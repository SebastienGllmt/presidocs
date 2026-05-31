import { test, expect } from "bun:test";
import {
  injectStructuredData,
  injectSiteStructuredData,
  countArticleWords,
  type StructuredDataContext,
  type SiteStructuredDataContext,
} from "./injectStructuredData.ts";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Offer Files: shared liquidity without a chain</title>
<link rel="stylesheet" href="../engine/client/base.css" />
</head>
<body>
<article data-narration-src="/generated/offer-files/manifest.json"
         data-narration-artist="presidocs">
  <h1 id="title">Offer Files</h1>
  <p id="lede" class="lede">How offer files turn a private swap into a plain
     text file you can paste anywhere.</p>
</article>
</body>
</html>`;

const CTX: StructuredDataContext = {
  siteUrl: "https://blog.example.com",
  postPath: "/posts/offer-files",
  author: {
    name: "Sebastien Guillemot",
    links: { x: "https://x.com/SebastienGllmt" },
    avatarUrl: "/assets/authors/sebastiengllmt.png",
  },
  publishedAt: "2026-05-22T18:40:13.120Z",
  modifiedAt: "2026-05-30T02:27:47.354Z",
  audio: { url: "/generated/offer-files/full.f2985f8c0b4fd293.mp3", durationMs: 2454530 },
  cardUrl: "/assets/og/offer-files.png",
};

function jsonLd(html: string): any {
  const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (!m) throw new Error("no JSON-LD block");
  return JSON.parse(m[1]!.replace(/\\u003c/g, "<"));
}

test("emits a BlogPosting with audio, author Person, dates, and publisher", () => {
  const out = injectStructuredData(HTML, CTX);
  const ld = jsonLd(out);
  expect(ld["@type"]).toBe("BlogPosting");
  // headline is the <title>, not the <h1> (per the proposal's data sources).
  expect(ld.headline).toBe("Offer Files: shared liquidity without a chain");
  expect(ld.description).toContain("private swap");
  expect(ld.inLanguage).toBe("en");
  expect(ld.datePublished).toBe("2026-05-22T18:40:13.120Z");
  expect(ld.dateModified).toBe("2026-05-30T02:27:47.354Z");
  expect(ld.author).toEqual({
    "@type": "Person",
    name: "Sebastien Guillemot",
    sameAs: ["https://x.com/SebastienGllmt"],
    // The avatar is the Person.image — NOT the post's share image.
    image: "https://blog.example.com/assets/authors/sebastiengllmt.png",
  });
  expect(ld.publisher).toEqual({ "@type": "Organization", name: "presidocs" });
  // The share image is the generated card, emitted as an ImageObject with dims.
  expect(ld.image).toEqual({
    "@type": "ImageObject",
    url: "https://blog.example.com/assets/og/offer-files.png",
    width: 1200,
    height: 630,
  });
  expect(ld.audio["@type"]).toBe("AudioObject");
  expect(ld.audio.contentUrl).toBe(
    "https://blog.example.com/generated/offer-files/full.f2985f8c0b4fd293.mp3",
  );
  // 2454530 ms → 2454.53 s → 40m 55s (rounded) → PT40M55S
  expect(ld.audio.duration).toBe("PT40M55S");
});

test("emits OG + Twitter Card tags with absolute URLs and the share card", () => {
  const out = injectStructuredData(HTML, CTX);
  expect(out).toContain('<meta property="og:type" content="article" />');
  expect(out).toContain('<meta property="og:title" content="Offer Files: shared liquidity without a chain" />');
  expect(out).toContain('<meta property="og:url" content="https://blog.example.com/posts/offer-files" />');
  expect(out).toContain('<meta property="og:audio" content="https://blog.example.com/generated/offer-files/full.f2985f8c0b4fd293.mp3" />');
  expect(out).toContain('<link rel="canonical" href="https://blog.example.com/posts/offer-files" />');
  // og:image is the generated card, always present, with alt + known dimensions.
  expect(out).toContain('<meta property="og:image" content="https://blog.example.com/assets/og/offer-files.png" />');
  expect(out).toContain('<meta property="og:image:alt" content="Offer Files: shared liquidity without a chain" />');
  expect(out).toContain('<meta property="og:image:width" content="1200" />');
  expect(out).toContain('<meta property="og:image:height" content="630" />');
  // The 1200x630 card is a large-format image → large card; creator from X handle.
  expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
  expect(out).toContain('<meta name="twitter:image" content="https://blog.example.com/assets/og/offer-files.png" />');
  expect(out).toContain('<meta name="twitter:creator" content="@SebastienGllmt" />');
});

test("article:author is the author's profile URL, not a display name", () => {
  const out = injectStructuredData(HTML, CTX);
  expect(out).toContain('<meta property="article:author" content="https://x.com/SebastienGllmt" />');
  // The display name must NOT appear as the article:author value.
  expect(out).not.toContain('<meta property="article:author" content="Sebastien Guillemot" />');
});

test("article:author falls back to the website link, omitted when no link", () => {
  const websiteOnly = injectStructuredData(HTML, {
    ...CTX,
    author: { name: "No Handle", links: { website: "https://example.com/me" }, avatarUrl: null },
  });
  expect(websiteOnly).toContain('<meta property="article:author" content="https://example.com/me" />');

  const noLinks = injectStructuredData(HTML, {
    ...CTX,
    author: { name: "No Links", links: {}, avatarUrl: null },
  });
  expect(noLinks).not.toContain("article:author");
});

test("never leaks the author email into the output", () => {
  const out = injectStructuredData(HTML, CTX);
  expect(out).not.toContain("@gmail.com");
  expect(out).not.toContain("sebastiengllmt@");
});

test("is idempotent (skips when JSON-LD already present)", () => {
  const once = injectStructuredData(HTML, CTX);
  const twice = injectStructuredData(once, CTX);
  expect(twice).toBe(once);
});

test("degrades when there is no audio, author, or share card", () => {
  const out = injectStructuredData(HTML, {
    ...CTX,
    author: null,
    audio: null,
    cardUrl: null,
  });
  const ld = jsonLd(out);
  expect(ld.audio).toBeUndefined();
  expect(ld.author).toBeUndefined();
  expect(ld.image).toBeUndefined();
  // No card and no override → no share image at all → small summary card.
  expect(out).not.toContain("og:image");
  expect(out).toContain('<meta name="twitter:card" content="summary" />');
  expect(ld.headline).toBe("Offer Files: shared liquidity without a chain");
});

test("BlogPosting links into the landing-page Blog @graph node", () => {
  const out = injectStructuredData(HTML, CTX);
  const ld = jsonLd(out);
  // Top-level `url` mirrors the Schema.org canonical example.
  expect(ld.url).toBe("https://blog.example.com/posts/offer-files");
  // `name` alias of `headline` — many consumers key on Thing.name.
  expect(ld.name).toBe(ld.headline);
  // isPartOf is a BARE reference to the landing page's Blog @id; the
  // consumer dereferences it to the full Blog node on the landing page.
  expect(ld.isPartOf).toEqual({
    "@type": "Blog",
    "@id": "https://blog.example.com/#blog",
  });
});

test("BlogPosting carries wordCount + a conservative SpeakableSpecification", () => {
  const out = injectStructuredData(HTML, CTX);
  const ld = jsonLd(out);
  // wordCount is approximate (whitespace-split of <article> text after tag
  // strip), so assert it's a positive number rather than a specific value.
  expect(typeof ld.wordCount).toBe("number");
  expect(ld.wordCount).toBeGreaterThan(0);
  // speakable points at the lede + h1, never the whole article.
  expect(ld.speakable).toEqual({
    "@type": "SpeakableSpecification",
    cssSelector: ["#lede", "h1"],
  });
});

test("countArticleWords ignores tags, scripts, styles, comments", () => {
  const n = countArticleWords(
    "<article>" +
      "<h1>One Two</h1>" +
      "<script>alert('skip')</script>" +
      "<style>p{color:red}</style>" +
      "<!-- skip skip -->" +
      "<p>three four five</p>" +
      "</article>",
  );
  expect(n).toBe(5);
});

test("countArticleWords returns 0 when there is no <article>", () => {
  expect(countArticleWords("<main><p>nope</p></main>")).toBe(0);
});

// --------------------------------------------------------------------------
// injectSiteStructuredData — landing page WebSite/Blog @graph
// --------------------------------------------------------------------------

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Presidocs — talks, not just text</title>
</head>
<body>
  <main>
    <h1>presidocs</h1>
    <p>Blog posts that feel like attending the talk. Hit Listen on any post — the page narrates itself.</p>
    <ul class="posts"><li><a href="/posts/offer-files">Offer Files</a></li></ul>
  </main>
</body>
</html>`;

