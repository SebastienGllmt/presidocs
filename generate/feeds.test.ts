import { test, expect } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import {
  escapeXml,
  buildAtomFeed,
  buildRssFeed,
  buildChaptersJson,
  assertFeedWellFormed,
  uuidv5,
  type FeedSite,
  type FeedPost,
} from "./feeds.ts";

// Parse feed XML with a real parser for assertions that extract/count elements
// (regex-scraping the serialized string is the fragile pattern we avoid).
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const asArray = <T>(v: T | T[] | undefined): T[] => [v ?? []].flat() as T[];

const SITE: FeedSite = {
  baseUrl: "https://blog.example.com",
  title: "Presidocs — talks, not just text",
  description: "Blog posts that feel like attending the talk.",
  language: "en-US",
  author: { name: "Sebastien Guillemot", links: { x: "https://x.com/SebastienGllmt" } },
  ownerEmail: null,
  imageUrl: "https://blog.example.com/assets/authors/sebastiengllmt.png",
  coverUrl: null,
  category: "Technology",
  explicit: false,
  tagYear: 2026,
  hubUrl: null,
  locked: true,
  license: null,
  licenseUrl: null,
  contentLicenseId: null,
};

const POST_WITH_AUDIO: FeedPost = {
  slug: "offer-files",
  postPath: "/posts/offer-files",
  title: "Offer Files: shared liquidity without a chain",
  summary: "How offer files turn a private swap into a plain text file.",
  contentHtml: "<h1>Offer Files</h1><p>body & <strong>more</strong></p>",
  published: "2026-05-22T18:40:13.120Z",
  updated: "2026-05-30T02:27:47.354Z",
  author: { name: "Sebastien Guillemot", links: { x: "https://x.com/SebastienGllmt" } },
  audio: {
    // The pipeline now emits the STABLE enclosure URL (`…/episode.mp3`), not the
    // hashed track — so a cached feed's download link survives a regeneration.
    // The hashed→stable derivation is unit-tested in shared/stableAudio.test.ts
    // (stableEpisodePath); `byteLength` is still measured from the hashed file.
    url: "https://blog.example.com/generated/offer-files/episode.mp3",
    byteLength: 19_636_240,
    durationSec: 2455,
    chaptersUrl: "https://blog.example.com/generated/offer-files/chapters.json",
    // Content-addressed alternate + SRI integrity (methodology.md →
    // Subscription feeds). The SRI
    // value here is the empty-string SHA-256 (a stable, recognizable vector).
    hashedUrl: "https://blog.example.com/generated/offer-files/full.f2985f8c0b4fd293.mp3",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  },
};

const POST_NO_AUDIO: FeedPost = {
  slug: "offer-files-data",
  postPath: "/posts/offer-files-data",
  title: "Chia Offer Files by the Numbers",
  summary: "830,000 completed trades.",
  contentHtml: "<h1>Data</h1>",
  published: "2026-05-25T04:07:37.106Z",
  updated: "2026-05-30T02:27:47.354Z",
  author: SITE.author,
};

// An older-dated post, used to prove entry ids don't move when it's added.
const POST_OLDER: FeedPost = {
  ...POST_NO_AUDIO,
  slug: "old-essay",
  postPath: "/posts/old-essay",
  title: "An older essay",
  published: "2023-01-02T00:00:00.000Z",
  updated: "2023-01-02T00:00:00.000Z",
};

test("escapeXml escapes the five XML metacharacters", () => {
  expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
});

test("Atom: per-entry tag-URI year comes from the entry's own publish date", () => {
  const xml = buildAtomFeed(SITE, [POST_WITH_AUDIO, POST_OLDER]);
  // 2026 post and 2023 post each carry their OWN year...
  expect(xml).toContain("<id>tag:blog.example.com,2026:/posts/offer-files</id>");
  expect(xml).toContain("<id>tag:blog.example.com,2023:/posts/old-essay</id>");
  // feed id uses the configured stable tagYear (not a min across posts)
  expect(xml).toContain("<id>tag:blog.example.com,2026:feed</id>");
});

test("Atom: adding an older-dated post does NOT change another entry's id", () => {
  const before = buildAtomFeed(SITE, [POST_WITH_AUDIO]);
  const after = buildAtomFeed(SITE, [POST_OLDER, POST_WITH_AUDIO]);
  const idOf = (xml: string) => {
    const entries = asArray<{ id?: string }>(xmlParser.parse(xml)?.feed?.entry);
    return entries.map((e) => e.id).find((id) => typeof id === "string" && id.includes("/posts/offer-files"));
  };
  expect(idOf(after)).toBe(idOf(before)); // permanence (RFC 4287 §4.2.6)
});

