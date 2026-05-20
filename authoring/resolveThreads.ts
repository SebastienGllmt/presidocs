#!/usr/bin/env bun
//
// Mark comment threads as author-resolved, from outside the browser.
//
// Usage:
//   bun authoring/resolveThreads.ts <slug> <threadId> [<threadId> ...]
//
// This is the resolution write-back for the in-session `process-comments`
// skill (see methodology.md → AI-assisted authoring → "Resolution
// write-back"). The skill edits `posts/<slug>.html` in place, then calls
// this with the thread ids it marked APPLIED — resolving a thread iff
// the edit it triggered actually shipped.
//
// It writes one author-resolution envelope per thread into the local dev
// comments store (`generated/.comments-dev/resolutions/<post>/<threadId>.json`),
// exactly like the dev server's PUT /resolutions handler. The author
// syncs these to R2 alongside the next deploy (`wrangler r2 object put`),
// same direction as the comment-fetch sync — an R2 push step is a v1
// manual follow-up (see methodology.md → AI authoring → Excluded from v1).
//
// It deliberately does NOT bump the post version: the content hash is
// recorded by `generate/post-versions.ts`, which already runs as part of
// `bun run build`. Resolving a thread and shipping a new version are
// separate concerns — resolution marks "this feedback was addressed",
// the version bump happens when the edited post is next built.

import { resolve } from "node:path";
import { join } from "node:path";
import { fsAdapter } from "../server/comments/fsAdapter.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

// Accept either a bare thread id (`abc123`) or the annotation IRI the
// exporter emits (`urn:blog:<slug>:thread:abc123`) — the skill works
// from the exported AnnotationCollection, so taking the IRI verbatim is
// the friction-free path.
function normalizeThreadId(arg: string): string {
  const marker = ":thread:";
  const i = arg.lastIndexOf(marker);
  return i === -1 ? arg : arg.slice(i + marker.length);
}

async function main(): Promise<void> {
  const [slug, ...rawIds] = process.argv.slice(2);
  if (!slug || rawIds.length === 0) {
    console.error(
      "Usage: bun authoring/resolveThreads.ts <slug> <threadId> [<threadId> ...]",
    );
    process.exit(1);
  }
  const threadIds = rawIds.map(normalizeThreadId);

  const commentsDir = join(PROJECT_ROOT, "generated", ".comments-dev");
  const store = fsAdapter(commentsDir);
  const postPath = `/posts/${slug}`;
  const now = Date.now();

  for (const threadId of threadIds) {
    const envelope = {
      threadId,
      resolvedAt: now,
      // `ai-applied` keeps every AI-driven resolution greppable under one
      // resolverId, distinct from the OAuth `<provider>:<sub>` scheme;
      // the resolverName records that the in-session skill wrote it.
      resolverId: "ai-applied",
      resolverName: "AI (process-comments skill)",
    };
    await store.putResolution(
      postPath,
      threadId,
      new TextEncoder().encode(JSON.stringify(envelope)),
    );
    console.log(`resolved ${threadId}`);
  }

  console.log(
    `\nWrote ${threadIds.length} resolution(s) to ${commentsDir}/resolutions${postPath}/.` +
      `\nPush to R2 alongside your next deploy (v1 manual step):` +
      `\n  wrangler r2 object put ...`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
