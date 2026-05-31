// Build step: emit subscription feeds from the build output. An audio-first
// blog with no feed is invisible to every podcast client and feed reader, yet
// every field a feed needs already exists on disk (post HTML, versions.json,
// narration manifests, author profiles). This script joins them into:
//
//   dist/feed.xml                      Atom 1.0 — one <entry> per post
//   dist/podcast.xml                   Podcast RSS 2.0 (+ itunes:/podcast: ns)
//                                      — one <item> per post that HAS audio
//   dist/generated/<slug>/chapters.json  Podlove Simple Chapters sidecar
//                                      (Podcasting 2.0 <podcast:chapters>)
//
// Runs AFTER strip-served-html.ts (it consumes the stripped post body for the
// feed <content>, so subscribers never see the author email or narration
// blobs). Zero Worker code — these are static assets served by the ASSETS
// binding (createWorker.ts adds the correct feed Content-Type).
//
// Skipped entirely when SITE_URL is unset (feeds need absolute URLs) — same
// fail-silent posture as the structured-data / analytics injects.
//
// Deliberately NOT done here: ID3v2 CHAP frames muxed into the MP3 itself
// (proposal step 3). That requires generate.ts to compute chapter timings
// before the content-hash + a full MOSS re-generate to take effect, and the
// <podcast:chapters> sidecar below already gives every modern podcast client
// chapters. See methodology.md → "Subscription feeds".

import { readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveFeedConfig, type FeedConfig } from "../shared/feedConfig.ts";
import { buildAuthorMap, type PublicAuthorProfile } from "../shared/authorProfile.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";
import { decodeHtmlEntities } from "../shared/htmlEntities.ts";
import { createHash } from "node:crypto";

const paths = resolveBlogPaths();

// ---- pure XML/JSON builders (exported for tests) ----------------------------

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Wrap HTML in CDATA for a feed <content>/<description>; split any literal
// `]]>` so it can't close the section early.
function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

export type FeedAuthor = { name: string; links: Record<string, string> };

export type FeedSite = {
  baseUrl: string;
  title: string;
  description: string;
  language: string;
  author: FeedAuthor | null;
  ownerEmail: string | null;
  /** Small image for the Atom <logo> (the author avatar is fine here). */
  imageUrl: string | null;
  /**
   * Podcast cover art for RSS <itunes:image> — must be a dedicated >=1400px
   * square asset (Apple rejects smaller). null => omit the channel image
   * rather than emit a too-small one. NOT the avatar.
   */
  coverUrl: string | null;
  category: string;
  explicit: boolean;
  /**
   * Stable year for the FEED's own tag-URI id (entries derive their year
   * per-post). Set from SITE_LAUNCH_YEAR; must not be derived from a
   * minimum-across-posts (that shifts when an older post is added).
   */
  tagYear: number;
};

export type FeedPost = {
  slug: string;
  postPath: string; // "/posts/<slug>"
  title: string;
  summary: string;
  contentHtml: string;
  published: string; // ISO
  updated: string; // ISO
  author: FeedAuthor | null;
  // Present only when the post has narration audio.
  audio?: {
    url: string; // absolute
    byteLength: number;
    durationSec: number;
    chaptersUrl: string; // absolute
  };
};

function host(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "");
  }
}