test("Atom: type=html content is entity-escaped, not CDATA", () => {
  const xml = buildAtomFeed(SITE, [POST_WITH_AUDIO]);
  expect(xml).not.toContain("<![CDATA[");
  expect(xml).toContain("<content type=\"html\">&lt;h1&gt;Offer Files&lt;/h1&gt;");
});

test("WebSub: hub link is opt-in — present only when hubUrl is set", () => {
  // Off by default (no WEBSUB_HUB) — neither feed advertises a hub.
  expect(buildAtomFeed(SITE, [POST_WITH_AUDIO])).not.toContain('rel="hub"');
  expect(buildRssFeed(SITE, [POST_WITH_AUDIO])).not.toContain('rel="hub"');

  const withHub = { ...SITE, hubUrl: "https://websubhub.com/hub" };
  // Atom: a <link rel="hub"> alongside the self-link.
  expect(buildAtomFeed(withHub, [POST_WITH_AUDIO])).toContain(
    '<link rel="hub" href="https://websubhub.com/hub"/>',
  );
  // RSS: the hub link uses the (already-declared) atom namespace.
  expect(buildRssFeed(withHub, [POST_WITH_AUDIO])).toContain(
    '<atom:link href="https://websubhub.com/hub" rel="hub"/>',
  );
});

