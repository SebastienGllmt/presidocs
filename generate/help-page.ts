// Build step: emit the engine's reader-facing "How this blog works" page and
// surface the feature inventory on the landing.
//
//   dist/help.html            A Q&A-shaped page (one anchored section per
//                             question) that walks a reader through listening,
//                             subscribing, commenting, and installing — plus a
//                             FAQPage JSON-LD block so search engines and LLM
//                             agents can cite a specific answer ("how do I add
//                             this to my podcast app" → /help#subscribe).
//   dist/index.html (mutated) A <nav class="presidocs-features"> chip row,
//                             injected before the post list, linking each live
//                             feature to its /help anchor.
//
// Why the help page is ENGINE-owned (unlike the operator-owned privacy page):
// every claim it makes is about ENGINE behavior — how the player works, what
// the feeds emit, which keyboard shortcuts the code binds, how comments flow.
// The engine is the authoritative narrator of its own behavior, so emitting the
// page here keeps it from drifting as features change. An operator who wants
// their own copy drops a `help.html` in the content root; this emitter then
// SKIPS (see main()), and the normal build/serve path picks their file up.
//
// Site-level analogue of generate/site-discovery.ts: same SITE_URL gate (the
// page links absolute-ish /help anchors and is a prod build artifact), same
// fail-silent posture, same disk gather. Conditional sections are gated on the
// artifacts the rest of the build actually produced (dist/feed.xml,
// dist/podcast.xml, narration manifests, manifest.webmanifest) — the same
// existence checks feeds.ts / strip-served-html.ts use, so the help page can't
// claim a feature the build didn't ship.
//
// Runs LAST in the build chain (after feeds.ts + site-discovery.ts) so those
// existence checks see the final dist/. Served by env.ASSETS.fetch; /help
// resolves to dist/help.html the same way /privacy resolves to dist/privacy.html
// (Workers Static Assets html_handling). The dev server has no dist/, so it
// renders /help on the fly from source instead — see `renderHelpHtmlFromSource`
// / `featuresFromSource` below, wired into createDevServer.ts's `/help` route,
// with feature-gating computed from source (a dev-preview approximation of the
// dist/-based gating here).

import { readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveFeedConfig } from "../shared/feedConfig.ts";
import { buildAuthorMap } from "../shared/authorProfile.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";
import { decodeHtmlEntities } from "../shared/htmlEntities.ts";
import { findManifestName } from "../shared/manifestFile.ts";
import { injectSiteFooter } from "../shared/injectFooter.ts";
// Typed Schema.org vocabulary (Apache-2.0), `import type` only → erased at
// compile time, never bundled. Catches a misspelled `@type`/property in the
// FAQ graph at `tsc` instead of in Google's validator post-deploy.
import type { WithContext, FAQPage, Question } from "schema-dts";
import { injectPwaHead } from "../shared/injectPwaHead.ts";
import { readSiteMeta } from "./feeds.ts";
import { KEY_BINDINGS } from "../client/narratorDom.ts";

const paths = resolveBlogPaths();

// ---- escaping ---------------------------------------------------------------

