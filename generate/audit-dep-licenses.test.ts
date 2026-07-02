import { expect, test } from "bun:test";
import {
  ALLOWED_LICENSES,
  evaluateLicenses,
  isPermissiveLicense,
  licenseTokens,
} from "./audit-dep-licenses.ts";
import type { DepLicense } from "./licenseFiles.ts";

// Note the `in` checks: an explicitly-passed `null` must override the default
// (a plain `?? "LICENSE TEXT"` would resurrect the default from null).
function dep(
  name: string,
  license: string,
  extra: Partial<DepLicense> = {},
): DepLicense {
  return {
    name,
    version: "1.0.0",
    license,
    licenseText:
      "licenseText" in extra ? (extra.licenseText ?? null) : "LICENSE TEXT",
    noticeText: "noticeText" in extra ? (extra.noticeText ?? null) : null,
    supplement: "supplement" in extra ? (extra.supplement ?? null) : null,
    homepage: null,
  };
}

test("licenseTokens — splits compound AND/OR/WITH and parens into atomic ids", () => {
  expect(licenseTokens("MIT")).toEqual(["MIT"]);
  expect(licenseTokens("(CC-BY-4.0 AND OFL-1.1 AND MIT)")).toEqual([
    "CC-BY-4.0",
    "OFL-1.1",
    "MIT",
  ]);
  expect(licenseTokens("Apache-2.0 OR MIT")).toEqual(["Apache-2.0", "MIT"]);
  expect(licenseTokens("")).toEqual([]);
});

test("isPermissiveLicense — allowlisted ids, the fontawesome compound, and rejections", () => {
  expect(isPermissiveLicense("MIT")).toBe(true);
  expect(isPermissiveLicense("Apache-2.0")).toBe(true);
  expect(isPermissiveLicense("(CC-BY-4.0 AND OFL-1.1 AND MIT)")).toBe(true);
  // A copyleft / unknown id anywhere in the expression fails.
  expect(isPermissiveLicense("GPL-3.0-only")).toBe(false);
  expect(isPermissiveLicense("MIT AND GPL-3.0-only")).toBe(false);
  // gsap's descriptive string is not an SPDX id → not permissive (it's waived instead).
  expect(
    isPermissiveLicense(
      "Standard 'no charge' license: https://gsap.com/standard-license.",
    ),
  ).toBe(false);
  expect(isPermissiveLicense("")).toBe(false);
});

test("evaluateLicenses — permissive deps with notices all pass", () => {
  const { ok, waived, blocking } = evaluateLicenses([
    dep("zod", "MIT"),
    dep("text-fragments-polyfill", "Apache-2.0"),
    dep("@fortawesome/fontawesome-free", "(CC-BY-4.0 AND OFL-1.1 AND MIT)"),
  ]);
  expect(ok.map((d) => d.name).sort()).toEqual([
    "@fortawesome/fontawesome-free",
    "text-fragments-polyfill",
    "zod",
  ]);
  expect(waived).toHaveLength(0);
  expect(blocking).toHaveLength(0);
});

test("evaluateLicenses — gsap's non-OSS license is waived (with its supplement as notice)", () => {
  const { ok, waived, blocking } = evaluateLicenses([
    dep(
      "gsap",
      "Standard 'no charge' license: https://gsap.com/standard-license.",
      {
        licenseText: null,
        supplement:
          "GreenSock custom license — terms at https://gsap.com/standard-license/",
      },
    ),
  ]);
  expect(ok).toHaveLength(0);
  expect(waived.map((d) => d.name)).toEqual(["gsap"]);
  expect(blocking).toHaveLength(0);
});

test("evaluateLicenses — a non-permissive, UNwaived license blocks the deploy", () => {
  const { blocking } = evaluateLicenses([dep("evil", "GPL-3.0-only")]);
  expect(blocking).toHaveLength(1);
  expect(blocking[0]!.name).toBe("evil");
  expect(blocking[0]!.reason).toContain("non-permissive");
});

test("evaluateLicenses — a permissive dep with NO reproducible notice blocks", () => {
  // MIT but ships no LICENSE file and isn't a curated supplement → we can't
  // reproduce the required notice, so we must not ship it silently.
  const { blocking } = evaluateLicenses([
    dep("naked", "MIT", { licenseText: null, supplement: null }),
  ]);
  expect(blocking).toHaveLength(1);
  expect(blocking[0]!.reason).toContain("no license notice");
});

test("evaluateLicenses — a waived dep STILL needs a notice (supplement); none → blocks", () => {
  const { blocking, waived } = evaluateLicenses([
    dep("gsap", "Standard 'no charge' license", {
      licenseText: null,
      supplement: null,
    }),
  ]);
  expect(waived).toHaveLength(0);
  expect(blocking).toHaveLength(1);
  expect(blocking[0]!.reason).toContain("no license notice");
});

test("ALLOWED_LICENSES — is notice-only (no copyleft leaked in)", () => {
  for (const lic of ALLOWED_LICENSES) {
    expect(lic).not.toMatch(/GPL|MPL|EUPL|CDDL/i);
  }
});
