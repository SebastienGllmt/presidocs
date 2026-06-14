// Build-time injection of discovery metadata into a post's served <head>:
// Schema.org JSON-LD (BlogPosting + AudioObject + Person + Organization),
// Open Graph, and a Twitter Card. This is the crawler/unfurl-facing counterpart
// to the client-rendered byline — search engines, chat unfurls (Slack/Discord/
// iMessage/LinkedIn), and LLM indexers read these tags, and Google's "Listen to
// this article" audio surface needs the BlogPosting→AudioObject linkage.
//
// Build-time, not runtime: same posture as injectAnalytics.ts — runs in the
// post-build rewrite over dist/ (server/createDevServer.ts serves un-rewritten
// source in dev, which is fine; crawlers hit prod). No new dependency, no
// source-HTML edits required.
//
// Title/description/lang/publisher are EXTRACTED from the post HTML (the data is
// already there); dates/audio/author/site-URL/card are PASSED IN by the caller
// (strip-served-html.ts), which has the disk + env context. The author Person
// is sourced from the same public profile the byline uses (shared/authorProfile)
// — so this file never sees the email either. `og:image`/`image` use the
// generated 1200x630 share card (generate/share-card.ts); the small author
// avatar is only the JSON-LD `Person.image`.
//
// Idempotent: if a JSON-LD block is already present, the whole inject is skipped.

import { parseHTML } from "linkedom";
import { decodeHtmlEntities } from "./htmlEntities.ts";
// Google's own typed Schema.org vocabulary (Apache-2.0). `import type` only, so
// it is fully erased at compile time — no runtime value, never bundled, never
// shipped (this whole module is the build-time `dist/` rewrite). It turns every
// `@type` and property name from an unchecked string into a `tsc`-checked one,
// so a `"BlogPosing"`/`acceptedAnswers` typo fails the build instead of silently
// shipping invalid JSON-LD that only Google's Rich Results Test would catch.
import type { WithContext, BlogPosting, BreadcrumbList, Person, ImageObject, WebSite, Blog, Graph } from "schema-dts";

// The generated share card is a fixed 1200x630 PNG (generate/share-card.ts).
// We know its dimensions here, so og:image:width/height and the JSON-LD
// ImageObject can advertise them without re-reading the file.
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

export type StructuredDataAuthor = {
  name: string;
  /** Public social links, e.g. { x: "https://x.com/Handle" }. */
  links: Record<string, string>;
  /** Absolute avatar URL, or null. Used only as the JSON-LD Person.image. */
  avatarUrl: string | null;
};

export type StructuredDataContext = {
  /** Canonical site origin, no trailing slash (e.g. "https://blog.example.com"). */
  siteUrl: string;
  /** Post path, e.g. "/posts/offer-files". */
  postPath: string;
  author: StructuredDataAuthor | null;
  /** ISO-8601 timestamps from versions.json (oldest build / newest build). */
  publishedAt: string | null;
  modifiedAt: string | null;
  /** Narration track, when the post has one. */
  audio: { url: string; durationMs: number } | null;
  /**
   * The generated 1200x630 share card for this post (`/assets/og/<slug>.png`),
   * or null when the card wasn't produced (the post declares its own og:image,
   * or share-card.ts didn't run). This is the default og:image / twitter:image /
   * JSON-LD image; a per-post og:image override still takes precedence.
   */
  cardUrl: string | null;
  /**
   * Absolute URL of the content (prose) license — JSON-LD `license`. Null when
   * `CONTENT_LICENSE` is unset (the field is then omitted; the engine imposes
   * no default — see shared/licenseConfig.ts). The post is prose,
   * so this is the *content* license; code samples are governed blog-level by
   * `LICENSE.md`, not per-post JSON-LD.
   */
  licenseUrl: string | null;
};

// Fields we read out of the post HTML in a single rewriter pass.
type Extracted = {
  title: string;
  description: string; // <meta name=description> wins over #lede
  lede: string;
  lang: string;
  publisher: string; // data-narration-artist (the site/publisher label)
  ogImageOverride: string | null;
  hasJsonLd: boolean;
};

