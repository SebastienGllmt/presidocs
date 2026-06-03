// Post-build step: rewrites every HTML file under `dist/` to remove
// generation-only tags (see `shared/stripServedHtml.ts`), injecting the
// structured-data + feed-autodiscovery + privacy-footer chrome along the way.
// Runs in-place. Idempotent — running twice produces the same output.
//
// Dev (`bun --hot index.ts`) does NOT apply this transform — the full HTML is
// served on localhost. The dev/prod difference is harmless: stripped tags are
// inert at runtime (player loads from the pre-generated manifest; server-side
// author check reads source HTML rather than served HTML).
//
// Analytics live entirely client-side (a `sendBeacon` from `client/analytics.ts`
// to `/_a`, written to Cloudflare Analytics Engine — see methodology.md →
// "Engagement analytics"). No build-time inject is needed.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stripServedHtml } from "../shared/stripServedHtml.ts";
import { injectSiteFooter } from "../shared/injectFooter.ts";
import { injectPwaHead, type PwaHeadOptions } from "../shared/injectPwaHead.ts";
import {
  injectStructuredData,
  injectSiteStructuredData,
  type StructuredDataContext,
  type SiteStructuredDataContext,
} from "../shared/injectStructuredData.ts";
import { buildAuthorMap, type PublicAuthorProfile } from "../shared/authorProfile.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { findManifestName } from "../shared/manifestFile.ts";

const paths = resolveBlogPaths();
const ROOT = paths.contentRoot;
const DIST = paths.distDir;

type VersionEntry = { hash: string; builtAt: string };
type VersionsFile = Record<string, VersionEntry[]>;

// dist/posts/offer-files.html → "/posts/offer-files"; non-post files map to a
// path that simply won't exist in versions.json (so they're skipped).
function distFileToPostPath(file: string): string {
  const rel = relative(DIST, file).split(sep).join("/").replace(/\.html$/, "");
  return `/${rel}`;
}

// Feed autodiscovery links, added to every page's <head> when feeds are built
// (i.e. SITE_URL is set, the same gate generate/feeds.ts uses). Relative hrefs
// resolve against the page origin; the podcast link is harmless if a given
// deploy has no audio (the file just 404s).
function injectFeedLinks(html: string): string {
  if (html.includes('type="application/atom+xml"')) return html;
  const links =
    `<link rel="alternate" type="application/atom+xml" title="Atom feed" href="/feed.xml" />` +
    `<link rel="alternate" type="application/rss+xml" title="Podcast feed" href="/podcast.xml" />`;
  return new HTMLRewriter()
    .on("head", { element(el) { el.append(links, { html: true }); } })
    .transform(html);
}

// Advertise the post's Markdown twin (`/posts/<slug>.md`, emitted by
// generate/markdown-export.ts) so the "Copy as Markdown" button — and any
// LLM/crawler that prefers Markdown — can discover it. Post-scoped; relative
// href resolves against the page origin, exactly like the feed autodiscovery
// links above. Idempotent on the `type="text/markdown"` marker. Independent of
// SITE_URL: the `.md` is built on every deploy, so the link always points at a
// real file (mirrors how the feed links advertise /feed.xml before feeds.ts).
function injectMarkdownAltLink(html: string, postPath: string): string {
  if (!postPath.startsWith("/posts/")) return html;
  if (html.includes('type="text/markdown"')) return html;
  const link =
    `<link rel="alternate" type="text/markdown" title="Markdown" href="${postPath}.md" />`;
  return new HTMLRewriter()
    .on("head", { element(el) { el.append(link, { html: true }); } })
    .transform(html);
}

