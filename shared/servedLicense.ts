// The blog's OWN license, served self-hosted (proposals 59 + 60). Proposal 59
// declared the license via env (CONTENT_LICENSE / CODE_LICENSE) and pointed the
// footer "License" link at the EXTERNAL license deed; it left a gap — the full
// text (notably the code half, MIT) was never reachable from the site itself.
// Proposal 60 closes that: `generate/copy-static.ts` copies the content repo's
// `LICENSE.md` to `dist/license` (served at `/license` as text/plain — see
// `staticAssetContentTypeOverride` in server/createWorker.ts) whenever the file
// exists, and the footer link retargets to that self-hosted text.
//
// When the content repo ships no `LICENSE.md` there's nothing to serve, so the
// link gracefully stays on the external deed — no hard dependency between the
// two surfaces (and no broken `/license` link).
//
// The existence predicate is the SINGLE source of truth the two footer-inject
// paths share — the build-time bundler plugin (shared/bunFooterPlugin.ts) and
// the post-build sweep (generate/strip-served-html.ts) — so both resolve the
// SAME href. That matters because the inject is idempotent: if the two paths
// disagreed, whichever won the race would decide the footer's license link.
//
// `/license` lists the blog's own terms, never any post, so it's a per-blog
// constant safe to serve on a private blog (it is NOT a post-enumerating
// artifact, so it stays out of generate/audit-private.ts's forbidden set).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBlogPaths } from "./blogPaths.ts";

/** Content-repo filename of the blog's own combined (prose + code) license. */
export const OWN_LICENSE_FILENAME = "LICENSE.md";

/** URL the self-hosted license is served at (copy-static → `dist/license`). */
export const SERVED_LICENSE_PATH = "/license";

/**
 * URL the combined license + third-party acknowledgements page is served at
 * (generate/licenses-page.ts → `dist/licenses.html`, the footer
 * "Acknowledgements" link target). Emitted under the SITE_URL gate, like /help.
 */
export const ACKNOWLEDGEMENTS_PATH = "/licenses";

/** Absolute path to the content repo's `LICENSE.md` (may not exist). */
export function ownLicenseSourcePath(
  contentRoot: string = resolveBlogPaths().contentRoot,
): string {
  return join(contentRoot, OWN_LICENSE_FILENAME);
}

/** True when the content repo ships a `LICENSE.md` for us to serve at `/license`. */
export function hasOwnLicenseFile(
  contentRoot: string = resolveBlogPaths().contentRoot,
): boolean {
  return existsSync(ownLicenseSourcePath(contentRoot));
}

/**
 * Resolve the footer license-link href: the self-hosted `/license` when the
 * blog ships a `LICENSE.md` we serve, else the given external deed URL
 * (proposal 59's prior behaviour). `deedUrl` is the resolved content-license URL
 * — `""` when no `CONTENT_LICENSE` is set, in which case there's no footer
 * license link at all and we return `""` unchanged.
 */
export function resolveLicenseLinkHref(
  deedUrl: string,
  contentRoot: string = resolveBlogPaths().contentRoot,
): string {
  if (!deedUrl) return "";
  return hasOwnLicenseFile(contentRoot) ? SERVED_LICENSE_PATH : deedUrl;
}
