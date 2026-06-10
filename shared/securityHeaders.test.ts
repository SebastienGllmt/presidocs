// Tests for the security-header layer. These are deliberately
// regression-focused: the two failure modes that are easy to introduce and
// painful to notice in prod are (a) dropping `'wasm-unsafe-eval'` from
// script-src (silently breaks the Automerge-backed comment system) and
// (b) reintroducing `'unsafe-inline'` to style-src (defeats the CSP's XSS
// hardening). Both are asserted explicitly below.
//
// `securityHeaders()` reads NODE_ENV / CSP_REPORT_ONLY at call time, so we
// snapshot and restore those env vars around each test.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { securityHeaders, withNoindexOffCanonicalHost, withSecurityHeaders } from "./securityHeaders.ts";

const ENV_KEYS = ["NODE_ENV", "CSP_REPORT_ONLY"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Default to a non-prod, enforcing baseline; individual tests override.
  delete process.env.NODE_ENV;
  delete process.env.CSP_REPORT_ONLY;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// Pull the value of a single CSP directive (e.g. "script-src") out of the
// joined policy string so assertions don't depend on directive ordering.
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

function cspOf(h: Record<string, string>): string {
  const v = h["Content-Security-Policy"] ?? h["Content-Security-Policy-Report-Only"];
  if (!v) throw new Error("no CSP header present");
  return v;
}

// ---- CSP content -------------------------------------------------------

test("script-src carries 'wasm-unsafe-eval' (Automerge WASM would break without it)", () => {
  const scriptSrc = directive(cspOf(securityHeaders()), "script-src");
  expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  expect(scriptSrc).toContain("'self'");
});

test("style-src is 'self' + the layer-order hash — no 'unsafe-inline'", () => {
  const styleSrc = directive(cspOf(securityHeaders()), "style-src")!;
  expect(styleSrc).toContain("'self'");
  // The ONLY relaxation is the sha256 of the engine's cascade-layer-order
  // inline <style>; 'unsafe-inline' must never reappear (it would defeat the
  // CSP's XSS hardening — the whole reason we hash instead).
  expect(styleSrc).toContain("'sha256-");
  expect(cspOf(securityHeaders())).not.toContain("'unsafe-inline'");
});

test("style-src layer-order hash matches CSS_LAYER_ORDER_STATEMENT (drift guard)", async () => {
  // The hardcoded hash in securityHeaders.ts must equal the sha256 of the
  // actual injected style. If a layer is ever added/renamed in cssLayers.ts,
  // the statement changes, this recomputed hash changes, and this test fails —
  // forcing the hash (and the allowance) to be regenerated in lockstep.
  const { CSS_LAYER_ORDER_STATEMENT } = await import("./cssLayers.ts");
  const { createHash } = await import("node:crypto");
  const want = "sha256-" + createHash("sha256").update(CSS_LAYER_ORDER_STATEMENT).digest("base64");
  const styleSrc = directive(cspOf(securityHeaders()), "style-src")!;
  expect(styleSrc).toContain(`'${want}'`);
});

test("deny-all defaults are present", () => {
  const csp = cspOf(securityHeaders());
  expect(directive(csp, "default-src")).toBe("default-src 'none'");
  expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
  expect(directive(csp, "object-src")).toBe("object-src 'none'");
});

test("worker-src is tight — no blob: (nothing constructs a Worker)", () => {
  // blob: workers are a known CSP-bypass primitive; keep it out unless a
  // real Worker appears. The Shikwasa blob is cover-art (img-src), not here.
  expect(directive(cspOf(securityHeaders()), "worker-src")).toBe("worker-src 'self'");
});

test("img-src allows both the bare Graph host and the wildcard", () => {
  const imgSrc = directive(cspOf(securityHeaders()), "img-src")!;
  // A CSP wildcard `*.host` does NOT match the bare host, so both are needed.
  expect(imgSrc).toContain(" https://graph.microsoft.com");
  expect(imgSrc).toContain("https://*.graph.microsoft.com");
  expect(imgSrc).toContain("https://lh3.googleusercontent.com");
});

test("no cross-origin analytics endpoints in CSP (engagement analytics ride /_a same-origin)", () => {
  // We dropped CF_ANALYTICS_TOKEN/static.cloudflareinsights.com when the
  // engagement-analytics path moved server-side. Posting to a fresh external
  // analytics origin would re-relax the structural check; assert the
  // directives stay tight to 'self'.
  const csp = cspOf(securityHeaders());
  expect(csp).not.toContain("cloudflareinsights.com");
  expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
  expect(directive(csp, "script-src")).toBe("script-src 'self' 'wasm-unsafe-eval'");
});

// ---- HSTS (prod-gated, bare max-age) -----------------------------------

test("HSTS is absent outside production", () => {
  expect(securityHeaders()).not.toHaveProperty("Strict-Transport-Security");
});

test("HSTS in production is bare max-age — no includeSubDomains/preload", () => {
  process.env.NODE_ENV = "production";
  const hsts = securityHeaders()["Strict-Transport-Security"];
  expect(hsts).toBe("max-age=63072000");
  expect(hsts).not.toContain("includeSubDomains");
  expect(hsts).not.toContain("preload");
});

// ---- CORP (private responses only) -------------------------------------

test("CORP is set only on private responses", () => {
  expect(securityHeaders()).not.toHaveProperty("Cross-Origin-Resource-Policy");
  expect(securityHeaders({ private: true })["Cross-Origin-Resource-Policy"]).toBe(
    "same-origin",
  );
});

// ---- Always-on headers -------------------------------------------------

test("the unconditional headers are always present", () => {
  const h = securityHeaders();
  expect(h["X-Content-Type-Options"]).toBe("nosniff");
  expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  expect(h["X-Frame-Options"]).toBe("DENY");
  expect(h["Permissions-Policy"]).toContain("autoplay=(self)");
});

// ---- report-only toggle ------------------------------------------------

test("CSP_REPORT_ONLY swaps the header name and drops the enforcing one", () => {
  process.env.CSP_REPORT_ONLY = "1";
  const h = securityHeaders();
  expect(h).toHaveProperty("Content-Security-Policy-Report-Only");
  expect(h).not.toHaveProperty("Content-Security-Policy");
});

// ---- withSecurityHeaders wrapper ---------------------------------------

test("withSecurityHeaders preserves status/body and sets headers", async () => {
  const res = withSecurityHeaders(
    new Response("hello", { status: 201, statusText: "Created" }),
  );
  expect(res.status).toBe(201);
  expect(res.statusText).toBe("Created");
  expect(await res.text()).toBe("hello");
  expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  expect(res.headers.get("Cross-Origin-Resource-Policy")).toBeNull();
});

test("withSecurityHeaders adds CORP when private", () => {
  const res = withSecurityHeaders(new Response("x"), { private: true });
  expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
});

test("withSecurityHeaders works on a response with immutable headers (302 redirect)", () => {
  // Response.redirect() yields an immutable-headers response — the exact
  // shape of the OAuth login/callback redirects. The wrapper must not throw
  // and must preserve the Location header.
  const res = withSecurityHeaders(Response.redirect("https://accounts.google.com/x", 302));
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://accounts.google.com/x");
  expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
});

test("withNoindexOffCanonicalHost: noindex only off the canonical host, only when a host is known", () => {
  const req = (url: string) => new Request(url);
  const fresh = () => withSecurityHeaders(new Response("x"));
  // Preview/staging host ≠ canonical → noindex.
  const preview = withNoindexOffCanonicalHost(req("https://preview.example.dev/"), fresh(), "blog.example.com");
  expect(preview.headers.get("X-Robots-Tag")).toBe("noindex");
  // The canonical host itself → untouched.
  const canonical = withNoindexOffCanonicalHost(req("https://blog.example.com/posts/x"), fresh(), "blog.example.com");
  expect(canonical.headers.get("X-Robots-Tag")).toBeNull();
  // No baked canonical host (SITE_URL-less build) → untouched anywhere.
  const ungated = withNoindexOffCanonicalHost(req("https://anywhere.dev/"), fresh(), null);
  expect(ungated.headers.get("X-Robots-Tag")).toBeNull();
  // Host compare includes the port (localhost:3000 ≠ localhost:4000 hosting matters).
  const port = withNoindexOffCanonicalHost(req("http://localhost:3000/"), fresh(), "localhost:3000");
  expect(port.headers.get("X-Robots-Tag")).toBeNull();
});

test("withNoindexOffCanonicalHost: a private blog noindexes everywhere, canonical host included", () => {
  const fresh = () => withSecurityHeaders(new Response("x"));
  const onHost = withNoindexOffCanonicalHost(
    new Request("https://blog.example.com/posts/x--Vq3xW8tR4hZcNdP5"), fresh(), "blog.example.com", true,
  );
  expect(onHost.headers.get("X-Robots-Tag")).toBe("noindex");
  // Even with no baked canonical host: private wins on its own.
  const noHost = withNoindexOffCanonicalHost(new Request("http://localhost:3000/"), fresh(), null, true);
  expect(noHost.headers.get("X-Robots-Tag")).toBe("noindex");
});