function extract(html: string): Extracted {
  const out: Extracted = {
    title: "",
    description: "",
    lede: "",
    lang: "",
    publisher: "",
    ogImageOverride: null,
    hasJsonLd: html.includes("application/ld+json"),
  };
  let inTitle = false;
  let inLede = false;
  new HTMLRewriter()
    .on("html", {
      element(el) {
        out.lang = el.getAttribute("lang") ?? "";
      },
    })
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) out.title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        out.description = el.getAttribute("content") ?? "";
      },
    })
    .on("#lede", {
      element(el) {
        // onEndTag rather than `lastInTextNode` — a lede with descendant
        // elements (`<strong>`, etc.) splits its text across multiple nodes;
        // closing on the first chunk would truncate at the first child.
        inLede = true;
        el.onEndTag(() => {
          inLede = false;
        });
      },
      text(t) {
        if (inLede) out.lede += t.text;
      },
    })
    .on("[data-narration-artist]", {
      element(el) {
        if (!out.publisher) out.publisher = el.getAttribute("data-narration-artist") ?? "";
      },
    })
    .on('meta[property="og:image"]', {
      element(el) {
        out.ogImageOverride = el.getAttribute("content");
      },
    })
    .transform(html);
  return out;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Count words inside the post's <article>. Content-agnostic: strip scripts /
// styles / comments / remaining tags, split on whitespace. Approximate but
// stable across re-builds and well-defined for "minor SEO + LLM length signal"
// (Schema.org wordCount is a number, no precision spec). 0 when no <article>
// is present — the caller then omits the field.
export function countArticleWords(html: string): number {
  // Parse with linkedom (build-time only — see the module header) rather than a
  // chain of `<article>`/tag-stripping regexes: the regex truncated at a nested
  // `</article>`, mishandled `>` inside attribute values, and double-counted
  // entity text. `textContent` already excludes comment nodes; we only need to
  // drop <script>/<style> so their source isn't counted as prose.
  const article = parseHTML(html).document.querySelector("article");
  if (!article) return 0;
  for (const el of [...article.querySelectorAll("script, style")]) el.remove();
  // Collect text nodes and join with a space so element boundaries separate
  // words (textContent would merge `<h1>One Two</h1><p>three…` into "Twothree").
  // This mirrors the old "every tag becomes whitespace" behavior, faithfully.
  const parts: string[] = [];
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) parts.push(child.textContent ?? ""); // TEXT_NODE
      else if (child.nodeType === 1) walk(child); // ELEMENT_NODE
    }
  };
  walk(article);
  return parts.join(" ").split(/\s+/).filter(Boolean).length;
}

// Escape for use inside a double-quoted HTML attribute.
function attr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Milliseconds → ISO-8601 duration (e.g. 94096 → "PT1M34S"). Rounded to seconds.
function msToIsoDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  let out = "PT";
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  if (s || (!h && !m)) out += `${s}S`;
  return out;
}

// og:locale wants `xx_YY`; bare "en" → "en_US" is the well-tested default.
function toOgLocale(lang: string): string | null {
  if (!lang) return null;
  if (lang.includes("-")) return lang.replace("-", "_");
  if (lang.toLowerCase() === "en") return "en_US";
  return lang;
}

