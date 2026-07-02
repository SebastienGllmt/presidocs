#!/usr/bin/env bun
// Deploy-time license-compliance gate (methodology → Licensing: content vs
// code). The license sibling of
// generate/audit-deps.ts: where that fails the release when a shipped dependency
// has a CVE, this fails it when a CLIENT-bundled dependency carries a license we
// can't satisfy — a non-permissive / unrecognised license reaching the code we
// distribute to every reader, or a dep whose required notice we have no text to
// reproduce. (Distinct from generate/audit-own-license.ts — which gates
// the blog's OWN declared content license.)
//
// Why this exists: generate/licenses-page.ts SURFACES the notices, but nothing
// stops a future client `import` from pulling in a copyleft or unknown-licensed
// package and shipping it to readers unnoticed, or a dep that ships no LICENSE
// file we can reproduce. This is the detective complement: "did we ship code we
// can't legally ship, or ship it without its notice?" becomes a build failure
// instead of something found in an audit.
//
// Scope is the CLIENT MODULE GRAPH only (generate/clientDeps.ts, derived from the
// real bundle metafile) — build-/server-only deps distribute nothing and are out
// of scope, exactly as the served notices are. A non-permissive license is a
// problem only when we DISTRIBUTE it.
//
// Like audit-deps, a reviewed exception lives in a coded WAIVED_LICENSES roster
// next to its one-line reason and review date (GSAP's custom non-OSS license is
// the standing waiver). Unlike audit-deps (which warns-and-passes when npm is
// unreachable), this gate fails CLOSED if it can't derive the client set: the
// derivation is a local bundle, so an inability to run means the build is broken,
// and a compliance gate that can't see the deps must not pass silently.

import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { deriveShippedClientPackages } from "./clientDeps.ts";
import { type DepLicense, resolveDepLicenses } from "./licenseFiles.ts";

// Permissive SPDX identifiers accepted in the client bundle without review. All
// are notice-only (attribution / permission-preservation) — none is copyleft or
// source-disclosure, which is the line a *distributed* bundle must not cross
// without a deliberate decision. Extend with a deliberate edit, not silently.
export const ALLOWED_LICENSES = new Set<string>([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "OFL-1.1",
  "BlueOak-1.0.0",
]);

// ⚠️  DELIBERATE, TRIAGED license waivers. ⚠️
//
// An entry means: this client dep's license is NOT a permissive SPDX identifier,
// but it was reviewed and judged acceptable to ship, so it doesn't block the
// deploy. The dependency-tree analogue of audit-deps.ts's WAIVED_ADVISORIES —
// a fixed roster of conscious decisions, each with WHY and the review date, NOT
// a pressure valve. Keyed by PACKAGE NAME (a non-SPDX license has no stable id).
// A waived dep must still surface a notice on /licenses (its supplement counts).
export const WAIVED_LICENSES: Record<
  string,
  { reason: string; reviewed: string }
> = {
  gsap: {
    reason:
      "GreenSock \"Standard 'No Charge' License\" — a custom, non-OSS license, but free for our use " +
      "(figure animation only) and its notice is surfaced verbatim on /licenses. Re-check on a gsap bump.",
    reviewed: "2026-06-14",
  },
};

export type LicenseFinding = {
  name: string;
  license: string;
  /** Why this dep blocks the deploy. */
  reason: string;
};

export type LicenseEvaluation = {
  /** Permissive license + a reproducible notice — fine to ship. */
  ok: DepLicense[];
  /** Non-permissive but reviewed/accepted in WAIVED_LICENSES. */
  waived: DepLicense[];
  /** Non-permissive & unwaived, or no notice to reproduce — these fail. */
  blocking: LicenseFinding[];
};

/**
 * Atomic SPDX identifiers in a license expression. Splits a compound expression
 * (`(CC-BY-4.0 AND OFL-1.1 AND MIT)`, `Apache-2.0 OR MIT`, `... WITH ...`) into
 * its component identifiers, dropping the operators and parentheses. Empty input
 * → empty list (treated as "unrecognised" by the caller).
 */
