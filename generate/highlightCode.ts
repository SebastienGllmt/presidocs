// Build-time code-block highlighting pass (proposal 34).
//
// Finds every `<pre><code class="language-X">…</code></pre>` ANYWHERE in a
// post's HTML — in prose flow, inside a `<figure>`, or inside a composite figure
// alongside other markup (the three patterns in proposal 34) — and rewrites the
// code into Shiki-highlighted, CSP-safe markup. Position-agnostic by
// construction (we match the element wherever it sits) and idempotent (an
// already-highlighted block carries `class="shiki-code"`, no `language-`, so a
// second run skips it).
//
// BUILD-TIME ONLY. Shiki's grammars/themes are megabytes of build data; this
// module must never enter the client bundle or the production Worker (the
// dumb-edge rule). It rides the one shared HTML seam that runs in BOTH dev and
// the prod build — `shared/bunHtmlHeadPlugin.ts` — so dev and prod render
// identically, and nothing Shiki reaches `server/createWorker.ts`.
//
// Surgical, not a round-trip: like `shared/stripServedHtml.ts` we use Bun's
// `HTMLRewriter`, which streams the page through untouched except for the code
// elements — a whole-document linkedom re-serialization perturbs ~400 bytes of
// a real post (SVG/whitespace normalization) and is the wrong tool for a
// serving transform. Two phases because Shiki is async and HTMLRewriter wants
// the full code text before it can highlight: phase 1 collects each block's
// source, we highlight off-line, phase 2 swaps the results back in.
//
// Output shape: the authored `<code class="language-rust">` becomes
// `<code class="shiki-code" data-lang="rust">…token spans…</code>`, its inner
// replaced by Shiki's line/token spans. Token colours are classes (never inline
// `style=`, which prod CSP `style-src 'self'` would strip) defined by the
// committed stylesheet (client/shikiCode.css); block typography is keyed off
// `code.shiki-code` there too, so we never need to touch the wrapping `<pre>`.

import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationMap,
  transformerNotationWordHighlight,
  transformerRemoveLineBreak,
} from "@shikijs/transformers";
import { decodeHTML } from "entities";
import { codeAnnotations, customTag, elisionComment, styleToClass, tokenColors, type LineNotes } from "./shikiTransformers.ts";

const THEME = "github-light";
// Languages whose grammar we load. A `language-X` block in any other language is
// left untouched (bare) rather than mis-highlighted. Grow as content needs it.
const SUPPORTED_LANGS = new Set(["rust"]);

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    langs: [import("@shikijs/langs/rust")],
    themes: [import("@shikijs/themes/github-light")],
    // The JS regex engine handles the Rust grammar (incl. generics) without the
    // Oniguruma WASM dependency; `forgiving` downgrades a rare unsupported
    // grammar regex to a no-op instead of throwing the whole build.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}

// The composed transformer stack. The stock `@shikijs/transformers` supply the
// in-code notations: `// [!code focus]` (dim the rest), `[!code highlight]`
// (field-row box), `[!code word:foo]`, diff `[!code ++/--]`, and via
// `transformerNotationMap` the semantic `[!code create]` / `[!code spend]`
// classes (transient-struct's green/purple). `customTag` adds the `@annotate:`
// pointer-label callouts. `styleToClass` runs last and de-inlines token styles
// for CSP. A fresh stack per call keeps the stateful `styleToClass` isolated.
function buildTransformers(s2c: ReturnType<typeof styleToClass>, notes: LineNotes) {
  return [
    // Overlay labels first, so it indexes the original source lines before
    // customTag can insert any callout lines and shift them.
    codeAnnotations(notes),
    tokenColors(),
    transformerNotationFocus(),
    transformerNotationHighlight(),
    transformerNotationWordHighlight(),
    transformerNotationDiff(),
    transformerNotationMap({ classMap: { create: "tok-create", spend: "tok-spend", ref: "tok-ref" } }, "presidocs:semantic"),
    customTag(),
    elisionComment(),
    // Drop the `\n` text nodes Shiki puts between lines. Our CSS makes each
    // `.line` a block (so line tints span the full width), and without this the
    // leftover newlines render as extra blank rows in the <pre> — double-spacing.
    transformerRemoveLineBreak(),
    s2c,
  ];
}

