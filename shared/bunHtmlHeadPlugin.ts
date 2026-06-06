// The engine's single HTML bundler plugin for build-time `<head>`/footer
// injection. Bun `onLoad` is first-match-wins, so every `.html` transform the
// engine needs has to ride ONE plugin — this one. It applies, per served page:
//
//   1. the canonical cascade-layer order, as the first <head> CSS
//      (injectLayerOrderStyle — layer-system pages only);
//   2. the site footer (injectSiteFooterFromEnv — env-gated, idempotent); and
//   3. (dev only) the landing feature-chips nav (injectChips option).
//
// All are idempotent and no-op when not applicable, so it's safe over every
// HTML entry-point (posts, landing, privacy).
//
// Registered in two places so dev and prod render identically:
//   - dev:  each content repo's `bunfig.toml` → [serve.static].plugins, which
//           hooks Bun's dev *bundler* (where `loader: "html"` works and the
//           HTML's referenced scripts/styles are still discovered — a runtime
//           `Bun.plugin()` can't; see shared/bunFooterPlugin.ts). The default
//           export turns chip injection ON, because in dev there's no build step
//           to add them.
//   - prod: `Bun.build({ plugins: [...] })` in generate/build-html.ts, with chip
//           injection OFF — generate/help-page.ts injects the chips there (from
//           the built dist/, with accurate feature-gating).
//
// See methodology → Cascade-layer architecture, "Pinning the order".

import type { BunPlugin } from "bun";
import { join, resolve } from "node:path";
import { injectLayerOrderStyle } from "./cssLayers.ts";
import { injectSiteFooterFromEnv } from "./bunFooterPlugin.ts";
import { resolveBlogPaths } from "./blogPaths.ts";
import { chipsHtmlFromSource, injectFeatureChips } from "../generate/help-page.ts";

// The above-the-fold Red Hat faces worth preloading: body prose (Text 400) and
// headings/title (Text 700). The other faces (500/600/italic, the mono pair)
// are below the fold or rare, so preloading them would only contend with the
// critical bundle. Served from dist root as `/fonts/*.woff2` (copy-static.ts);
// absolute so the same tag resolves from `/posts/<slug>` too.
const PRELOAD_FONT_FACES = ["redhattext-400.woff2", "redhattext-700.woff2"];

const FONT_PRELOAD_TAGS = PRELOAD_FONT_FACES.map(
  // `crossorigin` is mandatory even same-origin: fonts are fetched in CORS mode,
  // so a preload without it is a *separate* fetch the @font-face never reuses.
  (f) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/${f}">`,
).join("");

/**
 * Inject `<link rel="preload">` for the critical Red Hat faces as the first
 * <head> children, so the browser starts the woff2 fetch with the document
 * instead of after parsing the CSS chunk — cutting the post-FCP font swap that
 * Lighthouse's `cls-culprits-insight` attributes the article reflow to.
 *
 * PROD ONLY. Dev's serve.static inlines each @font-face as a data: URI, so a
 * preload there points at a URL the page never fetches — a wasted request.
 * Idempotent.
 */
export function injectFontPreloads(html: string): string {
  if (html.includes('rel="preload" as="font"')) return html;
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${FONT_PRELOAD_TAGS}`);
}

export function htmlHeadPlugin(
  opts: { injectChips?: boolean; preloadFonts?: boolean } = {},
): BunPlugin {
  // The landing whose chips we inject (dev only). Resolved once; null disables.
  const landingPath = opts.injectChips
    ? resolve(join(resolveBlogPaths().contentRoot, "index.html"))
    : null;
  return {
    name: "presidocs:html-head",
    setup(build) {
      build.onLoad({ filter: /\.html$/, namespace: "file" }, async (args) => {
        let html = await Bun.file(args.path).text();
        html = injectLayerOrderStyle(injectSiteFooterFromEnv(html));
        if (opts.preloadFonts) html = injectFontPreloads(html);
        if (landingPath && resolve(args.path) === landingPath) {
          html = injectFeatureChips(html, await chipsHtmlFromSource());
        }
        return { contents: html, loader: "html" };
      });
    },
  };
}

// `bunfig.toml`'s `plugins` array resolves each entry to its default export.
// Dev gets chips; prod's build-html.ts calls `htmlHeadPlugin()` (chips off).
export default htmlHeadPlugin({ injectChips: true });
