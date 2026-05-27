#!/usr/bin/env bun
//
// Diagnostic: print every unresolved thread the comment-applier would
// feed to Claude, in human-readable form. Useful for double-checking
// what's in the dev store before paying tokens. No model call.
//
// Usage: bun authoring/listUnresolved.ts <slug>

import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { loadUnresolvedThreads } from "./loadUnresolvedThreads.ts";
import {
  contextOf,
  graphicTargetId,
  isTextTarget,
  textTargetParts,
} from "../client/commentsStore.ts";

const paths = resolveBlogPaths();

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: bun authoring/listUnresolved.ts <slug>");
    process.exit(1);
  }
  const result = await loadUnresolvedThreads({
    postPath: `/posts/${slug}`,
    commentsDir: join(paths.generatedDir, ".comments-dev"),
  });
  console.log(
    `${result.totalCount} total / ${result.resolvedCount} resolved / ${result.unresolved.length} unresolved\n`,
  );
  for (const t of result.unresolved) {
    console.log(`Thread ${t.thread.id} (by ${t.ownerUserId}):`);
    const target = t.thread.target;
    if (isTextTarget(target)) {
      const { quote } = textTargetParts(target);
      console.log(`  anchor: text in ${contextOf(target)}, quote: ${JSON.stringify(quote)}`);
    } else {
      console.log(`  anchor: graphic figure id=${graphicTargetId(target)} in ${contextOf(target)}`);
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
