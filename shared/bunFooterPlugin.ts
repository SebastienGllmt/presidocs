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
// **Injection wiring.** The footer transform (`injectSiteFooterFromEnv`) is an
// HTML bundler transform. It must NOT be registered via a *runtime* `Bun.plugin()`
// at the dev server entry: the bundler's loader union includes "html", but the
// runtime `onLoad` loader set does not — verified on Bun 1.3.14, importing a
// `.html` with such a plugin registered throws `Expected loader to be one of
// "js","jsx","object","ts","tsx","toml","yaml","json","md"` (no "html"/"css"/
// "text"), and #21521 shows a runtime plugin may not discover the HTML's modules
// even when accepted (oven-sh/bun#17655, open).
//
// The seam that works is `bunfig.toml`'s `[serve.static].plugins`, which hooks
// the dev server's *bundler*. Because Bun `onLoad` is first-match-wins, the
// footer and the cascade-layer-order injection share ONE `.html` plugin —
// `shared/bunHtmlHeadPlugin.ts` — which calls `injectSiteFooterFromEnv` (here)
// and `injectLayerOrderStyle` (cssLayers.ts). That plugin is registered in dev
// via bunfig and in prod via `Bun.build` in generate/build-html.ts, so the
// footer now renders under `bun run dev` too (it is no longer prod-only).
// `siteFooterPlugin` below remains a standalone footer-only plugin for callers
// that want just the footer.
//
// Read PRIVACY_POLICY_URL once at construction (matches the build-time
// caller's posture: env-gated, fail-silent on unset). The plugin is a
// per-blog wiring concern — instantiated from the bundle entry script —
// so it has no per-call configuration beyond what comes off the env.

import type { BunPlugin } from "bun";
import { injectSiteFooter } from "./injectFooter.ts";
import { resolveLicenseConfig } from "./licenseConfig.ts";

export type SiteFooterPluginOptions = {
  // Override for the privacy-policy URL. Defaults to PRIVACY_POLICY_URL,
  // matching the build-time inject's source.
  privacyHref?: string;
  // Override for the help-page URL. Defaults to "/help" when SITE_URL is set
  // (the same gate generate/help-page.ts uses to emit it), else omitted.
  helpHref?: string;
};

/**
 * The footer transform, env-gated. Reads the privacy/help hrefs from the
 * environment (overridable via `opts`) and injects the footer; returns the HTML
 * unchanged when no links are configured (fail-silent) or when a footer is
 * already present (injectSiteFooter is idempotent). This is the reusable unit
 * shared by the build-time plugin below and the dev/prod HTML-head plugin
 * (shared/bunHtmlHeadPlugin.ts) — so dev and prod inject the same footer.
 */
export function injectSiteFooterFromEnv(
  html: string,
  opts: SiteFooterPluginOptions = {},
): string {
  const privacyHref = (opts.privacyHref ?? process.env.PRIVACY_POLICY_URL ?? "").trim();
  const helpHref = (opts.helpHref ?? (process.env.SITE_URL ? "/help" : "")).trim();
  // Content license: link the deed/text, labelled with its SPDX id. Resolved
  // from the same env as everywhere else (CONTENT_LICENSE), so the build-time
  // and post-build paths agree by construction. Null → no license link.
  const content = resolveLicenseConfig().content;
  const licenseHref = content?.url ?? "";
  const licenseLabel = content?.id ?? "";
  if (!privacyHref && !helpHref && !licenseHref) return html;
  return injectSiteFooter(html, { privacyHref, helpHref, licenseHref, licenseLabel });
}

export function siteFooterPlugin(opts: SiteFooterPluginOptions = {}): BunPlugin {
  return {
    name: "presidocs:inject-site-footer",
    setup(build) {
      build.onLoad({ filter: /\.html$/, namespace: "file" }, async (args) => {
        const html = await Bun.file(args.path).text();
        return { contents: injectSiteFooterFromEnv(html, opts), loader: "html" };
      });
    },
  };
}
