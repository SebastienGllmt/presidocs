// Shiki transformers for the build-time code-highlight pass (proposal 34).
//
// BUILD-TIME ONLY. Like the rest of `generate/`, this must never be imported by
// a client or Worker-reachable module — Shiki's grammars/themes are megabytes of
// build data and the production Worker is a dumb static server (see methodology
// → Copy as Markdown for the same build-time-not-edge stance).
//
// Two transformers beyond the stock `@shikijs/transformers` (which already
// supply focus / highlight / word-highlight / diff, and — via
// `transformerNotationMap` — the `[!code create]` / `[!code spend]` semantic
// classes the pass composes):
//
//   - customTag(): the `@annotate:` / `@log:` / `@warn:` / `@error:` labeled
//     callouts. It rewrites a `// @annotate: message` comment line into a static
//     `<span class="line twoslash-tag-line twoslash-tag-annotate-line">message</span>`
//     inserted after the annotated line — the figures' pointer labels ("what
//     gets appended as a leaf"), as build-time HTML with no client JS. VENDORED
//     from vocs (see attribution below); it touches only the hast tree, so it
//     drops straight into a `@shikijs/core` `codeToHtml` transformers array
//     without vocs's React/MDX/rehype machinery.
//
//   - styleToClass(): converts Shiki's per-token inline `style="color:…"` into
//     classes plus a collected stylesheet, so the served HTML carries ZERO
//     inline styles and satisfies the production `style-src 'self'` CSP (which
//     forbids inline `style=` — including the `--shiki-*` custom-property form
//     Shiki's "css-variables" mode would still emit inline). The class names are
//     a deterministic function of the colour, so the same theme always yields
//     the same classes — the token-colour CSS ships as a committed stylesheet
//     keyed by exactly these names (see client/shikiTheme.css), not a per-page
//     inline `<style>`.
//
// ── Attribution ──────────────────────────────────────────────────────────────
// customTag() is adapted from vocs (MIT, © wevm) —
//   https://github.com/wevm/vocs  src/internal/shiki-transformers.ts
// Ported to TypeScript against `@shikijs/*` 4.x; behaviour and the
// `twoslash-tag-*-line` class names are preserved so the callout CSS matches.

import type { ShikiTransformer } from "@shikijs/core";
import type { Element, Text } from "hast";

// The callout tags vocs recognises, in the `@tag: message` comment form. (These
// render a full-width callout LINE; the struct figures instead use the overlay
// `@note…` labels — see codeAnnotations below — but the callouts stay available
// as a vendored feature.)
const CALLOUT_TAGS = ["error", "log", "warn", "annotate"] as const;
const TAG_PATTERN = new RegExp(`@(${CALLOUT_TAGS.join("|")}):\\s*(.+)`);

function textOf(element: Element): string {
  let text = "";
  for (const child of element.children) {
    if (child.type === "text") text += child.value;
    else if (child.type === "element") text += textOf(child);
  }
  return text;
}

/**
 * Labeled-callout transformer: `// @annotate: message` (or `@log:`/`@warn:`/
 * `@error:`) on its own comment line is removed and replaced — after the line it
 * followed — by a `twoslash-tag-<type>-line` callout span carrying the message.
 * Vendored from vocs (MIT); see the file header for attribution and rationale.
 */
export function customTag(): ShikiTransformer {
  return {
    name: "presidocs:custom-tag",
    code(code) {
      const lines = code.children.filter(
        (c): c is Element => c.type === "element",
      );
      const pending: Array<{ afterIndex: number; type: string; message: string }> = [];
      const toRemove: Element[] = [];

      lines.forEach((line, index) => {
        const match = textOf(line).match(TAG_PATTERN);
        if (!match) return;
        const [, type, message] = match as [string, string, string];
        pending.push({ afterIndex: index, type, message: message.trim() });
        toRemove.push(line);
      });
      if (pending.length === 0) return;

      // Drop the comment lines (and the trailing newline text node).
      for (const line of toRemove) {
        const at = code.children.indexOf(line);
        if (at === -1) continue;
        const next = code.children[at + 1];
        const span = next?.type === "text" && next.value === "\n" ? 2 : 1;
        code.children.splice(at, span);
      }

      // The removals shift later line indices; re-base each callout's anchor.
      const rebased = pending.map((tag) => {
        let afterIndex = tag.afterIndex;
        for (const removed of toRemove) {
          const ri = lines.indexOf(removed);
          if (ri !== -1 && ri <= tag.afterIndex) afterIndex--;
        }
        return { ...tag, afterIndex };
      });

      // Insert bottom-up so earlier insertions don't invalidate later indices.
      for (const tag of rebased.sort((a, b) => b.afterIndex - a.afterIndex)) {
        const current = code.children.filter(
          (c): c is Element => c.type === "element",
        );
        const target = current[tag.afterIndex];
        if (!target) continue;
        const targetIndex = code.children.indexOf(target);
        if (targetIndex === -1) continue;

        const callout: Element = {
          type: "element",
          tagName: "span",
          properties: {
            class: ["line", "twoslash-tag-line", `twoslash-tag-${tag.type}-line`],
          },
          children: [{ type: "text", value: tag.message }],
        };

        const newline: Text = { type: "text", value: "\n" };
        const next = code.children[targetIndex + 1];
        const insertAt =
          next?.type === "text" && next.value === "\n" ? targetIndex + 2 : targetIndex + 1;
        code.children.splice(insertAt, 0, callout, newline);
      }
    },
  };
}

