// Programmatic `bun build` wrapper that runs the same bundle step the build
// script previously did via the CLI:
//
//   bun build ./index.html ./posts/*.html --outdir ./dist --target browser
//
// becomes:
//
//   bun engine/generate/build-html.ts ./index.html ./posts/*.html
//
// The shell still expands the glob, so callers pass entry paths verbatim.
// We do the indirection only to register `siteFooterPlugin()` — `bun build`'s
// CLI form doesn't expose a plugin hook short of bunfig preload, and the
// proposal that introduced this script (Proposal 13 §8) chose the programmatic
// route for explicitness.
//
// Anything entirely orthogonal to the inject (target/outdir/sourcemap) stays
// hardcoded to match the pre-refactor CLI invocation, so per-blog package.json
// only carries the per-blog entry list.

import { siteFooterPlugin } from "../shared/bunFooterPlugin.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";

async function main(): Promise<void> {
  const entries = process.argv.slice(2);
  if (entries.length === 0) {
    console.error(
      "Usage: bun engine/generate/build-html.ts <entry.html> [<entry.html> ...]",
    );
    process.exit(1);
  }

  const paths = resolveBlogPaths();
  const result = await Bun.build({
    entrypoints: entries,
    outdir: paths.distDir,
    target: "browser",
    plugins: [siteFooterPlugin()],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
