// Deploy step: upload each post's CURRENT full narration track to R2, then
// reconcile stale tracks (keep the 2 most-recent per slug — the live hash + the
// immediately-prior one for grace).
//
// Why R2 and not the asset bundle: a long track can exceed Cloudflare's hard
// 25 MiB per-static-asset cap, so full tracks are served from R2 by the Worker
// (env.AUDIO; createWorker.ts) and no longer ship to dist/ (copy-static.ts).
//
// Why a local index instead of listing R2: `wrangler r2 object` has get/put/
// delete but NO list, and `generate.ts` sweeps superseded `full.<hash>` files
// off disk (keeping only the live one), so we'd otherwise have no record of the
// prior hashes to delete. We track uploaded filenames per slug in
// `generated/.audio-r2-state.json` (gitignored, like all of generated/). It's
// the source of truth for the reconcile, and it gives a free skip-if-unchanged
// on upload. Degrades safely: a machine without the index re-uploads the live
// tracks (idempotent — content-addressed keys) and rebuilds the index, never
// deleting blindly.
//
// Usage (from the content repo, via its deploy script):
//   bun engine/generate/upload-audio-r2.ts [--bucket <name>] [--remote|--local] [--persist-to <dir>]
// `--bucket` is the per-repo R2 bucket name; when omitted it's auto-discovered
// from the content repo's wrangler.toml (the AUDIO binding's bucket_name). With
// no AUDIO binding the step is a graceful no-op (that repo serves audio from the
// ASSETS bundle). Defaults to --remote (real R2); --local seeds Miniflare's R2
// for the prod-Worker e2e tier (e2e/harness.ts) and dev:edge.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { resolveBlogPaths } from "../shared/blogPaths.ts";

const paths = resolveBlogPaths();

// Content-addressed full track: `full.<16 hex>.<ext>`.
const FULL_RE = /^full\.[0-9a-f]{16}\.[a-z0-9]+$/;
// How many tracks to retain per slug: the live one + one prior, for grace
// against an in-flight referrer (a podcast client mid-download, a warm edge
// cache) racing the deploy that rotated the hash.
const KEEP_PER_SLUG = 2;

// slug → uploaded track filenames, recency-descending ([0] is the live/newest).
type State = Record<string, string[]>;

function parseFlags(argv: string[]): {
  bucket: string | null;
  local: boolean;
  persistTo: string | null;
} {
  let bucket: string | null = null;
  let local = false;
  let persistTo: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bucket") bucket = argv[++i] ?? null;
    else if (a === "--local") local = true;
    else if (a === "--remote") local = false;
    else if (a === "--persist-to") persistTo = argv[++i] ?? null;
  }
  return { bucket, local, persistTo };
}

