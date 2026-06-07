#!/usr/bin/env bun
// Deploy-time dependency-CVE gate (software-composition analysis). The
// dependency-tree sibling of audit-posts.ts: where that gate fails the release
// on a content-tree regression, this one fails it on a *dependency-tree* one —
// a production dependency the project already accepted has since had a known
// vulnerability (a GHSA advisory) published against it.
//
// Why this exists: the engine's defence against bad dependencies is otherwise
// entirely PREVENTIVE — a deliberately tiny dependency set, vendoring over CDNs,
// documented refusals to pull SDKs with transitive deps. All of that lowers the
// *probability* of a vulnerable dependency; none of it tells you when one of the
// dependencies you DID accept gets a CVE published months after you shipped.
// `jose`/`arctic`/`@automerge/automerge`/`turndown`/`@mozilla/readability`/
// `linkedom` are crypto/JWT/OAuth/HTML-parsing libraries — exactly the class
// where an advisory lands long after adoption. This is the DETECTIVE complement.
//
// How: it shells out to the native `bun audit --prod --json` (a Bun subcommand,
// NOT an npm package — zero dependency added, zero client JS). `bun audit` reads
// the content repo's existing `bun.lock`, queries npm's advisory endpoint (the
// same API `npm audit` uses, so advisories carry GHSA identifiers), and prints a
// per-package list of advisories. We parse that JSON ourselves rather than lean
// on `bun audit`'s own exit code / `--ignore` flag, because parsing gives us two
// things a bare `bun audit --prod` line in package.json can't:
//   1. a severity FLOOR — gate only on serious findings (default: high), while
//      still surfacing lower-severity advisories as informational (low noise,
//      full transparency); and
//   2. a documented WAIVER roster (WAIVED_ADVISORIES below) — a triaged advisory
//      is waived in code, next to the one-line reason it's not exploitable in
//      our usage, mirroring axe.e2e.ts's CONTRAST_EXEMPT_SELECTORS discipline.
//      A bare `--ignore=GHSA-…` flag has nowhere to record the *why*.
//
// `--prod` audits production dependencies only (the tree that actually ships),
// excluding devDependencies. Runs in the content repo's root (contentRoot), the
// same place its `bun.lock` lives. Wired into the content repo's `deploy` script
// alongside verify-narration.ts, ahead of `wrangler deploy`, so a known-
// vulnerable production dependency stops a deploy before it goes out.
//
// Network at release time: the scan reaches npm's advisory API. A deploy is
// online anyway (`wrangler deploy`, `websub-ping`), but if the audit *can't* run
// (offline, npm unreachable, the subcommand missing) this gate WARNS and PASSES
// rather than wedging the deploy — the offline-release escape hatch the proposal
// calls for. It blocks only on a finding it can actually see and prove.

import { resolveBlogPaths } from "../shared/blogPaths.ts";

// npm/GHSA advisory severities, weakest → strongest. `bun audit --json` emits
// exactly these four strings in each advisory's `severity` field.
export const SEVERITY_ORDER = ["low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

// The severity FLOOR the gate fails on. Everything at or above this blocks the
// deploy; everything below is reported as informational and lets the deploy
// proceed. Starts at "high" to stay low-noise (the proposal's recommendation);
// tighten to "moderate" here — a one-word change — once the dependency set is
// known clean at that level.
export const GATE_SEVERITY: Severity = "high";

// One advisory as it appears in `bun audit --json` output. The report is an
// object keyed by package name, each value an array of these. We read only the
// fields we report on; extras (cwe, cvss, vulnerable_versions) are ignored.
export type Advisory = {
  url?: unknown;
  title?: unknown;
  severity?: unknown;
};
export type AuditReport = Record<string, Advisory[]>;

// A flattened, validated finding — one advisory against one package.
export type Finding = {
  pkg: string;
  ghsa: string; // GHSA id parsed from the advisory URL, or "" if absent
  severity: Severity;
  title: string;
  url: string;
};

// ⚠️  DELIBERATE, TRIAGED advisory waivers. ⚠️
//
// An entry here means: this exact advisory was reviewed and judged NOT
// exploitable in how the project actually uses the dependency, so it does not
// block the deploy. This is the dependency-tree analogue of axe.e2e.ts's
// CONTRAST_EXEMPT_SELECTORS — a fixed roster of conscious decisions, NOT a
// pressure valve. Do NOT add an entry to silence a finding you haven't
// triaged: the bar for entry is "we read the advisory and it can't reach us,"
// and each entry records WHY plus the date it was reviewed so it can be
// re-checked on a dependency bump. If a real finding blocks a deploy, the fix
// is to bump the dependency, not to waive it.
//
// Keyed by GHSA id (the stable identifier in each advisory's URL). Empty by
// design — the dependency tree is clean today.
export const WAIVED_ADVISORIES: Record<string, { reason: string; reviewed: string }> = {
  // "GHSA-xxxx-xxxx-xxxx": {
  //   reason: "lodash _.template injection — we never call _.template; sink unreachable.",
  //   reviewed: "2026-06-08",
  // },
};

function isSeverity(s: unknown): s is Severity {
  return typeof s === "string" && (SEVERITY_ORDER as readonly string[]).includes(s);
}

/** GHSA id out of an advisory URL (…/advisories/GHSA-xxxx-xxxx-xxxx). "" if none. */
export function ghsaFromUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  return url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i)?.[0] ?? "";
}

