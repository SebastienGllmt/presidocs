// The engine's single HTML bundler plugin for build-time `<head>`/footer
// injection. Bun `onLoad` is first-match-wins, so every `.html` transform the
// engine needs has to ride ONE plugin — this one. It applies, per served page:
//
//   1. the canonical cascade-layer order, as the first <head> CSS
//      (injectLayerOrderStyle — layer-system pages only);
//   2. the site footer (injectSiteFooterFromEnv — env-gated, idempotent);
//   3. the landing "Ask this blog" AI-search block + its client <script>
//      (injectAiSearch — landing only, dev AND prod, so the script bundles); and
//   4. (dev only) the landing feature-chips nav (injectChips option).
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
import { injectAiSearch } from "./injectAiSearch.ts";
import { isPrivateBlog } from "./blogPrivacy.ts";
import { resolveSourceRepo, sourceUrlForPostPath } from "./sourceRepo.ts";
import { resolveFeedConfig } from "./feedConfig.ts";

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
  // `prepend` puts the preloads among the first <head> children so the woff2
  // fetch starts with the document. HTMLRewriter is the engine's house head
  // injector (injectLayerOrderStyle, injectPwaHead, injectSiteFooter); first-
  // <head>-only and immune to a stray `<head` in a comment/attribute, where the
  // old `/<head…>/` regex was not. (Runs after injectLayerOrderStyle in the
  // chain, so the preloads end up just before the layer-order <style> — the
  // same relative order the two regexes produced.)
  return new HTMLRewriter()
    .on("head", { element(el) { el.prepend(FONT_PRELOAD_TAGS, { html: true }); } })
    .transform(html);
}

// Inject the per-post public-source link `<link rel="vcs-github" href="…">` that
// client/viewSource.ts reads to render the "View on GitHub" control (proposal 58).
// Idempotent. The href is attribute-escaped; the rel-vcs microformat also makes
// the repo pointer machine-discoverable in the head, like rel="canonical".
export function injectSourceLink(html: string, url: string): string {
  if (html.includes('rel="vcs-github"')) return html;
  const href = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return new HTMLRewriter()
    .on("head", { element(el) { el.append(`<link rel="vcs-github" href="${href}">`, { html: true }); } })
    .transform(html);
}

export function htmlHeadPlugin(
  opts: { injectChips?: boolean; preloadFonts?: boolean } = {},
): BunPlugin {
  const paths = resolveBlogPaths();
  // The landing page (the blog's root index). The AI-search block is injected
  // here in BOTH dev and prod (so its <script> is bundled either way); the
  // feature chips ride the same file but only when `injectChips` (dev).
  const landingPath = resolve(join(paths.contentRoot, "index.html"));
  // Absolute site origin for the AI-search prompt's blog/llms.txt link. May be
  // null (no SITE_URL) — the client then falls back to location.origin.
  const siteUrl = resolveFeedConfig().baseUrl;

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
        if (resolve(args.path) === landingPath) {
          // AI search first, then chips — so the landing order is
          // [Ask this blog, feature chips, post list] (both insert before
          // <ul class="posts">). Chips are dev-only here; prod adds them
          // post-build in generate/help-page.ts.
          // Private blogs get no Ask-this-blog: its prompt hands an external
          // LLM the blog URL + the llms.txt post index — it both requires a
          // leak artifact (suppressed in site-discovery) and teaches a
          // third-party model the content (methodology → Private blogs).
          if (!isPrivateBlog()) html = injectAiSearch(html, { siteUrl });
          if (opts.injectChips) {
            html = injectFeatureChips(html, await chipsHtmlFromSource());
          }
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
          // Public-source link for the "View on GitHub" control (proposal 58).
          // resolveSourceRepo returns null when SOURCE_REPO_URL is unset OR the
          // blog is private, so neither case injects anything. Runs dev+prod.
          const repo = resolveSourceRepo();
          if (repo) html = injectSourceLink(html, sourceUrlForPostPath(repo, postPath));
        }
        return { contents: html, loader: "html" };
      });
    },
  };
}

// `bunfig.toml`'s `plugins` array resolves each entry to its default export.
// Dev gets chips; prod's build-html.ts calls `htmlHeadPlugin()` (chips off).
export default htmlHeadPlugin({ injectChips: true });