// HTML text-node escape (for content between tags).
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// HTML double-quoted-attribute escape.
function escAttr(s: string): string {
  return escHtml(s).replace(/"/g, "&quot;");
}

// ---- feature model ----------------------------------------------------------

// Which features this build actually shipped. Each flag maps to one Q&A section
// + one landing chip; a false flag drops both, so the page and the chips can
// never advertise something the build didn't produce.
export type FeatureSet = {
  /** Any post has narration audio → the Listen player + shortcuts exist. */
  narration: boolean;
  /** dist/feed.xml emitted. */
  atom: boolean;
  /** dist/podcast.xml emitted (i.e. at least one narrated post). */
  podcast: boolean;
  /** The blog has posts → the comment surface exists on them. */
  comments: boolean;
  /** manifest.webmanifest shipped → installable / offline-capable PWA. */
  pwa: boolean;
};

export type HelpContext = {
  siteUrl: string;
  /** Blog title (from the landing's own <title>/<h1>, never hardcoded). */
  siteTitle: string;
  /** Blog tagline (landing's first <main> <p>); may be empty. */
  siteDescription: string;
  /** Site-level author display name, or null. Used in the listening blurb. */
  authorName: string | null;
  /** BCP-47 language tag for <html lang>. */
  lang: string;
  features: FeatureSet;
  /**
   * Absolute feed URLs (podcast null when no audio). `hubUrl` is the opt-in
   * [WebSub] hub (`WEBSUB_HUB`) — present only when the feeds advertise one, so
   * the subscribe section mentions real-time push only when it's actually on.
   */
  feeds: { atom: string; podcast: string | null; hubUrl?: string | null };
  /** Privacy-policy href if the deploy set PRIVACY_POLICY_URL, else null. */
  privacyHref: string | null;
  /** Verbatim <link rel="stylesheet"> tag(s) lifted from dist/index.html. */
  cssLinks: string;
};

// ---- Q&A model --------------------------------------------------------------
//
// One entry per section. `answerHtml` is the rich body rendered into the page;
// `answerText` is the plain-text equivalent for the FAQPage JSON-LD (Schema.org
// Answer.text is plain text). Keeping both off one array is what guarantees the
// prose and the structured data can't disagree about which questions exist.

export type HelpQuestion = {
  id: string;
  question: string;
  answerHtml: string;
  answerText: string;
};

function keyboardTableHtml(): string {
  const rows = KEY_BINDINGS.map(
    (b) => `<tr><td><kbd>${escHtml(b.label)}</kbd></td><td>${escHtml(b.description)}</td></tr>`,
  ).join("");
  return `<table class="shortcuts"><thead><tr><th>Key</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function keyboardTableText(): string {
  return KEY_BINDINGS.map((b) => `${b.label}: ${b.description}`).join("; ") + ".";
}

export function buildQuestions(ctx: HelpContext): HelpQuestion[] {
  const qs: HelpQuestion[] = [];
  const f = ctx.features;
  const voice = ctx.authorName ? `${ctx.authorName}'s voice` : "the author's voice";

  if (f.narration) {
    qs.push({
      id: "listen",
      question: "How do I listen to a post?",
      answerHtml:
        `<p>Every post can narrate itself in ${escHtml(voice)} while you read. Open a post and ` +
        `press the <strong>Listen</strong> button in the player dock; the spoken track plays and ` +
        `the page highlights the passage being read. A two-level chapter list lets you jump around — ` +
        `parts and the sub-chapters under them — and your operating system's media keys, lock screen, ` +
        `and Bluetooth-headset controls drive playback too, so you can listen with the tab in the ` +
        `background.</p>` +
        `<p>Keyboard shortcuts (when you're not typing in a field):</p>` +
        keyboardTableHtml() +
        `<p>Once you've started a post's narration, it keeps playing from cache even if you lose your ` +
        `connection — see <a href="#install">installing &amp; offline</a>.</p>`,
      answerText:
        `Every post can narrate itself in ${voice} while you read. Open a post and press the Listen ` +
        `button in the player dock; the page highlights the passage being read, and a two-level ` +
        `chapter list plus your OS media keys control playback. Keyboard shortcuts: ${keyboardTableText()}`,
    });
  }

  if (f.atom || f.podcast) {
    const podcastApps = f.podcast
      ? `<h3 id="subscribe-apple-podcasts">Apple Podcasts</h3>` +
        `<p>On macOS: <strong>File → Follow a Show by URL</strong>, then paste ` +
        `<code>${escHtml(ctx.feeds.podcast!)}</code>. On iOS, Apple Podcasts has no "add by URL" ` +
        `entry — use <a href="https://podcastsbyurl.com/" rel="noopener">podcastsbyurl.com</a> to add ` +
        `the same URL.</p>` +
        `<h3 id="subscribe-pocket-casts">Pocket Casts</h3>` +
        `<p><strong>Profile → Add Podcast → URL</strong>, then paste <code>${escHtml(ctx.feeds.podcast!)}</code>.</p>` +
        `<h3 id="subscribe-overcast">Overcast, Castro, AntennaPod</h3>` +
        `<p>Each has an "Add by URL" option (the exact label varies) — paste <code>${escHtml(ctx.feeds.podcast!)}</code>.</p>` +
        `<h3 id="subscribe-spotify">Spotify</h3>` +
        `<p>Spotify doesn't currently let listeners add a podcast by URL; the operator would have to ` +
        `submit the feed through Spotify for Podcasters first.</p>`
      : "";
    const atomLine = f.atom
      ? `<h3 id="subscribe-articles">Follow new posts as articles</h3>` +
        `<p>Add the Atom feed ` +
        `<code>${escHtml(ctx.feeds.atom)}</code> to any feed reader — NetNewsWire, Feedly, ` +
        `miniflux, Reeder. It tells you when a new post lands and carries the article itself.</p>`
      : "";
    // Readers who want posts in THEIR own chat use the same feed via that
    // platform's RSS integration — self-serve and reader-controlled, but polling
    // (so not instant). Distinct from the author's instant publish-webhook push,
    // which only reaches channels the author owns (see methodology → Subscription
    // feeds for that audience split).
    const chatLine = f.atom
      ? `<h3 id="subscribe-chat">Get new posts in your own Slack or Discord</h3>` +
        `<p>The same feed drops into a chat channel you control. In <strong>Slack</strong>, ` +
        `run <code>/feed subscribe ${escHtml(ctx.feeds.atom)}</code> in the channel. In ` +
        `<strong>Discord</strong>, point a third-party RSS bot (such as ` +
        `<a href="https://monitorss.xyz/" rel="noopener">MonitoRSS</a>) at that same URL. ` +
        `Both <em>poll</em> the feed, so posts show up on their schedule (Slack checks roughly hourly) ` +
        `rather than the instant a post goes live.</p>`
      : "";
    const podcastIntro = f.podcast
      ? `<h3 id="subscribe-podcast">Listen in a podcast app</h3>` +
        `<p>Add the podcast feed ` +
        `<code>${escHtml(ctx.feeds.podcast!)}</code>. It's an ordinary Apple-Podcasts-compatible ` +
        `RSS feed, so any podcast app that can add a feed by URL works.</p>`
      : "";
    // Real-time push (WebSub) — only when a hub is actually configured, so we
    // never advertise instant delivery a hub-less deploy can't provide.
    const realtimeLine = ctx.feeds.hubUrl
      ? `<h3 id="subscribe-realtime">Real-time updates</h3>` +
        `<p>These feeds support <a href="https://www.w3.org/TR/websub/" rel="noopener">WebSub</a> — if ` +
        `your reader does too, it gets new posts pushed within seconds instead of waiting for its next ` +
        `poll. Nothing to set up; it's announced in the feed automatically.</p>`
      : "";
    const realtimeText = ctx.feeds.hubUrl
      ? `These feeds support WebSub, so a compatible reader gets new posts pushed within seconds instead of polling. `
      : "";
    qs.push({
      id: "subscribe",
      question: "How do I subscribe or add this to my podcast app?",
      answerHtml:
        atomLine +
        chatLine +
        podcastIntro +
        podcastApps +
        realtimeLine +
        `<p>There's no email list, no signup, and no tracking — subscribing just means adding a URL ` +
        `to an app you control.</p>`,
      answerText:
        (f.atom
          ? `Follow new posts by adding the Atom feed ${ctx.feeds.atom} to any feed reader — or pipe ` +
            `it into your own chat (Slack: /feed subscribe <that URL>; Discord: a third-party RSS bot ` +
            `like MonitoRSS at https://monitorss.xyz/), which poll the feed so updates aren't instant. `
          : "") +
        (f.podcast
          ? `Listen in a podcast app by adding the RSS feed ${ctx.feeds.podcast} — it's Apple-Podcasts-compatible, ` +
            `so any app that adds a feed by URL works (Apple Podcasts via File → Follow a Show by URL on macOS or ` +
            `podcastsbyurl.com on iOS; Pocket Casts, Overcast, Castro, and AntennaPod via their Add-by-URL option). ` +
            `Spotify needs the operator to submit through Spotify for Podcasters first. `
          : "") +
        realtimeText +
        `There's no email list, signup, or tracking — subscribing just means adding a URL to an app you control.`,
    });
  }

  if (f.comments) {
    qs.push({
      id: "comments",
      question: "How do comments work, and what happens to mine?",
      answerHtml:
        `<p>To comment, sign in with Google or Microsoft, then highlight a passage and attach your ` +
        `note to it. What each provider shares, and how comments are stored, is covered in the ` +
        (ctx.privacyHref
          ? `<a href="${escAttr(ctx.privacyHref)}#comments">privacy policy</a>.</p>`
          : `privacy policy.</p>`) +
        `<p><strong>Comments here aren't only for discussion.</strong> The author runs an AI-assisted ` +
        `tool that takes every open comment thread and proposes a revision to the post — so your ` +
        `question or correction can become part of the next draft. A comment is a way to improve the ` +
        `piece, not just to reply to it.</p>`,
      answerText:
        `To comment, sign in with Google or Microsoft, then highlight a passage and attach your note. ` +
        `Comments here aren't only for discussion: the author runs an AI-assisted tool that turns open ` +
        `comment threads into a proposed revision of the post, so your question or correction can become ` +
        `part of the next draft.`,
    });
  }

  if (f.pwa) {
    qs.push({
      id: "install",
      question: "Can I install this as an app and read offline?",
      answerHtml:
        `<p>Yes — this blog is a Progressive Web App. You can install it to your home screen or app ` +
        `launcher. A post you've opened is cached so you can re-read it offline, and its narration is ` +
        `cached once you've started playing it — so a talk you've listened to replays without a connection.</p>` +
        `<p>Installing differs by browser:</p>` +
        `<ul>` +
        `<li><strong>Android Chrome:</strong> an "Install app" prompt appears, or use the ⋮ menu → "Install app."</li>` +
        `<li><strong>Desktop Chrome / Edge:</strong> click the install icon at the right of the address bar.</li>` +
        `<li><strong>iOS Safari:</strong> tap Share → <strong>Add to Home Screen</strong> (Safari shows no install banner).</li>` +
        `<li><strong>Desktop Safari:</strong> Share → <strong>Add to Dock</strong>.</li>` +
        `<li><strong>Firefox:</strong> no install on desktop or Android, but the offline cache still works — you just don't get an icon.</li>` +
        `</ul>` +
        `<p>What needs a connection: a post you've never opened, signing in, and loading or posting ` +
        `comments. Updates roll out automatically on your next visit.</p>`,
      answerText:
        `Yes — this blog is a Progressive Web App. Install it to your home screen or app launcher (Android/desktop ` +
        `Chrome and Edge show an install control; iOS Safari uses Share → Add to Home Screen; desktop Safari uses ` +
        `Share → Add to Dock; Firefox has no install but still caches offline). A post you've opened is cached for ` +
        `offline reading, and its narration is cached once you've started playing it. Signing in and loading or posting comments still need a connection.`,
    });
  }

  // Privacy section always present (even with no policy URL, the engine's
  // data posture is worth a sentence) — but the link only when a policy exists.
  qs.push({
    id: "privacy",
    question: "What does this blog collect about me?",
    answerHtml:
      `<p>The blog doesn't sell or share your data. Engagement analytics are anonymous and cookieless, ` +
      `and comments require sign-in and store what you write. ` +
      (ctx.privacyHref
        ? `The full details are in the <a href="${escAttr(ctx.privacyHref)}">privacy policy</a>.</p>`
        : `</p>`),
    answerText:
      `The blog doesn't sell or share your data. Engagement analytics are anonymous and cookieless, and ` +
      `comments require sign-in and store what you write.` +
      (ctx.privacyHref ? ` Full details are in the privacy policy.` : ""),
  });

  return qs;
}

// ---- FAQPage JSON-LD --------------------------------------------------------
//
// Built from the SAME question array as the prose, so the structured data and
// the visible page can't drift. Each Question carries its section-anchor @id
// (the URL a chip / LLM citation deep-links), and the FAQPage is joined to the
// landing's WebSite @graph (minted by injectSiteStructuredData) via isPartOf so
// a crawler sees one connected site rather than a floating node.
export function buildFaqJsonLd(questions: HelpQuestion[], siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  const ld: WithContext<FAQPage> = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${base}/help#faq`,
    isPartOf: { "@id": `${base}/#website` },
    // Explicit `: Question` return type so each mapped node is excess-property
    // checked — otherwise a typo INSIDE the map callback (e.g. `acceptedAnswerz`)
    // would slip past, since excess-property checks don't propagate through
    // `.map()` to the contextual `mainEntity` type.
    mainEntity: questions.map((q): Question => ({
      "@type": "Question",
      "@id": `${base}/help#${q.id}`,
      name: q.question,
      acceptedAnswer: { "@type": "Answer", text: q.answerText },
    })),
  };
  // Escape `<` so the JSON can never break out of the <script> element — same
  // guard injectStructuredData.ts uses.
  return `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
}

// ---- landing chips ----------------------------------------------------------

type Chip = { href: string; label: string };

export function featureChips(features: FeatureSet): Chip[] {
  const chips: Chip[] = [];
  if (features.narration) chips.push({ href: "/help#listen", label: "🎧 Listen on any post" });
  if (features.atom || features.podcast) chips.push({ href: "/help#subscribe", label: "📡 Subscribe" });
  if (features.comments) chips.push({ href: "/help#comments", label: "💬 Comments" });
  if (features.pwa) chips.push({ href: "/help#install", label: "📱 Install & offline" });
  chips.push({ href: "/help", label: "❓ How this blog works" });
  return chips;
}

export function buildFeatureChipsHtml(features: FeatureSet): string {
  const links = featureChips(features)
    .map((c) => `<a class="chip" href="${escAttr(c.href)}">${escHtml(c.label)}</a>`)
    .join("");
  return `<nav class="presidocs-features" aria-label="What this blog can do">${links}</nav>`;
}

// Inject the chip nav into the landing. Placed immediately before the first
// `<ul class="posts">` (the post list every landing template has); if there
// isn't one, appended to the end of <main>. Idempotent — a second pass sees the
// `presidocs-features` marker and skips.
export function injectFeatureChips(landingHtml: string, chipsHtml: string): string {
  if (landingHtml.includes("presidocs-features")) return landingHtml;
  if (landingHtml.includes('class="posts"')) {
    return new HTMLRewriter()
      .on("ul.posts", {
        element(el) {
          el.before(chipsHtml, { html: true });
        },
      })
      .transform(landingHtml);
  }
  // No post list — fall back to the end of <main>.
  return new HTMLRewriter()
    .on("main", {
      element(el) {
        el.append(chipsHtml, { html: true });
      },
    })
    .transform(landingHtml);
}

// ---- full help page ---------------------------------------------------------

export function buildHelpHtml(ctx: HelpContext, questions: HelpQuestion[]): string {
  const title = ctx.siteTitle || "this blog";
  const sections = questions
    .map(
      (q) =>
        `<section id="${escAttr(q.id)}">` +
        `<h2>${escHtml(q.question)}</h2>` +
        q.answerHtml +
        `</section>`,
    )
    .join("");

  const metaDesc = `How to listen to, subscribe to, comment on, and read ${title} offline.`;

  // Feed autodiscovery (mirrors injectFeedLinks in strip-served-html, which
  // doesn't run over this generated file). Only when a feed actually exists.
  const feedLinks =
    (ctx.features.atom
      ? `<link rel="alternate" type="application/atom+xml" title="Atom feed" href="/feed.xml" />`
      : "") +
    (ctx.features.podcast
      ? `<link rel="alternate" type="application/rss+xml" title="Podcast feed" href="/podcast.xml" />`
      : "");

  const faq = buildFaqJsonLd(questions, ctx.siteUrl);

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="${escAttr(ctx.lang || "en")}">\n` +
    `<head>\n` +
    `<meta charset="UTF-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>How this blog works — ${escHtml(title)}</title>\n` +
    `<meta name="description" content="${escAttr(metaDesc)}" />\n` +
    ctx.cssLinks +
    feedLinks +
    `\n</head>\n` +
    `<body>\n` +
    `<main class="legal help">\n` +
    `<p class="legal-back"><a href="/">&larr; Back to the blog</a></p>\n` +
    `<h1>How this blog works</h1>\n` +
    `<p class="legal-meta">A quick guide to listening, subscribing, commenting, and installing.</p>\n` +
    sections +
    `\n</main>\n` +
    faq +
    `\n</body>\n</html>\n`
  );
}