const SITE_CTX: SiteStructuredDataContext = {
  siteUrl: "https://blog.example.com",
  author: {
    name: "Sebastien Guillemot",
    links: { x: "https://x.com/SebastienGllmt" },
    avatarUrl: "/assets/authors/sebastiengllmt.png",
  },
  publisher: "presidocs",
  cardUrl: null,
};

test("landing inject: emits WebSite + Blog @graph with the same author Person", () => {
  const out = injectSiteStructuredData(LANDING_HTML, SITE_CTX);
  const ld = jsonLd(out);
  expect(ld["@graph"]).toBeDefined();
  expect(ld["@graph"]).toHaveLength(2);
  const webSite = ld["@graph"].find((n: any) => n["@type"] === "WebSite");
  const blog = ld["@graph"].find((n: any) => n["@type"] === "Blog");
  expect(webSite).toBeDefined();
  expect(blog).toBeDefined();
  expect(webSite["@id"]).toBe("https://blog.example.com/#website");
  expect(webSite.url).toBe("https://blog.example.com/");
  expect(webSite.name).toBe("Presidocs — talks, not just text");
  expect(webSite.description).toContain("attending the talk");
  expect(webSite.inLanguage).toBe("en");
  expect(webSite.publisher).toEqual({ "@type": "Organization", name: "presidocs" });
  // WebSite.mainEntity references the Blog @id — the inverse of
  // BlogPosting.isPartOf, making the @graph a connected document.
  expect(webSite.mainEntity).toEqual({ "@id": "https://blog.example.com/#blog" });
  // Blog carries the Person author + publisher Organization (one source —
  // matches each post's BlogPosting publisher/author).
  expect(blog.author).toEqual({
    "@type": "Person",
    name: "Sebastien Guillemot",
    sameAs: ["https://x.com/SebastienGllmt"],
    image: "https://blog.example.com/assets/authors/sebastiengllmt.png",
  });
  expect(blog.publisher).toEqual({ "@type": "Organization", name: "presidocs" });
});

