// Tests for the feed config — focused on the https-only guard for SITE_URL
// (the Podcasting 2.0 namespace requires https resource URLs in the feed).

import { test, expect } from "bun:test";
import { resolveFeedConfig } from "./feedConfig.ts";

test("https SITE_URL resolves, trailing slash stripped", () => {
  expect(resolveFeedConfig({ SITE_URL: "https://blog.example.com/" }).baseUrl).toBe(
    "https://blog.example.com",
  );
});

test("unset SITE_URL → null baseUrl (feeds skipped), no throw", () => {
  expect(resolveFeedConfig({}).baseUrl).toBeNull();
  expect(resolveFeedConfig({ SITE_URL: "" }).baseUrl).toBeNull();
});

test("http:// published origin is rejected (Podcasting 2.0 requires https)", () => {
  expect(() => resolveFeedConfig({ SITE_URL: "http://blog.example.com" })).toThrow(/https/);
});

test("http loopback is allowed (local dev, never published)", () => {
  expect(resolveFeedConfig({ SITE_URL: "http://localhost:3000" }).baseUrl).toBe(
    "http://localhost:3000",
  );
  expect(resolveFeedConfig({ SITE_URL: "http://127.0.0.1:8788" }).baseUrl).toBe(
    "http://127.0.0.1:8788",
  );
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  expect(resolveFeedConfig({ SITE_URL: "http://127.0.0.2:8788" }).baseUrl).toBe(
    "http://127.0.0.2:8788",
  );
});

test("a non-loopback host that merely starts with 127 is NOT exempt", () => {
  expect(() => resolveFeedConfig({ SITE_URL: "http://127.example.com" })).toThrow(/https/);
});

test("locked defaults to yes (true); only an explicit 'no' opts out", () => {
  expect(resolveFeedConfig({}).locked).toBe(true);
  expect(resolveFeedConfig({ PODCAST_LOCKED: "yes" }).locked).toBe(true);
  expect(resolveFeedConfig({ PODCAST_LOCKED: "no" }).locked).toBe(false);
  expect(resolveFeedConfig({ PODCAST_LOCKED: "NO" }).locked).toBe(false); // case-insensitive
});

test("license + licenseUrl are opt-in (null unless set)", () => {
  expect(resolveFeedConfig({}).license).toBeNull();
  expect(resolveFeedConfig({}).licenseUrl).toBeNull();
  const wellKnown = resolveFeedConfig({ PODCAST_LICENSE: "CC-BY-4.0" });
  expect(wellKnown.license).toBe("CC-BY-4.0");
  expect(wellKnown.licenseUrl).toBeNull();
  const custom = resolveFeedConfig({
    PODCAST_LICENSE: "my-blog-license-v1",
    PODCAST_LICENSE_URL: "https://example.org/license.pdf",
  });
  expect(custom.licenseUrl).toBe("https://example.org/license.pdf");
});