// The narration track for a post, if it was generated (opt-out posts have none).
async function readAudio(
  postPath: string,
): Promise<{ url: string; durationMs: number } | null> {
  const slug = postPath.replace(/^\/posts\//, "");
  const dir = join(paths.generatedDir, slug);
  const name = await findManifestName(dir);
  if (!name) return null;
  try {
    const m = (await Bun.file(join(dir, name)).json()) as {
      audio?: string;
      duration?: number;
    };
    if (!m.audio || typeof m.duration !== "number") return null;
    return { url: m.audio, durationMs: m.duration };
  } catch {
    return null;
  }
}

// Sample any source post's `data-narration-artist` — used as the WebSite/Blog
// publisher on the landing page so it matches each post's BlogPosting.publisher
// (one source, not a separate landing-only knob). Empty when no post declares
// one; the landing injector degrades the publisher field rather than failing.
//
// Uses HTMLRewriter (the right HTML parser, matching the per-post extractor in
// injectStructuredData.ts) rather than a regex over attribute syntax — a regex
// like /data-narration-artist=["']([^"']+)["']/ silently truncates values
// containing an apostrophe (e.g. "Author's blog" → "Author"), because the
// negated character class `[^"']+` stops at the first quote of EITHER kind.
async function readSitePublisher(postsDir: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(postsDir);
  } catch {
    return "";
  }
  // readdir order is filesystem-dependent; sort for a deterministic pick when
  // posts disagree (which they shouldn't — `data-narration-artist` is the
  // publisher label and should be consistent across posts of the same blog).
  entries.sort();
  for (const f of entries) {
    if (!f.endsWith(".html")) continue;
    const html = await Bun.file(join(postsDir, f)).text();
    let found = "";
    new HTMLRewriter()
      .on("[data-narration-artist]", {
        element(el) {
          if (!found) found = el.getAttribute("data-narration-artist") ?? "";
        },
      })
      .transform(html);
    if (found) return found;
  }
  return "";
}

// Pick a site-level author for the landing JSON-LD. For a single-author blog
// the map has one entry; for multi-author we pick the author of the newest
// post (mirrors feeds.ts:475 — `posts.find((p) => p.author)`). With no posts,
// returns null and the landing degrades cleanly.
function pickSiteAuthor(
  authorMap: Record<string, PublicAuthorProfile>,
  versions: VersionsFile,
): PublicAuthorProfile | null {
  const newest = Object.entries(versions)
    .filter(([, h]) => h && h.length > 0)
    .sort((a, b) => (a[1]![0]!.builtAt < b[1]![0]!.builtAt ? 1 : -1))[0];
  if (newest && authorMap[newest[0]]) return authorMap[newest[0]]!;
  const first = Object.values(authorMap)[0];
  return first ?? null;
}

// Point the player at the content-addressed manifest. The author writes a
// stable `data-narration-src="/generated/<slug>/manifest.json"`; we rewrite it
// to the `manifest.<hash>.json` actually on disk so the URL the browser fetches
// changes whenever the narration changes — which is what lets the service
// worker and the Cloudflare edge cache the manifest immutably without ever
// pinning a stale copy that points the <audio> element at a swept `full.<hash>`
// (the `NotSupportedError` failure). Posts with no manifest — or only a legacy
// bare `manifest.json` — are left untouched. Idempotent: a second pass sees the
// already-rewritten URL and returns the html unchanged.
async function rewriteNarrationManifestSrc(
  html: string,
  postPath: string,
  generatedDir: string = paths.generatedDir,
): Promise<string> {
  if (!postPath.startsWith("/posts/")) return html;
  const slug = postPath.slice("/posts/".length);
  const name = await findManifestName(join(generatedDir, slug));
  if (!name || name === "manifest.json") return html;
  const url = `/generated/${slug}/${name}`;
  if (html.includes(`data-narration-src="${url}"`)) return html;
  return new HTMLRewriter()
    .on("[data-narration-src]", {
      element(el) {
        el.setAttribute("data-narration-src", url);
      },
    })
    .transform(html);
}

// Mark the post's top-level <article> as the document's main landmark. Posts
// render <body><article …> with no <main>; axe's landmark-one-main wants
// exactly one main landmark, and role="main" on the article satisfies it
// without restructuring authored HTML. Post-scoped (the /posts/ gate) so the
// landing page — which has its own <main> and may list <article> cards — is
// untouched. Idempotent: the first <article> already carrying a role
// (role="main" from a prior pass, or an author-set role) short-circuits the add.
function injectPostMainLandmark(html: string, postPath: string): string {
  if (!postPath.startsWith("/posts/")) return html;
  let done = false;
  return new HTMLRewriter()
    .on("article", {
      element(el) {
        if (done) return;
        done = true;
        if (!el.getAttribute("role")) el.setAttribute("role", "main");
      },
    })
    .transform(html);
}

