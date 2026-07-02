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
import { isPrivateBlog } from "../shared/blogPrivacy.ts";
import { resolveFeedConfig, type FeedConfig } from "./feedConfig.ts";
import { resolveLicenseConfig } from "../shared/licenseConfig.ts";
import { buildAuthorMap, type PublicAuthorProfile } from "../shared/authorProfile.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";
import { decodeHtmlEntities } from "./htmlEntities.ts";
import { parseHTML } from "linkedom";
import { XMLValidator } from "fast-xml-parser";
import { encodeXML } from "entities";
import { findManifestName } from "../shared/manifestFile.ts";
import { stableEpisodePath } from "../shared/stableAudio.ts";
import { isSha256Hex, sriSha256 } from "../shared/audioDigest.ts";
import { createHash } from "node:crypto";

const paths = resolveBlogPaths();

// ---- pure XML/JSON builders (exported for tests) ----------------------------

// XML-escape a plain-text field. Backed by `entities`' `encodeXML` — the same
// audited library as the decode side (shared/htmlEntities.ts) — so both halves
// of the decode-before-escape step share one source of truth. `encodeXML`
// emits the identical five XML metacharacter entities (incl. `&apos;`) the
// hand-rolled five-replace version did. Kept as `escapeXml` so the ~50 call
// sites here and the re-export in site-discovery.ts are untouched.
export function escapeXml(s: string): string {
  return encodeXML(s);
}

// Wrap HTML in CDATA for a feed <content>/<description>; split any literal
// `]]>` so it can't close the section early.
function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

