// Re-export shim. The HTML-head plugin moved to `generate/bunHtmlHeadPlugin.ts`
// in Phase 2a (it is build-only and imports generate/ internals). This shim is
// kept ONLY so an already-deployed consumer whose `bunfig.toml` still resolves
// the plugin by its old path (`presidocs/shared/bunHtmlHeadPlugin.ts`) keeps
// working until it migrates to the `generate/` path. New consumers (templates)
// reference the `generate/` path directly. Remove once no consumer points here.
export * from "../generate/bunHtmlHeadPlugin.ts";
export { default } from "../generate/bunHtmlHeadPlugin.ts";