// Pull the inner of Shiki's single `<pre><code>…</code></pre>` — string-slicing
// our OWN controlled output, not authored HTML. We keep only the token/line
// spans; block background/padding come from our CSS on `code.shiki-code`, not
// Shiki's `<pre>` class.
function codeInnerOf(shikiHtml: string): string {
  const codeOpen = shikiHtml.indexOf(">", shikiHtml.indexOf("<code")) + 1;
  const codeClose = shikiHtml.lastIndexOf("</code>");
  return shikiHtml.slice(codeOpen, codeClose);
}

// Strip a single leading newline (authors usually open `<code>` then break to a
// fresh line) and any trailing whitespace, without touching the first line's
// real indentation.
function normalizeSource(raw: string): string {
  return decodeHTML(raw).replace(/^\r?\n/, "").replace(/\s+$/, "");
}

// Pull `// @note…: text` overlay annotations out of the source BEFORE Shiki sees
// it, so the label text never tokenizes as code. Returns the cleaned source plus
// a {lineIndex → {type, text}} map for codeAnnotations to re-inject as overlays.
const NOTE_RE = /^(.*?)\s*\/\/\s*@note(?:-(create|spend))?:\s*(.+?)\s*$/;
function extractNotes(source: string): { cleaned: string; notes: LineNotes } {
  const notes: LineNotes = new Map();
  const cleaned = source
    .split("\n")
    .map((line, i) => {
      const m = line.match(NOTE_RE);
      if (!m) return line;
      notes.set(i, { type: m[2] ?? "note", text: m[3]!.trim() });
      return m[1]!.replace(/\s+$/, "");
    })
    .join("\n");
  return { cleaned, notes };
}

/** Highlight one source string. Returns the `<code>` inner spans + the token CSS. */
export async function highlightOne(source: string, lang: string): Promise<{ inner: string; css: string }> {
  const hl = await getHighlighter();
  const s2c = styleToClass();
  const { cleaned, notes } = extractNotes(source);
  const html = hl.codeToHtml(cleaned, { lang, theme: THEME, transformers: buildTransformers(s2c, notes) });
  return { inner: codeInnerOf(html), css: s2c.getCss() };
}

function langOf(classAttr: string | null | undefined): string | null {
  const m = (classAttr ?? "").match(/\blanguage-([\w-]+)/);
  return m?.[1] ?? null;
}

/**
 * Rewrite every supported `<pre><code class="language-X">` in `html` into
 * Shiki-highlighted markup. Idempotent; a no-op (returns the input) when the
 * page has no fenced code. Unsupported languages are left bare.
 */
export async function highlightCodeInHtml(html: string): Promise<string> {
  // Cheap string guard (not HTML parsing) — most pages have no code at all.
  if (!/<code[^>]*\bclass="[^"]*language-/i.test(html)) return html;

  // Phase 1 — collect each `<pre><code>`'s language + raw source, in document
  // order. (Already-highlighted blocks carry no `language-`, so they collect a
  // null lang and are skipped in phase 2 — that's the idempotency guard.)
  type Block = { lang: string | null; raw: string };
  const blocks: Block[] = [];
  let active: Block | null = null;
  await new HTMLRewriter()
    .on("pre > code", {
      element(el) {
        active = { lang: langOf(el.getAttribute("class")), raw: "" };
        blocks.push(active);
      },
      text(t) {
        if (active) active.raw += t.text;
      },
    })
    .transform(new Response(html))
    .text();

  // Highlight off-line (async), aligned with phase-1 order. Null = leave bare.
  const rendered = await Promise.all(
    blocks.map(async (b) => {
      if (!b.lang || !SUPPORTED_LANGS.has(b.lang)) return null;
      const { inner } = await highlightOne(normalizeSource(b.raw), b.lang);
      return { inner, lang: b.lang };
    }),
  );

  // Phase 2 — swap the highlighted inner back in, in the same element order.
  let i = 0;
  return await new HTMLRewriter()
    .on("pre > code", {
      element(el) {
        const out = rendered[i++];
        if (!out) return;
        el.setInnerContent(out.inner, { html: true });
        el.setAttribute("class", "shiki-code");
        el.setAttribute("data-lang", out.lang);
      },
    })
    .transform(new Response(html))
    .text();
}
