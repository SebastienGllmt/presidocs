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
import { join, relative, resolve } from "node:path";
import { injectLayerOrderStyle } from "./cssLayers.ts";
import { injectSiteFooterFromEnv } from "./bunFooterPlugin.ts";
import { resolveBlogPaths } from "./blogPaths.ts";
import { buildAuthorMap } from "./authorProfile.ts";
import { buildPublicPostVersionsMap } from "./publicPostVersions.ts";
import { injectPostChrome } from "./articleChromeReserve.ts";
import { chipsHtmlFromSource, injectFeatureChips } from "../generate/help-page.ts";

// The above-the-fold Red Hat faces worth preloading: body prose (Text 400),
// the medium weight (Text 500 — Lighthouse's `cls-culprits-insight` named its
// woff2 by name as the residual first-section reflow once 400/700 were
// preloaded), and headings/title (Text 700). The remaining faces (600/italic,
// the mono pair) are below the fold or rare, so preloading them would only
// contend with the critical bundle. Served from dist root as `/fonts/*.woff2`
// (copy-static.ts); absolute so the same tag resolves from `/posts/<slug>` too.
const PRELOAD_FONT_FACES = [
  "redhattext-400.woff2",
  "redhattext-500.woff2",
  "redhattext-700.woff2",
];

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
  const paths = resolveBlogPaths();
  // The landing whose chips we inject (dev only). Resolved once; null disables.
  const landingPath = opts.injectChips
    ? resolve(join(paths.contentRoot, "index.html"))
    : null;

  // Map a built HTML file back to its public post path (`/posts/<slug>`), or
  // null for non-posts (landing, privacy, the dev sound-test page). Posts live
  // flat under postsDir; anything outside it isn't a post.
  const postsDir = resolve(paths.postsDir);
  const toPostPath = (file: string): string | null => {
    const rel = relative(postsDir, resolve(file));
    if (rel.startsWith("..") || rel.includes("/") || !rel.endsWith(".html")) return null;
    return `/posts/${rel.slice(0, -".html".length)}`;
  };

  // Lazy, cached lookups for the data-gated reserves (byline needs an author,
  // post-meta needs a version) — the SAME sources the byline fetches at runtime
  // (createDevServer serves authors.json/post-versions.json from these), so the
  // reserve matches what renders. Cached so a multi-post build doesn't re-scan
  // per file; absent data degrades to "no reserve" rather than throwing.
  let authorsP: Promise<Record<string, { name?: string }>> | null = null;
  let versionsP: Promise<Record<string, unknown>> | null = null;
  const authors = () =>
    (authorsP ??= buildAuthorMap(paths.postsDir, paths.contentRoot)
      .then((r) => r.map as Record<string, { name?: string }>)
      .catch(() => ({}) as Record<string, { name?: string }>));
  const versions = () =>
    (versionsP ??= buildPublicPostVersionsMap(paths.versionsJson)
      .then((m) => m as Record<string, unknown>)
      .catch(() => ({}) as Record<string, unknown>));

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
        // Reserve the client-injected article chrome + hide the narration dock,
        // so it never reflows the page on mount. Runs in dev and prod (this
        // plugin is registered in both), keeping CLS identical across them.
        const postPath = toPostPath(args.path);
        if (postPath) {
          const [authorMap, versionMap] = await Promise.all([authors(), versions()]);
          html = injectPostChrome(html, postPath, {
            hasAuthor: !!authorMap[postPath]?.name,
            hasVersion: postPath in versionMap,
          });
        }
        return { contents: html, loader: "html" };
      });
    },
  };
}

// `bunfig.toml`'s `plugins` array resolves each entry to its default export.
// Dev gets chips; prod's build-html.ts calls `htmlHeadPlugin()` (chips off).
export default htmlHeadPlugin({ injectChips: true });
