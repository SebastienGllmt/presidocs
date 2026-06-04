import { test, expect } from "bun:test";
import { injectPwaHead } from "./injectPwaHead.ts";

const PAGE = "<!doctype html><html><head><title>t</title></head><body><main>hi</main></body></html>";

test("injectPwaHead — always links the engine-fixed manifest URL, inside <head>", () => {
  const out = injectPwaHead(PAGE);
  expect(out).toContain('<link class="pwa-manifest" rel="manifest" href="/manifest.webmanifest" />');
  // Injected into the head, before the body.
  expect(out.indexOf("pwa-manifest")).toBeLessThan(out.indexOf("<body"));
});

test("injectPwaHead — theme-color only when provided", () => {
  expect(injectPwaHead(PAGE)).not.toContain('name="theme-color"');
  const out = injectPwaHead(PAGE, { themeColor: "#0d1117" });
  expect(out).toContain('<meta name="theme-color" content="#0d1117" />');
});

test("injectPwaHead — apple-touch-icon only when provided (iOS ignores manifest icons)", () => {
  expect(injectPwaHead(PAGE)).not.toContain("apple-touch-icon");
  const out = injectPwaHead(PAGE, { appleTouchIcon: "/icons/icon-192.png" });
  expect(out).toContain('<link rel="apple-touch-icon" href="/icons/icon-192.png" />');
});

test("injectPwaHead — idempotent (re-run sees the pwa-manifest marker, skips)", () => {
  const once = injectPwaHead(PAGE, { themeColor: "#0d1117", appleTouchIcon: "/icons/icon-192.png" });
  const twice = injectPwaHead(once, { themeColor: "#0d1117", appleTouchIcon: "/icons/icon-192.png" });
  expect(twice).toBe(once);
  // Exactly one manifest link, even after a second pass.
  expect(once.match(/pwa-manifest/g)?.length).toBe(1);
});

test("injectPwaHead — escapes attribute values (no markup injection via opts)", () => {
  const out = injectPwaHead(PAGE, { themeColor: '"><script>', appleTouchIcon: "/a&b" });
  expect(out).toContain("&quot;&gt;&lt;script&gt;");
  expect(out).not.toContain('content=""><script>');
  expect(out).toContain("/a&amp;b");
});
