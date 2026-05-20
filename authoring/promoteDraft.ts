#!/usr/bin/env bun
//
// Promote an AI-authored draft to a new post version.
//
// Usage:
//   bun authoring/promoteDraft.ts <slug> [--yes] [--show-diff]
//
// What it does:
//   1. Reads `posts/<slug>.ai-draft.meta.json` to recover Claude's
//      per-thread verdicts (APPLIED / PARTIAL / NOTE-ONLY).
//   2. (Optional) Prints the unified diff so the author can re-check
//      before accepting.
//   3. Prompts for confirmation (skip with --yes).
//   4. Writes a resolution envelope into the local dev comments store
//      for each APPLIED thread. The author syncs these to R2
//      separately (`wrangler r2 object sync`), same direction as the
//      comment-fetch sync.
//   5. Moves the draft into place: `posts/<slug>.ai-draft.html` →
//      `posts/<slug>.html`.
//   6. Deletes the meta sidecar.
//   7. Re-runs `generate/post-versions.ts` so the new content hash is
//      recorded in `posts/versions.json` and the generated Worker
//      bundle picks it up on next build.
//
// The "draft → promote" split exists because resolution is a
// side-effect that's wrong if the author rejects the draft. Tying
// resolution to acceptance (not to Claude's run) keeps the system
// honest: a thread is only resolved if the edit it triggered actually
// shipped.

import { rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { fsAdapter } from "../server/comments/fsAdapter.ts";
import type { DraftMeta } from "./applyComments.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

type CliArgs = {
  slug: string;
  yes: boolean;
  showDiff: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  let slug: string | null = null;
  let yes = false;
  let showDiff = false;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--show-diff") showDiff = true;
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (slug === null) {
      slug = a;
    } else {
      throw new Error(`unexpected positional arg: ${a}`);
    }
  }
  if (!slug) {
    printUsage();
    process.exit(1);
  }
  return { slug, yes, showDiff };
}

function printUsage(): void {
  console.error(`
Usage: bun authoring/promoteDraft.ts <slug> [options]

  <slug>           post stem under posts/, e.g. "hash-functions"

Options:
  --yes, -y        skip the y/N prompt
  --show-diff      print the unified diff before prompting
  --help           show this help
`.trimStart());
}