// Whole-feed well-formedness gate. Both feeds are hand-assembled by string
// concatenation over deeply-nested, conditional `podcast:*`/`itunes:*` branches
// (alternateEnclosure, transcripts, locked/person/license) — exactly where a
// single mis-closed or mis-escaped branch yields well-formed-LOOKING output a
// strict parser (and a podcast directory's ingest) rejects wholesale. Substring
// `toContain` assertions structurally cannot see that class of bug: they pass
// whether or not the surrounding document is balanced. So before either feed is
// written (or its per-tag goldens are trusted), it is round-tripped through
// `XMLValidator` from fast-xml-parser — already a direct dependency on this same
// build path — which catches unbalanced tags, broken entities, and malformed
// attributes. Throws (fail-loud) so a malformed feed fails the build instead of
// shipping a file a directory will bounce. Exported so feeds.test.ts asserts the
// same gate over the pure builders. Note: this proves well-formedness, NOT
// directory acceptance (Apple/Podcast Index cover-art/category/policy rules live
// beyond any local parser) and NOT namespace-declaration survival (a separate
// parse-side assertion checks the root xmlns:* decls). See methodology.md →
// Subscription feeds → "Feed validity gate".
export function assertFeedWellFormed(xml: string, label: string): void {
  const result = XMLValidator.validate(xml);
  if (result !== true) {
    const { msg, line, col } = result.err;
    throw new Error(`${label}: emitted feed is not well-formed XML — ${msg} (line ${line}, col ${col})`);
  }
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
  /**
   * Opt-in [WebSub] hub URL. When set, both feeds advertise it via
   * `<link rel="hub">` (Atom) / `<atom:link rel="hub">` (RSS) alongside the
   * existing self-link, so a subscriber's reader can ask the hub to PUSH it
   * updates instead of polling. null → omit the hub link. The publish ping
   * itself is a post-deploy step (generate/websub-ping.ts), not emitted here.
   */
  hubUrl: string | null;
  /**
   * `<podcast:locked>` value (anti-hijack import signal). Defaults true; the
   * `owner` attribute rides on it only when `ownerEmail` is set.
   */
  locked: boolean;
  /** `<podcast:license>` identifier for the audio (e.g. `CC-BY-4.0`); null → omit. */
  license: string | null;
  /** Full-text URL for a custom `license` (optional for well-known ones). */
  licenseUrl: string | null;
  /**
   * Content (prose) license identifier for the Atom `<rights>` element — the
   * Atom feed conveys the textual posts, so its rights reflect `CONTENT_LICENSE`
   * directly, NOT the (possibly different) podcast/audio license above. Null →
   * omit `<rights>`.
   */
  contentLicenseId: string | null;
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
    url: string; // absolute STABLE enclosure URL (…/episode.<ext>)
    byteLength: number;
    durationSec: number;
    chaptersUrl: string; // absolute
    // Absolute URL of the word-timed WebVTT transcript (…/captions.vtt).
    // Present only when the post was built with forced alignment (the file
    // exists in dist) — gates the <podcast:transcript type="text/vtt"> tag so
    // a non-aligned episode never advertises a 404. See proposals/39.
    captionsUrl?: string;
    // Content-addressed alternate (…/full.<hash>.<ext>, absolute) + the SRI
    // string of the audio bytes. Both present ⇒ a <podcast:alternateEnclosure>
    // advertises the immutable URL and lets clients verify integrity.
    hashedUrl?: string;
    integrity?: string; // W3C SRI, e.g. "sha256-<base64>"
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
    (site.hubUrl ? `<link rel="hub" href="${escapeXml(site.hubUrl)}"/>` : "") +
    `<link rel="alternate" type="text/html" href="${escapeXml(site.baseUrl)}/"/>` +
    `<updated>${feedUpdated}</updated>` +
    authorBlock +
    // <rights> (RFC 4287 §4.2.10): the content license, for parity with the
    // podcast feed's <podcast:license>. The SPDX identifier is short and the
    // value consumers key on; omitted when CONTENT_LICENSE is unset.
    (site.contentLicenseId ? `<rights>${escapeXml(site.contentLicenseId)}</rights>` : "") +
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
  // Channel host: name + X profile (href) + the author avatar (img) — the
  // avatar already exists on disk (it's the Atom <logo>), so populating `img`
  // lights up the host card in apps that render <podcast:person>.
  const person = site.author
    ? `<podcast:person role="host"${
        site.author.links.x ? ` href="${escapeXml(site.author.links.x)}"` : ""
      }${site.imageUrl ? ` img="${escapeXml(site.imageUrl)}"` : ""}>${escapeXml(
        site.author.name,
      )}</podcast:person>`
    : "";
  // <podcast:locked>: tell other hosts not to import this feed (anti-hijack).
  // `owner` (an email used to verify a legitimate move) only when opted-in.
  const locked = `<podcast:locked${
    site.ownerEmail ? ` owner="${escapeXml(site.ownerEmail)}"` : ""
  }>${site.locked ? "yes" : "no"}</podcast:locked>`;
  // <podcast:license> for the audio. Well-known identifier needs no url;
  // a custom abbreviation requires one (spec). Omitted entirely when unset.
  const license = site.license
    ? `<podcast:license${
        site.licenseUrl ? ` url="${escapeXml(site.licenseUrl)}"` : ""
      }>${escapeXml(site.license)}</podcast:license>`
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
        // Advertise the content-addressed alternate alongside the stable
        // enclosure, with the audio's SRI so capable clients can verify or
        // prefer the immutable URL (Podcasting 2.0; see specs/PodcastNamespace).
        // `default="true"`: same media as the <enclosure> above.
        (a.hashedUrl
          ? `<podcast:alternateEnclosure type="audio/mpeg" length="${a.byteLength}" default="true">` +
            `<podcast:source uri="${escapeXml(a.url)}"/>` +
            `<podcast:source uri="${escapeXml(a.hashedUrl)}"/>` +
            (a.integrity ? `<podcast:integrity type="sri" value="${escapeXml(a.integrity)}"/>` : "") +
            `</podcast:alternateEnclosure>`
          : "") +
        `<itunes:duration>${a.durationSec}</itunes:duration>` +
        (site.author ? `<itunes:author>${escapeXml(site.author.name)}</itunes:author>` : "") +
        `<itunes:explicit>${site.explicit ? "true" : "false"}</itunes:explicit>` +
        `<podcast:chapters url="${escapeXml(a.chaptersUrl)}" type="application/json+chapters"/>` +
        // Two transcripts, richest first (clients pick the best type they read):
        //  - text/vtt: the verbatim, word-timed transcript of the spoken audio
        //    (our forced-aligned captions.vtt), present only when alignment was
        //    built. rel="captions" per the Podcast Namespace transcript tag.
        //  - text/html: the post page — the parallel-prose companion. The
        //    narration is a parallel narrative, not a read-aloud (see
        //    methodology → What we're building), so the VTT is what's actually
        //    heard and the HTML is the readable transcript-of-record.
        (a.captionsUrl
          ? `<podcast:transcript url="${escapeXml(a.captionsUrl)}" type="text/vtt" rel="captions"/>`
          : "") +
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
    (site.hubUrl ? `<atom:link href="${escapeXml(site.hubUrl)}" rel="hub"/>` : "") +
    `<podcast:guid>${guid}</podcast:guid>` +
    // medium=podcast tells apps this is spoken-word (e.g. don't reset playback
    // speed the way they would for `music`); it's the default but stated so the
    // signal is explicit.
    `<podcast:medium>podcast</podcast:medium>` +
    locked +
    license +
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
// The manifest shape is the shared one (single source of truth with the
// producer + narrator + video renderer). Feeds reads a subset (audio, duration,
// chapters, audioDigest) and keeps its own presence guards, so a partial/older
// manifest still degrades to Atom-only via the surrounding try/catch.
import type { Manifest, ManifestChapter } from "../shared/manifestSchema.ts";

// Pull the site title + description out of the blog's own landing index.html,
// so the engine never hardcodes a blog name. Exported so sibling generators
// (site-discovery.ts) reuse one extractor; they all join the same convention.
export async function readSiteMeta(): Promise<{ title: string; description: string }> {
  const indexPath = join(paths.contentRoot, "index.html");
  if (!existsSync(indexPath)) return { title: "", description: "" };
  const html = await Bun.file(indexPath).text();
  let title = "";
  let description = "";
  let inTitle = false;
  let inP = false;
  let captured = false; // landed-on flag — only the FIRST <main> <p> contributes
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
      element(el) {
        // Use onEndTag to close — a `<p>` with descendant elements (e.g.
        // `<strong>`) splits its text across multiple text nodes, and closing
        // on `lastInTextNode` would truncate at the first descendant.
        if (!captured && !inP) {
          inP = true;
          captured = true;
          el.onEndTag(() => {
            inP = false;
          });
        }
      },
      text(t) {
        if (inP) description += t.text;
      },
    })
    .transform(html);
  return {
    title: decodeHtmlEntities(title.replace(/\s+/g, " ").trim()),
    description: decodeHtmlEntities(description.replace(/\s+/g, " ").trim()),
  };
}

