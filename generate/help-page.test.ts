import { test, expect } from "bun:test";
import {
  buildQuestions,
  buildHelpHtml,
  buildFaqJsonLd,
  featureChips,
  buildFeatureChipsHtml,
  injectFeatureChips,
  type FeatureSet,
  type HelpContext,
} from "./help-page.ts";

const ALL_FEATURES: FeatureSet = {
  narration: true,
  atom: true,
  podcast: true,
  comments: true,
  pwa: true,
};

function ctx(features: FeatureSet, over: Partial<HelpContext> = {}): HelpContext {
  return {
    siteUrl: "https://blog.example.com",
    siteTitle: "Example Blog",
    siteDescription: "Explainers on things.",
    authorName: "Jane Doe",
    lang: "en",
    features,
    feeds: {
      atom: "https://blog.example.com/feed.xml",
      podcast: features.podcast ? "https://blog.example.com/podcast.xml" : null,
    },
    privacyHref: "/privacy",
    cssLinks: `<link rel="stylesheet" href="./chunk-abc.css">`,
    ...over,
  };
}

// ---- question model ---------------------------------------------------------

test("buildQuestions — all features → listen, subscribe, comments, install, privacy", () => {
  const ids = buildQuestions(ctx(ALL_FEATURES)).map((q) => q.id);
  expect(ids).toEqual(["listen", "subscribe", "comments", "install", "privacy"]);
});

test("buildQuestions — no narration drops the listen section", () => {
  const ids = buildQuestions(ctx({ ...ALL_FEATURES, narration: false })).map((q) => q.id);
  expect(ids).not.toContain("listen");
  expect(ids).toContain("subscribe");
});

test("buildQuestions — no feeds drops the subscribe section", () => {
  const ids = buildQuestions(
    ctx({ ...ALL_FEATURES, atom: false, podcast: false }),
  ).map((q) => q.id);
  expect(ids).not.toContain("subscribe");
});

test("buildQuestions — no posts drops the comments section", () => {
  const ids = buildQuestions(ctx({ ...ALL_FEATURES, comments: false })).map((q) => q.id);
  expect(ids).not.toContain("comments");
});

test("buildQuestions — no PWA drops the install section", () => {
  const ids = buildQuestions(ctx({ ...ALL_FEATURES, pwa: false })).map((q) => q.id);
  expect(ids).not.toContain("install");
});

test("buildQuestions — privacy section always present; links policy only when set", () => {
  const withPolicy = buildQuestions(ctx(ALL_FEATURES)).find((q) => q.id === "privacy")!;
  expect(withPolicy.answerHtml).toContain('href="/privacy"');
  const noPolicy = buildQuestions(ctx(ALL_FEATURES, { privacyHref: null })).find((q) => q.id === "privacy")!;
  expect(noPolicy).toBeDefined();
  expect(noPolicy.answerHtml).not.toContain("href=");
});

test("buildQuestions — atom-only subscribe section omits podcast app recipes", () => {
  const sub = buildQuestions(ctx({ ...ALL_FEATURES, podcast: false }, { feeds: { atom: "https://blog.example.com/feed.xml", podcast: null } }))
    .find((q) => q.id === "subscribe")!;
  expect(sub.answerHtml).toContain("/feed.xml");
  expect(sub.answerHtml).not.toContain("Apple Podcasts");
});

test("buildQuestions — listen section renders the KEY_BINDINGS shortcut table", () => {
  const listen = buildQuestions(ctx(ALL_FEATURES)).find((q) => q.id === "listen")!;
  expect(listen.answerHtml).toContain('<table class="shortcuts">');
  expect(listen.answerHtml).toContain("Space");
  expect(listen.answerHtml).toContain("Play or pause the narration");
  // The author name flows into the listening blurb.
  expect(listen.answerHtml).toContain("Jane Doe's voice");
});

test("buildQuestions — null author falls back to 'the author's voice'", () => {
  const listen = buildQuestions(ctx(ALL_FEATURES, { authorName: null })).find((q) => q.id === "listen")!;
  expect(listen.answerHtml).toContain("the author's voice");
});

// ---- FAQPage JSON-LD --------------------------------------------------------

