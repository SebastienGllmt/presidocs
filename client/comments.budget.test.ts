// Bundle-budget guard for the comments code-split (methodology.md → Comments).
//
// `client/commentsLoader.ts` is the eager <script> the post loads; the heavy
// comment system (`client/comments.ts` + its module graph) lives behind a
// dynamic import so it stays out of the critical FCP/TBT path. This test fails
// if that boundary erodes — i.e. if the loader grows a STATIC import of the
// heavy graph, which would pull ~150 KB back into the first-paint chunk.
// Source-level (no build needed), matching the Tier-A static-audit posture.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const loader = readFileSync(join(import.meta.dir, "commentsLoader.ts"), "utf8");

test("commentsLoader.ts defers the comment system via a dynamic import", () => {
  expect(loader).toContain('import("./comments.ts")');
});

test("commentsLoader.ts (the eager entry) has NO static imports of the heavy graph", () => {
  // The comment system and its modules must reach the page only via the dynamic
  // import. A static `import ... from "./<mod>.ts"` in the loader would defeat
  // the split. `comments` itself is included: the loader must `import()` it, not
  // statically import it.
  const heavy = [
    "comments.ts",
    "commentsStore",
    "commentsSync",
    "commentsApi",
    "commentsDom",
    "commentsPolling",
    "commentsStale",
    "commentsAggregator",
    "resolutionsStore",
    "resolutionsApi",
    "@automerge",
    "shikwasa",
  ];
  // Match only STATIC import statements (`import ... "x"` / `import "x"`), not
  // the dynamic `import("x")` call form — those are the whole point.
  const staticImport = /^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm;
  const statics: string[] = [];
  for (const m of loader.matchAll(staticImport)) statics.push(m[1]!);

  for (const mod of heavy) {
    const offender = statics.find((s) => s.includes(mod));
    expect(offender, `commentsLoader.ts statically imports "${offender}" — keep it lazy`).toBeUndefined();
  }
});
