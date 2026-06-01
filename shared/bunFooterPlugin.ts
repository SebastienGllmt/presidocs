// Bun bundler plugin that runs the privacy-policy footer inject at *build*
// time, replacing the prior reliance on the post-build sweep in
// `generate/strip-served-html.ts`. The companion `injectSiteFooter` call in
// strip-served-html.ts stays in place; the inject is idempotent (skips when
// it sees the `class="site-footer"` marker the plugin already wrote), so
// that call becomes a harmless backstop — it only does real work when
// someone runs the prod pipeline without the plugin registered, which keeps
// prod HTML correct regardless of which path produced it. See Proposal 13
// §8 for the build-only-vs-content-bearing taxonomy this addresses.
//
// **Build-only.** This plugin is wired through `Bun.build({plugins:[...]})`
// in `engine/generate/build-html.ts`. It is deliberately NOT registered via
// `Bun.plugin(...)` at the dev server's entry: Bun's runtime plugin system
// (as of 1.3.14) rejects `loader: "html"` in onLoad results, so a runtime
// registration crashes Bun.serve as soon as an HTMLBundle import resolves.
// Dev pages that need a visible footer (the landing, /privacy) carry a
// hand-authored `<footer class="site-footer">` in source HTML; the inject
// short-circuits on that marker in prod. When Bun's runtime plugin system
// gains html-loader support the dev gap (Proposal 13 §1 divergence 7) can
// be closed by also calling `Bun.plugin(siteFooterPlugin())` from each
// content-repo's `index.ts`.
//
// Read PRIVACY_POLICY_URL once at construction (matches the build-time
// caller's posture: env-gated, fail-silent on unset). The plugin is a
// per-blog wiring concern — instantiated from the bundle entry script —
// so it has no per-call configuration beyond what comes off the env.

import type { BunPlugin } from "bun";
import { injectSiteFooter } from "./injectFooter.ts";

export type SiteFooterPluginOptions = {
  // Override for the URL the footer links at. Defaults to
  // process.env.PRIVACY_POLICY_URL, matching the build-time inject's source.
  privacyHref?: string;
};

export function siteFooterPlugin(
  opts: SiteFooterPluginOptions = {},
): BunPlugin {
  const privacyHref = (opts.privacyHref ?? process.env.PRIVACY_POLICY_URL ?? "")
    .trim();
  return {
    name: "presidocs:inject-site-footer",
    setup(build) {
      // No privacy URL → register nothing. Same fail-silent posture as
      // strip-served-html.ts's main(): the blog still ships, it just doesn't
      // inject the legal footer in this deploy.
      if (!privacyHref) return;
      build.onLoad({ filter: /\.html$/, namespace: "file" }, async (args) => {
        const html = await Bun.file(args.path).text();
        return {
          contents: injectSiteFooter(html, { privacyHref }),
          loader: "html",
        };
      });
    },
  };
}
