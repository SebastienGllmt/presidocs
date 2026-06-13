// Resolves the license NOTICE for one client-shipped dependency from its
// installed `node_modules` directory (proposal 60). The package's own `LICENSE`
// file is the authoritative notice text — more complete than a stripped
// `@license` banner, and the thing MIT ("in all copies"), Apache-2.0 (§4), and
// CC-BY ("visible attribution") actually require us to reproduce when we ship
// the code. `generate/clientDeps.ts` decides WHICH packages ship; this reads
// their notices.
//
// A package may ship its license under any of several conventional names
// (LICENSE, LICENSE.txt, LICENSE.md, LICENCE, COPYING), and an Apache package
// MAY ship a NOTICE file whose contents §4 requires us to propagate. Some
// packages ship NO license file at all and instead state terms in package.json's
// `license` field — notably `gsap`, whose custom "no-charge" license isn't an
// SPDX text. Those get a curated MANUAL_SUPPLEMENT line so the served notice is
// still meaningful.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";

export type DepLicense = {
  name: string;
  version: string;
  /**
   * The `license` field from package.json: an SPDX expression (`MIT`,
   * `Apache-2.0`, `(CC-BY-4.0 AND OFL-1.1 AND MIT)`) or, for a non-SPDX dep, the
   * raw descriptive string (gsap's custom-license line). Empty string when the
   * package declares none.
   */
  license: string;
  /** Full text of the package's LICENSE file, or null when it ships none. */
  licenseText: string | null;
  /** Apache NOTICE text (§4) when the package ships one, else null. */
  noticeText: string | null;
  /** A curated supplement for deps with no standard license file (e.g. gsap). */
  supplement: string | null;
  /** package.json `homepage`, when present. */
  homepage: string | null;
};

// Conventional license / notice filenames, case-insensitive. LICENSE wins over
// COPYING when both exist (rare); NOTICE is separate (Apache §4).
const LICENSE_FILE_RE = /^(licen[sc]e|copying)(\.[a-z0-9]+)?$/i;
const NOTICE_FILE_RE = /^notice(\.[a-z0-9]+)?$/i;

// Deps whose terms aren't a standard SPDX license file. Keyed by package name.
// gsap: GreenSock's custom, non-OSS "no-charge" license — free for the common
// case, full terms at the URL. The blog uses it only to drive figure animation.
const MANUAL_SUPPLEMENT: Record<string, string> = {
  gsap:
    "GreenSock's \"Standard 'No Charge' License\" — a custom, non-open-source license (not an SPDX identifier). " +
    "It is free to use for the vast majority of cases; the full, current terms are published at " +
    "https://gsap.com/standard-license/ . This blog uses GSAP solely to drive its figure animations.",
};

/** Resolve a package's installed directory under the engine's node_modules. */
export function packageDir(name: string, engineRoot: string): string {
  // Prefer the resolver (honours symlinks / hoisting), fall back to the
  // conventional path so a package without a `./package.json` export still works.
  try {
    const pkgJson = Bun.resolveSync(`${name}/package.json`, engineRoot);
    return pkgJson.replace(/\/package\.json$/, "");
  } catch {
    return join(engineRoot, "node_modules", name);
  }
}

/** Normalise package.json's `license`/`licenses` into a single string. */
export function licenseFieldToString(pkg: {
  license?: string | { type?: string };
  licenses?: { type?: string }[];
}): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object")
    return pkg.license.type ?? "";
  // Deprecated `licenses: [{type}]` array form.
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses
      .map((l) => l.type)
      .filter(Boolean)
      .join(" AND ");
  }
  return "";
}

/** First file in `dir` matching `re`, read as UTF-8, or null. */
function readFirstMatch(dir: string, re: RegExp): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // Stable order so the choice is deterministic across machines.
  const match = entries.sort().find((f) => re.test(f));
  if (!match) return null;
  try {
    return readFileSync(join(dir, match), "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve one dependency's full license record from its installed dir. Throws
 * when the package can't be located at all (a derived client dep with no
 * installed dir is a broken tree, not a notice to silently drop).
 */
export function resolveDepLicense(
  name: string,
  engineRoot: string = resolveBlogPaths().engineRoot,
): DepLicense {
  const dir = packageDir(name, engineRoot);
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(
      `Cannot resolve installed package "${name}" (looked in ${dir}); ` +
        `it is in the client bundle but not in node_modules — the dependency tree is inconsistent.`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    version?: string;
    license?: string | { type?: string };
    licenses?: { type?: string }[];
    homepage?: string;
  };
  return {
    name,
    version: pkg.version ?? "",
    license: licenseFieldToString(pkg),
    licenseText: readFirstMatch(dir, LICENSE_FILE_RE),
    noticeText: readFirstMatch(dir, NOTICE_FILE_RE),
    supplement: MANUAL_SUPPLEMENT[name] ?? null,
    homepage: pkg.homepage ?? null,
  };
}

/** Resolve every dependency in `names`, sorted by name. */
export function resolveDepLicenses(
  names: string[],
  engineRoot: string = resolveBlogPaths().engineRoot,
): DepLicense[] {
  return [...names].sort().map((n) => resolveDepLicense(n, engineRoot));
}