test("RSS: channel carries a stable podcast:guid + atom:link self", () => {
  const xml = buildRssFeed(SITE, [POST_WITH_AUDIO]);
  expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
  expect(xml).toContain('<atom:link href="https://blog.example.com/podcast.xml" rel="self" type="application/rss+xml"/>');
  // guid is a UUIDv5 (deterministic over the feed URL)
  const guid = xmlParser.parse(xml)?.rss?.channel?.["podcast:guid"];
  expect(typeof guid).toBe("string");
  expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("uuidv5 is deterministic and matches the podcast-namespace example", () => {
  // From specs/PodcastNamespace-spec.md: feed url `podnews.net/rss` →
  // 9b024349-ccf0-5f69-a609-6b82873eab3c
  const guid = uuidv5("podnews.net/rss", "ead4c236-bf58-58c6-a2c6-a6b28d128cb6");
  expect(guid).toBe("9b024349-ccf0-5f69-a609-6b82873eab3c");
});

test("RSS: only audio posts become items, with a STABLE enclosure URL + chapters", () => {
  const xml = buildRssFeed(SITE, [POST_WITH_AUDIO, POST_NO_AUDIO]);
  expect(asArray(xmlParser.parse(xml)?.rss?.channel?.item).length).toBe(1);
  // Enclosure points at the stable `…/episode.mp3` (no hash), while `length`
  // still matches the hashed file's byte size — methodology.md → Subscription feeds.
  expect(xml).toContain(
    '<enclosure url="https://blog.example.com/generated/offer-files/episode.mp3" length="19636240" type="audio/mpeg"/>',
  );
  expect(xml).not.toMatch(/<enclosure url="[^"]*\/full\.[0-9a-f]{16}\.mp3"/);
  expect(xml).toContain("<podcast:chapters");
});

test("RSS transcript: non-aligned audio post advertises only the text/html transcript", () => {
  // POST_WITH_AUDIO has no captionsUrl (no forced alignment built), so the
  // word-timed VTT tag must be absent — never advertise a 404. proposals/39.
  const xml = buildRssFeed(SITE, [POST_WITH_AUDIO]);
  expect(xml).toContain(
    '<podcast:transcript url="https://blog.example.com/posts/offer-files" type="text/html"/>',
  );
  expect(xml).not.toContain('type="text/vtt"');
});

test("RSS transcript: aligned post advertises BOTH the word-timed VTT and the HTML transcript", () => {
  const aligned: FeedPost = {
    ...POST_WITH_AUDIO,
    audio: {
      ...POST_WITH_AUDIO.audio!,
      captionsUrl: "https://blog.example.com/generated/offer-files/captions.vtt",
    },
  };
  const xml = buildRssFeed(SITE, [aligned]);
  // The verbatim, word-timed transcript of the spoken audio (rel="captions").
  expect(xml).toContain(
    '<podcast:transcript url="https://blog.example.com/generated/offer-files/captions.vtt" type="text/vtt" rel="captions"/>',
  );
  // The HTML companion (parallel-prose transcript-of-record) is still present.
  expect(xml).toContain(
    '<podcast:transcript url="https://blog.example.com/posts/offer-files" type="text/html"/>',
  );
  // VTT listed first (clients pick the richest type they support).
  expect(xml.indexOf('type="text/vtt"')).toBeLessThan(xml.indexOf('type="text/html"'));
});

test("RSS: alternateEnclosure advertises stable + hashed sources with SRI integrity", () => {
  const xml = buildRssFeed(SITE, [POST_WITH_AUDIO]);
  // One alternateEnclosure, default=true (same media as <enclosure>), length matches.
  expect(xml).toContain(
    '<podcast:alternateEnclosure type="audio/mpeg" length="19636240" default="true">',
  );
  // Both URIs are advertised: the stable enclosure URL and the immutable hashed one.
  expect(xml).toContain('<podcast:source uri="https://blog.example.com/generated/offer-files/episode.mp3"/>');
  expect(xml).toContain(
    '<podcast:source uri="https://blog.example.com/generated/offer-files/full.f2985f8c0b4fd293.mp3"/>',
  );
  // The audio's W3C SRI, so capable clients can verify the bytes.
  expect(xml).toContain(
    '<podcast:integrity type="sri" value="sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="/>',
  );
  expect(xml).toContain("<itunes:duration>2455</itunes:duration>");
  expect(xml).toContain('<podcast:chapters url="https://blog.example.com/generated/offer-files/chapters.json" type="application/json+chapters"/>');
  expect(xml).toContain("<pubDate>Fri, 22 May 2026 18:40:13 GMT</pubDate>");
});

test("RSS: channel declares medium=podcast (spoken-word) + locked=yes by default", () => {
  const xml = buildRssFeed(SITE, [POST_WITH_AUDIO]);
  expect(xml).toContain("<podcast:medium>podcast</podcast:medium>");
  expect(xml).toContain("<podcast:locked>yes</podcast:locked>");
});

test("RSS: locked owner attr is opt-in, and PODCAST_LOCKED=no is respected", () => {
  // No owner email by default → bare <podcast:locked>yes</podcast:locked>.
  expect(buildRssFeed(SITE, [POST_WITH_AUDIO])).not.toContain("podcast:locked owner");
  // Owner email opted in → it rides on the locked tag (verifies a legit move).
  const withOwner = buildRssFeed({ ...SITE, ownerEmail: "owner@example.com" }, [POST_WITH_AUDIO]);
  expect(withOwner).toContain('<podcast:locked owner="owner@example.com">yes</podcast:locked>');
  // Explicit opt-out.
  expect(buildRssFeed({ ...SITE, locked: false }, [POST_WITH_AUDIO])).toContain(
    "<podcast:locked>no</podcast:locked>",
  );
});

test("RSS: license is opt-in — well-known needs no url, custom carries one", () => {
  // Unset → tag omitted entirely (no wrong default).
  expect(buildRssFeed(SITE, [POST_WITH_AUDIO])).not.toContain("podcast:license");
  // Well-known identifier: clients resolve it, so no url attribute.
  expect(buildRssFeed({ ...SITE, license: "CC-BY-4.0" }, [POST_WITH_AUDIO])).toContain(
    "<podcast:license>CC-BY-4.0</podcast:license>",
  );
  // Custom license: the url is required by the spec and is emitted.
  expect(
    buildRssFeed(
      { ...SITE, license: "my-blog-license-v1", licenseUrl: "https://example.org/license.pdf" },
      [POST_WITH_AUDIO],
    ),
  ).toContain(
    '<podcast:license url="https://example.org/license.pdf">my-blog-license-v1</podcast:license>',
  );
});

test("Atom: <rights> carries the content license, opt-in (proposal 59)", () => {
  // Unset → no <rights> (no imposed default).
  expect(buildAtomFeed(SITE, [POST_WITH_AUDIO])).not.toContain("<rights>");
  // The Atom feed conveys the textual posts → its rights are the CONTENT
  // license, independent of the podcast/audio license.
  expect(
    buildAtomFeed({ ...SITE, contentLicenseId: "CC-BY-4.0" }, [POST_WITH_AUDIO]),
  ).toContain("<rights>CC-BY-4.0</rights>");
});

test("RSS: channel <podcast:person> carries the author avatar (img)", () => {
  const xml = buildRssFeed(SITE, [POST_WITH_AUDIO]);
  expect(xml).toContain(
    '<podcast:person role="host" href="https://x.com/SebastienGllmt" ' +
      'img="https://blog.example.com/assets/authors/sebastiengllmt.png">Sebastien Guillemot</podcast:person>',
  );
});

test("RSS: itunes:image only emitted for a real cover (avatar is NOT used)", () => {
  // No cover → no channel image, even though SITE has an avatar imageUrl.
  expect(buildRssFeed(SITE, [POST_WITH_AUDIO])).not.toContain("itunes:image");
  // With a dedicated cover, it's emitted.
  const withCover = buildRssFeed(
    { ...SITE, coverUrl: "https://blog.example.com/assets/podcast-cover.png" },
    [POST_WITH_AUDIO],
  );
  expect(withCover).toContain('<itunes:image href="https://blog.example.com/assets/podcast-cover.png"/>');
});

test("RSS owner email is opt-in (absent unless set)", () => {
  expect(buildRssFeed(SITE, [POST_WITH_AUDIO])).not.toContain("itunes:owner");
  const withOwner = buildRssFeed({ ...SITE, ownerEmail: "owner@example.com" }, [POST_WITH_AUDIO]);
  expect(withOwner).toContain("<itunes:email>owner@example.com</itunes:email>");
});

test("feeds never leak an author email by default", () => {
  expect(buildAtomFeed(SITE, [POST_WITH_AUDIO])).not.toContain("@gmail.com");
  expect(buildRssFeed(SITE, [POST_WITH_AUDIO])).not.toContain("@gmail.com");
});

// ---- whole-feed validity gate ----------------------------------------------
// The per-tag assertions above are all substring checks, which pass whether or
// not the surrounding document is balanced — they cannot see an unbalanced tag,
// a broken entity, or a mis-closed conditional branch. These round-trip the
// emitted feeds through the real parser (the same gate feeds.ts runs before it
// writes to disk) so that class of bug fails the suite. methodology.md →
// Subscription feeds → "Feed validity gate".

test("Atom: the emitted feed is well-formed XML", () => {
  // Mix of audio + no-audio + older-dated entries to exercise every entry branch.
  assertFeedWellFormed(buildAtomFeed(SITE, [POST_WITH_AUDIO, POST_NO_AUDIO, POST_OLDER]), "atom");
});

test("RSS: the fully-populated feed is well-formed XML (every conditional branch on)", () => {
  // Turn on every opt-in branch at once — owner, locked-owner, license+url, hub,
  // cover image, person, alternateEnclosure (hashed + SRI), and both transcripts
  // — so a mis-closed branch in the deeply-nested podcast:*/itunes:* tree trips
  // the validator rather than a directory's ingest.
  const maximalSite: FeedSite = {
    ...SITE,
    ownerEmail: "owner@example.com",
    coverUrl: "https://blog.example.com/assets/podcast-cover.png",
    hubUrl: "https://websubhub.com/hub",
    license: "my-blog-license-v1",
    licenseUrl: "https://example.org/license.pdf",
    contentLicenseId: "CC-BY-4.0",
  };
  const aligned: FeedPost = {
    ...POST_WITH_AUDIO,
    audio: {
      ...POST_WITH_AUDIO.audio!,
      captionsUrl: "https://blog.example.com/generated/offer-files/captions.vtt",
    },
  };
  assertFeedWellFormed(buildRssFeed(maximalSite, [aligned, POST_NO_AUDIO]), "rss");
});

test("RSS: the five root namespace declarations survive a parse", () => {
  // Well-formedness alone doesn't guarantee the xmlns:* decls reached the root —
  // a dropped namespace decl gets the whole feed rejected by a strict reader.
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  }).parse(buildRssFeed(SITE, [POST_WITH_AUDIO]));
  const rss = parsed.rss;
  expect(rss["@_version"]).toBe("2.0");
  expect(rss["@_xmlns:itunes"]).toBe("http://www.itunes.com/dtds/podcast-1.0.dtd");
  expect(rss["@_xmlns:content"]).toBe("http://purl.org/rss/1.0/modules/content/");
  expect(rss["@_xmlns:atom"]).toBe("http://www.w3.org/2005/Atom");
  expect(rss["@_xmlns:podcast"]).toBe("https://podcastindex.org/namespace/1.0");
});

test("Atom: the single Atom namespace survives a parse", () => {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  }).parse(buildAtomFeed(SITE, [POST_WITH_AUDIO]));
  expect(parsed.feed["@_xmlns"]).toBe("http://www.w3.org/2005/Atom");
});

test("the validity gate actually rejects malformed XML (it is not a no-op)", () => {
  // Unbalanced tag and a raw unescaped ampersand — the two classes the substring
  // goldens are blind to. The gate must throw, naming the feed.
  expect(() => assertFeedWellFormed("<feed><title>x</feed>", "atom")).toThrow(/not well-formed/);
  expect(() => assertFeedWellFormed("<feed><title>a & b</title></feed>", "atom")).toThrow(
    /not well-formed/,
  );
});

test("chapters JSON converts ms → seconds in Podlove shape", () => {
  const json = JSON.parse(
    buildChaptersJson([
      { title: "Welcome", startTime: 0 },
      { title: "The core idea", startTime: 8838 },
    ]),
  );
  expect(json.version).toBe("1.2.0");
  expect(json.chapters).toEqual([
    { startTime: 0, title: "Welcome" },
    { startTime: 8.838, title: "The core idea" },
  ]);
});