test("landing inject: emits OG website tags + a meta description (if absent)", () => {
  const out = injectSiteStructuredData(LANDING_HTML, SITE_CTX);
  expect(out).toContain('<meta property="og:type" content="website" />');
  expect(out).toContain('<meta property="og:title" content="Presidocs — talks, not just text" />');
  expect(out).toContain('<meta property="og:url" content="https://blog.example.com/" />');
  expect(out).toContain('<meta property="og:site_name" content="presidocs" />');
  expect(out).toContain('<meta property="og:locale" content="en_US" />');
  // Source has no <meta name="description">, so we add one (no duplicate risk).
  expect(out).toContain('<meta name="description"');
  expect(out).toMatch(/<meta name="description" content="[^"]*attending the talk[^"]*"/);
  // No card today → small summary card, no og:image.
  expect(out).toContain('<meta name="twitter:card" content="summary" />');
  expect(out).not.toContain("og:image");
});

test("landing inject: description captures text across descendant elements", () => {
  // Regression: a <p> with a child <strong> used to truncate at the first
  // descendant (lastInTextNode fired between text nodes).
  const out = injectSiteStructuredData(LANDING_HTML, SITE_CTX);
  const ld = jsonLd(out);
  const webSite = ld["@graph"].find((n: any) => n["@type"] === "WebSite");
  expect(webSite.description).toContain("attending the talk");
  // Text AFTER the descendant <strong>Listen</strong> must be present too.
  expect(webSite.description).toContain("narrates itself");
});