export function licenseTokens(license: string): string[] {
  return license
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/i)
    .map((t) => t.trim())
    .filter((t) => t && !/^(AND|OR|WITH)$/i.test(t));
}

/**
 * True when EVERY atomic identifier in the expression is on the allowlist. For a
 * compound `A AND B` this is exactly right (we must satisfy all). For `A OR B`
 * it's conservative — strictly we could pick one allowed branch — but erring
 * toward review on a disjunction with a non-permissive branch is the safe choice
 * for our own small dep set. An empty / unparseable expression is not permissive.
 */
export function isPermissiveLicense(license: string): boolean {
  const tokens = licenseTokens(license);
  if (tokens.length === 0) return false;
  return tokens.every((t) => ALLOWED_LICENSES.has(t));
}

/** Whether we have any reproducible notice text for a dep (LICENSE or supplement). */
function hasNotice(d: DepLicense): boolean {
  return Boolean(d.licenseText || d.supplement);
}

/**
 * Pure evaluation of the client deps against the allowlist + waiver roster.
 * Buckets each dep into ok / waived / blocking. Exported for unit tests.
 */
export function evaluateLicenses(
  deps: DepLicense[],
  opts: { allowed?: Set<string>; waived?: Record<string, unknown> } = {},
): LicenseEvaluation {
  const allowed = opts.allowed ?? ALLOWED_LICENSES;
  const waived = opts.waived ?? WAIVED_LICENSES;
  const permissive = (lic: string) => {
    const tokens = licenseTokens(lic);
    return tokens.length > 0 && tokens.every((t) => allowed.has(t));
  };

  const ok: DepLicense[] = [];
  const waivedHits: DepLicense[] = [];
  const blocking: LicenseFinding[] = [];

  for (const d of deps) {
    const isWaived = Object.hasOwn(waived, d.name);
    if (!hasNotice(d)) {
      blocking.push({
        name: d.name,
        license: d.license || "(none declared)",
        reason:
          "ships to the client but has no license notice we can reproduce (no LICENSE file and no curated supplement).",
      });
      continue;
    }
    if (permissive(d.license)) {
      ok.push(d);
    } else if (isWaived) {
      waivedHits.push(d);
    } else {
      blocking.push({
        name: d.name,
        license: d.license || "(none declared)",
        reason:
          "a non-permissive / unrecognised license reaching the client bundle. Verify it's safe to distribute, then add it to ALLOWED_LICENSES (if it's a permissive SPDX id) or WAIVED_LICENSES (with a reason) in generate/audit-dep-licenses.ts.",
      });
    }
  }

  return { ok, waived: waivedHits, blocking };
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();

  let packages: string[];
  try {
    packages = await deriveShippedClientPackages(paths);
  } catch (err) {
    // Fail CLOSED: the client set is derived from a local bundle, so an inability
    // to derive it means the build itself is broken — a compliance gate that
    // can't see what ships must not wave the deploy through.
    console.error(
      `audit-dep-licenses FAILED: could not derive the client dependency set — ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const deps = resolveDepLicenses(packages, paths.engineRoot);
  const { ok, waived, blocking } = evaluateLicenses(deps);

  for (const d of waived) {
    const w = WAIVED_LICENSES[d.name];
    console.log(
      `  ~ waived ${d.name} (${d.license})${w ? ` — ${w.reason}` : ""}`,
    );
  }

  if (blocking.length > 0) {
    console.error(
      `\naudit-dep-licenses FAILED: ${blocking.length} client-bundled dependency(ies) with an unsatisfiable license:\n`,
    );
    for (const f of blocking)
      console.error(`      ${f.name} [${f.license}] — ${f.reason}`);
    console.error(
      `\nThe client bundle is distributed to every reader, so each dep's license must be permissive (notice-only) and its notice reproducible on /licenses.\n`,
    );
    process.exit(1);
  }

  const waivedNote = waived.length > 0 ? ` (${waived.length} waived)` : "";
  console.log(
    `audit-dep-licenses: OK — ${ok.length} client dependency(ies) on the permissive allowlist with reproducible notices${waivedNote}.`,
  );
}

// CLI only — importing the helpers (tests) must not run the gate.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