test("buildFaqJsonLd — one Question per section, anchored @id, joined to WebSite", () => {
  const qs = buildQuestions(ctx(ALL_FEATURES));
  const json = buildFaqJsonLd(qs, "https://blog.example.com");
  const parsed = JSON.parse(json.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "").replace(/\\u003c/g, "<"));
  expect(parsed["@type"]).toBe("FAQPage");
  expect(parsed["@id"]).toBe("https://blog.example.com/help#faq");
  expect(parsed.isPartOf["@id"]).toBe("https://blog.example.com/#website");
  expect(parsed.mainEntity).toHaveLength(qs.length);
  const listenQ = parsed.mainEntity.find((q: { "@id": string }) => q["@id"].endsWith("#listen"));
  expect(listenQ.name).toBe("How do I listen to a post?");
  expect(listenQ.acceptedAnswer["@type"]).toBe("Answer");
  expect(typeof listenQ.acceptedAnswer.text).toBe("string");
});

test("buildFaqJsonLd — escapes < so it can't break out of the script element", () => {
  // answerText is plain text, but defense-in-depth: any literal < is escaped.
  const json = buildFaqJsonLd(
    [{ id: "x", question: "Q<b>?", answerHtml: "", answerText: "a < b" }],
    "https://blog.example.com",
  );
  expect(json).not.toContain("a < b");
  expect(json).toContain("\\u003c");
});

// ---- chips ------------------------------------------------------------------

test("featureChips — full set, in order, ending with the catch-all Help chip", () => {
  const hrefs = featureChips(ALL_FEATURES).map((c) => c.href);
  expect(hrefs).toEqual([
    "/help#listen",
    "/help#subscribe",
    "/help#comments",
    "/help#install",
    "/help",
  ]);
});

test("featureChips — audio-less blog drops Listen, keeps Subscribe (atom)", () => {
  const hrefs = featureChips({ narration: false, atom: true, podcast: false, comments: true, pwa: false }).map((c) => c.href);
  expect(hrefs).toEqual(["/help#subscribe", "/help#comments", "/help"]);
});

test("featureChips — bare blog still gets the Help chip", () => {
  const hrefs = featureChips({ narration: false, atom: false, podcast: false, comments: false, pwa: false }).map((c) => c.href);
  expect(hrefs).toEqual(["/help"]);
});

test("injectFeatureChips — inserts the nav before <ul class=posts>", () => {
  const landing = `<body><main><h1>Blog</h1><p>tag</p><ul class="posts"><li>a</li></ul></main></body>`;
  const out = injectFeatureChips(landing, buildFeatureChipsHtml(ALL_FEATURES));
  expect(out).toContain('class="presidocs-features"');
  expect(out.indexOf("presidocs-features")).toBeLessThan(out.indexOf('class="posts"'));
});

test("injectFeatureChips — no post list → appended to end of <main>", () => {
  const landing = `<body><main><h1>Blog</h1></main></body>`;
  const out = injectFeatureChips(landing, buildFeatureChipsHtml(ALL_FEATURES));
  expect(out).toContain("presidocs-features");
  expect(out.indexOf("presidocs-features")).toBeGreaterThan(out.indexOf("<h1>"));
});

test("injectFeatureChips — idempotent (second pass is a no-op)", () => {
  const landing = `<body><main><ul class="posts"><li>a</li></ul></main></body>`;
  const once = injectFeatureChips(landing, buildFeatureChipsHtml(ALL_FEATURES));
  const twice = injectFeatureChips(once, buildFeatureChipsHtml(ALL_FEATURES));
  expect(twice).toBe(once);
  expect((twice.match(/presidocs-features/g) ?? []).length).toBe(1);
});

// ---- full page --------------------------------------------------------------

test("buildHelpHtml — well-formed page with reused CSS, anchored sections, FAQ JSON-LD", () => {
  const c = ctx(ALL_FEATURES);
  const qs = buildQuestions(c);
  const html = buildHelpHtml(c, qs);
  expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(html).toContain('<html lang="en">');
  expect(html).toContain("<title>How this blog works — Example Blog</title>");
  // Reuses the landing's bundled stylesheet verbatim.
  expect(html).toContain(`<link rel="stylesheet" href="./chunk-abc.css">`);
  // Each question is an anchored <section>.
  for (const q of qs) expect(html).toContain(`<section id="${q.id}">`);
  // Feed autodiscovery present when feeds exist.
  expect(html).toContain('type="application/atom+xml"');
  expect(html).toContain('type="application/rss+xml"');
  // FAQPage JSON-LD shipped on the page.
  expect(html).toContain('"@type":"FAQPage"');
});

test("buildHelpHtml — audio-less blog omits podcast autodiscovery link", () => {
  const c = ctx({ ...ALL_FEATURES, podcast: false }, { feeds: { atom: "https://blog.example.com/feed.xml", podcast: null } });
  const html = buildHelpHtml(c, buildQuestions(c));
  expect(html).toContain('type="application/atom+xml"');
  expect(html).not.toContain('type="application/rss+xml"');
});