test("landing inject: cardUrl drives og:image + ImageObject with known dims", () => {
  const out = injectSiteStructuredData(LANDING_HTML, {
    ...SITE_CTX,
    cardUrl: "/assets/og/_site.png",
  });
  const ld = jsonLd(out);
  const blog = ld["@graph"].find((n: any) => n["@type"] === "Blog");
  // Card has known 1200x630 dims → ImageObject form, not a bare URL string.
  expect(blog.image).toEqual({
    "@type": "ImageObject",
    url: "https://blog.example.com/assets/og/_site.png",
    width: 1200,
    height: 630,
  });
  expect(out).toContain(
    '<meta property="og:image" content="https://blog.example.com/assets/og/_site.png" />',
  );
  expect(out).toContain('<meta property="og:image:width" content="1200" />');
  expect(out).toContain('<meta property="og:image:height" content="630" />');
  // Large card → Twitter switches to summary_large_image.
  expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
  expect(out).toContain(
    '<meta name="twitter:image" content="https://blog.example.com/assets/og/_site.png" />',
  );
});

test("landing inject: does NOT duplicate an existing meta description", () => {
  const withDesc = LANDING_HTML.replace(
    "<title>",
    '<meta name="description" content="hand-authored" />\n<title>',
  );
  const out = injectSiteStructuredData(withDesc, SITE_CTX);
  expect((out.match(/<meta name="description"/g) ?? []).length).toBe(1);
  expect(out).toContain('<meta name="description" content="hand-authored" />');
});

test("landing inject: is idempotent (skips when JSON-LD already present)", () => {
  const once = injectSiteStructuredData(LANDING_HTML, SITE_CTX);
  const twice = injectSiteStructuredData(once, SITE_CTX);
  expect(twice).toBe(once);
});

test("landing inject: degrades when no author / publisher", () => {
  const out = injectSiteStructuredData(LANDING_HTML, {
    ...SITE_CTX,
    author: null,
    publisher: "",
  });
  const ld = jsonLd(out);
  const blog = ld["@graph"].find((n: any) => n["@type"] === "Blog");
  expect(blog.author).toBeUndefined();
  expect(blog.publisher).toBeUndefined();
  expect(out).not.toContain("og:site_name");
  expect(out).not.toContain("twitter:creator");
});

test("landing inject: never leaks an author email", () => {
  const out = injectSiteStructuredData(LANDING_HTML, SITE_CTX);
  expect(out).not.toContain("@gmail.com");
  expect(out).not.toContain("sebastiengllmt@");
});

test("a per-post og:image override wins over the generated card", () => {
  const withOverride = HTML.replace(
    "<title>",
    '<meta property="og:image" content="/assets/hero-offer.png" />\n<title>',
  );
  const out = injectStructuredData(withOverride, CTX);
  const ld = jsonLd(out);
  // JSON-LD `image` and twitter:image resolve the override to an absolute URL.
  // Dimensions are unknown for an override, so it stays a bare URL string.
  expect(ld.image).toBe("https://blog.example.com/assets/hero-offer.png");
  expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
  expect(out).toContain('<meta name="twitter:image" content="https://blog.example.com/assets/hero-offer.png" />');
  // The source's own og:image tag is left exactly as authored (the injector
  // skips emitting its default), so there is only ONE og:image — and no
  // og:image:width/height (those are only emitted for our known-size card).
  expect((out.match(/property="og:image"/g) ?? []).length).toBe(1);
  expect(out).toContain('<meta property="og:image" content="/assets/hero-offer.png" />');
  expect(out).not.toContain("og:image:width");
  // The author's own image is still the avatar (a Person attribute, not the
  // post's share card) — correct, not a leak.
  expect(ld.author.image).toBe("https://blog.example.com/assets/authors/sebastiengllmt.png");
});
