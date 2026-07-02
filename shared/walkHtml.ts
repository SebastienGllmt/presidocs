// One declarative recursive `**/*.html` collector, replacing five hand-rolled
// readdir recursions the engine's own comments called mutual "mirrors" (each
// re-derived the `isDirectory()`/`isFile()`/`endsWith(".html")` branch and the
// `join(dir, name)` accumulation; three copy-pasted an ENOENT try/catch).
//
// Backed by `Bun.Glob` — a runtime built-in, zero dependency. Returns ABSOLUTE
// paths, **sorted**: Bun's glob does not promise lexicographic order, and four
// of the call sites depend on determinism, so the sort is applied here once.
// `onlyFiles` defaults true (matching the old `isFile()` filter) and `dot`
// defaults false.
//
// BUN-ONLY, BUILD/DEV-ONLY. Every caller runs under Bun at `generate` time or in
// the `bun --hot` dev server (`*.dev.ts` modules the prod Worker never imports;
// the Worker uses the pre-generated maps). `Bun.Glob` does not exist on the
// Cloudflare Worker or in a `client/` bundle — DO NOT import this from those
// paths. If a walker ever moves onto the Worker path it must drop back to
// `node:fs` (or `fs.glob` under `nodejs_compat`).
//
// ENOENT: `Bun.Glob.scanSync` THROWS when `dir` is missing (it does NOT yield
// empty — verified on Bun 1.3.14). The dev/strip walkers swallowed ENOENT and
// returned `[]`; pass `onMissing: "empty"` to reproduce that. The build-time
// generators (`generate-all`, `post-versions`) kept the throw — a missing
// `posts/` there is a real misconfiguration — so they use the default.

import { Glob } from "bun";

const HTML_GLOB = new Glob("**/*.html");
// `recursive: false` — top-level `*.html` only. Restores the exact behavior of
// the old non-recursive `postHtmlFiles` readdir walker for callers that scan a
// posts dir: source `posts/` is flat, and `dist/posts/` has `<slug>/figures/`
// subdirs whose (non-.html today) contents must NOT be swept into post auditing
// / markdown-export if a future artifact ever lands an .html there.
const HTML_GLOB_FLAT = new Glob("*.html");

/**
 * Absolute paths of every `*.html` under `dir`, sorted. Recursive by default;
 * pass `recursive: false` for top-level `*.html` only. Throws on a missing
 * `dir` unless `onMissing: "empty"` is passed (then returns `[]`).
 */
export function collectHtmlFiles(
  dir: string,
  opts: { onMissing?: "throw" | "empty"; recursive?: boolean } = {},
): string[] {
  const glob = opts.recursive === false ? HTML_GLOB_FLAT : HTML_GLOB;
  try {
    return [...glob.scanSync({ cwd: dir, absolute: true })].sort();
  } catch (err) {
    if (opts.onMissing === "empty" && (err as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