async function printDiff(slug: string): Promise<void> {
  // git diff --no-index handles color + pager logic better than BSD
  // diff. Force --color=always since stdout is inherited; the author
  // can pipe to less if they want paging.
  const proc = Bun.spawn(
    [
      "git",
      "diff",
      "--no-index",
      "--color=always",
      `posts/${slug}.html`,
      `posts/${slug}.ai-draft.html`,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      cwd: PROJECT_ROOT,
    },
  );
  // git diff --no-index exits 1 when files differ (which is exactly
  // what we expect). Don't treat that as an error.
  await proc.exited;
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function regeneratePostVersions(): Promise<number> {
  // Reuse the existing build-time generator instead of duplicating
  // its hash-and-write logic here — keeps versions.json's format
  // owned by one place. Run as a child process because that script's
  // top-level await + side-effect-on-import shape doesn't play well
  // with re-invocation from another module.
  const proc = Bun.spawn(["bun", "generate/post-versions.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: PROJECT_ROOT,
  });
  return await proc.exited;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const srcPath = join(PROJECT_ROOT, "posts", `${args.slug}.html`);
  const draftPath = join(PROJECT_ROOT, "posts", `${args.slug}.ai-draft.html`);
  const metaPath = join(
    PROJECT_ROOT,
    "posts",
    `${args.slug}.ai-draft.meta.json`,
  );

  if (!existsSync(srcPath)) {
    console.error(`error: ${srcPath} does not exist`);
    process.exit(1);
  }
  if (!existsSync(draftPath)) {
    console.error(
      `error: no draft at posts/${args.slug}.ai-draft.html — run apply-comments first`,
    );
    process.exit(1);
  }

  // Meta is allowed to be missing (e.g. someone hand-wrote the draft
  // file). In that case there's nothing to auto-resolve; we still
  // promote and update versions.
  let meta: DraftMeta | null = null;
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(await Bun.file(metaPath).text()) as DraftMeta;
    } catch (err) {
      console.warn(
        `warning: failed to parse ${metaPath} — continuing without auto-resolve. (${(err as Error).message})`,
      );
    }
  }

  const appliedIds =
    meta?.verdicts.filter((v) => v.status === "APPLIED").map((v) => v.threadId) ??
    [];
  const partialCount =
    meta?.verdicts.filter((v) => v.status === "PARTIAL").length ?? 0;
  const noteOnlyCount =
    meta?.verdicts.filter((v) => v.status === "NOTE-ONLY").length ?? 0;

  console.log(`Promote: posts/${args.slug}.ai-draft.html → posts/${args.slug}.html`);
  if (meta) {
    console.log(
      `Auto-resolve: ${appliedIds.length} thread(s) marked APPLIED by Claude` +
        (partialCount + noteOnlyCount > 0
          ? ` (${partialCount} PARTIAL + ${noteOnlyCount} NOTE-ONLY left unresolved)`
          : ""),
    );
  } else {
    console.log("Auto-resolve: skipped (no meta sidecar)");
  }

  if (args.showDiff) {
    console.log("\n" + "─".repeat(64));
    await printDiff(args.slug);
    console.log("─".repeat(64) + "\n");
  }

  if (!args.yes) {
    const ok = await promptYesNo("Promote? [y/N] ");
    if (!ok) {
      console.log("Aborted. Nothing changed.");
      process.exit(0);
    }
  }

  // 1) Write resolutions for the APPLIED threads, BEFORE the rename.
  // If we crashed between the rename and the resolution writes, the
  // post would be promoted but the threads would still look open in
  // the author aggregator — confusing, and the author would have no
  // memory of which threads were supposed to be resolved (the meta
  // sidecar is gone too). Doing resolutions first means a crash leaves
  // resolutions written + draft intact + threads correctly marked
  // resolved on next aggregator load.
  const commentsDir = join(PROJECT_ROOT, "generated", ".comments-dev");
  const store = fsAdapter(commentsDir);
  const postPath = `/posts/${args.slug}`;
  const now = Date.now();

  for (const threadId of appliedIds) {
    const envelope = {
      threadId,
      resolvedAt: now,
      // Identity scheme distinct from <provider>:<sub> on purpose —
      // makes "this resolution came from the AI tool" greppable in
      // logs / audits without overloading the OAuth namespace.
      resolverId: "ai-applied",
      resolverName: "AI (apply-comments)",
    };
    await store.putResolution(
      postPath,
      threadId,
      new TextEncoder().encode(JSON.stringify(envelope)),
    );
    console.log(`  resolved ${threadId}`);
  }

  // 2) Move the draft into place. Use rename() (atomic on same fs)
  // rather than copy+delete so a crash mid-promote can't leave both
  // files diverging from the intended state.
  await rename(draftPath, srcPath);

  // 3) Drop the meta sidecar — its contents are now in versions.json
  // (the new hash) + the resolution blobs, and keeping it around
  // would just confuse a later re-run.
  if (existsSync(metaPath)) {
    await unlink(metaPath);
  }

  // 4) Re-run the post-versions generator to record the new hash.
  // The Worker's `server/postVersions.generated.ts` is rewritten as a
  // side-effect, so the next `bun run build` already picks up the
  // new bytes; the in-tree versions.json carries the history forward.
  const code = await regeneratePostVersions();
  if (code !== 0) {
    console.error(
      `warning: post-versions generator exited ${code}; posts/${args.slug}.html was moved but versions.json may not reflect it. Re-run \`bun generate/post-versions.ts\` manually.`,
    );
    process.exit(code);
  }

  console.log(
    `\nPromoted. Next steps:\n` +
      `  bun run generate         # re-synthesize affected audio segments\n` +
      `  bun run build && wrangler deploy\n` +
      (appliedIds.length > 0
        ? `\nThe ${appliedIds.length} resolution blob(s) were written to ${commentsDir}/resolutions/. Push them to R2 alongside your next deploy:\n` +
          `  wrangler r2 object put ...\n` +
          `(R2 sync is a v1 manual step — see methodology.md.)\n`
        : ""),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
