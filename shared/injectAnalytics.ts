// Build-time injection of the Cloudflare Web Analytics beacon snippet.
//
// Cloudflare Web Analytics is a small, cookieless JS beacon that
// reports page views to Cloudflare's analytics dashboard. The token
// is public (it appears in served HTML by definition — there's no
// way to keep it secret from clients) but it's still treated as
// configuration rather than a hardcoded literal so a fork can plug
// in their own dashboard.
//
// Snippet shape per Cloudflare's docs:
//   <script defer
//     src="https://static.cloudflareinsights.com/beacon.min.js"
//     data-cf-beacon='{"token": "<token>"}'></script>
//
// We inject at the end of <head> via Bun's HTMLRewriter (same parser
// used by `stripServedHtml`). Idempotent: running twice with the same
// HTML produces the same output because the rewriter only fires the
// `element` handler on the FIRST `<head>` in the document.

export function injectCloudflareAnalytics(
  html: string,
  token: string,
): string {
  const trimmed = token.trim();
  if (!trimmed) return html;
  // If the beacon is already present (e.g. someone re-runs the build
  // step), don't add a duplicate. A literal substring check is enough
  // — the snippet URL is unique to Cloudflare's beacon.
  if (html.includes("static.cloudflareinsights.com/beacon.min.js")) {
    return html;
  }
  const beacon =
    `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" `
    + `data-cf-beacon='${JSON.stringify({ token: trimmed })}'></script>`;
  const rewriter = new HTMLRewriter().on("head", {
    element(el) {
      el.append(beacon, { html: true });
    },
  });
  return rewriter.transform(html);
}
