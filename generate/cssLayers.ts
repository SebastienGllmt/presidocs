// Single source of truth for the engine's CSS cascade-layer order.
//
// Cascade-layer precedence is fixed by the order in which layers are FIRST
// declared, and a layer-ordering statement (`@layer a, b, c;`) is append-only:
// it can create names that don't yet exist (at the end of the current order)
// but can never reorder a name that already exists. So the canonical order must
// be parsed BEFORE any stylesheet — linked or JS-imported — creates a layer, or
// dev and prod can resolve the same cascade differently (dev injects
// JS-imported CSS at module-eval time, ahead of base.css; prod bundles base.css
// first). See client/base.css and methodology → Cascade-layer architecture
// ("Pinning the order") for the full why.
//
// Posts don't author the order. The engine's HTML-head bundler plugin
// (shared/bunHtmlHeadPlugin.ts) injects it as the first <head> CSS from the
// constants here — in dev via `bunfig.toml`'s `[serve.static].plugins` and in
// prod via `Bun.build` in generate/build-html.ts — so the single source of
// truth lives here and a layer-order change needs no per-post edit.
// `client/base.css` restates the order as a backstop; build-html.ts asserts the
// built HTML still satisfies it. `injectLayerOrderStyle` below is the shared
// injector (it `prepend`s the <style> via HTMLRewriter, the same engine the
// other head/body injectors use); `checkHeadLayerOrder` is the assertion.

export const CSS_LAYER_ORDER = [
  "engine-tokens",
  "vendor",
  "engine-layout",
  "post",
  "engine-components",
] as const;

export type CssLayerName = (typeof CSS_LAYER_ORDER)[number];

/** The canonical ordering statement, e.g. `@layer engine-tokens, …;`. */
export const CSS_LAYER_ORDER_STATEMENT = `@layer ${CSS_LAYER_ORDER.join(", ")};`;

/** The inline <style> the injector places as the first CSS in a post <head>. */
export const CSS_LAYER_ORDER_STYLE_TAG = `<style id="engine-layer-order">${CSS_LAYER_ORDER_STATEMENT}</style>`;

/**
 * Inject the canonical layer-order <style> as the first child of <head>, for
 * documents in the engine layer system (those that link base.css). Idempotent
 * (skips if an `engine-layer-order` style is already present) and a no-op for
 * non-layer pages (landing/legal). This is the shared injector both the dev
 * bunfig plugin and the prod build-html step call.
 */
export function injectLayerOrderStyle(html: string): string {
  if (!html.includes("base.css")) return html;
  if (html.includes('id="engine-layer-order"')) return html;
  // `prepend` makes the <style> the FIRST child of <head>, which the cascade
  // requires (it must precede any linked/imported layer-bearing CSS). Same
  // HTMLRewriter the sibling head/body injectors use (injectPwaHead,
  // injectSiteFooter, injectPostChrome): the element handler fires only on the
  // first <head>, so this stays idempotent on unusual HTML and — unlike the old
  // `/<head…>/` regex — can't be fooled by a stray `<head` inside a comment,
  // CDATA section, or attribute value.
  return new HTMLRewriter()
    .on("head", { element(el) { el.prepend(CSS_LAYER_ORDER_STYLE_TAG, { html: true }); } })
    .transform(html);
}

/** Whitespace-insensitive comparison key. */
const norm = (s: string): string => s.replace(/\s+/g, "");

/** Drop CSS (`/* *​/`) and HTML (`<!-- -->`) comments so `@layer` mentions in
 *  prose/code examples don't count as real declarations. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Every layer name introduced by `css`, from both the block form (`@layer x {`)
 * and statement form (`@layer a, b;`), plus the layered `@import` form
 * (`@import "…" layer(x)`). Comments are stripped first; anonymous layers
 * (`@layer {`) are ignored. Deduped, order-preserving.
 */