// ---- disk gather ------------------------------------------------------------

export type VersionEntry = { hash: string; builtAt: string };

// Lift the <link rel="stylesheet"> tag(s) out of the built landing page so the
// help page reuses the exact same bundled stylesheet (post-build hashed chunk).
// help.html sits at the dist root like index.html, so the relative href
// resolves identically. Falls back to the engine's source landing.css if the
// landing somehow carries no stylesheet link (degraded but not broken).
export function extractStylesheetLinks(landingHtml: string): string {
  const matches = landingHtml.match(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi);
  if (matches && matches.length) return matches.join("");
  return `<link rel="stylesheet" href="/engine/client/landing.css" />`;
}

// Any narrated post → the Listen feature exists. Mirrors the manifest check
// feeds.ts / strip-served-html.ts use per post.
export async function hasAnyNarration(generatedDir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(generatedDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const manifestName = await findManifestName(join(generatedDir, ent.name));
    if (!manifestName) continue;
    try {
      const m = (await Bun.file(join(generatedDir, ent.name, manifestName)).json()) as { audio?: string };
      if (m.audio) return true;
    } catch {
      // malformed manifest → ignore
    }
  }
  return false;
}

// Count real posts (posts/<slug>.html with an author email AND a versions.json
// record) — the same "is this a post" convention feeds.ts / site-discovery.ts
// use. Comments are a core feature on every post, so a non-zero count is what
// gates the Comments section/chip (auth config is a runtime secret we can't
// read at build time, so "has posts" is the honest build-time signal).
export async function countPosts(postsDir: string, versions: Record<string, VersionEntry[]>): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(postsDir)).filter((f) => f.endsWith(".html"));
  } catch {
    return 0;
  }
  let n = 0;
  for (const file of files) {
    const slug = file.replace(/\.html$/, "");
    const srcHtml = await Bun.file(join(postsDir, file)).text();
    if (!parseAuthorEmailFromHtml(srcHtml)) continue;
    const history = versions[`/posts/${slug}`];
    if (history && history.length > 0) n++;
  }
  return n;
}