export type AuditEvaluation = {
  /** At/above GATE_SEVERITY and NOT waived — these fail the deploy. */
  blocking: Finding[];
  /** At/above GATE_SEVERITY but waived in WAIVED_ADVISORIES — reported, not fatal. */
  waived: Finding[];
  /** Below GATE_SEVERITY — informational only. */
  belowThreshold: Finding[];
};

/**
 * Pure evaluation of a parsed `bun audit --json` report against the gate
 * severity floor and the waiver roster. Returns findings bucketed into
 * blocking / waived / below-threshold. Exported for unit tests.
 *
 * `report` is whatever `JSON.parse(stdout)` produced; this is defensive about
 * its shape (a clean audit emits `{}`, and the schema is npm's, not ours).
 */
export function evaluateAuditReport(
  report: unknown,
  opts: { gate?: Severity; waived?: Record<string, unknown> } = {},
): AuditEvaluation {
  const gate = opts.gate ?? GATE_SEVERITY;
  const waived = opts.waived ?? WAIVED_ADVISORIES;
  const gateRank = SEVERITY_ORDER.indexOf(gate);

  const blocking: Finding[] = [];
  const waivedHits: Finding[] = [];
  const belowThreshold: Finding[] = [];

  if (typeof report !== "object" || report === null) {
    return { blocking, waived: waivedHits, belowThreshold };
  }

  for (const [pkg, advisories] of Object.entries(report as Record<string, unknown>)) {
    if (!Array.isArray(advisories)) continue;
    for (const adv of advisories) {
      if (typeof adv !== "object" || adv === null) continue;
      const a = adv as Advisory;
      if (!isSeverity(a.severity)) continue; // skip malformed/unknown-severity rows
      const finding: Finding = {
        pkg,
        ghsa: ghsaFromUrl(a.url),
        severity: a.severity,
        title: typeof a.title === "string" ? a.title : "(no title)",
        url: typeof a.url === "string" ? a.url : "",
      };
      if (SEVERITY_ORDER.indexOf(finding.severity) < gateRank) {
        belowThreshold.push(finding);
      } else if (finding.ghsa && Object.prototype.hasOwnProperty.call(waived, finding.ghsa)) {
        waivedHits.push(finding);
      } else {
        blocking.push(finding);
      }
    }
  }

  return { blocking, waived: waivedHits, belowThreshold };
}

function formatFinding(f: Finding): string {
  const id = f.ghsa || f.url || "(no id)";
  return `      [${f.severity}] ${f.pkg}: ${f.title} — ${id}`;
}

/**
 * Run `bun audit --prod --json` in `cwd` and return its parsed report, or null
 * if the audit could not be run/parsed (offline, npm unreachable, subcommand
 * missing). A null result is the signal for main() to warn-and-pass rather than
 * block the deploy. Exit code is intentionally ignored: `bun audit` exits 1
 * whenever the report is non-empty, so the JSON — not the code — is the truth.
 */
async function runAudit(cwd: string): Promise<{ report: AuditReport | null; stderr: string }> {
  const proc = Bun.spawn(["bun", "audit", "--prod", "--json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { report: null, stderr };
    }
    return { report: parsed as AuditReport, stderr };
  } catch {
    return { report: null, stderr };
  }
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();
  const { report, stderr } = await runAudit(paths.contentRoot);

  // Could not produce a parseable report → offline / npm unreachable / tooling
  // gap. Warn loudly and let the deploy proceed (the deploy is online anyway and
  // will fail later if the network is truly down). Never silently wedge a deploy
  // on the audit's own inability to run.
  if (report === null) {
    console.warn(
      "audit-deps: could not run `bun audit --prod --json` (offline, npm advisory API unreachable, or unexpected output) — SKIPPING the dependency gate, not blocking the deploy.",
    );
    if (stderr.trim()) console.warn(stderr.trim());
    return;
  }

  const { blocking, waived, belowThreshold } = evaluateAuditReport(report);

  for (const f of waived) {
    const w = WAIVED_ADVISORIES[f.ghsa];
    console.log(`  ~ waived ${formatFinding(f).trim()}${w ? ` — ${w.reason}` : ""}`);
  }
  if (belowThreshold.length > 0) {
    console.log(
      `  i ${belowThreshold.length} advisory(ies) below the gate floor (<${GATE_SEVERITY}) — informational, not blocking:`,
    );
    for (const f of belowThreshold) console.log(formatFinding(f));
  }

  if (blocking.length > 0) {
    console.error(
      `\naudit-deps FAILED: ${blocking.length} production dependency advisory(ies) at or above "${GATE_SEVERITY}" severity:\n`,
    );
    for (const f of blocking) console.error(formatFinding(f));
    console.error(
      `\nFix by bumping the affected dependency (\`bun update\`), or — only if you have triaged the advisory as unreachable in our usage — add it to WAIVED_ADVISORIES in generate/audit-deps.ts with a one-line reason.\n`,
    );
    process.exit(1);
  }

  const waivedNote = waived.length > 0 ? ` (${waived.length} waived)` : "";
  const infoNote = belowThreshold.length > 0 ? ` (${belowThreshold.length} below floor)` : "";
  console.log(
    `audit-deps: OK — no production dependency advisory at or above "${GATE_SEVERITY}"${waivedNote}${infoNote}.`,
  );
}

// CLI only — importing the helpers (tests) must not run the gate.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