export function collectLayerNames(css: string): string[] {
  const body = stripComments(css);
  const out: string[] = [];
  const add = (raw: string): void => {
    for (const name of raw.split(",").map((n) => n.trim()).filter(Boolean)) {
      if (!out.includes(name)) out.push(name);
    }
  };
  let m: RegExpExecArray | null;
  const block = /@layer\s+([^{;]+)[{;]/g;
  while ((m = block.exec(body))) add(m[1] ?? "");
  const imp = /@import\b[^;]*?\blayer\(\s*([^)]+?)\s*\)/g;
  while ((m = imp.exec(body))) add(m[1] ?? "");
  return out;
}

/** Layer names used in `css` that aren't part of the canonical registry. */
export function foreignLayerNames(css: string): string[] {
  const registry = new Set<string>(CSS_LAYER_ORDER);
  return collectLayerNames(css).filter((n) => !registry.has(n));
}

/** The standalone layer-ordering statements in `css` (statement form, `… ;`). */
export function layerOrderStatements(css: string): string[] {
  return stripComments(css).match(/@layer\s+[^{;]+;/g) ?? [];
}

/**
 * Verify an HTML document declares the canonical layer order as inline CSS
 * BEFORE any layer-bearing stylesheet. Returns a list of problems; empty = OK.
 *
 * Checks: (1) an inline <style> carries an `@layer …;` statement matching the
 * registry exactly; (2) it precedes the first `<link rel="stylesheet">`; and
 * (3) it precedes the first `<script type="module">` (a module can JS-import a
 * layered stylesheet, which in dev is injected at eval time).
 */
export function checkHeadLayerOrder(html: string): string[] {
  const problems: string[] = [];

  // Walk the document with HTMLRewriter (a runtime global, same parser as the
  // injector above) instead of regex/.search() over the raw string. The check
  // is fundamentally about DOCUMENT ORDER — does the qualifying inline <style>
  // precede the first layer-bearing <link>/<script>? — and HTMLRewriter streams
  // in document order, so "did we see X before the style?" is a single flag.
  // The old `.search(/<link …>/)` approach was fooled by `<link>`-looking text
  // inside comments/scripts and by attribute-value `>` characters.
  //
  // The `@layer …;` extraction below stays a regex: it parses CSS text (a
  // <style>'s body), not HTML structure, and there's no CSS DOM here — same as
  // the sibling helpers (collectLayerNames / layerOrderStatements).
  let statement: string | null = null;
  let styleFound = false; // a qualifying <style> has fully closed
  let linkBeforeStyle = false;
  let scriptBeforeStyle = false;
  let currentStyleText: string[] | null = null;

  new HTMLRewriter()
    .on("style", {
      element(el) {
        currentStyleText = [];
        el.onEndTag(() => {
          const text = (currentStyleText ?? []).join("");
          currentStyleText = null;
          if (styleFound) return; // first qualifying <style> wins
          const found = text.match(/@layer\s+[^{;]+;/);
          if (found?.[0]) {
            statement = found[0];
            styleFound = true;
          }
        });
      },
      text(t) {
        currentStyleText?.push(t.text);
      },
    })
    .on('link[rel~="stylesheet"]', {
      element() {
        if (!styleFound) linkBeforeStyle = true;
      },
    })
    .on('script[type="module"]', {
      element() {
        if (!styleFound) scriptBeforeStyle = true;
      },
    })
    .transform(html);

  // `statement` is written only inside the HTMLRewriter closure, which TS's
  // control-flow analysis can't see — it believes the value is always the
  // initial `null` and would narrow the else-branch below to `never`. Re-assert
  // the real type so the null check narrows correctly.
  const layerStatement = statement as string | null;
  if (layerStatement == null) {
    problems.push(
      `no inline <style> with an "@layer …;" ordering statement (expected ${CSS_LAYER_ORDER_STATEMENT})`,
    );
    return problems; // ordering checks below are meaningless without one
  }

  if (norm(layerStatement) !== norm(CSS_LAYER_ORDER_STATEMENT)) {
    problems.push(
      `inline layer order "${layerStatement.trim()}" does not match canonical "${CSS_LAYER_ORDER_STATEMENT}"`,
    );
  }

  if (linkBeforeStyle) {
    problems.push('a <link rel="stylesheet"> appears before the inline @layer statement');
  }

  if (scriptBeforeStyle) {
    problems.push('a <script type="module"> appears before the inline @layer statement');
  }

  return problems;
}
