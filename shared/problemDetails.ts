// RFC 9457 Problem Details builder. Single point where the response
// content-type and JSON shape are decided, so adding/renaming a problem
// type is a one-file change and the wire format can't drift between
// handlers. See methodology.md → "HTTP error responses" and the local
// RFC mirror at specs/ProblemDetails-spec.html.

export type ProblemSlug =
  | "auth/unauthenticated"
  | "auth/forbidden"
  | "auth/misconfigured"
  | "auth/oauth-provider-error"
  | "auth/callback-invalid"
  | "auth/userinfo-unavailable"
  | "request/missing-parameter"
  | "request/empty-body"
  | "rate-limit/exceeded"
  | "comments/change-too-large"
  | "resolutions/resolution-too-large";

// RFC 9457 §3.1.3: title is constant per type. detail (§3.1.4) is the
// only freeform per-call field; consumers SHOULD NOT parse it for
// information — that's what extensions are for.
const TITLES: Record<ProblemSlug, string> = {
  "auth/unauthenticated": "Authentication required",
  "auth/forbidden": "Forbidden",
  "auth/misconfigured": "Authentication is misconfigured",
  "auth/oauth-provider-error": "OAuth provider reported an error",
  "auth/callback-invalid": "OAuth callback was rejected",
  "auth/userinfo-unavailable": "Could not load user info from provider",
  "request/missing-parameter": "Missing required query parameter",
  "request/empty-body": "Request body required",
  "rate-limit/exceeded": "Rate limit exceeded",
  "comments/change-too-large": "Change object exceeds size limit",
  "resolutions/resolution-too-large": "Resolution body exceeds size limit",
};

// Per RFC 9457 §4.1, type URIs SHOULD be stable and under our control.
// Resolution chain, in priority order:
//   1. PROBLEM_BASE_URL — explicit override (e.g. a vendored docs path
//      that differs from the site origin).
//   2. SITE_URL + "/probs" — the canonical site origin a content repo
//      already configures for feeds + structured data. Reusing it
//      means the operator sets one origin var instead of two, and the
//      problem URIs land under a domain we provably control.
//   3. blog.example.com fallback — IANA-reserved for documentation
//      (RFC 2606), explicitly NOT under our control. Exists only so
//      a fresh dev loop isn't a crash; loud warn-once below.
//
// `typeof process` guard: this module is also imported from the
// client, where `process` isn't defined.
const FALLBACK_BASE = "https://blog.example.com/probs";

function readEnv(name: string): string | null {
  if (typeof process === "undefined") return null;
  const v = process.env?.[name];
  return v ? v : null;
}

// Pure resolver — exported for tests. Returns { base, usingFallback }.
// usingFallback drives the warn-once.
export function resolveProblemBase(env: {
  PROBLEM_BASE_URL?: string | null;
  SITE_URL?: string | null;
}): { base: string; usingFallback: boolean } {
  const explicit = env.PROBLEM_BASE_URL || null;
  if (explicit) return { base: explicit, usingFallback: false };
  const site = env.SITE_URL || null;
  if (site) {
    const trimmed = site.endsWith("/") ? site.slice(0, -1) : site;
    return { base: `${trimmed}/probs`, usingFallback: false };
  }
  return { base: FALLBACK_BASE, usingFallback: true };
}

const { base: BASE, usingFallback: USING_FALLBACK } = resolveProblemBase({
  PROBLEM_BASE_URL: readEnv("PROBLEM_BASE_URL"),
  SITE_URL: readEnv("SITE_URL"),
});

let warnedFallback = false;
function warnFallbackOnce(): void {
  if (warnedFallback || !USING_FALLBACK) return;
  warnedFallback = true;
  // eslint-disable-next-line no-console
  console.warn(
    "Neither PROBLEM_BASE_URL nor SITE_URL is set; emitting RFC 9457 " +
      `type URIs under ${FALLBACK_BASE} (IANA-reserved documentation ` +
      "domain). Set one of them in the deploy environment to anchor " +
      "the URIs under your origin.",
  );
}