// Discover the AUDIO binding's bucket_name from the content repo's
// wrangler.toml. Scans each `[[r2_buckets]]` array-of-tables block for
// `binding = "AUDIO"` (bounded by the next table header so fields don't bleed
// across blocks; order-independent within a block). Null ⇒ no AUDIO binding.
async function discoverAudioBucket(contentRoot: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(contentRoot, "wrangler.toml"), "utf8");
  } catch {
    return null;
  }
  for (const block of text.split(/^\s*\[\[r2_buckets\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\s*\[/m)[0] ?? ""; // up to the next table header
    if (/\bbinding\s*=\s*"AUDIO"/.test(body)) {
      const m = body.match(/\bbucket_name\s*=\s*"([^"]+)"/);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

async function loadState(file: string): Promise<State> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as State;
  } catch {
    return {}; // first run on this machine, or no index yet
  }
}

// Scan generated/<slug>/ for the single live `full.<hash>.<ext>` per slug.
// `generate.ts` sweeps superseded tracks, so there's at most one on disk.
async function liveTracks(generatedDir: string): Promise<Map<string, string>> {
  const live = new Map<string, string>();
  let slugs: string[];
  try {
    slugs = (await readdir(generatedDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return live; // no generated/ → nothing to upload
  }
  for (const slug of slugs) {
    const files = await readdir(join(generatedDir, slug)).catch(() => [] as string[]);
    const track = files.find((f) => FULL_RE.test(f));
    if (track) live.set(slug, track);
  }
  return live;
}

async function main(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2));
  const bucket = flags.bucket ?? (await discoverAudioBucket(paths.contentRoot));
  if (!bucket) {
    console.log("Audio → R2: no AUDIO binding in wrangler.toml — skipping (served from ASSETS).");
    return;
  }
  const { local, persistTo } = flags;
  const mode = local ? "--local" : "--remote";
  const persistArgs = local && persistTo ? ["--persist-to", persistTo] : [];

  // Local (Miniflare) and remote R2 are SEPARATE stores, so their indexes must
  // not be shared — a local seed must never make a remote deploy think a track
  // is already uploaded (it'd skip the real upload → prod 404). Keyed by mode.
  const stateFile = join(
    paths.generatedDir,
    local ? ".audio-r2-state.local.json" : ".audio-r2-state.json",
  );
  const state = await loadState(stateFile);
  const live = await liveTracks(paths.generatedDir);

  // Nothing to upload and no prior index → nothing to do. Covers a blog that has
  // the AUDIO binding but no generated audio yet (a fresh scaffold), where the
  // `generated/` dir may not even exist — don't fall through to writing the index
  // into a missing directory.
  if (live.size === 0 && Object.keys(state).length === 0) {
    console.log(`Audio → R2 (${bucket}, ${local ? "local" : "remote"}): no tracks — nothing to do.`);
    return;
  }

  const key = (slug: string, file: string) => `generated/${slug}/${file}`;
  const objRef = (slug: string, file: string) => `${bucket}/${key(slug, file)}`;

  let uploaded = 0;
  let skipped = 0;
  let deleted = 0;

  // 1. Upload any live track whose hash isn't already the newest recorded one.
  for (const [slug, file] of live) {
    const recorded = state[slug] ?? [];
    if (recorded[0] === file) {
      skipped++; // unchanged since last deploy — content-addressed, already in R2
    } else {
      const src = join(paths.generatedDir, slug, file);
      console.log(`  ↑ ${key(slug, file)}`);
      await $`bunx wrangler r2 object put ${objRef(slug, file)} --file ${src} --content-type audio/mpeg ${mode} ${persistArgs}`.quiet();
      uploaded++;
      // Prepend live to the front (dedupe so a revert to an old hash re-anchors).
      state[slug] = [file, ...recorded.filter((f) => f !== file)];
    }
  }

  // 2. Reconcile. For a slug with a live track, keep the 2 most-recent (live +
  //    prior) and delete the rest. For a slug no longer on disk (deleted post /
  //    audio removed), delete ALL its tracks — it has no live referrer.
  for (const slug of Object.keys(state)) {
    const recorded = state[slug] ?? [];
    const keep = live.has(slug) ? recorded.slice(0, KEEP_PER_SLUG) : [];
    const failed: string[] = [];
    for (const file of recorded) {
      if (keep.includes(file)) continue;
      console.log(`  ✗ ${key(slug, file)}`);
      const ok = await $`bunx wrangler r2 object delete ${objRef(slug, file)} ${mode} ${persistArgs}`
        .quiet()
        .then(() => true)
        .catch((e: unknown) => {
          console.warn(`    (delete failed, will retry next deploy: ${String(e)})`);
          return false;
        });
      if (ok) deleted++;
      else failed.push(file); // RETAIN in the index — it's the only record of
      // prior hashes (no R2 list), so dropping it here would orphan the object
      // forever instead of retrying next deploy.
    }
    // New index = the kept tracks plus any whose delete failed, in recorded order.
    const next = recorded.filter((f) => keep.includes(f) || failed.includes(f));
    if (next.length > 0) state[slug] = next;
    else delete state[slug];
  }

  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(
    `Audio → R2 (${bucket}, ${local ? "local" : "remote"}): ${uploaded} uploaded, ${skipped} unchanged, ${deleted} reclaimed.`,
  );
}

main().catch((err) => {
  console.error("upload-audio-r2 failed:", err);
  process.exit(1);
});