export function buildAtomFeed(site: FeedSite, posts: FeedPost[]): string {
  const h = host(site.baseUrl);
  const feedUpdated = posts.reduce(
    (max, p) => (p.updated > max ? p.updated : max),
    posts[0]?.updated ?? new Date(0).toISOString(),
  );
  const authorBlock = site.author
    ? `<author><name>${escapeXml(site.author.name)}</name>${
        site.ownerEmail ? `<email>${escapeXml(site.ownerEmail)}</email>` : ""
      }</author>`
    : "";

  const entries = posts
    .map((p) => {
      const url = `${site.baseUrl}${p.postPath}`;
      // Per-entry tag-URI date = the entry's OWN first-publish year, so an
      // entry's atom:id never changes when another (older-dated) post is later
      // added (RFC 4287 §4.2.6: the id MUST NOT change). A global minimum year
      // would rewrite every id whenever an earlier-dated post appears.
      const entryYear = new Date(p.published).getUTCFullYear();
      const entryAuthor = p.author
        ? `<author><name>${escapeXml(p.author.name)}</name></author>`
        : "";
      return (
        `<entry>` +
        `<id>tag:${h},${entryYear}:${p.postPath}</id>` +
        `<title>${escapeXml(p.title)}</title>` +
        `<link rel="alternate" type="text/html" href="${escapeXml(url)}"/>` +
        `<published>${p.published}</published>` +
        `<updated>${p.updated}</updated>` +
        entryAuthor +
        (p.summary ? `<summary>${escapeXml(p.summary)}</summary>` : "") +
        // Atom requires type="html" content to be ENTITY-escaped, not CDATA
        // (RFC 4287 §4.1.3.3). RSS content:encoded below stays CDATA (RSS norm).
        `<content type="html">${escapeXml(p.contentHtml)}</content>` +
        `</entry>`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom">` +
    `<id>tag:${h},${site.tagYear}:feed</id>` +
    `<title>${escapeXml(site.title)}</title>` +
    (site.description ? `<subtitle>${escapeXml(site.description)}</subtitle>` : "") +
    `<link rel="self" type="application/atom+xml" href="${escapeXml(site.baseUrl)}/feed.xml"/>` +
    `<link rel="alternate" type="text/html" href="${escapeXml(site.baseUrl)}/"/>` +
    `<updated>${feedUpdated}</updated>` +
    authorBlock +
    (site.imageUrl ? `<logo>${escapeXml(site.imageUrl)}</logo>` : "") +
    entries +
    `</feed>\n`
  );
}

function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

// The fixed "podcast" UUIDv5 namespace from the Podcasting 2.0 <podcast:guid>
// spec (specs/PodcastNamespace-spec.md).
const PODCAST_GUID_NAMESPACE = "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";

// Deterministic UUIDv5 (SHA-1 of namespace bytes + name; version/variant bits
// set) — no dependency. Used for the stable channel-level podcast GUID.
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex"); // 16 bytes
  const bytes = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Per the spec, the GUID is computed over the feed URL with the protocol scheme
// and trailing slashes stripped.
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function buildRssFeed(site: FeedSite, posts: FeedPost[]): string {
  const withAudio = posts.filter((p) => p.audio);
  const feedUrl = `${site.baseUrl}/podcast.xml`;
  const guid = uuidv5(stripScheme(feedUrl), PODCAST_GUID_NAMESPACE);
  // Channel art must be the dedicated >=1400px square cover, never the avatar;
  // omit when absent (a too-small image gets the feed rejected by Apple).
  const channelImage = site.coverUrl
    ? `<image><url>${escapeXml(site.coverUrl)}</url><title>${escapeXml(site.title)}</title>` +
      `<link>${escapeXml(site.baseUrl)}/</link></image>` +
      `<itunes:image href="${escapeXml(site.coverUrl)}"/>`
    : "";
  const owner =
    site.author && site.ownerEmail
      ? `<itunes:owner><itunes:name>${escapeXml(site.author.name)}</itunes:name>` +
        `<itunes:email>${escapeXml(site.ownerEmail)}</itunes:email></itunes:owner>`
      : "";
  const person = site.author
    ? `<podcast:person role="host"${
        site.author.links.x ? ` href="${escapeXml(site.author.links.x)}"` : ""
      }>${escapeXml(site.author.name)}</podcast:person>`
    : "";

  const items = withAudio
    .map((p) => {
      const url = `${site.baseUrl}${p.postPath}`;
      const a = p.audio!;
      return (
        `<item>` +
        `<title>${escapeXml(p.title)}</title>` +
        `<link>${escapeXml(url)}</link>` +
        `<guid isPermaLink="false">${escapeXml(url)}</guid>` +
        `<pubDate>${rfc822(p.published)}</pubDate>` +
        (p.summary ? `<description>${cdata(p.summary)}</description>` : "") +
        `<content:encoded>${cdata(p.contentHtml)}</content:encoded>` +
        `<enclosure url="${escapeXml(a.url)}" length="${a.byteLength}" type="audio/mpeg"/>` +
        `<itunes:duration>${a.durationSec}</itunes:duration>` +
        (site.author ? `<itunes:author>${escapeXml(site.author.name)}</itunes:author>` : "") +
        `<itunes:explicit>${site.explicit ? "true" : "false"}</itunes:explicit>` +
        `<podcast:chapters url="${escapeXml(a.chaptersUrl)}" type="application/json+chapters"/>` +
        `<podcast:transcript url="${escapeXml(url)}" type="text/html"/>` +
        `</item>`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<rss version="2.0" ` +
    `xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" ` +
    `xmlns:content="http://purl.org/rss/1.0/modules/content/" ` +
    `xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `xmlns:podcast="https://podcastindex.org/namespace/1.0">` +
    `<channel>` +
    `<atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>` +
    `<podcast:guid>${guid}</podcast:guid>` +
    `<title>${escapeXml(site.title)}</title>` +
    `<link>${escapeXml(site.baseUrl)}/</link>` +
    `<description>${escapeXml(site.description)}</description>` +
    `<language>${escapeXml(site.language)}</language>` +
    `<lastBuildDate>${rfc822(
      withAudio.reduce((max, p) => (p.updated > max ? p.updated : max), withAudio[0]!.updated),
    )}</lastBuildDate>` +
    (site.author ? `<itunes:author>${escapeXml(site.author.name)}</itunes:author>` : "") +
    owner +
    `<itunes:category text="${escapeXml(site.category)}"/>` +
    `<itunes:explicit>${site.explicit ? "true" : "false"}</itunes:explicit>` +
    `<itunes:type>episodic</itunes:type>` +
    channelImage +
    person +
    items +
    `</channel></rss>\n`
  );
}

// flatten the optional two-level chapter hierarchy for the podcast
// chapters sidecar, which has no nesting primitive. A leaf with a `parentId`
// gets its title prefixed with its part's title ("<part> — <chapter>") so the
// grouping survives in a podcast app's flat chapter menu; parts (and flat
// chapters) keep their bare title. A `parentId` whose part can't be resolved
// just falls back to the bare title.
function prefixChildChapterTitles(
  chapters: ManifestChapter[],
): { title: string; startTime: number }[] {
  const titleById = new Map(chapters.map((c) => [c.id, c.title]));
  return chapters.map((c) => {
    const parentTitle = c.parentId ? titleById.get(c.parentId) : undefined;
    return {
      startTime: c.startTime,
      title: parentTitle ? `${parentTitle} — ${c.title}` : c.title,
    };
  });
}

export function buildChaptersJson(
  chapters: { title: string; startTime: number }[],
): string {
  return JSON.stringify({
    version: "1.2.0",
    // Manifest times are ms; Podlove Simple Chapters wants seconds.
    chapters: chapters.map((c) => ({
      startTime: Math.round(c.startTime) / 1000,
      title: c.title,
    })),
  });
}

// ---- disk gathering ---------------------------------------------------------

type VersionEntry = { hash: string; builtAt: string };
type ManifestChapter = { id: string; title: string; startTime: number; endTime: number; parentId?: string };
type Manifest = { audio?: string; duration?: number; chapters?: ManifestChapter[] };

// Pull the site title + description out of the blog's own landing index.html,
// so the engine never hardcodes a blog name.
async function readSiteMeta(): Promise<{ title: string; description: string }> {
  const indexPath = join(paths.contentRoot, "index.html");
  if (!existsSync(indexPath)) return { title: "", description: "" };
  const html = await Bun.file(indexPath).text();
  let title = "";
  let description = "";
  let inTitle = false;
  let inP = false;
  new HTMLRewriter()
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .on("main p", {
      element() {
        if (!description && !inP) inP = true;
      },
      text(t) {
        if (inP) description += t.text;
        if (t.lastInTextNode) inP = false;
      },
    })
    .transform(html);
  return {
    title: decodeHtmlEntities(title.replace(/\s+/g, " ").trim()),
    description: decodeHtmlEntities(description.replace(/\s+/g, " ").trim()),
  };
}

// Inner HTML of the first <article> in a stripped post — the feed <content>.
function extractArticle(html: string): string {
  const m = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  return m ? m[1]!.trim() : "";
}

// Title + lede from a source post.
function extractPostMeta(html: string): { title: string; summary: string } {
  let title = "";
  let summary = "";
  let metaDesc = "";
  let inTitle = false;
  let inLede = false;
  new HTMLRewriter()
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        metaDesc = el.getAttribute("content") ?? "";
      },
    })
    .on("#lede", {
      element() {
        inLede = true;
      },
      text(t) {
        if (inLede) summary += t.text;
        if (t.lastInTextNode) inLede = false;
      },
    })
    .transform(html);
  return {
    title: decodeHtmlEntities(title.replace(/\s+/g, " ").trim()),
    summary: decodeHtmlEntities((metaDesc || summary).replace(/\s+/g, " ").trim()),
  };
}

async function main(): Promise<void> {
  const cfg: FeedConfig = resolveFeedConfig();
  if (!cfg.baseUrl) {
    console.log("Feeds: no SITE_URL — skipping feed generation.");
    return;
  }
  const baseUrl = cfg.baseUrl;
  const distDir = paths.distDir;
  if (!existsSync(distDir)) {
    console.warn("  dist/ does not exist — run `bun build` first; skipping feeds.");
    return;
  }

  // versions.json: post path → newest-first [{hash, builtAt}].
  let versions: Record<string, VersionEntry[]> = {};
  try {
    versions = (await Bun.file(paths.versionsJson).json()) as Record<string, VersionEntry[]>;
  } catch {
    versions = {};
  }

  // Public author profiles (name/links, no email) keyed by post path.
  const authorMap = (await buildAuthorMap(paths.postsDir, paths.contentRoot)).map;

  // Walk source posts; a post is anything posts/<slug>.html with an author-email
  // (the same convention post-meta uses).
  const posts: FeedPost[] = [];
  let earliestYear = new Date().getUTCFullYear();
  const postFiles = (await readdir(paths.postsDir)).filter((f) => f.endsWith(".html"));
  for (const file of postFiles) {
    const slug = file.replace(/\.html$/, "");
    const postPath = `/posts/${slug}`;
    const srcHtml = await Bun.file(join(paths.postsDir, file)).text();
    if (!parseAuthorEmailFromHtml(srcHtml)) continue; // not a real post
    const history = versions[postPath];
    if (!history || history.length === 0) continue;

    const published = history[history.length - 1]!.builtAt;
    const updated = history[0]!.builtAt;
    earliestYear = Math.min(earliestYear, new Date(published).getUTCFullYear());

    const { title, summary } = extractPostMeta(srcHtml);
    const distPost = join(distDir, "posts", `${slug}.html`);
    const contentHtml = existsSync(distPost)
      ? extractArticle(await Bun.file(distPost).text())
      : "";

    const profile: PublicAuthorProfile | undefined = authorMap[postPath];
    const author: FeedAuthor | null = profile
      ? { name: profile.name, links: profile.links }
      : null;

    // Audio (+ chapters sidecar) only when the post has a narration manifest.
    let audio: FeedPost["audio"];
    const manifestPath = join(paths.generatedDir, slug, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const m = (await Bun.file(manifestPath).json()) as Manifest;
        if (m.audio && typeof m.duration === "number") {
          const distAudio = join(distDir, m.audio.replace(/^\//, ""));
          if (existsSync(distAudio)) {
            const byteLength = (await stat(distAudio)).size;
            // Emit the Podlove chapters sidecar next to the audio. The sidecar
            // format is flat (no nesting primitive), so the two-level hierarchy
            // degrades to a flat list with part-prefixed child
            // titles ("<part> — <chapter>"); parts keep their bare title.
            const chaptersJson = buildChaptersJson(prefixChildChapterTitles(m.chapters ?? []));
            const chaptersFsPath = join(distDir, "generated", slug, "chapters.json");
            await writeFile(chaptersFsPath, chaptersJson, "utf8");
            audio = {
              url: `${baseUrl}${m.audio}`,
              byteLength,
              durationSec: Math.round(m.duration / 1000),
              chaptersUrl: `${baseUrl}/generated/${slug}/chapters.json`,
            };
          }
        }
      } catch {
        // malformed manifest → Atom-only for this post
      }
    }

    posts.push({ slug, postPath, title, summary, contentHtml, published, updated, author, audio });
  }

  if (posts.length === 0) {
    console.log("Feeds: no posts with version history — nothing to emit.");
    return;
  }

  // Newest-first for reader display.
  posts.sort((a, b) => (a.published < b.published ? 1 : -1));

  // Site-level author = the newest post's author (single-channel podcast owner).
  const siteAuthor = posts.find((p) => p.author)?.author ?? null;
  const siteAuthorProfile = siteAuthor
    ? Object.values(authorMap).find((p) => p.name === siteAuthor.name)
    : undefined;
  const imageUrl = siteAuthorProfile?.avatar ? `${baseUrl}${siteAuthorProfile.avatar}` : null;
  // Podcast cover (>=1400px square) is a dedicated asset, never the avatar.
  const coverRaw = (process.env.PODCAST_COVER ?? "").trim();
  const coverUrl = coverRaw
    ? /^https?:\/\//i.test(coverRaw)
      ? coverRaw
      : `${baseUrl}${coverRaw.startsWith("/") ? "" : "/"}${coverRaw}`
    : null;
  // Feed-id year: a stable configured value, NOT a min-across-posts (which
  // shifts when an older post is added). Falls back to earliestYear only when
  // unset — set SITE_LAUNCH_YEAR for a permanently stable feed id.
  const launchYear = Number(process.env.SITE_LAUNCH_YEAR) || earliestYear;

  const meta = await readSiteMeta();
  const site: FeedSite = {
    baseUrl,
    title: meta.title || "Blog",
    description: meta.description,
    language: cfg.language,
    author: siteAuthor,
    ownerEmail: cfg.ownerEmail,
    imageUrl,
    coverUrl,
    category: cfg.category,
    explicit: cfg.explicit,
    tagYear: launchYear,
  };

  await writeFile(join(distDir, "feed.xml"), buildAtomFeed(site, posts), "utf8");
  const audioPosts = posts.filter((p) => p.audio);
  if (audioPosts.length > 0) {
    await writeFile(join(distDir, "podcast.xml"), buildRssFeed(site, posts), "utf8");
  }

  console.log(
    `Feeds: dist/feed.xml (${posts.length} entr${posts.length === 1 ? "y" : "ies"})` +
      (audioPosts.length > 0
        ? `, dist/podcast.xml (${audioPosts.length} episode(s) + chapters sidecars)`
        : " (no audio posts — podcast.xml suppressed)"),
  );
}

// Only run as a CLI; importing the pure builders (e.g. from tests) must not
// trigger generation.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
