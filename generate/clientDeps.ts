// Derives the set of third-party (`node_modules`) packages that actually reach
// the CLIENT bundle — the deps the blog distributes to every reader and
// therefore owes a license notice for (proposal 60). The same "derive from the
// real artifact" discipline `generate/audit-deps.ts` uses for CVEs (`bun audit`
// over the real lockfile), applied to licenses: only what the browser actually
// receives is listed, so the set can't silently drift when a client `import` is
// added/removed.
//
// HOW — `Bun.build({ metafile: true })` over the blog's real HTML entrypoints
// (`index.html` + `posts/*.html`, skipping `_`-prefixed fixtures/drafts, exactly
// like `build-html.ts`). The Compact/esbuild-style metafile reports, per emitted
// chunk, which inputs ended up IN it and how many bytes (`bytesInOutput`).
//
// CRUCIAL — collect from `metafile.outputs[*].inputs` filtered to
// `bytesInOutput > 0`, NOT from `metafile.inputs`. The latter is the *parsed*
// module graph and OVER-CLAIMS: a dep that's imported but fully tree-shaken away
// (only its types used, or a re-export DCE'd) appears in `inputs` yet ships
// nothing. A compliance artifact must list what is *distributed*, so we read the
// post-tree-shake output composition. (Verified: `zod` + `content-disposition`
// genuinely ship via `client/identity.ts`; `turndown`/`@mozilla/readability`
// correctly never appear — they're build-only.)
//
// (`legalComments: "external"` would have been the obvious source for the actual
// notice text, but `Bun.build` silently ignores it — see proposal 60 / Option B.
// So this only derives the package *set*; the notice text comes from each
// package's own `LICENSE` file, resolved by `generate/licenseFiles.ts`.)

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";
import { type BlogPaths, resolveBlogPaths } from "../shared/blogPaths.ts";

/**
 * Extract the npm package name from a `node_modules`-relative input path,
 * handling scoped packages (`@scope/name`). Returns null for a path with no
 * `node_modules` segment (a first-party module).
 */
export function packageNameFromInput(inputPath: string): string | null {
  // The LAST `node_modules/` wins, so a nested dep
  // (`a/node_modules/b/...`) resolves to `b`, not `a`.
  const idx = inputPath.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const rest = inputPath.slice(idx + "node_modules/".length);
  const m = rest.match(/^(@[^/]+\/[^/]+|[^/]+)/);
  return m?.[1] ?? null;
}

/**
 * The blog's client HTML entrypoints — `index.html` (if present) and every
 * `posts/*.html` that isn't a `_`-prefixed fixture/draft. Mirrors the entry set
 * `build-html.ts` is invoked with (`./index.html ./posts/*.html`, `_`-filtered).
 */
export async function clientHtmlEntrypoints(
  paths: BlogPaths = resolveBlogPaths(),
): Promise<string[]> {
  const entries: string[] = [];
  const index = join(paths.contentRoot, "index.html");
  if (existsSync(index)) entries.push(index);
  for await (const f of new Glob("*.html").scan({ cwd: paths.postsDir })) {
    if (basename(f).startsWith("_")) continue;
    entries.push(join(paths.postsDir, f));
  }
  return entries.sort();
}

/**
 * Build the entrypoints with a metafile and return the sorted set of
 * `node_modules` packages whose code actually ships to the client. Build
 * options mirror the load-bearing parts of `build-html.ts` (browser target,
 * code-splitting so lazy `import()` chunks are included, minify so tree-shaking
 * matches prod) — the HTML-head/footer plugins are omitted because they don't
 * change which deps resolve. No `outdir`, so nothing is written to disk.
 *
 * Throws when the build fails (a broken build can't yield a trustworthy notice
 * set), and when there are no entrypoints (a misconfigured content root —
 * silently returning `[]` would under-claim).
 */
export async function deriveShippedClientPackages(
  paths: BlogPaths = resolveBlogPaths(),
): Promise<string[]> {
  const entrypoints = await clientHtmlEntrypoints(paths);
  if (entrypoints.length === 0) {
    throw new Error(
      `No client HTML entrypoints found under ${paths.contentRoot} (looked for index.html + posts/*.html). ` +
        `Cannot derive the client dependency set.`,
    );
  }
  const result = await Bun.build({
    entrypoints,
    target: "browser",
    splitting: true,
    minify: true,
    external: ["*.woff2"],
    define: { __BUN_DEV__: "false" },
    metafile: true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error(
      "Bun.build failed while deriving the client dependency set.",
    );
  }
  if (!result.metafile) {
    throw new Error("Bun.build returned no metafile despite metafile: true.");
  }
  return packagesFromMetafile(result.metafile);
}

/**
 * Pure extraction of the shipped-package set from a Bun metafile, split out so
 * it's unit-testable without running a real build. Reads each output chunk's
 * `inputs` and keeps only packages that contributed bytes (`bytesInOutput > 0`),
 * i.e. survived tree-shaking.
 */
export function packagesFromMetafile(metafile: BunMetafile): string[] {
  const shipped = new Set<string>();
  for (const out of Object.values(metafile.outputs)) {
    for (const [input, info] of Object.entries(out.inputs ?? {})) {
      if ((info?.bytesInOutput ?? 0) <= 0) continue;
      const name = packageNameFromInput(input);
      if (name) shipped.add(name);
    }
  }
  return [...shipped].sort();
}

// Minimal shape of the parts of Bun's metafile we read. Bun's own type is
// loose (`Record<string, any>` in places); this pins exactly what we touch.
export type BunMetafile = {
  inputs: Record<string, unknown>;
  outputs: Record<
    string,
    { inputs?: Record<string, { bytesInOutput?: number }> }
  >;
};
