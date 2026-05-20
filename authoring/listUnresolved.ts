#!/usr/bin/env bun
//
// Diagnostic: print every unresolved thread the comment-applier would
// feed to Claude, in human-readable form. Useful for double-checking
// what's in the dev store before paying tokens. No model call.
//
// Usage: bun authoring/listUnresolved.ts <slug>

import { join, resolve } from "node:path";
import { loadUnresolvedThreads } from "./loadUnresolvedThreads.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: bun authoring/listUnresolved.ts <slug>");
    process.exit(1);
  }
  const result = await loadUnresolvedThreads({
    postPath: `/posts/${slug}`,
    commentsDir: join(PROJECT_ROOT, "generated", ".comments-dev"),
  });
  console.log(
    `${result.totalCount} total / ${result.resolvedCount} resolved / ${result.unresolved.length} unresolved\n`,
  );
  for (const t of result.unresolved) {
    console.log(`Thread ${t.thread.id} (by ${t.ownerUserId}):`);
    const a = t.thread.anchor;
    if (a.kind === "text") {
      console.log(`  anchor: text in ${a.context}, quote: ${JSON.stringify(a.quote)}`);
    } else {
      console.log(`  anchor: graphic figure id=${a.id} in ${a.context}`);
    }
    for (const r of t.thread.replies) {
      console.log(`  - ${r.authorName}: ${r.body}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
