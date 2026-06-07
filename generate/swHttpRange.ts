// Build-only helper: render shared/httpRange.ts as plain JS and splice it into
// client/sw.js at copy time, so the service worker shares the ONE RFC 7233
// range resolver the dev server (createDevServer.ts) and the prod Worker
// (createWorker.ts) already use, instead of carrying a third hand-rolled copy
// that drifts (it did — `bytes=-` resolved to 416 in the SW vs 200 in the
// shared module). See methodology.md → "Dev server HTTP range support".
//
// Bun-only (uses Bun.Transpiler) and build-time only — imported by
// generate/copy-static.ts and its test. MUST NOT be imported by any
// worker/browser-reachable module.

// Markers in client/sw.js delimiting the block copy-static replaces. The
// authored block between them is a faithful copy (kept readable + valid); the
// SHIPPED block is always regenerated from shared/httpRange.ts, so production
// can't drift. generate/swHttpRange.test.ts proves the spliced resolver behaves
// identically to the shared source.
export const HTTP_RANGE_START = "// __HTTP_RANGE_START__";
export const HTTP_RANGE_END = "// __HTTP_RANGE_END__";

// Transpile shared/httpRange.ts (TS) to plain JS and strip the ESM `export`
// keywords — sw.js is a classic worker served as-is (no module wrapping), so a
// bare `export` would be a syntax error. Comments + type annotations are erased
// by the transpiler.
export function renderHttpRangeForSw(httpRangeSource: string): string {
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(httpRangeSource);
  return js.replace(/^export\s+/gm, "").trim();
}

// Replace whatever sits between the two markers in sw.js with `renderedRangeJs`.
// Throws if the markers are missing or out of order, so a refactor that drops
// them fails the build loudly instead of silently shipping the stale authored
// copy.
export function spliceHttpRangeIntoSw(swText: string, renderedRangeJs: string): string {
  const s = swText.indexOf(HTTP_RANGE_START);
  const e = swText.indexOf(HTTP_RANGE_END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(
      `sw.js: missing or mis-ordered ${HTTP_RANGE_START} / ${HTTP_RANGE_END} markers`,
    );
  }
  const before = swText.slice(0, s + HTTP_RANGE_START.length);
  const after = swText.slice(e);
  return `${before}\n${renderedRangeJs}\n${after}`;
}
