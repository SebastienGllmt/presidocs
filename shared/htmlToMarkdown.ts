// Pure HTML → Markdown transform for the "Copy as Markdown" feature
// (methodology.md → "Copy as Markdown", proposal 30). Turns one post's HTML
// into clean Markdown an LLM can ingest — figures collapsed to their caption
// text, runtime chrome dropped, the article body serialized.
//
// Like shared/annotationExport.ts this is a *pure* transform: HTML string in,
// `{ markdown, title }` out. No filesystem, no network, no Worker — it runs in
// the build step (generate/markdown-export.ts), in the dev server route, and is
// trivially golden-testable (htmlToMarkdown.test.ts). It is deliberately NOT a
// Worker route: production's dumb-server rule means no per-request rendering on
// the edge; the Markdown is a build artifact served as a static file.
//
// Why we extract at *build/source* time, not from the live browser DOM: reader
// engines (Firefox Readability, Chrome reading mode) run on the post-JS DOM,
// where the comment column (`<aside id="cmt-column">`), the populated narration
// dock, and the enhanced interactive figures all exist and must be fought off.
// The source/served HTML is already the clean version — the comment aside isn't
// created yet, the dock is empty, and each figure is still its static
// `<svg role="img" aria-label>` fallback. So the only structural work is
// collapsing `<figure>` to text; everything else is just "serialize the
// article." See proposal 30 §1–§2.
//
// We still run Mozilla's Readability (the actual Firefox engine) as the
// extractor — it robustly finds the article root and strips stray chrome on
// arbitrary authored HTML — but guard it: a short post fails Readability's
// readerability check (it returns null, or keeps too little), so we fall back
// to the post's own marked article root (`[data-narration-src]` / role="main")
// and serialize that. Either way the figure/chrome pre-clean below has already
// run, so the two paths converge on the same simplified DOM.

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { strikethrough, tables, taskListItems } from "@joplin/turndown-plugin-gfm";
import { stringify } from "yaml";

export type MarkdownExtract = {
  /** The post title (its `<h1 id="title">`, falling back to `<title>`). */
  title: string;
  /** The article body as Markdown. Does NOT include the title or front matter. */
  markdown: string;
  /** Whether Readability's extraction was used (false → article-root fallback). */
  usedReadability: boolean;
};

// Runtime / engine-injected chrome that has no place in the article Markdown.
// Most of these are absent from build-time HTML (they're created by the client
// modules at runtime), but we strip them defensively so the same transform is
// correct if ever pointed at a post-JS DOM (e.g. a future live-DOM caller) or
// at source HTML that an author hand-wrote one into.
const CHROME_SELECTORS = [
  ".narrate-dock", // narration player dock (sibling of <article>)
  "#cmt-column", // comments margin column (client/comments.ts)
  ".cmt-hide-all-fab", // mobile hide-all-comments button
  ".byline", // author byline (client/byline.ts) — author metadata, not prose
  ".author-cta", // follow-the-author CTA
  ".engine-attribution", // "Built with presidocs" line
  "script",
  "style",
  "noscript",
  "template",
  '[aria-hidden="true"]',
  "[hidden]",
].join(",");

// Find the post's authored content root. `[data-narration-src]` is the article
// element every post carries (the same selector byline/headerLinks/comments
// anchor to); role="main" is the served-HTML landmark; <article> and <body>
// are last-ditch fallbacks so a malformed post still yields *something*.
function findArticleRoot(doc: Document): Element {
  return (
    doc.querySelector("[data-narration-src]") ??
    doc.querySelector('[role="main"]') ??
    doc.querySelector("article") ??
    doc.body
  );
}

// The post title: the visible `<h1 id="title">` an author writes, falling back
// to the document `<title>`. We render this ourselves as the Markdown's top
// `# heading`, so the title-h1 is removed from the body during pre-clean (and
// Readability removes it independently) — no duplicate headline.
function extractTitle(doc: Document, root: Element): string {
  const h1 = root.querySelector("h1");
  const fromH1 = h1?.textContent?.trim();
  if (fromH1) return fromH1;
  const fromTitle = doc.querySelector("title")?.textContent?.trim();
  return fromTitle ?? "";
}

// Replace a `<figure>` with a one-line caption note. Interactive SVG/canvas
// figures don't survive a flatten to Markdown, but the `<figcaption>` (or the
// static SVG's `aria-label`, which we author for accessibility anyway) carries
// what the figure was *saying* — exactly the payload an LLM can use. Rendered as
// an emphasised blockquote so it reads as an aside, not body prose.
function figureCaption(figure: Element): string {
  const cap = figure.querySelector("figcaption")?.textContent?.trim();
  if (cap) return cap;
  const labelled = figure.querySelector("[aria-label]");
  const aria = labelled?.getAttribute("aria-label")?.trim();
  return aria ?? "";
}

