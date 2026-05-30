// Post-build step: rewrites every HTML file under `dist/` to
//   1. Remove generation-only tags (see `shared/stripServedHtml.ts`).
//   2. Inject the Cloudflare Web Analytics beacon if
//      `CF_ANALYTICS_TOKEN` is set in the environment (see
//      `shared/injectAnalytics.ts`).
// Runs in-place. Idempotent — running twice produces the same output.
//
// Dev (`bun --hot index.ts`) does NOT apply either transform — the
// full HTML is served on localhost and no analytics beacon fires.
// The dev/prod difference is harmless: stripped tags are inert at
// runtime (player loads from the pre-generated manifest; server-side
// author check reads source HTML rather than served HTML), and
// localhost views aren't something the analytics dashboard should
// count anyway.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stripServedHtml } from "../shared/stripServedHtml.ts";
import { injectCloudflareAnalytics } from "../shared/injectAnalytics.ts";
import {
  injectStructuredData,
  type StructuredDataContext,
} from "../shared/injectStructuredData.ts";
import { buildAuthorMap } from "../shared/authorProfile.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";

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

// The narration track for a post, if it was generated (opt-out posts have none).
async function readAudio(
  postPath: string,
): Promise<{ url: string; durationMs: number } | null> {
  const slug = postPath.replace(/^\/posts\//, "");
  const manifestPath = join(paths.generatedDir, slug, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const m = (await Bun.file(manifestPath).json()) as {
      audio?: string;
      duration?: number;
    };
    if (!m.audio || typeof m.duration !== "number") return null;
    return { url: m.audio, durationMs: m.duration };
  } catch {
    return null;
  }
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
  const analyticsToken = (process.env.CF_ANALYTICS_TOKEN ?? "").trim();
  // Canonical site origin for absolute URLs in structured data / OG tags. No
  // value → skip the structured-data inject entirely (same fail-silent posture
  // as a missing CF_ANALYTICS_TOKEN); the blog still works, it just doesn't get
  // rich cards in this deploy. Prod always knows its hostname.
  const siteUrl = (process.env.SITE_URL ?? "").trim().replace(/\/+$/, "");

  const stages = ["author-email + narration + PLS strip"];
  if (siteUrl) stages.push("structured data + OG + Twitter Card");
  else stages.push("(no SITE_URL — skipping structured-data inject)");
  if (analyticsToken) stages.push("Cloudflare Analytics beacon");
  else stages.push("(no CF_ANALYTICS_TOKEN — skipping analytics inject)");
  console.log(`Post-build HTML rewrite: ${stages.join(", ")}…`);

  const files = await walkHtml(DIST);
  if (files.length === 0) {
    console.warn(
      `  No HTML files found under ${relative(ROOT, DIST)} — did you run \`bun build\` first?`,
    );
    return;
  }

  // Gathered once for the structured-data inject: per-post dates (versions.json,
  // newest-first) and the public author profiles (post path → name/links/avatar,
  // never the email — same source as the byline). Both empty/absent → the
  // inject degrades field-by-field.
  let versions: VersionsFile = {};
  let authorMap: Record<string, { name: string; links: Record<string, string>; avatar: string | null }> = {};
  if (siteUrl) {
    try {
      versions = (await Bun.file(paths.versionsJson).json()) as VersionsFile;
    } catch {
      versions = {};
    }
    authorMap = (await buildAuthorMap(paths.postsDir, ROOT)).map;
  }

  let totalSaved = 0;
  let touched = 0;
  for (const file of files) {
    const before = await readFile(file, "utf8");
    let after = stripServedHtml(before);

    // Structured data only for real posts (those with a version record);
    // landing/other HTML short-circuit.
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
      }
      // Feed autodiscovery on every page (landing included), not just posts.
      after = injectFeedLinks(after);
    }

    if (analyticsToken) {
      after = injectCloudflareAnalytics(after, analyticsToken);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
