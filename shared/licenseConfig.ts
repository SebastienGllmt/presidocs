// Resolved content/code licensing config — the single source of truth for the
// blog's reuse terms, stamped into every build-emitted surface (JSON-LD,
// Atom <rights>, the Markdown twin's front-matter, llms.txt, the footer link,
// and — once they're built — figure-source SPDX headers and the video
// end-card). See proposals/59-licensing-content-and-code.md.
//
// The licensing is DUAL: prose/figures/audio are one license (recommended
// CC-BY-4.0), code samples + figure source are another (recommended MIT). Each
// is its own knob so the split travels as data, not as scattered branches.
//
// OPT-IN, like PODCAST_LICENSE / SITE_URL: unset → null → the surface omits the
// license entirely. The engine stays content-agnostic and never *imposes* a
// license on a downstream blog — declaring someone's content freely-reusable
// without their choice is a worse failure than omitting. The recommended
// CC-BY-4.0 / MIT values live in .env.example and the blog's own .env, not as a
// universal code default. (This is the same fail-silent posture feedConfig uses
// for the podcast license.)
//
// `PODCAST_LICENSE` relates by INHERITANCE: the narrated audio is a rendition of
// the prose, so when an author sets a content license but no explicit podcast
// license, the podcast feed inherits the content one. That chaining lives in
// feedConfig.ts (which consumes `resolveLicenseConfig`), keeping the two vars
// separate while giving them a single source of truth.

import { z } from "zod";
import { trimmedOrNull } from "./envSchemas.ts";

/** A resolved license: its SPDX-style identifier plus a URL to the full text. */
export type License = {
  /** SPDX identifier as the author wrote it, e.g. `CC-BY-4.0`, `MIT`. */
  id: string;
  /**
   * URL to the full legal text. An explicit `_URL` wins; otherwise a canonical
   * URL is resolved for the well-known ids below, falling back to the uniform
   * SPDX page. So when `id` is set, `url` is ALWAYS a usable link (HTML footer
   * and JSON-LD `license` consumers need a URL, unlike the podcast feed which
   * lets clients resolve a bare identifier).
   */
  url: string;
};

export type LicenseConfig = {
  /** Prose / figures / audio license, or null when `CONTENT_LICENSE` is unset. */
  content: License | null;
  /** Code samples / figure-source license, or null when `CODE_LICENSE` is unset. */
  code: License | null;
};

// Canonical full-text URLs for the licenses we recommend / expect, so an author
// who sets just `CONTENT_LICENSE=CC-BY-4.0` need not also paste the deed URL.
// Keys are the exact SPDX identifiers (case-sensitive, as SPDX defines them and
// as .env.example documents them). Anything not here resolves to the uniform
// SPDX license page, which exists for every valid identifier.
const KNOWN_LICENSE_URLS: Record<string, string> = {
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  MIT: "https://opensource.org/license/mit",
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
};

/** Uniform SPDX page for any identifier with no hand-picked canonical URL. */
function spdxUrl(id: string): string {
  return `https://spdx.org/licenses/${id}.html`;
}

// Resolve one (id, explicitUrl) pair into a License, or null when no id is set.
// An explicit URL always wins (REQUIRED for a custom identifier the spec/SPDX
// can't resolve); otherwise we look up the canonical URL, then the SPDX page.
function resolveLicense(id: string | null, explicitUrl: string | null): License | null {
  if (!id) return null;
  return { id, url: explicitUrl ?? KNOWN_LICENSE_URLS[id] ?? spdxUrl(id) };
}

const LicenseEnv = z.object({
  CONTENT_LICENSE: trimmedOrNull,
  CONTENT_LICENSE_URL: trimmedOrNull,
  CODE_LICENSE: trimmedOrNull,
  CODE_LICENSE_URL: trimmedOrNull,
});

export function resolveLicenseConfig(
  env: Record<string, string | undefined> = process.env,
): LicenseConfig {
  const e = LicenseEnv.parse(env);
  return {
    content: resolveLicense(e.CONTENT_LICENSE, e.CONTENT_LICENSE_URL),
    code: resolveLicense(e.CODE_LICENSE, e.CODE_LICENSE_URL),
  };
}
