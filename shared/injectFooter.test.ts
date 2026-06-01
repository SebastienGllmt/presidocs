import { test, expect } from "bun:test";
import { injectSiteFooter } from "./injectFooter.ts";

const PAGE = "<!doctype html><html><head></head><body><main>hi</main></body></html>";

test("injectSiteFooter — both links: Home, help, privacy in order", () => {
  const out = injectSiteFooter(PAGE, { privacyHref: "/privacy", helpHref: "/help" });
  expect(out).toContain('<footer class="site-footer">');
  expect(out).toContain('<a href="/">Home</a>');
  expect(out).toContain('<a href="/help">How this blog works</a>');
  expect(out).toContain('<a href="/privacy">Privacy Policy</a>');
  // Order: Home → Help → Privacy.
  const home = out.indexOf(">Home<");
  const help = out.indexOf(">How this blog works<");
  const priv = out.indexOf(">Privacy Policy<");
  expect(home).toBeLessThan(help);
  expect(help).toBeLessThan(priv);
});

test("injectSiteFooter — privacy only (no SITE_URL): no help link", () => {
  const out = injectSiteFooter(PAGE, { privacyHref: "/privacy" });
  expect(out).toContain('<a href="/privacy">Privacy Policy</a>');
  expect(out).not.toContain("How this blog works");
  // Home still present so the footer isn't a lone privacy link.
  expect(out).toContain('<a href="/">Home</a>');
});

test("injectSiteFooter — help only (no PRIVACY_POLICY_URL): no privacy link", () => {
  const out = injectSiteFooter(PAGE, { helpHref: "/help" });
  expect(out).toContain('<a href="/help">How this blog works</a>');
  expect(out).not.toContain("Privacy Policy");
});

test("injectSiteFooter — neither link → no-op (a lone Home link is noise)", () => {
  expect(injectSiteFooter(PAGE, {})).toBe(PAGE);
  expect(injectSiteFooter(PAGE, { privacyHref: "  ", helpHref: "" })).toBe(PAGE);
});

test("injectSiteFooter — idempotent (re-run sees site-footer marker, skips)", () => {
  const once = injectSiteFooter(PAGE, { privacyHref: "/privacy", helpHref: "/help" });
  const twice = injectSiteFooter(once, { privacyHref: "/privacy", helpHref: "/help" });
  expect(twice).toBe(once);
  expect((twice.match(/site-footer/g) ?? []).length).toBe(1);
});

test("injectSiteFooter — escapes the privacy href", () => {
  const out = injectSiteFooter(PAGE, { privacyHref: '/p"><script>x' });
  expect(out).not.toContain('"><script>');
  expect(out).toContain("&quot;");
});
