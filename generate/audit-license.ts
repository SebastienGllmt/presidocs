#!/usr/bin/env bun
// Deploy-time license-declaration gate. The licensing sibling of audit-posts.ts:
// where that gate fails the release on a content-tree regression, this one fails
// it when a *published* build hasn't declared its content license.
//
// Why a gate at all (proposal 59): the license config is OPT-IN — unset means the
// surfaces omit the license, which is *safe* in the copyright sense (omission =
// all-rights-reserved by default, so nothing is given away). But that has the
// inverse footgun: an author who MEANT to publish under CC-BY but forgot to set
// CONTENT_LICENSE ships silently as all-rights-reserved, quietly defeating the
// "meant to be cited and reused" point. So the engine keeps the frictionless
// opt-in for local exploration but forces an EXPLICIT choice at the moment the
// blog becomes public.
//
// The "is this published" signal is SITE_URL — the same gate feeds.ts /
// site-discovery.ts / injectStructuredData.ts already use to mean "this build is
// going live" (no SITE_URL → feeds/sitemap/structured-data are all skipped). So:
//   - SITE_URL unset  → local/preview build, exempt (no friction; explore away).
//   - SITE_URL set    → published build, CONTENT_LICENSE is REQUIRED (hard fail).
//                       CODE_LICENSE is recommended (warn): a post's code samples
//                       are all-rights-reserved without it. (A blog that advertises
//                       figure source — proposal 58 — promotes the missing
//                       CODE_LICENSE to a hard error in figure-source-export.ts.)
//
// Pure check + thin main, matching audit-posts.ts: the gate logic is a testable
// function; main() prints and sets the exit code.

import { resolveLicenseConfig } from "../shared/licenseConfig.ts";

export type LicenseGateResult = { errors: string[]; warnings: string[] };

/**
 * Decide the gate outcome for an environment. Returns the (possibly empty)
 * errors and warnings; the caller fails the build iff `errors` is non-empty.
 * Exported so the policy is unit-tested without spawning a process.
 */
export function checkLicenseGate(
  env: Record<string, string | undefined> = process.env,
): LicenseGateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const published = ((env.SITE_URL ?? "").trim()) !== "";
  if (!published) return { errors, warnings }; // local/preview: exempt.

  const license = resolveLicenseConfig(env);
  if (!license.content) {
    errors.push(
      "SITE_URL is set (this is a published build) but CONTENT_LICENSE is unset. " +
        "Declare your content license before publishing — e.g. `CONTENT_LICENSE=CC-BY-4.0` " +
        "in .env (see LICENSE.md and proposals/59). Builds without SITE_URL are exempt.",
    );
  }
  if (license.content && !license.code) {
    warnings.push(
      "CODE_LICENSE is unset: code samples in posts are all-rights-reserved by default. " +
        "Set `CODE_LICENSE=MIT` (or your choice) to license them — recommended for a blog " +
        "that shows code, and required once a post advertises figure source (proposal 58).",
    );
  }
  return { errors, warnings };
}

async function main(): Promise<void> {
  const { errors, warnings } = checkLicenseGate();
  for (const w of warnings) console.warn(`  ~ [license] ${w}`);
  if (errors.length === 0) {
    console.log("License gate: OK.");
    return;
  }
  console.error("License gate: FAILED.");
  for (const e of errors) console.error(`  ✗ [license] ${e}`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
