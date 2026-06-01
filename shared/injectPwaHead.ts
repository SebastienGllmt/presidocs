// Build-time injection of the PWA <head> metadata: manifest link, theme-color,
// and apple-touch-icon. Sits in the same family as injectSiteFooter /
// injectFeedLinks / injectStructuredData — runs in the post-build rewrite step,
// idempotent (a re-run that sees the marker class skips the inject).
//
// The /manifest.webmanifest URL is engine-owned (the SW + installability
// contract pins it to the origin root). theme_color and the apple-touch-icon
// src are per-blog content, read by strip-served-html.ts from the blog's
// manifest.webmanifest and threaded through here as opts so this module stays
// content-free.
//
// Why not also emit these from the Bun bundler plugin (bunFooterPlugin.ts)?
// Same answer as the privacy footer + structured-data injects — these tags are
// *inert-at-render* metadata (browsers/PWA installers consume them without
// visible rendering), so they belong in the post-build sweep, not in the bundler
// step (the build-only-vs-content-bearing split; see methodology → Build-time HTML strip).

export interface PwaHeadOptions {
  /** = manifest.theme_color. Omitted → no <meta name="theme-color"> emitted. */
  themeColor?: string;
  /** = manifest.icons[0].src. Omitted → no apple-touch-icon link emitted. */
  appleTouchIcon?: string;
}

// Sentinel class on the injected <link rel="manifest"> so a second pass over
// the same HTML doesn't double-inject. Distinct from anything a hand-authored
// post might use.
const MANIFEST_CLASS = "pwa-manifest";
const MARKER = `class="${MANIFEST_CLASS}"`;

export function injectPwaHead(html: string, opts: PwaHeadOptions = {}): string {
  if (html.includes(MARKER)) return html;

  let inject =
    `<link class="${MANIFEST_CLASS}" rel="manifest" href="/manifest.webmanifest" />`;
  if (opts.themeColor) {
    inject += `<meta name="theme-color" content="${escapeAttr(opts.themeColor)}" />`;
  }
  if (opts.appleTouchIcon) {
    inject += `<link rel="apple-touch-icon" href="${escapeAttr(opts.appleTouchIcon)}" />`;
  }

  // Append inside <head>. HTMLRewriter only fires the element handler on the
  // FIRST <head> it encounters, which keeps this idempotent on unusual HTML.
  return new HTMLRewriter()
    .on("head", { element(el) { el.append(inject, { html: true }); } })
    .transform(html);
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
