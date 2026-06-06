// Centralized HTTP security headers. See methodology.md → Deploy
// architecture → "HTTP security headers" for the full per-directive
// rationale; the load-bearing, non-obvious bits are commented inline here.
//
// Where this runs:
//   - PROD (worker.ts): wraps EVERY response — the API routes and the
//     `ASSETS.fetch` fall-through that serves the article HTML. This is the
//     authoritative place the document CSP takes effect, so verify the CSP
//     against `wrangler dev` / a deploy, NOT the Bun dev server.
//   - DEV (index.ts): wraps the function-style route handlers only. The two
//     HTMLBundle routes ("/" and the post) are served by Bun's bundler and
//     cannot be wrapped, so dev HTML carries no CSP. That's fine — and it's
//     also why we need no dev-relaxed `style-src`: Bun's HMR injects inline
//     styles only into those unwrapped HTML routes, so a tight `style-src`
//     never collides with HMR.

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

// sha256 of the cascade-layer-order inline <style>'s content
// (CSS_LAYER_ORDER_STATEMENT in shared/cssLayers.ts), base64 — the CSP hash
// that allows that one engine-emitted inline style under a no-'unsafe-inline'
// style-src. Hardcoded (no runtime crypto in workerd) and guarded against drift
// by securityHeaders.test.ts, which recomputes it from the constant.
const STYLE_LAYER_ORDER_HASH = "sha256-wmcq5f2L5SjOMdfmh0MPE8ZN1Aui78gc2GzM6aRHnf8=";

// Content-Security-Policy. Two directives are easy to get wrong:
//   - script-src needs 'wasm-unsafe-eval': Automerge instantiates its WASM
//     core from a fetched buffer (client/commentsStore.ts), which 'self'
//     alone does NOT permit. Omit it and the comment system dies under
//     enforcement.
//   - style-src has NO 'unsafe-inline'. Stylesheets are <link>ed, and the
//     client-side `.style.x =` writes are CSSOM (which CSP does not govern),
//     so they keep working. The ONE inline <style> we emit is the engine's
//     cascade-layer-order pin (shared/cssLayers.ts, injected first in <head>
//     by bunHtmlHeadPlugin) — a fixed, engine-controlled string. We allow it
//     by HASH, not 'unsafe-inline': maximally tight (this exact style and
//     nothing else). `STYLE_LAYER_ORDER_HASH` below is the sha256 of
//     CSS_LAYER_ORDER_STATEMENT; securityHeaders.test.ts recomputes it from
//     the constant and fails if they ever drift (e.g. a new layer is added).
const CSP_DIRECTIVES = [
  "default-src 'none'",
  "base-uri 'self'",
  // OAuth IdP origins are defensive only — the login is an anchor->302
  // navigation, which spec-compliant `form-action` does not govern (kept
  // for Safari's broader interpretation / a future POST form).
  "form-action 'self' https://accounts.google.com https://login.microsoftonline.com",
  "frame-ancestors 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  `style-src 'self' '${STYLE_LAYER_ORDER_HASH}'`,
  // Both the bare host and the wildcard: a CSP wildcard `*.host` matches
  // subdomains but NOT the bare host, and Graph's photo endpoint is the
  // bare `graph.microsoft.com`.
  "img-src 'self' https://lh3.googleusercontent.com https://graph.microsoft.com https://*.graph.microsoft.com",
  "font-src 'self'",
  // Same-origin XHRs (`/comments`, `/auth/me`, manifests) and the same-origin
  // analytics beacon (`navigator.sendBeacon('/_a', ...)`). No external
  // analytics origin — engagement analytics post to our own Worker route,
  // which writes to Cloudflare Analytics Engine server-side.
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  // Covers our same-origin Service Worker (`/sw.js`, loaded by
  // client/swRegister.ts — see methodology.md → Offline / PWA). No code
  // (ours or Shikwasa) constructs a dedicated Worker, so this stays tight —
  // no `blob:`. (Shikwasa's one `URL.createObjectURL(blob)` is ID3 cover-art,
  // an *image* governed by `img-src`; it's dormant because our ffmpeg mp3s
  // carry no embedded artwork. If that ever changes, add `blob:` to img-src,
  // not here.)
  "worker-src 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=(self)", // narrator dock plays audio from same-origin code
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=(self)", // Shikwasa full-screen
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=(self)", // audio PiP on Safari
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "web-share=()",
  "xr-spatial-tracking=()",
].join(", ");

export type SecurityHeaderOpts = {
  // Private (non-asset) responses — comments, /auth/me, /post-version —
  // get Cross-Origin-Resource-Policy: same-origin so a third-party page
  // can't load them as a cross-origin subresource. Not set on the article
  // HTML/JS/CSS/audio, where it isn't meaningful.
  private?: boolean;
};

export function securityHeaders(
  opts: SecurityHeaderOpts = {},
): Record<string, string> {
  // CSP_REPORT_ONLY lets the local verification pass run the exact
  // production policy in report-only mode without a code edit — violations
  // log to the console instead of blocking (see methodology.md → HTTP
  // security headers, "Verifying / iterating").
  const cspHeader = process.env.CSP_REPORT_ONLY
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  const headers: Record<string, string> = {
    [cspHeader]: CSP_DIRECTIVES,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    // Redundant with CSP `frame-ancestors 'none'` for modern browsers, but a
    // free fallback for any ancient UA that ignores CSP — clickjacking the
    // OAuth flow is a threat we explicitly defend.
    "X-Frame-Options": "DENY",
  };

  // HSTS only over real HTTPS (prod), gated like the Secure cookie flag.
  // Bare max-age on purpose: no includeSubDomains/preload until the
  // production hostname is confirmed (preload is browser-baked and
  // effectively irreversible — see methodology.md → HTTP security headers).
  if (isProd()) {
    headers["Strict-Transport-Security"] = "max-age=63072000";
  }

  if (opts.private) {
    headers["Cross-Origin-Resource-Policy"] = "same-origin";
  }

  return headers;
}

// Return a copy of `res` with the security headers set. We rebuild the
// Response because a Response returned from a fetch/handler may carry
// immutable headers.
export function withSecurityHeaders(
  res: Response,
  opts: SecurityHeaderOpts = {},
): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders(opts))) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