// Assemble the HelpContext from gathered inputs. Shared by the prod build
// (main, dist-gathered) and the dev server (renderHelpHtmlFromSource,
// source-gathered) so the two can't drift. `cssLinks` is passed in because its
// source differs: prod lifts the bundled chunk link from dist/index.html; dev
// points at the engine-served landing.css.
async function buildHelpContext(args: {
  baseUrl: string;
  language?: string | null;
  hubUrl?: string | null;
  features: FeatureSet;
  versions: Record<string, VersionEntry[]>;
  cssLinks: string;
}): Promise<HelpContext> {
  const authorMap = (await buildAuthorMap(paths.postsDir, paths.contentRoot)).map;
  const newestPath = Object.entries(args.versions)
    .filter(([, h]) => h && h.length > 0)
    .sort((a, b) => (a[1]![0]!.builtAt < b[1]![0]!.builtAt ? 1 : -1))[0]?.[0];
  const authorName =
    (newestPath && authorMap[newestPath]?.name) || Object.values(authorMap)[0]?.name || null;
  const meta = await readSiteMeta();
  const lang = (args.language || "en").split("-")[0] || "en";
  const privacyHref = (process.env.PRIVACY_POLICY_URL ?? "").trim() || null;
  return {
    siteUrl: args.baseUrl,
    siteTitle: meta.title,
    siteDescription: meta.description,
    authorName: authorName ? decodeHtmlEntities(authorName) : null,
    lang,
    features: args.features,
    feeds: {
      atom: `${args.baseUrl}/feed.xml`,
      podcast: args.features.podcast ? `${args.baseUrl}/podcast.xml` : null,
      hubUrl: args.hubUrl,
    },
    privacyHref,
    cssLinks: args.cssLinks,
  };
}

