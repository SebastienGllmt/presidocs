// Resolves the two roots the engine and a content repo occupy, plus every
// content-relative path the build/serve/generate steps need.
//
// - engineRoot: where this engine's code + node_modules live. Derived from
//   this module's own location (shared/ sits directly under the engine root),
//   so it's correct regardless of cwd — including when the engine is consumed
//   from an external content repo's node_modules.
// - contentRoot: the blog whose posts/audio/dist we're operating on. Defaults
//   to the current working directory, overridable via BLOG_CONTENT_DIR. For
//   the presidocs repo itself, cwd === engineRoot so the two coincide and
//   behavior is identical to before the engine/content split. For an external
//   content repo (e.g. personal-blog) that depends on the engine via a `file:`
//   dependency, cwd is the content repo and engineRoot resolves into
//   node_modules/presidocs.
//
// Rule of thumb: anything content-specific (posts, generated audio, the built
// dist, the per-build generated maps) hangs off contentRoot; anything
// engine-specific (the Automerge WASM we vendor) hangs off engineRoot.

import { join, resolve } from "node:path";

export type BlogPaths = {
  engineRoot: string;
  contentRoot: string;
  postsDir: string;
  generatedDir: string;
  distDir: string;
  versionsJson: string;
  commonTermsPls: string;
  /** Per-build generated TS maps (postMeta/postVersions) the Worker imports. */
  generatedMapsDir: string;
  postMetaMap: string;
  postVersionsMap: string;
  /** Dev-only static route table for the Bun dev server. */
  postRoutesFile: string;
  /** Vendored Automerge WASM — served in dev, copied into dist. Engine-owned. */
  automergeWasm: string;
};

// Resolve the vendored Automerge WASM. A `file:` install of the engine hoists
// @automerge into the *content* repo's node_modules rather than the engine's
// own, so a hardcoded engineRoot/node_modules path would miss. Bun's resolver
// walks up from engineRoot and finds it in either place; fall back to the
// nested path (the standalone-presidocs case) if resolution somehow fails.
function resolveAutomergeWasm(engineRoot: string): string {
  const spec = "@automerge/automerge/dist/automerge.wasm";
  try {
    return Bun.resolveSync(spec, engineRoot);
  } catch {
    return join(engineRoot, "node_modules", spec);
  }
}

export function resolveBlogPaths(): BlogPaths {
  // shared/ lives directly under the engine root.
  const engineRoot = resolve(import.meta.dir, "..");
  const contentRoot = process.env.BLOG_CONTENT_DIR
    ? resolve(process.env.BLOG_CONTENT_DIR)
    : process.cwd();
  const postsDir = join(contentRoot, "posts");
  const generatedMapsDir = join(contentRoot, ".generated");
  return {
    engineRoot,
    contentRoot,
    postsDir,
    generatedDir: join(contentRoot, "generated"),
    distDir: join(contentRoot, "dist"),
    versionsJson: join(postsDir, "versions.json"),
    commonTermsPls: join(postsDir, "common-terms.pls"),
    generatedMapsDir,
    postMetaMap: join(generatedMapsDir, "postMeta.ts"),
    postVersionsMap: join(generatedMapsDir, "postVersions.ts"),
    postRoutesFile: join(generatedMapsDir, "postRoutes.ts"),
    automergeWasm: resolveAutomergeWasm(engineRoot),
  };
}
