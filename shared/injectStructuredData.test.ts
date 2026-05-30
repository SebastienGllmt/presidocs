import { test, expect } from "bun:test";
import { injectStructuredData, type StructuredDataContext } from "./injectStructuredData.ts";

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