// PWA <head> + site footer chrome, so /help isn't an outlier among served pages.
// Shared by prod and dev. Reads the content repo's manifest for theme/icon.
async function applyHelpChrome(helpHtml: string, privacyHref: string | null): Promise<string> {
  let out = helpHtml;
  const manifestSrc = join(paths.contentRoot, "manifest.webmanifest");
  if (existsSync(manifestSrc)) {
    try {
      const m = (await Bun.file(manifestSrc).json()) as { theme_color?: string; icons?: { src?: string }[] };
      out = injectPwaHead(out, { themeColor: m.theme_color, appleTouchIcon: m.icons?.[0]?.src });
    } catch {
      // malformed manifest → skip PWA head
    }
  }
  return injectSiteFooter(out, { privacyHref: privacyHref ?? "", helpHref: "/help" });
}

async function readVersions(): Promise<Record<string, VersionEntry[]>> {
  try {
    return (await Bun.file(paths.versionsJson).json()) as Record<string, VersionEntry[]>;
  } catch {
    return {};
  }
}

// Feature gating computed from SOURCE (no dist/), for the dev server. Mirrors
// main()'s dist-based gating: feeds are emitted whenever SITE_URL is set
// (atom), the podcast feed exists iff there's narration audio (podcast), the
// manifest ships from the content root (pwa), posts gate comments. Can differ
// from prod only where a prod artifact isn't represented in source — acceptable
// for a dev preview (see methodology).
export async function featuresFromSource(): Promise<FeatureSet> {
  const narration = await hasAnyNarration(paths.generatedDir);
  const versions = await readVersions();
  const postCount = await countPosts(paths.postsDir, versions);
  return {
    narration,
    atom: !!resolveFeedConfig().baseUrl,
    podcast: narration,
    comments: postCount > 0,
    pwa: existsSync(join(paths.contentRoot, "manifest.webmanifest")),
  };
}