// Mutate `doc` in place into the simplified DOM both extraction paths share:
// title-h1 removed, every `<figure>` collapsed to a caption note, all runtime
// chrome stripped. Operates document-wide (not just the article root) so the
// dock — a *sibling* of <article> — is gone before Readability scores siblings.
function preClean(doc: Document, root: Element): void {
  // Drop the title-h1 (we emit the title ourselves). Match by id first, then
  // the root's first h1, so a post without `id="title"` still de-dupes.
  const titleH1 =
    root.querySelector("h1#title") ?? root.querySelector("h1");
  titleH1?.remove();

  for (const figure of [...doc.querySelectorAll("figure")]) {
    const caption = figureCaption(figure);
    const note = doc.createElement("blockquote");
    note.className = "x-figure-note";
    const p = doc.createElement("p");
    const em = doc.createElement("em");
    em.textContent = caption ? `Figure: ${caption}` : "Figure (omitted).";
    p.appendChild(em);
    note.appendChild(p);
    figure.replaceWith(note);
  }

  for (const el of [...doc.querySelectorAll(CHROME_SELECTORS)]) {
    el.remove();
  }
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx", // `## Heading`, not underline style
    codeBlockStyle: "fenced", // ```lang fences, not 4-space indent
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
    linkStyle: "inlined",
  });
  // GFM extensions beyond CommonMark (via @joplin/turndown-plugin-gfm): pipe
  // tables, `~~strikethrough~~`, and task-list items. Without these Turndown has
  // no `<table>` rule, so a table is flattened into a structureless run-on line
  // (its cell text concatenated) — see proposal 23 / methodology "Copy as
  // Markdown". Scoped to exactly these three rules; no autolinks etc.
  td.use([tables, strikethrough, taskListItems]);
  // Any stray inline SVG that survived (figures are pre-collapsed, but a
  // decorative icon SVG elsewhere — including inside a table cell — shouldn't
  // dump its path data into the text). Registered after the GFM rules; an `svg`
  // node only matches this removal, so cell SVGs still drop.
  td.remove(["svg" as keyof HTMLElementTagNameMap]);
  return td;
}

/**
 * Convert one post's HTML into `{ title, markdown }`. Pure: no IO. The caller
 * (build step / dev route) adds the front-matter header and writes the file.
 */
export function htmlToMarkdown(html: string): MarkdownExtract {
  // Two independent parses: Readability mutates the document it's handed, so
  // the fallback root must come from a separate, un-consumed parse.
  const fallbackDoc = parseHTML(html).document as unknown as Document;
  const readabilityDoc = parseHTML(html).document as unknown as Document;

  const fallbackRoot = findArticleRoot(fallbackDoc);
  const title = extractTitle(fallbackDoc, fallbackRoot);

  preClean(fallbackDoc, fallbackRoot);
  preClean(readabilityDoc, findArticleRoot(readabilityDoc));

  const fallbackHtml = fallbackRoot.innerHTML;
  const fallbackTextLen = (fallbackRoot.textContent ?? "").replace(/\s+/g, " ").trim().length;

  // Run Readability over the pre-cleaned document. Accept its result only when
  // it kept a substantial share of the article text — this rejects both the
  // null (too-short post) case and the rare case where its heuristics drop a
  // real section as boilerplate. Otherwise serialize the article root directly.
  let contentHtml = fallbackHtml;
  let usedReadability = false;
  try {
    const parsed = new Readability(readabilityDoc, { keepClasses: false }).parse();
    const parsedTextLen = (parsed?.textContent ?? "").replace(/\s+/g, " ").trim().length;
    if (parsed?.content && parsedTextLen >= fallbackTextLen * 0.5) {
      contentHtml = parsed.content;
      usedReadability = true;
    }
  } catch {
    // Readability can throw on pathological DOMs; the fallback covers it.
  }

  const markdown = makeTurndown().turndown(contentHtml).trim();
  return { title, markdown, usedReadability };
}

export type FrontMatter = {
  title: string;
  /** Canonical absolute URL of the post, when SITE_URL is known. */
  url?: string;
  /** ISO date the post was last updated (versions.json `builtAt`). */
  updated?: string;
};

// Assemble the final `.md` document: a small YAML front-matter block (title,
// source URL, last-updated) followed by the article Markdown. The front matter
// gives a pasted-into-an-LLM document its provenance without the body having to
// repeat the title heading.
//
// The block is serialized by `yaml` (eemeli, ISC, build-time only — already a
// transitive of openapi3-ts, so zero install footprint; never the client bundle
// or the production Worker). It implements the YAML scalar grammar properly:
// where the previous hand-rolled `yamlScalar()` heuristic emitted a title of
// `true`/`null`/`2026` bare — so a strict consumer parsed `title:` as a boolean,
// null, or number instead of the string the author wrote — and silently broke
// the `---` block on an embedded newline/tab, `stringify` quotes (or block-folds)
// exactly the values that need it so the provenance header always round-trips as
// the string it denotes. Insertion order (title → source → updated) is the
// emitted field order.
export function renderMarkdownDocument(extract: MarkdownExtract, fm: FrontMatter): string {
  const title = (fm.title || extract.title).trim();
  const data: Record<string, string> = { title };
  if (fm.url) data.source = fm.url;
  if (fm.updated) data.updated = fm.updated;
  const front = stringify(data).trimEnd();
  const lines: string[] = ["---", front, "---", ""];
  if (title) lines.push(`# ${title}`, "");
  lines.push(extract.markdown, "");
  return lines.join("\n");
}
