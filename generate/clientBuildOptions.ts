// The load-bearing `Bun.build` options shared by the two places that bundle the
// blog's CLIENT code: generate/build-html.ts (the real dist/ build) and
// generate/clientDeps.ts (a metafile-only build that derives the set of
// third-party packages the browser actually receives). Kept here as one source
// of truth so the two can't drift — clientDeps must tree-shake IDENTICALLY to
// the real build or its license-notice set silently under/over-claims.
//
// Each caller spreads this and adds its own orthogonal fields: build-html adds
// `outdir`/`sourcemap`/`plugins`; clientDeps adds `metafile: true` (and no
// outdir, so nothing is written). The head/footer plugins are deliberately NOT
// here — they don't change which deps resolve.
export function clientBuildOptions(): Partial<Bun.BuildConfig> {
  return {
    target: "browser",
    // Code-splitting: emit lazy `import()` chunks separately (so
    // client/commentsLoader.ts's dynamic import doesn't inline the ~150 KB
    // comment system into the eager entry) and de-dupe shared code across the
    // post entries. Bundle-budget guarded by client/comments.budget.test.ts.
    splitting: true,
    // Minify so tree-shaking matches prod: clientDeps reads the post-shake
    // output composition, and build-html serves the minified chunks.
    minify: true,
    // Keep the self-hosted Red Hat woff2 OUT of the bundle — otherwise Bun
    // inlines each @font-face url() as a base64 data: URI into every post's CSS
    // chunk. `external` leaves the url verbatim; copy-static.ts serves the file.
    external: ["*.woff2"],
    // client/swRegister.ts gates on `typeof __BUN_DEV__ === "undefined"`;
    // folding it to `false` here selects the bundled (SW-registering) path,
    // while the un-bundled source Bun's dev loop serves keeps it undeclared.
    define: { __BUN_DEV__: "false" },
  };
}