// Inner HTML of the first <article> in a stripped post — the feed <content>.
// Parsed with linkedom (build-time only) rather than a `<article>…</article>`
// regex: the regex truncated at the first nested `</article>` and grabbed raw
// bytes; querySelector + innerHTML returns exactly the article's children as
// well-formed HTML, which is what a feed reader renders.
function extractArticle(html: string): string {
  const article = parseHTML(html).document.querySelector("article");
  return article ? article.innerHTML.trim() : "";
}

// Title + lede from a source post. Exported so site-discovery.ts reuses the
// same extractor (sitemap/llms.txt want exactly the title + description the
// feed uses; one source of truth keeps them in lockstep).
export function extractPostMeta(html: string): { title: string; summary: string } {
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
      element(el) {
        // onEndTag (not `lastInTextNode`) — descendant elements inside the
        // lede split its text across multiple text nodes; closing on the
        // first would truncate at the first <strong>/<em>/etc.
        inLede = true;
        el.onEndTag(() => {
          inLede = false;
        });
      },
      text(t) {
        if (inLede) summary += t.text;
      },
    })
    .transform(html);
  return {
    title: decodeHtmlEntities(title.replace(/\s+/g, " ").trim()),
    summary: decodeHtmlEntities((metaDesc || summary).replace(/\s+/g, " ").trim()),
  };
}

