import { test, expect } from "bun:test";
import {
  buildRobotsTxt,
  buildSitemapXml,
  buildLlmsTxt,
  type SitemapEntry,
  type LlmsPost,
  type LlmsSite,
} from "./site-discovery.ts";

const SITEMAP_URL = "https://blog.example.com/sitemap.xml";

test("robots.txt: default-allow has no Disallow lines, points at sitemap", () => {
  const txt = buildRobotsTxt({ sitemapUrl: SITEMAP_URL, allowAi: true });
  expect(txt).toContain("User-agent: *");
  expect(txt).toContain("Allow: /");
  expect(txt).toContain(`Sitemap: ${SITEMAP_URL}`);
  // The default stance MUST NOT silently disallow any bot.
  expect(txt).not.toContain("Disallow:");
  expect(txt).not.toContain("GPTBot");
  expect(txt).not.toContain("ClaudeBot");
});

test("robots.txt: deny stance blocks every known AI crawler explicitly", () => {
  const txt = buildRobotsTxt({ sitemapUrl: SITEMAP_URL, allowAi: false });
  // The * allow stays — only the named AI bots are blocked.
  expect(txt).toContain("User-agent: *\nAllow: /");
  expect(txt).toContain(`Sitemap: ${SITEMAP_URL}`);
  // A representative sample of the named bots.
  for (const bot of ["GPTBot", "ClaudeBot", "Google-Extended", "PerplexityBot", "CCBot"]) {
    expect(txt).toContain(`User-agent: ${bot}\nDisallow: /`);
  }
});

test("sitemap.xml: emits one <url> per entry with escaped loc and lastmod", () => {
  const entries: SitemapEntry[] = [
    { loc: "https://blog.example.com/", lastmod: "2026-05-31T05:02:17.626Z" },
    { loc: "https://blog.example.com/posts/offer-files", lastmod: "2026-05-31T05:02:17.626Z" },
  ];
  const xml = buildSitemapXml(entries);
  expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  expect((xml.match(/<url>/g) ?? []).length).toBe(2);
  expect(xml).toContain(
    "<url><loc>https://blog.example.com/posts/offer-files</loc><lastmod>2026-05-31T05:02:17.626Z</lastmod></url>",
  );
  // changefreq/priority are deliberately omitted (Google ignores both).
  expect(xml).not.toContain("changefreq");
  expect(xml).not.toContain("priority");
});

test("sitemap.xml: XML-escapes & in URLs", () => {
  const xml = buildSitemapXml([
    { loc: "https://blog.example.com/?q=a&b=c", lastmod: "2026-05-31" },
  ]);
  expect(xml).toContain("<loc>https://blog.example.com/?q=a&amp;b=c</loc>");
  expect(xml).not.toContain("?q=a&b=c</loc>");
});

const LLMS_SITE: LlmsSite = {
  title: "Presidocs — talks, not just text",
  description: "Blog posts that feel like attending the talk.",
  feeds: {
    atom: "https://blog.example.com/feed.xml",
    podcast: "https://blog.example.com/podcast.xml",
  },
  helpUrl: "https://blog.example.com/help",
};

const LLMS_POSTS: LlmsPost[] = [
  {
    url: "https://blog.example.com/posts/offer-files",
    title: "Offer Files: shared liquidity without a chain",
    summary: "How Midnight turns a private swap into a file you can paste anywhere",
  },
  {
    url: "https://blog.example.com/posts/offer-files-data",
    title: "Chia Offer Files by the Numbers",
    summary: "An analysis of offer files on the Chia blockchain",
  },
];

test("llms.txt: title, blockquote summary, post list with summaries, ## Optional feeds", () => {
  const txt = buildLlmsTxt(LLMS_SITE, LLMS_POSTS);
  expect(txt).toContain("# Presidocs — talks, not just text");
  expect(txt).toContain("> Blog posts that feel like attending the talk.");
  expect(txt).toContain("## Posts");
  expect(txt).toContain(
    "- [Offer Files: shared liquidity without a chain](https://blog.example.com/posts/offer-files): How Midnight turns a private swap into a file you can paste anywhere",
  );
  // `## Optional` is reserved by the llmstxt.org spec — feeds belong there
  // (subscription endpoints are skippable when token-budgeted).
  expect(txt).toContain("## Optional");
  expect(txt).not.toContain("## Feeds");
  expect(txt).toContain("- [Atom feed](https://blog.example.com/feed.xml)");
  expect(txt).toContain("- [Podcast feed](https://blog.example.com/podcast.xml)");
  // The help page is listed in ## Optional so an LLM can fetch one curated
  // "how do I subscribe / listen" page instead of inferring from the posts.
  expect(txt).toContain("- [How this blog works](https://blog.example.com/help)");
});

test("llms.txt: podcast feed omitted when null (audio-less blog)", () => {
  const txt = buildLlmsTxt(
    { ...LLMS_SITE, feeds: { atom: LLMS_SITE.feeds.atom, podcast: null } },
    LLMS_POSTS,
  );
  expect(txt).toContain("- [Atom feed]");
  expect(txt).not.toContain("Podcast feed");
});

test("llms.txt: help link omitted when helpUrl is null", () => {
  const txt = buildLlmsTxt({ ...LLMS_SITE, helpUrl: null }, LLMS_POSTS);
  expect(txt).not.toContain("How this blog works");
});

test("llms.txt: empty posts list collapses cleanly (header + Optional only)", () => {
  const txt = buildLlmsTxt(LLMS_SITE, []);
  expect(txt).toContain("# Presidocs");
  expect(txt).not.toContain("## Posts");
  expect(txt).toContain("## Optional");
});

test("llms.txt: post with no summary still renders as a clean bullet", () => {
  const txt = buildLlmsTxt(LLMS_SITE, [
    { url: "https://blog.example.com/posts/x", title: "Bare", summary: "" },
  ]);
  expect(txt).toContain("- [Bare](https://blog.example.com/posts/x)\n");
  expect(txt).not.toContain("- [Bare](https://blog.example.com/posts/x):");
});
