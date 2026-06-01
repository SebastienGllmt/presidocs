// HTTP Range request parsing — one source of truth for the dev server's
// `serveFromDir` (createDevServer.ts) and the prod Worker's `applyRangeSupport`
// (createWorker.ts). Both used to hand-maintain near-identical parsers; this
// module replaces both. See methodology.md → "Dev server HTTP range support"
// for the audio-seek reason this exists at all.
//
// Pure: takes a header string and a size, returns a verdict. The caller
// decides how to slice (Bun.file in dev, a buffered Uint8Array in prod) and
// how to wrap the response.

export type RangeOutcome =
  // No Range header, header is unparseable, or size is 0 — serve the full
  // resource as 200 (callers should still advertise `Accept-Ranges: bytes`).
  | { kind: "none" }
  // The request can be satisfied: emit 206 with `Content-Range: bytes
  // start-end/size` and slice [start, end] inclusive.
  | { kind: "satisfiable"; start: number; end: number; size: number }
  // The request asks for bytes outside the resource: emit 416 with
  // `Content-Range: bytes */size`.
  | { kind: "unsatisfiable"; size: number };

// RFC 7233 single-range requests of the form `bytes=N-M`, `bytes=N-`, or
// `bytes=-N` (the suffix form, "last N bytes"). Multi-range (`bytes=N-M,P-Q`)
// is rare in practice and supported by neither prior implementation, so it
// stays unsupported here too — the caller's behaviour on a no-match parse is
// to return the full resource, which is a spec-compliant fallback.
const SINGLE_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

// True iff the header is a Range header `resolveRange` will produce a
// satisfiable/unsatisfiable verdict for (i.e. not `none`). Useful as a
// pre-buffer check in the prod path, where the caller wants to skip
// `await res.arrayBuffer()` for requests it can't slice anyway.
export function isResolvableRangeHeader(header: string | null): boolean {
  if (!header) return false;
  return SINGLE_RANGE_RE.test(header.trim());
}

export function resolveRange(
  rangeHeader: string | null,
  size: number,
): RangeOutcome {
  if (!rangeHeader || size <= 0) return { kind: "none" };
  const m = SINGLE_RANGE_RE.exec(rangeHeader.trim());
  if (!m) return { kind: "none" };
  let start = m[1] === "" ? NaN : Number(m[1]);
  let end = m[2] === "" ? NaN : Number(m[2]);
  if (Number.isNaN(start)) {
    // suffix range `bytes=-N`: the last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) {
    return { kind: "unsatisfiable", size };
  }
  end = Math.min(end, size - 1);
  return { kind: "satisfiable", start, end, size };
}

// `Content-Range` value for a successful (206) response.
export function contentRangeHeader(
  start: number,
  end: number,
  size: number,
): string {
  return `bytes ${start}-${end}/${size}`;
}

// `Content-Range` value for an unsatisfiable (416) response.
export function unsatisfiedRangeHeader(size: number): string {
  return `bytes */${size}`;
}