async function main(): Promise<void> {
  // A private blog emits no feeds at all: both feeds exist to ENUMERATE posts
  // to subscribers/directories (methodology → Private blogs). Skipping here
  // also kills the downstream consumers for free — the autodiscovery <link>s
  // (strip-served-html gates on what this step emitted), the publish-webhook
  // diff (reads dist/feed.xml), and the WebSub ping (no topics).
  if (isPrivateBlog()) {
    console.log("Feeds: private blog — feed.xml/podcast.xml suppressed.");
    return;
  }
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
    const manifestDir = join(paths.generatedDir, slug);
    const manifestName = await findManifestName(manifestDir);
    if (manifestName) {
      try {
        const m = (await Bun.file(join(manifestDir, manifestName)).json()) as Manifest;
        if (m.audio && typeof m.duration === "number") {
          // Enclosure byte length. The track is served from R2 and no longer
          // ships to dist/, so we can't stat the dist file.
          // Prefer the manifest's persisted `audioBytes`; fall back to stat-ing
          // the on-disk SOURCE track (always present at build time) for a
          // manifest that predates the field. Null ⇒ no measurable enclosure ⇒
          // Atom-only for this post.
          const srcAudio = join(manifestDir, m.audio.split("/").pop() ?? "");
          const byteLength =
            typeof m.audioBytes === "number" && m.audioBytes > 0
              ? m.audioBytes
              : existsSync(srcAudio)
                ? (await stat(srcAudio)).size
                : null;
          if (byteLength !== null) {
            // Emit the Podlove chapters sidecar next to the audio. The sidecar
            // format is flat (no nesting primitive), so the two-level hierarchy
            // degrades to a flat list with part-prefixed child
            // titles ("<part> — <chapter>"); parts keep their bare title.
            const chaptersJson = buildChaptersJson(prefixChildChapterTitles(m.chapters ?? []));
            const chaptersFsPath = join(distDir, "generated", slug, "chapters.json");
            await writeFile(chaptersFsPath, chaptersJson, "utf8");
            // STABLE shareable enclosure URL (`…/episode.<ext>`) — survives the
            // next regeneration when the content hash rotates, unlike the hashed
            // `m.audio`. Served with revalidation (strong ETag = the hash) and
            // resolves to the very bytes we measured for `length` here. See
            // methodology.md → Stable shareable episode URL.
            audio = {
              url: `${baseUrl}${stableEpisodePath(m.audio)}`,
              byteLength,
              durationSec: Math.round(m.duration / 1000),
              chaptersUrl: `${baseUrl}/generated/${slug}/chapters.json`,
              // Word-timed WebVTT transcript, advertised only when present.
              // The build emits captions.vtt next to the audio iff the post
              // was aligned (proposals/17), and copy-static ships it to dist;
              // checking dist here keeps the tag and the file in lockstep.
              ...(existsSync(join(distDir, "generated", slug, "captions.vtt"))
                ? { captionsUrl: `${baseUrl}/generated/${slug}/captions.vtt` }
                : {}),
              // Content-addressed alternate + integrity (methodology.md →
              // Subscription feeds): the
              // immutable URL clients may prefer, and the SRI of the very bytes.
              hashedUrl: `${baseUrl}${m.audio}`,
              integrity:
                m.audioDigest && isSha256Hex(m.audioDigest)
                  ? sriSha256(m.audioDigest)
                  : undefined,
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
    hubUrl: cfg.hubUrl,
    locked: cfg.locked,
    license: cfg.license,
    licenseUrl: cfg.licenseUrl,
    contentLicenseId: resolveLicenseConfig().content?.id ?? null,
  };

  // Validity gate: round-trip each feed through XMLValidator before it touches
  // disk, so a malformed branch fails the build rather than shipping a file a
  // podcast directory / feed reader rejects.
  const atom = buildAtomFeed(site, posts);
  assertFeedWellFormed(atom, "feed.xml (Atom)");
  await writeFile(join(distDir, "feed.xml"), atom, "utf8");
  const audioPosts = posts.filter((p) => p.audio);
  if (audioPosts.length > 0) {
    const rss = buildRssFeed(site, posts);
    assertFeedWellFormed(rss, "podcast.xml (RSS)");
    await writeFile(join(distDir, "podcast.xml"), rss, "utf8");
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
