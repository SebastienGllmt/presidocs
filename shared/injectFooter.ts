// Build-time injection of the site footer — a small, every-page set of links:
// "Home", the engine's "How this blog works" help page, and the operator's
// privacy policy.
//
// Sits in the same family as injectAnalytics / injectStructuredData /
// injectFeedLinks / injectPwaHead — runs in the post-build rewrite step,
// idempotent (a re-run that sees the marker class skips the inject), env-gated
// (no links available → no footer, same fail-silent posture as the other
// injectors).
//
// The link SET is conditional, each piece independently gated by its caller:
//   - Privacy   — present when PRIVACY_POLICY_URL is set (the GDPR / CalOPPA /
//                 APPI every-page-link requirement; this is why the footer
//                 originally existed).
//   - Help      — present when SITE_URL is set, i.e. when generate/help-page.ts
//                 actually emits /help. Linking it before that step runs in the
//                 build is fine: the target exists by serve time, exactly like
//                 injectFeedLinks advertising /feed.xml before generate/feeds.ts
//                 emits it.
//   - Home      — present whenever the footer is shown at all.
// Feeds are deliberately NOT linked here: a visible "Podcast" link would 404 on
// an audio-less blog, and raw feed XML is unfriendly to a human anyway — the
// /help#subscribe walkthrough is the human entry point, and the <head>
// autodiscovery <link>s (injectFeedLinks) are the machine one.
//
// Why build-time, not static HTML or a client-side script:
//   - Static HTML would duplicate the markup across every post + the
//     landing page, and a downstream blog using this engine would have
//     to remember to paste it into every new post they author.
//   - A client-side DOM injection would break the "no inline scripts,
//     no extra runtime JS" posture and would flash the page without a
//     footer before the script ran.
//   - Build-time injection treats the footer as a deploy-time
//     decoration, exactly like the Cloudflare Analytics beacon, and
//     keeps the source HTML clean.

import { escapeHtmlAttr, escapeHtmlText } from "./htmlEscape.ts";

export interface FooterOptions {
  /**
   * URL the "Privacy Policy" link points at. Relative or absolute.
   * Empty/omitted → the privacy link is left out.
   */
  privacyHref?: string;
  /**
   * URL the "How this blog works" link points at (typically "/help").
   * Empty/omitted → the help link is left out (e.g. no SITE_URL, so no
   * help page was emitted).
   */
  helpHref?: string;
  /**
   * URL the content-license link points at (the canonical license text/deed).
   * Empty/omitted → the license link is left out (no CONTENT_LICENSE set).
   * Present when the operator declared a content license.
   */
  licenseHref?: string;
  /**
   * Label for the license link — the SPDX identifier (e.g. `CC-BY-4.0`), so the
   * footer reads like the conventional license badge. Falls back to "License"
   * when a href is set without a label.
   */
  licenseLabel?: string;
  /**
   * URL the "Acknowledgements" link points at (typically "/licenses"), the
   * combined third-party-notices page. Empty/omitted → the link is
   * left out (e.g. no SITE_URL, so the page wasn't emitted).
   */
  acknowledgementsHref?: string;
}

// Sentinel class on the injected <footer> so a second pass over the
// same HTML doesn't double-inject. Distinct from any class the
// downstream blog might use, so a hand-authored footer on a custom
// page doesn't accidentally suppress this one.
const FOOTER_CLASS = "site-footer";
const MARKER = `class="${FOOTER_CLASS}"`;

export function injectSiteFooter(html: string, opts: FooterOptions): string {
  const privacyHref = opts.privacyHref?.trim() ?? "";
  const helpHref = opts.helpHref?.trim() ?? "";
  const licenseHref = opts.licenseHref?.trim() ?? "";
  const licenseLabel = opts.licenseLabel?.trim() || "License";
  const acknowledgementsHref = opts.acknowledgementsHref?.trim() ?? "";

  // Build the link list in a stable order. Home first (orientation), then the
  // engine's help page, the operator's privacy policy, the content license, and
  // the third-party acknowledgements. Anything unset is simply skipped.
  const links: string[] = [`<a href="/">Home</a>`];
  if (helpHref) links.push(`<a href="${escapeHtmlAttr(helpHref)}">How this blog works</a>`);
  if (privacyHref) links.push(`<a href="${escapeHtmlAttr(privacyHref)}">Privacy Policy</a>`);
  // rel="license" is the machine-readable hint that this link names the page's
  // license (microformats / RDFa convention).
  if (licenseHref)
    links.push(`<a href="${escapeHtmlAttr(licenseHref)}" rel="license">${escapeHtmlText(licenseLabel)}</a>`);
  if (acknowledgementsHref)
    links.push(`<a href="${escapeHtmlAttr(acknowledgementsHref)}">Acknowledgements</a>`);

  // With no help, privacy, license, or acknowledgements link there's nothing
  // worth a footer (a lone "Home" link on every page is noise), so no-op — same
  // fail-silent posture as the other injectors when their gate is unset.
  if (!helpHref && !privacyHref && !licenseHref && !acknowledgementsHref) return html;
  if (html.includes(MARKER)) return html;

  const footer = `<footer class="${FOOTER_CLASS}">${links.join("")}</footer>`;
  // Append inside <body> so the footer lives in the document flow.
  // HTMLRewriter only fires the element handler on the FIRST <body>
  // it encounters, which keeps this idempotent even on HTML with
  // unusual structure.
  const rewriter = new HTMLRewriter().on("body", {
    element(el) {
      el.append(footer, { html: true });
    },
  });
  return rewriter.transform(html);
}