// Overlay annotations: labels that float beside a specific code line rather
// than sitting in the code as a comment. The build pass extracts `// @note…:`
// trailing comments from the source BEFORE highlighting (so the text never
// tokenizes as code) and passes the surviving {lineIndex → {type, text}} map
// here; this transformer tints that line and appends an absolutely-positioned
// `<span class="code-anno …">` the CSS places at the line's right edge — the
// "non-Shiki annotation overlaid onto Shiki code" the struct figures use for
// their pointer labels. `type` is "note" (neutral), "create", or "spend".
export type LineNotes = Map<number, { type: string; text: string }>;

const NOTE_LINE_CLASS: Record<string, string> = {
  note: "highlighted",
  create: "tok-create",
  spend: "tok-spend",
};

export function codeAnnotations(notes: LineNotes): ShikiTransformer {
  return {
    name: "presidocs:code-annotations",
    code(code) {
      if (notes.size === 0) return;
      const lines = code.children.filter((c): c is Element => c.type === "element");
      for (const [index, note] of notes) {
        const line = lines[index];
        if (!line) continue;
        const lineClass = NOTE_LINE_CLASS[note.type] ?? "highlighted";
        const existing = line.properties?.class;
        const classes = Array.isArray(existing)
          ? existing.map(String)
          : typeof existing === "string"
            ? existing.split(" ")
            : [];
        line.properties = { ...line.properties, class: [...classes, lineClass] };
        line.children.push({
          type: "element",
          tagName: "span",
          properties: { class: ["code-anno", `code-anno-${note.type}`] },
          children: [{ type: "text", value: note.text }],
        });
      }
    },
  };
}

// Deterministic, stable class suffix for a given inline-style string. Same style
// → same class on every build and across every post, so the token-colour CSS can
// be a committed static file rather than per-page injected. (Not cryptographic;
// only needs to avoid collisions across a theme's ~30 distinct token styles.)
function styleHash(style: string): string {
  let h = 2166136261;
  for (let i = 0; i < style.length; i++) {
    h ^= style.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Elision marker: authors write `// ...` (a real comment — valid in the source,
// copies sensibly, and Shiki already colours it as a comment), but the leading
// `//` is visual noise for what's really just an "omitted fields" ellipsis. This
// rewrites the rendered text of a comment token that is exactly `// ...` down to
// `...`, keeping the comment colour. Source/Markdown twin keep the real `// ...`.
export function elisionComment(): ShikiTransformer {
  return {
    name: "presidocs:elision-comment",
    span(node) {
      const child = node.children[0];
      if (node.children.length !== 1 || child?.type !== "text") return;
      // The comment token includes the line's leading indentation; keep it and
      // drop only the `// ` marker so the ellipsis stays aligned with the fields.
      const m = child.value.match(/^(\s*)\/\/\s*\.\.\.\s*$/);
      if (m) child.value = `${m[1]}...`;
    },
  };
}

export type StyleToClass = ShikiTransformer & {
  /** CSS for every class this transformer emitted, e.g. `.shk-ab12{color:#24292e}`. */
  getCss(): string;
};

/**
 * Rewrites Shiki's inline `style="…"` (on token `<span>`s and the `<pre>`) into
 * classes, collecting the corresponding CSS. The served HTML ends up with no
 * inline styles — required under the production `style-src 'self'` CSP. Call
 * `getCss()` after highlighting to retrieve the class→style rules.
 */
export function styleToClass(prefix = "shk-"): StyleToClass {
  const cssByClass = new Map<string, string>();

  function classFor(style: string): string {
    const cls = prefix + styleHash(style);
    if (!cssByClass.has(cls)) cssByClass.set(cls, style);
    return cls;
  }

  function rewrite(node: Element): void {
    const style = node.properties?.style;
    if (typeof style !== "string" || style.length === 0) return;
    const cls = classFor(style);
    delete node.properties.style;
    const existing = node.properties.class;
    node.properties.class = Array.isArray(existing)
      ? [...existing, cls]
      : existing
        ? `${existing} ${cls}`
        : cls;
  }

  return {
    name: "presidocs:style-to-class",
    span(node) {
      rewrite(node);
    },
    pre(node) {
      rewrite(node);
    },
    getCss() {
      let css = "";
      for (const [cls, style] of cssByClass) css += `.${cls}{${style}}`;
      return css;
    },
  };
}
