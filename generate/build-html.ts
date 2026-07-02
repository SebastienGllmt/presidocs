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
// CLI form doesn't expose a plugin hook short of bunfig preload, so this script
// uses the programmatic route for explicitness (see methodology → Build-time
// HTML strip for the build-only-vs-content-bearing rationale).
//
// Anything entirely orthogonal to the inject (target/outdir/sourcemap) stays
// hardcoded to match the pre-refactor CLI invocation, so per-blog package.json
// only carries the per-blog entry list.

import { basename } from "node:path";
import { htmlHeadPlugin } from "./bunHtmlHeadPlugin.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { checkHeadLayerOrder } from "./cssLayers.ts";

/**
 * Assert the canonical cascade-layer order landed before the (bundled)
 * stylesheet in each built layer-system page. The injection itself is done by
 * `htmlHeadPlugin()` during the bundle (the same plugin dev registers via
 * bunfig — see shared/bunHtmlHeadPlugin.ts); this is the build-time half of the
 * dev/prod parity guard (methodology → Cascade-layer architecture, "Pinning the
 * order") and catches any future bundler change that reorders or drops it.
 *
 * Layer participation is decided from the *source* entry (it links base.css);
 * the built output links the bundled chunk instead, so the string is gone there.
 */
async function assertLayerOrderInBuiltHtml(
  entries: string[],
  outputs: Bun.BuildArtifact[],
): Promise<void> {
  const htmlByName = new Map<string, string>();
  for (const o of outputs) {
    if (o.kind === "entry-point" && o.path.endsWith(".html")) {
      htmlByName.set(basename(o.path), o.path);
    }
  }

  const problems: string[] = [];
  for (const entry of entries) {
    const source = await Bun.file(entry).text().catch(() => "");
    if (!source.includes("base.css")) continue; // not in the layer system
    const outPath = htmlByName.get(basename(entry));
    if (!outPath) continue;
    const built = await Bun.file(outPath).text();
    for (const p of checkHeadLayerOrder(built)) problems.push(`${basename(entry)}: ${p}`);
  }

  if (problems.length > 0) {
    console.error(
      "Cascade-layer order assertion failed in built HTML " +
        "(see methodology → Cascade-layer architecture):",
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // `_`-prefixed entries are fixtures/drafts: the dev route table serves them
  // (post-routes.ts globs posts/**/*.html, so e.g. the figure-journey
  // conformance fixture is reachable in dev), but they must NOT reach dist/ and
  // be deployed. Filter them out of the production build here.
  const entries = process.argv.slice(2).filter((e) => !basename(e).startsWith("_"));
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
    // Code-splitting is required for `import()` to emit a SEPARATE chunk rather
    // than inlining the dynamic dependency back into the importer. Without it,
    // `client/commentsLoader.ts`'s lazy `import("./comments.ts")` would still
    // ship the ~150 KB comment system in the eager entry.
    // With it, shared code across the post's many <script> entries is also
    // de-duplicated into shared chunks the HTML modulepreloads. Bundle-budget
    // guarded by client/comments.budget.test.ts.
    splitting: true,
    // Keep the self-hosted Red Hat woff2 OUT of the bundle. Without this Bun
    // inlines each @font-face `url(./fonts/*.woff2)` as a base64 data: URI into
    // every post's CSS chunk (~104 KB of fonts duplicated per post, re-fetched
    // on every navigation). `external` leaves the url verbatim; the CSS chunks
    // sit at dist root, so `./fonts/x.woff2` resolves to `/fonts/x.woff2`, which
    // copy-static.ts copies to `dist/fonts/` — one cacheable file, fetched once.
    // (Dev's serve.static still inlines, which is fine — no caching concerns
    // there, and it keeps the figure-height gate / capture font-faithful.)
    external: ["*.woff2"],
    // Production assets are content-hashed and served immutable (methodology →
    // Serving generated audio / Immutable Responses), so the build is the only
    // place to shrink them. `minify` trims the JS/CSS chunks (Lighthouse
    // `unminified-javascript`/`unminified-css`); `sourcemap: "linked"` emits a
    // sibling `.js.map` + `//# sourceMappingURL` so prod stays debuggable and
    // `valid-source-maps` passes. The head plugin and the `__BUN_DEV__`
    // constant-fold both run before minify, so neither is disturbed.
    minify: true,
    sourcemap: "linked",
    // Injects the cascade-layer order + site footer (shared/bunHtmlHeadPlugin.ts).
    // The same plugin runs in dev via bunfig, so dev and prod render identically.
    // `preloadFonts` is prod-only: it adds the critical-face <link rel=preload>,
    // which dev must NOT emit (dev inlines the woff2, so a preload would point at
    // a never-fetched URL). `external: ["*.woff2"]` above is what makes the prod
    // fonts real URLs the preload can target.
    plugins: [htmlHeadPlugin({ preloadFonts: true })],
    define: {
      // client/swRegister.ts uses `typeof __BUN_DEV__ === "undefined"` to
      // decide whether to register the SW. Substituting the identifier with
      // the literal `false` here means the bundled output runs the
      // registration path; the un-bundled source served by Bun's inner loop
      // sees an undeclared identifier and the SW stays unregistered there.
      // (Proposal 06 §7 "Don't register the SW from the Bun inner loop".)
      __BUN_DEV__: "false",
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  await assertLayerOrderInBuiltHtml(entries, result.outputs);
}

if (import.meta.main) {
  void main();
}