async function walkHtml(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...await walkHtml(full));
    } else if (ent.isFile() && ent.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  // URL of the blog's privacy policy. If set, every served page gets a
  // small <footer> at the end of <body> linking to it — the GDPR /
  // CalOPPA / APPI guidance pattern (one conspicuous, every-page link
  // using the word "Privacy"). Unset → no footer is injected.
  const privacyHref = (process.env.PRIVACY_POLICY_URL ?? "").trim();
  // Canonical site origin for absolute URLs in structured data / OG tags. No
  // value → skip the structured-data inject entirely (fail-silent); the blog
  // still works, it just doesn't get rich cards in this deploy. Prod always
  // knows its hostname.
  const siteUrl = (process.env.SITE_URL ?? "").trim().replace(/\/+$/, "");

  // Per-blog PWA <head> values, read once from the blog's manifest.webmanifest.
  // If absent, the PWA inject is skipped entirely (no broken /manifest link in
  // the served HTML — same fail-silent posture as the structured-data + footer
  // injects). When present, theme_color and icons[0].src flow through as the
  // <meta name="theme-color"> and <link rel="apple-touch-icon"> values.
  let pwaOpts: PwaHeadOptions | null = null;
  const manifestPath = join(ROOT, "manifest.webmanifest");
  if (existsSync(manifestPath)) {
    try {
      const m = (await Bun.file(manifestPath).json()) as {
        theme_color?: string;
        icons?: { src?: string }[];
      };
      pwaOpts = {
        themeColor: m.theme_color,
        appleTouchIcon: m.icons?.[0]?.src,
      };
    } catch {
      pwaOpts = null;
    }
  }

  // The footer's "How this blog works" link points at /help, which
  // generate/help-page.ts emits when SITE_URL is set (same gate). Linking it
  // before that step runs is fine — it exists by serve time, exactly like the
  // feed autodiscovery links advertise /feed.xml before generate/feeds.ts runs.
  const helpHref = siteUrl ? "/help" : "";

  const stages = ["author-email + narration + PLS strip"];
  if (siteUrl) stages.push("structured data + OG + Twitter Card");
  else stages.push("(no SITE_URL — skipping structured-data inject)");
  if (privacyHref || helpHref) {
    const parts = [helpHref ? "help" : null, privacyHref ? "privacy" : null].filter(Boolean);
    stages.push(`site footer (${parts.join(" + ")})`);
  } else stages.push("(no PRIVACY_POLICY_URL or SITE_URL — skipping footer inject)");
  if (pwaOpts) stages.push("PWA <head> (manifest + theme-color + apple-touch-icon)");
  else stages.push("(no manifest.webmanifest — skipping PWA <head> inject)");
  console.log(`Post-build HTML rewrite: ${stages.join(", ")}…`);

  const files = await walkHtml(DIST);
  if (files.length === 0) {
    console.warn(
      `  No HTML files found under ${relative(ROOT, DIST)} — did you run \`bun build\` first?`,
    );
    return;
  }

  // Gathered once for the structured-data inject: per-post dates (versions.json,
  // newest-first), the public author profiles (post path → name/links/avatar,
  // never the email — same source as the byline), and the site-level publisher
  // label (sampled from a post's `data-narration-artist`, so the landing's
  // Blog.publisher matches each post's BlogPosting.publisher). All empty/absent
  // → the inject degrades field-by-field.
  let versions: VersionsFile = {};
  let authorMap: Record<string, PublicAuthorProfile> = {};
  let sitePublisher = "";
  let siteAuthor: PublicAuthorProfile | null = null;
  if (siteUrl) {
    try {
      versions = (await Bun.file(paths.versionsJson).json()) as VersionsFile;
    } catch {
      versions = {};
    }
    authorMap = (await buildAuthorMap(paths.postsDir, ROOT)).map;
    sitePublisher = await readSitePublisher(paths.postsDir);
    siteAuthor = pickSiteAuthor(authorMap, versions);
  }

  const landingPath = join(DIST, "index.html");

  let totalSaved = 0;
  let touched = 0;
  for (const file of files) {
    const before = await readFile(file, "utf8");
    let after = stripServedHtml(before);

    // Content-address the narration manifest URL (independent of SITE_URL — the
    // cache-correctness fix must apply to every deploy). No-op for non-posts and
    // posts without a hashed manifest.
    after = await rewriteNarrationManifestSrc(after, distFileToPostPath(file));

    // Give the post's <article> the main landmark (axe landmark-one-main).
    // Independent of SITE_URL — the /posts/ gate scopes it to real posts.
    after = injectPostMainLandmark(after, distFileToPostPath(file));

    // Advertise the post's Markdown twin (built by markdown-export.ts).
    // Independent of SITE_URL — the .md is emitted on every deploy.
    after = injectMarkdownAltLink(after, distFileToPostPath(file));

    // Structured data: real posts get BlogPosting; the landing page gets a
    // WebSite/Blog @graph; everything else short-circuits.
    if (siteUrl) {
      const postPath = distFileToPostPath(file);
      const history = versions[postPath];
      if (history && history.length > 0) {
        const profile = authorMap[postPath];
        // The generated share card, if share-card.ts produced one (it skips
        // posts that declare their own og:image). Gated on the file actually
        // existing so a missing card degrades to "no og:image" rather than a
        // broken link.
        const slug = postPath.replace(/^\/posts\//, "");
        const cardFsPath = join(DIST, "assets", "og", `${slug}.png`);
        const cardUrl = existsSync(cardFsPath) ? `/assets/og/${slug}.png` : null;
        const ctx: StructuredDataContext = {
          siteUrl,
          postPath,
          author: profile
            ? { name: profile.name, links: profile.links, avatarUrl: profile.avatar }
            : null,
          publishedAt: history[history.length - 1]!.builtAt,
          modifiedAt: history[0]!.builtAt,
          audio: await readAudio(postPath),
          cardUrl,
        };
        after = injectStructuredData(after, ctx);
      } else if (file === landingPath) {
        // The landing-page share card (generate/share-card.ts:_site.png). Gated
        // on the file actually existing so a deploy without share cards (no
        // SITE_URL when share-card.ts ran, or no site description) degrades
        // cleanly to "no og:image" rather than a broken link.
        const siteCardFsPath = join(DIST, "assets", "og", "_site.png");
        const siteCardUrl = existsSync(siteCardFsPath) ? "/assets/og/_site.png" : null;
        const siteCtx: SiteStructuredDataContext = {
          siteUrl,
          author: siteAuthor
            ? { name: siteAuthor.name, links: siteAuthor.links, avatarUrl: siteAuthor.avatar }
            : null,
          publisher: sitePublisher,
          cardUrl: siteCardUrl,
        };
        after = injectSiteStructuredData(after, siteCtx);
      }
      // Feed autodiscovery on every page (landing included), not just posts.
      after = injectFeedLinks(after);
    }

    if (privacyHref || helpHref) {
      after = injectSiteFooter(after, { privacyHref, helpHref });
    }
    if (pwaOpts) {
      after = injectPwaHead(after, pwaOpts);
    }
    if (after === before) continue;
    await writeFile(file, after, "utf8");
    const delta = before.length - after.length;
    totalSaved += delta;
    touched++;
    console.log(
      `  ${relative(ROOT, file)} — ${delta > 0 ? `${delta} bytes removed` : `${-delta} bytes added`}`,
    );
  }
  console.log(
    `Done. Net ${totalSaved} bytes across ${touched}/${files.length} file(s).`,
  );
}

// Only run as a CLI; importing the helpers (e.g. from tests) must not trigger
// the build pass. Matches the posture of feeds.ts / site-discovery.ts.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for tests.
export {
  readSitePublisher,
  rewriteNarrationManifestSrc,
  injectPostMainLandmark,
  injectMarkdownAltLink,
};
