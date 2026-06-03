#!/usr/bin/env bun
// Deploy-time narration gate. Walks every generated post that ships a narration
// manifest and refuses the deploy unless that manifest was produced by the
// production pipeline: MOSS audio AND Qwen3 forced alignment (the word-level
// timing the drawer highlights against), with no `--mock` placeholder audio.
//
// Why this exists: nothing about a manifest's audio *bytes* reveals which engine
// made them, so a stray `bun run generate` (which on Linux defaults to espeak-ng
// and emits no `--align`) silently overwrites a post's manifest+audio with a
// degraded build that still plays — but loses word highlighting (the `words[]`
// marks vanish) and uses the wrong voice. That's invisible until a reader hits
// it in prod. The fix isn't to forbid test regenerations; it's to read the
// provenance block generate.ts now stamps into each manifest and fail loudly at
// deploy if the shipped artifacts aren't the real thing. See methodology.md and
// the words-in-manifest path in generate.ts (`provenance`, `marks[].words`).
//
// Scope mirrors episode-audio.ts: a post "ships narration" iff its generated
// dir contains a manifest. Posts with no manifest are simply not narrated and
// are skipped — this gate never *requires* a post to have audio, only that any
// audio it does ship is production-grade.
//
// Wired into the content repo's `deploy` script (package.json) ahead of the
// build, so it fails fast before wrangler ever runs. Runs browser-free with no
// network, same as audit-posts.ts, so it's cheap enough to gate every deploy.

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { findManifestName } from "../shared/manifestFile.ts";

/** Production requirements — the only combination allowed to ship. */
export const REQUIRED_TTS = "moss";
export const REQUIRED_ALIGNER = "qwen3";

type Provenance = {
  tts?: unknown;
  aligner?: unknown;
  mock?: unknown;
};
type Mark = { text?: unknown; words?: unknown };
type NarrationManifest = { provenance?: Provenance; marks?: unknown };

/**
 * Pure check of one parsed manifest against the production requirements. Returns
 * one human-readable violation per failed invariant (empty array = ship-ready).
 * Exported for unit tests.
 */
export function verifyNarrationManifest(manifest: unknown): string[] {
  const violations: string[] = [];
  if (typeof manifest !== "object" || manifest === null) {
    return ["manifest is not a JSON object"];
  }
  const m = manifest as NarrationManifest;

  // Provenance is the authoritative signal. Its absence means the manifest was
  // written by an engine predating this gate (or hand-edited) — either way we
  // can't prove it's production-grade, so refuse it and point at the fix.
  const prov = m.provenance;
  if (typeof prov !== "object" || prov === null) {
    violations.push(
      "no `provenance` block — built by a pre-gate engine or hand-edited; regenerate with `bun run generate:prod`",
    );
  } else {
    if (prov.mock === true) {
      violations.push("built with --mock (silent placeholder audio, not real narration)");
    }
    if (prov.tts !== REQUIRED_TTS) {
      violations.push(
        `tts=${JSON.stringify(prov.tts)} (expected ${JSON.stringify(REQUIRED_TTS)}) — likely a bare \`bun run generate\` (espeak-ng); use \`bun run generate:prod\``,
      );
    }
    if (prov.aligner !== REQUIRED_ALIGNER) {
      violations.push(
        `aligner=${JSON.stringify(prov.aligner)} (expected ${JSON.stringify(REQUIRED_ALIGNER)}) — drawer word-highlighting needs forced alignment; regenerate with --align=${REQUIRED_ALIGNER}`,
      );
    }
  }

  // Corroborate the aligner claim against the data it should have produced: with
  // forced alignment on, every spoken mark carries word-level timing. A mark
  // with text but no `words[]` means highlighting is dead for that segment even
  // if provenance looked right — catches a half-written/partially-cached run.
  const marks = Array.isArray(m.marks) ? (m.marks as Mark[]) : [];
  if (marks.length === 0) {
    violations.push("manifest has no marks (no narration segments to align)");
  } else {
    const missing = marks.filter(
      (mk) =>
        typeof mk.text === "string" &&
        mk.text.trim().length > 0 &&
        !(Array.isArray(mk.words) && mk.words.length > 0),
    );
    if (missing.length > 0) {
      const sample = missing
        .slice(0, 3)
        .map((mk) => JSON.stringify(typeof mk.text === "string" ? mk.text.slice(0, 32) : ""))
        .join(", ");
      violations.push(
        `${missing.length}/${marks.length} spoken mark(s) have no word-level timing — drawer highlighting will be dead (e.g. ${sample})`,
      );
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();

  let slugs: string[] = [];
  try {
    const entries = await readdir(paths.generatedDir, { withFileTypes: true });
    slugs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    // No generated/ dir → nothing narrated to verify. A deploy with zero audio
    // posts is legitimate (a fresh content repo), so this is a clean pass.
  }

  let checked = 0;
  const failures: { slug: string; violations: string[] }[] = [];

  for (const slug of slugs) {
    const dir = join(paths.generatedDir, slug);
    const manifestName = await findManifestName(dir);
    if (!manifestName) continue; // post ships no narration → not this gate's concern
    checked++;
    let manifest: unknown;
    try {
      manifest = await Bun.file(join(dir, manifestName)).json();
    } catch (err) {
      failures.push({ slug, violations: [`unreadable/malformed manifest: ${(err as Error).message}`] });
      continue;
    }
    const violations = verifyNarrationManifest(manifest);
    if (violations.length > 0) {
      failures.push({ slug, violations });
    } else {
      console.log(`  ✓ ${slug}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nverify-narration: ${failures.length} of ${checked} narrated post(s) are NOT production-grade:\n`,
    );
    for (const f of failures) {
      console.error(`  ✗ ${f.slug}`);
      for (const v of f.violations) console.error(`      - ${v}`);
    }
    console.error(
      `\nRegenerate the offending post(s) with MOSS + alignment before deploying:\n  bun run generate:prod\n`,
    );
    process.exit(1);
  }

  console.log(`verify-narration: OK — ${checked} narrated post(s) are MOSS + ${REQUIRED_ALIGNER}-aligned`);
}

// Only run the gate when invoked directly; importing for tests must not exit.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
