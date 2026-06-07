import { test, expect } from "bun:test";
import { evaluateAuditReport, ghsaFromUrl, type AuditReport } from "./audit-deps.ts";

// One advisory, shaped exactly like a `bun audit --json` row.
const adv = (severity: string, ghsa: string, title = "some vuln") => ({
  url: `https://github.com/advisories/${ghsa}`,
  title,
  severity,
  vulnerable_versions: "<1.0.0",
  cwe: ["CWE-1321"],
  cvss: { score: 7.4, vectorString: "CVSS:3.1/…" },
});

test("a clean report ({}) yields no findings", () => {
  const e = evaluateAuditReport({});
  expect(e.blocking).toEqual([]);
  expect(e.waived).toEqual([]);
  expect(e.belowThreshold).toEqual([]);
});

test("high/critical advisories block at the default floor", () => {
  const report: AuditReport = {
    jose: [adv("high", "GHSA-aaaa-bbbb-cccc")],
    arctic: [adv("critical", "GHSA-dddd-eeee-ffff")],
  };
  const e = evaluateAuditReport(report);
  expect(e.blocking.map((f) => f.pkg).sort()).toEqual(["arctic", "jose"]);
  expect(e.belowThreshold).toEqual([]);
});

test("low/moderate advisories are below the floor, not blocking", () => {
  const report: AuditReport = {
    turndown: [adv("low", "GHSA-1111-2222-3333"), adv("moderate", "GHSA-4444-5555-6666")],
  };
  const e = evaluateAuditReport(report);
  expect(e.blocking).toEqual([]);
  expect(e.belowThreshold.map((f) => f.severity).sort()).toEqual(["low", "moderate"]);
});

test("a tighter floor promotes moderate to blocking", () => {
  const report: AuditReport = { turndown: [adv("moderate", "GHSA-4444-5555-6666")] };
  expect(evaluateAuditReport(report, { gate: "moderate" }).blocking).toHaveLength(1);
  expect(evaluateAuditReport(report, { gate: "high" }).blocking).toHaveLength(0);
});

test("a waived high advisory is reported but does not block", () => {
  const report: AuditReport = { jose: [adv("high", "GHSA-aaaa-bbbb-cccc")] };
  const e = evaluateAuditReport(report, {
    waived: { "GHSA-aaaa-bbbb-cccc": { reason: "sink unreachable", reviewed: "2026-06-08" } },
  });
  expect(e.blocking).toEqual([]);
  expect(e.waived.map((f) => f.ghsa)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
});

test("a waiver only applies at/above the floor — below-floor stays informational", () => {
  // A waiver for a moderate advisory is moot under the high floor: it's already
  // below-threshold (informational), never waived.
  const report: AuditReport = { turndown: [adv("moderate", "GHSA-4444-5555-6666")] };
  const e = evaluateAuditReport(report, {
    waived: { "GHSA-4444-5555-6666": { reason: "x", reviewed: "2026-06-08" } },
  });
  expect(e.waived).toEqual([]);
  expect(e.belowThreshold).toHaveLength(1);
});

test("malformed input is tolerated (defensive against npm's schema)", () => {
  expect(evaluateAuditReport(null).blocking).toEqual([]);
  expect(evaluateAuditReport("not an object" as unknown).blocking).toEqual([]);
  // package value isn't an array, advisory isn't an object, unknown severity
  expect(evaluateAuditReport({ pkg: "nope" } as unknown).blocking).toEqual([]);
  expect(evaluateAuditReport({ pkg: [null, 42] } as unknown).blocking).toEqual([]);
  expect(
    evaluateAuditReport({ pkg: [{ severity: "spicy", url: "x", title: "t" }] }).blocking,
  ).toEqual([]);
});

test("an advisory with no GHSA url can never be silently waived", () => {
  // No GHSA id → no waiver key can match → it always blocks (if at/above floor).
  const report = { pkg: [{ severity: "high", title: "t", url: "https://example.com/x" }] };
  const e = evaluateAuditReport(report, { waived: { "": { reason: "x", reviewed: "y" } } });
  expect(e.blocking).toHaveLength(1);
  expect(e.waived).toEqual([]);
});

test("ghsaFromUrl extracts the id, tolerates absence", () => {
  expect(ghsaFromUrl("https://github.com/advisories/GHSA-fvqr-27wr-82fm")).toBe(
    "GHSA-fvqr-27wr-82fm",
  );
  expect(ghsaFromUrl("https://example.com/no-id")).toBe("");
  expect(ghsaFromUrl(undefined)).toBe("");
  expect(ghsaFromUrl(42)).toBe("");
});
