// Bun bundler plugin that runs the site-footer inject at *build* time,
// replacing the prior reliance on the post-build sweep in
// `generate/strip-served-html.ts`. The companion `injectSiteFooter` call in
// strip-served-html.ts stays in place; the inject is idempotent (skips when
// it sees the `class="site-footer"` marker the plugin already wrote), so
// that call becomes a harmless backstop — it only does real work when
// someone runs the prod pipeline without the plugin registered, which keeps
// prod HTML correct regardless of which path produced it. See methodology →
// Build-time HTML strip for the build-only-vs-content-bearing taxonomy this addresses.
//
// The footer link SET (Home / How this blog works / Privacy) must match what
// strip-served-html.ts passes, or the two paths would render different footers
// depending on which one wins the idempotency race. So the plugin derives the
// same two hrefs from the same env: privacy from PRIVACY_POLICY_URL, help from
// SITE_URL (the gate generate/help-page.ts uses to emit /help).
//
// **Build-only.** This plugin is wired through `Bun.build({plugins:[...]})`
// in `engine/generate/build-html.ts`. It is deliberately NOT registered via
// `Bun.plugin(...)` at the dev server's entry: Bun's runtime plugin system
// (as of 1.3.14) rejects `loader: "html"` in onLoad results, so a runtime
// registration crashes Bun.serve as soon as an HTMLBundle import resolves.
// The footer is fully engine-owned (content pages no longer hand-author one),
// so it's simply absent under `bun run dev` — the same prod-only posture as the
// feeds, sitemap, and /help. When Bun's runtime plugin system gains html-loader
// support the dev gap closes by also calling `Bun.plugin(siteFooterPlugin())`
// from each content-repo's `index.ts`.
//
// Read PRIVACY_POLICY_URL once at construction (matches the build-time
// caller's posture: env-gated, fail-silent on unset). The plugin is a
// per-blog wiring concern — instantiated from the bundle entry script —
// so it has no per-call configuration beyond what comes off the env.

import type { BunPlugin } from "bun";
import { injectSiteFooter } from "./injectFooter.ts";

export type SiteFooterPluginOptions = {
  // Override for the privacy-policy URL. Defaults to PRIVACY_POLICY_URL,
  // matching the build-time inject's source.
  privacyHref?: string;
  // Override for the help-page URL. Defaults to "/help" when SITE_URL is set
  // (the same gate generate/help-page.ts uses to emit it), else omitted.
  helpHref?: string;
};

export function siteFooterPlugin(
  opts: SiteFooterPluginOptions = {},
): BunPlugin {
  const privacyHref = (opts.privacyHref ?? process.env.PRIVACY_POLICY_URL ?? "")
    .trim();
  const helpHref = (opts.helpHref ?? (process.env.SITE_URL ? "/help" : ""))
    .trim();
  return {
    name: "presidocs:inject-site-footer",
    setup(build) {
      // No links to show → register nothing. Same fail-silent posture as
      // strip-served-html.ts's main(): the blog still ships, it just doesn't
      // inject a footer in this deploy.
      if (!privacyHref && !helpHref) return;
      build.onLoad({ filter: /\.html$/, namespace: "file" }, async (args) => {
        const html = await Bun.file(args.path).text();
        return {
          contents: injectSiteFooter(html, { privacyHref, helpHref }),
          loader: "html",
        };
      });
    },
  };
}
