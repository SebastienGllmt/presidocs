// Tests for the license config — the opt-in posture, canonical-URL resolution,
// and the explicit-URL-wins rule. The PODCAST_LICENSE inheritance that consumes
// this lives in feedConfig.test.ts.

import { test, expect } from "bun:test";
import { resolveLicenseConfig } from "./licenseConfig.ts";

test("unset → both null (surfaces omit the license, no imposed default)", () => {
  const cfg = resolveLicenseConfig({});
  expect(cfg.content).toBeNull();
  expect(cfg.code).toBeNull();
});

test("well-known ids resolve their canonical URL without an explicit _URL", () => {
  const cfg = resolveLicenseConfig({ CONTENT_LICENSE: "CC-BY-4.0", CODE_LICENSE: "MIT" });
  expect(cfg.content).toEqual({
    id: "CC-BY-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
  });
  expect(cfg.code).toEqual({ id: "MIT", url: "https://opensource.org/license/mit" });
});

test("an explicit _URL wins over the canonical lookup", () => {
  const cfg = resolveLicenseConfig({
    CONTENT_LICENSE: "CC-BY-4.0",
    CONTENT_LICENSE_URL: "https://example.org/my-cc-by.html",
  });
  expect(cfg.content?.url).toBe("https://example.org/my-cc-by.html");
});

test("a custom/unknown id falls back to the uniform SPDX page", () => {
  const cfg = resolveLicenseConfig({ CODE_LICENSE: "BlueOak-1.0.0" });
  expect(cfg.code).toEqual({
    id: "BlueOak-1.0.0",
    url: "https://spdx.org/licenses/BlueOak-1.0.0.html",
  });
});

test("content and code are independent knobs", () => {
  const cfg = resolveLicenseConfig({ CONTENT_LICENSE: "CC-BY-4.0" });
  expect(cfg.content?.id).toBe("CC-BY-4.0");
  expect(cfg.code).toBeNull();
});

test("whitespace-only values are treated as unset", () => {
  const cfg = resolveLicenseConfig({ CONTENT_LICENSE: "   ", CODE_LICENSE: "" });
  expect(cfg.content).toBeNull();
  expect(cfg.code).toBeNull();
});