/** The feature-chip nav for the landing, gated from source (dev). */
export async function chipsHtmlFromSource(): Promise<string> {
  return buildFeatureChipsHtml(await featuresFromSource());
}

/**
 * Render /help on the fly from source, for the dev server. Returns null when
 * SITE_URL is unset or the content repo ships its own help.html (which the dev
 * route should serve directly instead). `cssLinks` should point at a dev-served
 * stylesheet (the engine landing.css), since there's no bundled chunk in dev.
 */
export async function renderHelpHtmlFromSource(cssLinks: string): Promise<string | null> {
  const cfg = resolveFeedConfig();
  if (!cfg.baseUrl) return null;
  if (existsSync(join(paths.contentRoot, "help.html"))) return null; // operator's own
  const features = await featuresFromSource();
  const versions = await readVersions();
  const ctx = await buildHelpContext({
    baseUrl: cfg.baseUrl,
    language: cfg.language,
    hubUrl: cfg.hubUrl,
    features,
    versions,
    cssLinks,
  });
  const helpHtml = buildHelpHtml(ctx, buildQuestions(ctx));
  return applyHelpChrome(helpHtml, ctx.privacyHref);
}

async function main(): Promise<void> {
  const cfg = resolveFeedConfig();
  if (!cfg.baseUrl) {
    console.log("Help page: no SITE_URL — skipping.");
    return;
  }
  const baseUrl = cfg.baseUrl;
  const distDir = paths.distDir;
  if (!existsSync(distDir)) {
    console.warn("  dist/ does not exist — run `bun build` first; skipping help page.");
    return;
  }

  // Operator escape hatch: a hand-authored help.html in the content root takes
  // over (the normal build/serve path picks it up). Don't clobber it.
  if (existsSync(join(paths.contentRoot, "help.html"))) {
    console.log("Help page: content repo has its own help.html — skipping engine emit.");
    return;
  }

  const landingPath = join(distDir, "index.html");
  if (!existsSync(landingPath)) {
    console.warn("  dist/index.html missing — skipping help page + chips.");
    return;
  }
  const landingHtml = await Bun.file(landingPath).text();

  // versions.json (post path → newest-first [{hash, builtAt}]); missing → no
  // posts, which degrades the page rather than failing.
  let versions: Record<string, VersionEntry[]> = {};
  try {
    versions = (await Bun.file(paths.versionsJson).json()) as Record<string, VersionEntry[]>;
  } catch {
    versions = {};
  }

  const postCount = await countPosts(paths.postsDir, versions);

  const features: FeatureSet = {
    narration: await hasAnyNarration(paths.generatedDir),
    atom: existsSync(join(distDir, "feed.xml")),
    podcast: existsSync(join(distDir, "podcast.xml")),
    comments: postCount > 0,
    pwa: existsSync(join(distDir, "manifest.webmanifest")),
  };

  const ctx = await buildHelpContext({
    baseUrl,
    language: cfg.language,
    hubUrl: cfg.hubUrl,
    features,
    versions,
    // Prod lifts the bundled chunk link from the built landing so help.html is
    // styled by the same hashed stylesheet.
    cssLinks: extractStylesheetLinks(landingHtml),
  });

  const questions = buildQuestions(ctx);

  // 1) Emit dist/help.html with the same head/footer chrome the other served
  //    pages get (PWA <head> + site footer) so /help isn't an outlier.
  const helpHtml = await applyHelpChrome(buildHelpHtml(ctx, questions), ctx.privacyHref);
  await writeFile(landingPath.replace(/index\.html$/, "help.html"), helpHtml, "utf8");

  // 2) Inject the feature chips into the landing (idempotent).
  const chips = buildFeatureChipsHtml(features);
  const newLanding = injectFeatureChips(landingHtml, chips);
  if (newLanding !== landingHtml) {
    await writeFile(landingPath, newLanding, "utf8");
  }

  const live = featureChips(features)
    .map((c) => c.label.replace(/^[^ ]+ /, ""))
    .join(", ");
  console.log(
    `Help page: dist/help.html (${questions.length} section${questions.length === 1 ? "" : "s"})` +
      `, chips on dist/index.html [${live}]`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