// Maximum problem-details body the client will buffer. Our own
// problem bodies are <500B (the worst case is comments/change-too-large
// with maxBytes+actualBytes extensions); 64 KB is a generous cap that
// keeps a hostile/misbehaving intermediary from OOMing a tab via a
// pathological body. Per §5 — defensive parsing of generator output.
const MAX_PROBLEM_BODY_BYTES = 64 * 1024;

// RFC 9110 §10.2.3 — Retry-After in delta-seconds. The Worker rate
// limiter's window. Exporting so call sites can also reference a
// single source of truth; if wrangler.toml's `period` ever changes,
// this constant changes with it.
export const RATE_LIMIT_WINDOW_SECONDS = 60;

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  // Extension members. Per RFC 9457 §3.2, consumers MUST ignore
  // extensions they don't recognise — so adding fields here is
  // backwards-compatible.
  [k: string]: unknown;
};

// `about:blank` is the spec's sentinel for "no problem type beyond the
// status code" (§4.2.1). The title for about:blank SHOULD be the HTTP
// reason phrase; the table covers the codes we actually emit.
const STATUS_PHRASE: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  416: "Range Not Satisfiable",
};

export function problem(
  status: number,
  slug: ProblemSlug | "about:blank",
  detail?: string,
  extensions?: Record<string, unknown>,
): Response {
  if (slug !== "about:blank") warnFallbackOnce();
  const type = slug === "about:blank" ? "about:blank" : `${BASE}/${slug}`;
  const title =
    slug === "about:blank"
      ? STATUS_PHRASE[status] ?? `HTTP ${status}`
      : TITLES[slug];
  // Spread extensions FIRST so the core members (type/title/status,
  // detail) always win. Without this, an extension like
  // `{ status: 999 }` would overwrite the body's status and violate
  // RFC 9457 §3.1.2's MUST that body status matches wire status.
  // The dedicated `detail` parameter is the only sanctioned writer:
  // an extension that also names `detail` is dropped, since the
  // caller's `detail` arg (even when undefined) is authoritative.
  // `instance` is NOT reserved — callers may supply it via the
  // extension bag (§3.1.5 makes it a normal spec member, but the
  // helper exposes no dedicated parameter for it).
  const body: ProblemDetails = { ...extensions, type, title, status };
  if (detail !== undefined) body.detail = detail;
  else delete body.detail;
  const headers: Record<string, string> = {
    "Content-Type": "application/problem+json",
  };
  // Per RFC 9457 §4 + RFC 9110 §10.2.3: problem-type definitions may
  // pair with Retry-After. Use the shared constant so the header and
  // any body extension can't disagree.
  if (slug === "rate-limit/exceeded") {
    headers["Retry-After"] = String(RATE_LIMIT_WINDOW_SECONDS);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// Client-side parser. Returns null for non-problem responses so callers
// can fall back to `${status} ${statusText}` for legacy / out-of-scope
// surfaces (e.g. the static-asset 404s in createDevServer / the
// dev-only routes).
//
// Defensive against pathological generators (§5):
//   - Strict media-type match (split on `;`, ignore parameters but
//     don't substring-match — so `text/plain; note="application/problem+json"`
//     is rejected).
//   - Body buffered with a size cap. If Content-Length advertises >cap,
//     skip entirely. Otherwise read into a bounded buffer.
export async function parseProblem(
  res: Response,
): Promise<ProblemDetails | null> {
  if (!isProblemMediaType(res.headers.get("content-type"))) return null;
  const cl = res.headers.get("content-length");
  if (cl !== null && Number(cl) > MAX_PROBLEM_BODY_BYTES) return null;
  try {
    const text = await readBoundedText(res);
    if (text === null) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ProblemDetails;
  } catch {
    return null;
  }
}

function isProblemMediaType(raw: string | null): boolean {
  if (!raw) return false;
  // Media type per RFC 9110 §8.3.1: type/subtype followed by optional
  // params. Take just the type/subtype, lowercase, equality-check.
  const head = raw.split(";", 1)[0]?.trim().toLowerCase();
  return head === "application/problem+json";
}

async function readBoundedText(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body — fall back to text() which still respects the
    // earlier Content-Length pre-check.
    const t = await res.text();
    return t.length > MAX_PROBLEM_BODY_BYTES ? null : t;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > MAX_PROBLEM_BODY_BYTES) {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}
