// Bundle-budget guard for the narrator code-split (methodology.md → Narrator).
//
// `client/narratorLoader.ts` is the eager <script> the post loads; the narrator
// (`client/narrator.ts` + Shikwasa + its module graph) lives behind a dynamic
// import so Shikwasa stays out of the critical FCP/TBT path. This test fails if
// that boundary erodes — i.e. if the loader grows a STATIC import of the heavy
// graph, which would pull Shikwasa + the ~2000-line narrator back into the
// first-paint chunk. Source-level (no build needed), matching the Tier-A
// static-audit posture and mirroring comments.budget.test.ts.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const loader = readFileSync(join(import.meta.dir, "narratorLoader.ts"), "utf8");

test("narratorLoader.ts defers the narrator via a dynamic import", () => {
  expect(loader).toContain('import("./narrator.ts")');
});

test("narratorLoader.ts (the eager entry) has NO static imports of the heavy graph", () => {
  // The narrator and Shikwasa must reach the page only via the dynamic import.
  // A static `import ... from "./narrator.ts"` (or "shikwasa") in the loader
  // would defeat the split. `narrator` itself is included: the loader must
  // `import()` it, not statically import it.
  const heavy = ["narrator.ts", "shikwasa", "shikwasa-vendor.css", "figureAnimation"];
  // Match only STATIC import statements (`import ... "x"` / `import "x"`), not
  // the dynamic `import("x")` call form — those are the whole point.
  const staticImport = /^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm;
  const statics: string[] = [];
  for (const m of loader.matchAll(staticImport)) statics.push(m[1]!);

  for (const mod of heavy) {
    const offender = statics.find((s) => s.includes(mod));
    expect(offender, `narratorLoader.ts statically imports "${offender}" — keep it lazy`).toBeUndefined();
  }
});