// Make an absolute URL: siteUrl already has no trailing slash; pathOrUrl is
// either an absolute URL (override) or a site-root-relative path.
function abs(siteUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${siteUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

// `https://x.com/Handle` → `@Handle` for twitter:creator.
function xCreator(xUrl: string | undefined): string | null {
  if (!xUrl) return null;
  const seg = xUrl.replace(/\/+$/, "").split("/").pop();
  return seg ? `@${seg}` : null;
}

export function injectStructuredData(
  html: string,
  ctx: StructuredDataContext,
): string {
  const ex = extract(html);
  // Idempotent — never inject twice (a re-run of the build, or pre-existing
  // hand-authored JSON-LD).
  if (ex.hasJsonLd) return html;

  const siteUrl = ctx.siteUrl.replace(/\/+$/, "");
  const url = `${siteUrl}${ctx.postPath}`;
  // Decode HTML entities (HTMLRewriter leaves them intact) before these
  // plain-text fields hit JSON.stringify / attribute escaping, or e.g.
  // `&mdash;` would double-encode to `&amp;mdash;` and render literally.
  const title = decodeHtmlEntities(collapseWs(ex.title));
  const description = decodeHtmlEntities(collapseWs(ex.description || ex.lede));
  const lang = ex.lang || "en";
  const publisher = decodeHtmlEntities(collapseWs(ex.publisher));
  // og:image is a REQUIRED Open Graph property. Per-post override wins; else the
  // generated 1200x630 card. `usingCard` distinguishes the card (whose dims we
  // know) from an override (whose dims we don't).
  const shareImage = ex.ogImageOverride
    ? abs(siteUrl, ex.ogImageOverride)
    : ctx.cardUrl
      ? abs(siteUrl, ctx.cardUrl)
      : null;
  const usingCard = !ex.ogImageOverride && !!ctx.cardUrl;

  // ---- JSON-LD (BlogPosting) ----
  // `name` is emitted alongside `headline` (the Schema.org canonical
  // BlogPosting example does this) because some consumers — generic LLM
  // indexers and tooling that walks Thing.name — key on `name` rather than
  // Article-specific fields.
  // `url` mirrors the canonical example (Article rich-result examples emit
  // a top-level `url` alongside `mainEntityOfPage`).
  // `isPartOf` ties this post to the Blog @graph node minted on the landing
  // page (`injectSiteStructuredData`), so a crawler that fetches both pages
  // sees one connected graph (one Blog, N BlogPostings) instead of two
  // unrelated documents. A bare `@id` reference is sufficient — the consumer
  // dereferences to the landing page's full Blog node.
  const ld: WithContext<BlogPosting> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    isPartOf: { "@type": "Blog", "@id": `${siteUrl}/#blog` },
    headline: title,
    name: title,
    inLanguage: lang,
  };
  if (description) ld.description = description;
  if (ctx.publishedAt) ld.datePublished = ctx.publishedAt;
  if (ctx.modifiedAt) ld.dateModified = ctx.modifiedAt;
  if (ctx.author) {
    const person: Person = {
      "@type": "Person",
      name: ctx.author.name,
    };
    const sameAs = Object.values(ctx.author.links).filter(Boolean);
    if (sameAs.length) person.sameAs = sameAs;
    if (ctx.author.avatarUrl) person.image = abs(siteUrl, ctx.author.avatarUrl);
    ld.author = person;
  }
  if (publisher) {
    ld.publisher = { "@type": "Organization", name: publisher };
  }
  // Licensing: `license` points at the content license's full text (proposal
  // 59); `copyrightHolder` reuses the author Person (or the publisher Org when
  // there's no author profile); `copyrightYear` is the publish year. All three
  // omit when their source is absent — `license` only appears once the operator
  // declares CONTENT_LICENSE, so the engine never asserts terms on a blog that
  // didn't choose them.
  if (ctx.licenseUrl) ld.license = ctx.licenseUrl;
  if (ctx.author) {
    ld.copyrightHolder = { "@type": "Person", name: ctx.author.name };
  } else if (publisher) {
    ld.copyrightHolder = { "@type": "Organization", name: publisher };
  }
  if (ctx.publishedAt) {
    const year = Number(ctx.publishedAt.slice(0, 4));
    if (Number.isFinite(year)) ld.copyrightYear = year;
  }
  // Google parses both a bare URL and an ImageObject; the object form (with
  // dimensions) is the documented-preferred shape for the Article rich result.
  // We only know the dims for our own card; an override stays a URL string.
  if (shareImage) {
    // Numeric width/height: the Google Article rich-result examples emit them as
    // plain integers and the validator accepts that, but strict Schema.org (and
    // schema-dts) type the `width`/`height` Distance properties as
    // string|QuantitativeValue, not a bare number. We keep the numbers
    // (changing them would alter the emitted JSON, which is out of scope), so
    // this one deliberately-non-canonical node carries a documented cast — the
    // type still guards the surrounding graph; only the dimensions opt out.
    ld.image = usingCard
      ? ({ "@type": "ImageObject", url: shareImage, width: CARD_WIDTH, height: CARD_HEIGHT } as unknown as ImageObject)
      : shareImage;
  }
  if (ctx.audio) {
    ld.audio = {
      "@type": "AudioObject",
      "@id": `${url}#audio`,
      contentUrl: abs(siteUrl, ctx.audio.url),
      encodingFormat: "audio/mpeg",
      duration: msToIsoDuration(ctx.audio.durationMs),
      name: title ? `${title} (narrated)` : "Narration",
      inLanguage: lang,
    };
  }
  // wordCount: free length signal for SEO + LLM context — counted from the
  // article body the injector already parses. Omitted when no <article>
  // (the count would be 0 and misleading).
  const wordCount = countArticleWords(html);
  if (wordCount > 0) ld.wordCount = wordCount;
  // speakable: marks the read-aloud-worthy sections for voice surfaces (Google
  // Assistant et al.). Especially apt for an audio-first blog. Conservative
  // selectors: the `<h1>` and the `#lede` paragraph — never the full article.
  ld.speakable = {
    "@type": "SpeakableSpecification",
    cssSelector: ["#lede", "h1"],
  };
  // Escape `<` so the JSON can never break out of the <script> element.
  const ldJson = JSON.stringify(ld).replace(/</g, "\\u003c");

  // BreadcrumbList: the site is two levels deep (no /posts index page), so the
  // trail is just landing → this post. Thin, but it names the parent surface
  // for search/LLM consumers either way (methodology → Site-level discovery).
  // Its own script
  // block (not folded into the BlogPosting): Google parses multiple ld+json
  // scripts, and the breadcrumb is a page property, not an article property.
  // The landing crumb is named by the publisher (the blog's name) when known —
  // a literal "Home" would be English-only on a `lang`-declared page.
  const breadcrumb: WithContext<BreadcrumbList> = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumb`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: publisher || "Home", item: `${siteUrl}/` },
      // Last crumb = the current page: per Google's breadcrumb guidance the
      // `item` URL is omitted (the page's canonical already names it).
      { "@type": "ListItem", position: 2, name: title || url },
    ],
  };
  const breadcrumbJson = JSON.stringify(breadcrumb).replace(/</g, "\\u003c");

  // ---- Open Graph + Twitter Card meta tags ----
  const tags: string[] = [];
  const meta = (prop: string, content: string, kind: "property" | "name" = "property") =>
    tags.push(`<meta ${kind}="${prop}" content="${attr(content)}" />`);

  tags.push(`<link rel="canonical" href="${attr(url)}" />`);
  // Plain <meta name="description"> for the search-snippet surface. Lighthouse's
  // SEO `meta-description` audit checks this exact tag — og:/twitter:/JSON-LD
  // descriptions don't satisfy it. Emit only when the post didn't author its
  // own: `ex.description` is sourced solely from an existing tag (extract():99),
  // so a non-empty value means one is already present and we must not duplicate.
  // When absent, `description` falls back to the lede — the same text the og/
  // twitter/JSON-LD descriptions already use.
  if (description && !ex.description) meta("description", description, "name");
  meta("og:type", "article");
  if (title) meta("og:title", title);
  if (description) meta("og:description", description);
  meta("og:url", url);
  if (publisher) meta("og:site_name", publisher);
  const locale = toOgLocale(lang);
  if (locale) meta("og:locale", locale);
  // Only emit our own og:image when the source didn't already declare one —
  // otherwise the author's per-post override tag stays and we'd duplicate it.
  // (JSON-LD `image` / `twitter:image` below still use the resolved shareImage.)
  if (shareImage && !ex.ogImageOverride) {
    meta("og:image", shareImage);
    // og:image:alt SHOULD accompany every og:image (OG "Structured Properties").
    // The post title describes the card (blog name + title + author).
    if (title) meta("og:image:alt", title);
    // The card's size is fixed and known, so advertise it — unfurlers can lay
    // out the card without first fetching the image.
    if (usingCard) {
      meta("og:image:width", String(CARD_WIDTH));
      meta("og:image:height", String(CARD_HEIGHT));
    }
  }
  if (ctx.audio) {
    const audioUrl = abs(siteUrl, ctx.audio.url);
    meta("og:audio", audioUrl);
    meta("og:audio:secure_url", audioUrl);
    meta("og:audio:type", "audio/mpeg");
  }
  if (ctx.publishedAt) meta("article:published_time", ctx.publishedAt);
  if (ctx.modifiedAt) meta("article:modified_time", ctx.modifiedAt);
  // article:author is typed as a profile URL (OG Article type → "profile array"),
  // not a display name. Emit the author's X/website profile; the human-readable
  // name is still carried by JSON-LD author.name and twitter:creator.
  const authorUrl = ctx.author?.links.x ?? ctx.author?.links.website ?? null;
  if (authorUrl) meta("article:author", authorUrl);

  // The generated card and any wide override are large-format; only fall back to
  // the small `summary` when there's no share image at all. Twitter falls back
  // to OG for unset fields.
  meta("twitter:card", shareImage ? "summary_large_image" : "summary", "name");
  if (title) meta("twitter:title", title, "name");
  if (description) meta("twitter:description", description, "name");
  if (shareImage) meta("twitter:image", shareImage, "name");
  const creator = xCreator(ctx.author?.links.x);
  if (creator) meta("twitter:creator", creator, "name");

  const block =
    `<script type="application/ld+json">${ldJson}</script>` +
    `<script type="application/ld+json">${breadcrumbJson}</script>` +
    tags.join("");

  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(block, { html: true });
      },
    })
    .transform(html);
}

// ============================================================================
// Landing-page (the "blog in general") structured data.
//
// The per-post injector above short-circuits any HTML without a versions.json
// record, so the landing page would otherwise carry NO JSON-LD, OG, or
// description — to a structured-data consumer the homepage is semantically
// empty. This is the parallel injector for that case: WebSite + Blog @graph
// JSON-LD, OG (og:type=website), a meta description, and the same emailless
// Person/Organization a post uses. Same SITE_URL gate; same idempotent skip.
//
// Search action: NOT emitted — the engine has no site-search endpoint to
// advertise (a SearchAction pointing nowhere is worse than omitting it). Add
// it only if a search route is ever introduced.
// ============================================================================

export type SiteStructuredDataContext = {
  /** Canonical site origin, no trailing slash. */
  siteUrl: string;
  /** Same public Person used in post bylines / JSON-LD; emailless. */
  author: StructuredDataAuthor | null;
  /**
   * Publisher/`og:site_name` label. The single source is the same one posts
   * use (the `data-narration-artist` value), passed in by the build so this
   * injector stays content-agnostic. Empty string omits the field.
   */
  publisher: string;
  /**
   * Optional dedicated landing-page share card path (`/assets/og/_site.png`).
   * No site card today, so this is null in practice — wired so the future
   * "site card" entry point doesn't require touching this signature again.
   */
  cardUrl: string | null;
  /**
   * Content (prose) license URL for the Blog/WebSite `license`. Null when
   * `CONTENT_LICENSE` is unset (the field is omitted). Same source and posture
   * as the per-post `licenseUrl` — see methodology → Licensing: content vs code.
   */
  licenseUrl: string | null;
};

type SiteExtracted = {
  title: string;
  metaDescription: string;
  firstParagraph: string;
  lang: string;
  ogImageOverride: string | null;
  hasJsonLd: boolean;
  hasDescription: boolean;
};

function extractSite(html: string): SiteExtracted {
  const out: SiteExtracted = {
    title: "",
    metaDescription: "",
    firstParagraph: "",
    lang: "",
    ogImageOverride: null,
    hasJsonLd: html.includes("application/ld+json"),
    hasDescription: false,
  };
  let inTitle = false;
  let inP = false;
  new HTMLRewriter()
    .on("html", {
      element(el) {
        out.lang = el.getAttribute("lang") ?? "";
      },
    })
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) out.title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        out.hasDescription = true;
        out.metaDescription = el.getAttribute("content") ?? "";
      },
    })
    .on("main p", {
      element(el) {
        // First <main> <p> only. onEndTag (not `lastInTextNode`) so a <p> with
        // descendant elements doesn't get truncated at the first child — see
        // readSiteMeta() in generate/feeds.ts for the same fix.
        if (!out.firstParagraph && !inP) {
          inP = true;
          el.onEndTag(() => {
            inP = false;
          });
        }
      },
      text(t) {
        if (inP) out.firstParagraph += t.text;
      },
    })
    .on('meta[property="og:image"]', {
      element(el) {
        out.ogImageOverride = el.getAttribute("content");
      },
    })
    .transform(html);
  return out;
}

export function injectSiteStructuredData(
  html: string,
  ctx: SiteStructuredDataContext,
): string {
  const ex = extractSite(html);
  if (ex.hasJsonLd) return html;

  const siteUrl = ctx.siteUrl.replace(/\/+$/, "");
  const title = decodeHtmlEntities(collapseWs(ex.title));
  const description = decodeHtmlEntities(
    collapseWs(ex.metaDescription || ex.firstParagraph),
  );
  const lang = ex.lang || "en";
  const publisher = decodeHtmlEntities(collapseWs(ctx.publisher));
  const shareImage = ex.ogImageOverride
    ? abs(siteUrl, ex.ogImageOverride)
    : ctx.cardUrl
      ? abs(siteUrl, ctx.cardUrl)
      : null;
  const usingCard = !ex.ogImageOverride && !!ctx.cardUrl;

  // ---- JSON-LD: WebSite + Blog @graph ----
  // The two are linked: the WebSite's `mainEntity` is the Blog node (the
  // inverse of `mainEntityOfPage`, per Schema.org's mainEntity background
  // notes — makes the @graph genuinely connected instead of two parallel
  // nodes), and both share the same author Person / publisher Organization
  // the posts already use.
  const webSite: WebSite = {
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    url: `${siteUrl}/`,
    name: title || publisher || "Blog",
    inLanguage: lang,
    mainEntity: { "@id": `${siteUrl}/#blog` },
  };
  if (description) webSite.description = description;
  if (publisher) {
    webSite.publisher = { "@type": "Organization", name: publisher };
  }

  const blog: Blog = {
    "@type": "Blog",
    "@id": `${siteUrl}/#blog`,
    url: `${siteUrl}/`,
    name: title || publisher || "Blog",
    inLanguage: lang,
  };
  if (description) blog.description = description;
  if (ctx.author) {
    const person: Person = {
      "@type": "Person",
      name: ctx.author.name,
    };
    const sameAs = Object.values(ctx.author.links).filter(Boolean);
    if (sameAs.length) person.sameAs = sameAs;
    if (ctx.author.avatarUrl) person.image = abs(siteUrl, ctx.author.avatarUrl);
    blog.author = person;
  }
  if (publisher) {
    blog.publisher = { "@type": "Organization", name: publisher };
  }
  // Blog-level licensing: the same content-license URL and
  // copyright holder the posts carry, on the Blog node a crawler reads for the
  // site as a whole. Omitted when CONTENT_LICENSE / author are absent.
  if (ctx.licenseUrl) blog.license = ctx.licenseUrl;
  if (ctx.author) {
    blog.copyrightHolder = { "@type": "Person", name: ctx.author.name };
  } else if (publisher) {
    blog.copyrightHolder = { "@type": "Organization", name: publisher };
  }
  if (shareImage) {
    // Documented cast for the numeric ImageObject dimensions — see the matching
    // note in injectStructuredData() above.
    blog.image = usingCard
      ? ({ "@type": "ImageObject", url: shareImage, width: CARD_WIDTH, height: CARD_HEIGHT } as unknown as ImageObject)
      : shareImage;
  }

  const graph: Graph = {
    "@context": "https://schema.org",
    "@graph": [webSite, blog],
  };
  const ldJson = JSON.stringify(graph).replace(/</g, "\\u003c");

  // ---- OG + a fallback meta description ----
  const tags: string[] = [];
  const meta = (prop: string, content: string, kind: "property" | "name" = "property") =>
    tags.push(`<meta ${kind}="${prop}" content="${attr(content)}" />`);

  // Only add a meta description if the source doesn't already have one — never
  // duplicate (some crawlers downrank conflicting descriptions).
  if (description && !ex.hasDescription) {
    meta("description", description, "name");
  }
  meta("og:type", "website");
  if (title) meta("og:title", title);
  if (description) meta("og:description", description);
  meta("og:url", `${siteUrl}/`);
  if (publisher) meta("og:site_name", publisher);
  const locale = toOgLocale(lang);
  if (locale) meta("og:locale", locale);
  if (shareImage && !ex.ogImageOverride) {
    meta("og:image", shareImage);
    if (title) meta("og:image:alt", title);
    if (usingCard) {
      meta("og:image:width", String(CARD_WIDTH));
      meta("og:image:height", String(CARD_HEIGHT));
    }
  }
  meta("twitter:card", shareImage ? "summary_large_image" : "summary", "name");
  if (title) meta("twitter:title", title, "name");
  if (description) meta("twitter:description", description, "name");
  if (shareImage) meta("twitter:image", shareImage, "name");
  const creator = xCreator(ctx.author?.links.x);
  if (creator) meta("twitter:creator", creator, "name");

  const block = `<script type="application/ld+json">${ldJson}</script>` + tags.join("");
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(block, { html: true });
      },
    })
    .transform(html);
}
