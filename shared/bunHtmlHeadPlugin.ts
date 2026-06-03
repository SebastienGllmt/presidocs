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

export function htmlHeadPlugin(opts: { injectChips?: boolean } = {}): BunPlugin {
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
