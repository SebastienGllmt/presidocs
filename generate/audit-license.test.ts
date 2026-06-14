// Tests for the deploy-time license-declaration gate.

import { test, expect } from "bun:test";
import { checkLicenseGate } from "./audit-license.ts";

test("no SITE_URL → exempt (local/preview build, no friction)", () => {
  // Even with no license at all, an unpublished build passes clean.
  const r = checkLicenseGate({});
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("published build without CONTENT_LICENSE → hard error", () => {
  const r = checkLicenseGate({ SITE_URL: "https://blog.example.com" });
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toMatch(/CONTENT_LICENSE/);
});

test("published build with CONTENT_LICENSE but no CODE_LICENSE → warn, not fail", () => {
  const r = checkLicenseGate({
    SITE_URL: "https://blog.example.com",
    CONTENT_LICENSE: "CC-BY-4.0",
  });
  expect(r.errors).toEqual([]);
  expect(r.warnings.length).toBe(1);
  expect(r.warnings[0]).toMatch(/CODE_LICENSE/);
});

test("published build with both licenses → clean", () => {
  const r = checkLicenseGate({
    SITE_URL: "https://blog.example.com",
    CONTENT_LICENSE: "CC-BY-4.0",
    CODE_LICENSE: "MIT",
  });
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("a whitespace-only SITE_URL is treated as unpublished (exempt)", () => {
  expect(checkLicenseGate({ SITE_URL: "   " }).errors).toEqual([]);
});
