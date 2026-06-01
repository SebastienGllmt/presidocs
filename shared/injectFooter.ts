// Build-time injection of the site footer (privacy-policy link).
//
// Sits in the same family as injectAnalytics / injectStructuredData /
// injectFeedLinks — runs in the post-build rewrite step, idempotent
// (a re-run that sees the marker class skips the inject), env-gated
// (no PRIVACY_POLICY_URL → no footer, same fail-silent posture as the
// other injectors).
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
//
// Why a privacy footer at all: GDPR Art. 12 requires privacy
// information to be "concise, transparent, intelligible, easily
// accessible"; CalOPPA requires it to be "conspicuously posted"; the
// industry-standard satisfaction of both is a footer link on every
// page that uses the word "Privacy". See the post for the long form.

export interface FooterOptions {
  /**
   * URL the "Privacy Policy" link points at. Relative or absolute.
   * No value → no footer is injected (the whole call is a no-op).
   */
  privacyHref: string;
}

// Sentinel class on the injected <footer> so a second pass over the
// same HTML doesn't double-inject. Distinct from any class the
// downstream blog might use, so a hand-authored footer on a custom
// page doesn't accidentally suppress this one.
const FOOTER_CLASS = "site-footer";
const MARKER = `class="${FOOTER_CLASS}"`;

export function injectSiteFooter(html: string, opts: FooterOptions): string {
  const href = opts.privacyHref.trim();
  if (!href) return html;
  if (html.includes(MARKER)) return html;
  const footer =
    `<footer class="${FOOTER_CLASS}">`
    + `<a href="${escapeAttr(href)}">Privacy Policy</a>`
    + `</footer>`;
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

// Minimal HTML-attribute escape for the href value. We only emit URLs
// the operator configured, but defense-in-depth: never trust env vars
// to be already-escaped.
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
