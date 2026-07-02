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
// exactly like the dev server's PUT /resolutions handler. Run
// `bun run push-resolutions <slug>` afterward to mirror these up to R2,
// symmetric with the `pull-comments` fetch (see methodology.md → AI
// authoring → "Syncing production comments").
//
// It deliberately does NOT bump the post version: the content hash is
// recorded by `generate/post-versions.ts`, which already runs as part of
// `bun run build`. Resolving a thread and shipping a new version are
// separate concerns — resolution marks "this feedback was addressed",
// the version bump happens when the edited post is next built.

import { join } from "node:path";
import { fsAdapter } from "./fsAdapter.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { ResolutionEnvelope } from "../shared/commentSchemas.ts";

const paths = resolveBlogPaths();

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

  const commentsDir = join(paths.generatedDir, ".comments-dev");
  const store = fsAdapter(commentsDir);
  const postPath = `/posts/${slug}`;
  const now = Date.now();

  for (const threadId of threadIds) {
    // Build through the shared schema (the same one the browser's
    // putResolution validates against) so the CLI and client provably write
    // the same envelope shape, and a malformed write fails here at the CLI
    // rather than landing a bad blob in .comments-dev (and then in R2).
    const envelope = ResolutionEnvelope.parse({
      threadId,
      resolvedAt: now,
      // `ai-applied` keeps every AI-driven resolution greppable under one
      // resolverId, distinct from the OAuth `<provider>:<sub>` scheme;
      // the resolverName records that the in-session skill wrote it.
      resolverId: "ai-applied",
      resolverName: "AI (process-comments skill)",
    });
    await store.putResolution(
      postPath,
      threadId,
      new TextEncoder().encode(JSON.stringify(envelope)),
    );
    console.log(`resolved ${threadId}`);
  }

  console.log(
    `\nWrote ${threadIds.length} resolution(s) to ${commentsDir}/resolutions${postPath}/.` +
      `\nPush them to production with:` +
      `\n  bun run push-resolutions ${slug}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
