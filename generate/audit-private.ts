// Build-time PRIVACY gate for a private (capability-URL) blog — the
// allowlist-shaped proof that every discovery emitter actually suppressed
// itself (methodology → Private blogs; proposal 57). Suppression happens at
// each emitter, consulting `BLOG_PRIVATE` (shared/blogPrivacy.ts); this gate
// is the belt over those suspenders, run as the LAST step of a private
// content repo's `bun run build`, after audit-posts.ts.
//
// Why an audit and not trust in the knob: a blacklist-shaped scrub (delete
// known leak files from dist/) would let a NEW emitter leak by default, and
// the externally-POSTing steps (publish webhooks, WebSub) leave the machine
// during deploy where nothing can be scrubbed. This gate enumerates the leak
// ledger deterministically and fails the build on any violation:
//
//   forbidden-file   — dist/{sitemap.xml,llms.txt,feed.xml,podcast.xml} exist
//                      to ENUMERATE posts; they must not exist.
//   robots-sitemap   — robots.txt must carry no `Sitemap:` pointer. (It IS
//                      still emitted, default-allow: the index-exclusion work
//                      is done by noindex, and `Disallow: /` would backfire —
//                      a crawler forbidden from fetching a leaked link never
//                      sees the noindex, so the URL can be indexed URL-only.)
//   post-link-leak   — no served NON-post page (landing, help, privacy, …)
//                      may link into /posts/: the landing is the one
//                      guessable URL in the deploy.
//   ai-search-leak   — the Ask-this-blog affordance hands an external LLM the
//                      blog URL + llms.txt index; it must not be injected.
//   noindex-meta     — every served page carries <meta name="robots"> with
//                      noindex (the belt for the X-Robots-Tag header, for any
//                      path where HTML is mirrored without its headers).
//   slug-token       — every deployable posts/*.html filename ends in the
//                      `--<token>` capability suffix (≥11 base64url chars;
//                      see shared/blogPrivacy.ts for the calibration).
//                      `_`-prefixed dev-only posts are exempt (never deploy).
//   announce-env     — the announce channels (publish webhooks, WebSub) must
//                      not be configured: they push post URLs to third
//                      parties on deploy.
//   not-private      — BLOG_PRIVATE itself must be set. This script's
//                      presence in a build chain DECLARES the repo private;
//                      a lost env var must fail the build, not silently
//                      flip the deploy public.
//
// Runtime invariants (X-Robots-Tag on every response, Referrer-Policy
// stripping paths from outbound clicks) can't be seen in dist/ — they're
// asserted by the e2e tier (e2e/privateBlog.ts) against the built worker.

import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseHTML } from "linkedom";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { isPrivateBlog, PRIVATE_SLUG_TOKEN_RE } from "../shared/blogPrivacy.ts";
import { collectHtmlFiles } from "../shared/walkHtml.ts";

export type PrivacyViolation = { rule: string; detail: string };

/**
 * dist/ paths (relative to dist/) that ENUMERATE posts — every one hands a
 * holder of a single capability link the full post list, defeating the
 * model. sitemap/llms/feeds advertise to crawlers; the two /assets maps are
 * the byline's data sources (the byline reads inline per-post data instead on
 * a private blog — see copy-static.ts / strip-served-html.ts:injectBylineData).
 */
export const FORBIDDEN_DIST_FILES = [
  "sitemap.xml",
  "llms.txt",
  "feed.xml",
  "podcast.xml",
  "assets/post-versions.json",
  "assets/authors.json",
] as const;

/** Env vars that announce posts to third parties on deploy. */
export const FORBIDDEN_ANNOUNCE_VARS = [
  "DISCORD_WEBHOOK_URL",
  "SLACK_WEBHOOK_URL",
  "WEBHOOK_URL",
  "WEBSUB_HUB",
] as const;

/**
 * Audit one served page's HTML (build-only — linkedom per the engine's HTML
 * parsing conventions). `isPost` relaxes the link rule: posts may link each
 * other (same capability class); everything else must not link into /posts/.
 */
export function auditPrivateHtml(html: string, opts: { isPost: boolean }): PrivacyViolation[] {
  const out: PrivacyViolation[] = [];
  const { document } = parseHTML(html);

  if (!opts.isPost) {
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (/(^|\/\/[^/]+)\/posts\//.test(href) || href.startsWith("/posts/")) {
        out.push({ rule: "post-link-leak", detail: `links into /posts/: ${href}` });
      }
    }
    if (document.querySelector(".presidocs-ai-search")) {
      out.push({ rule: "ai-search-leak", detail: "Ask-this-blog affordance present" });
    }
  }

  const robots = document.querySelector('meta[name="robots" i]');
  const content = (robots?.getAttribute("content") ?? "").toLowerCase();
  if (!content.includes("noindex")) {
    out.push({ rule: "noindex-meta", detail: '<meta name="robots"> with noindex missing' });
  }

  return out;
}

/** Audit one source post filename (basename without `.html`). */
export function auditPrivateSlug(slug: string): PrivacyViolation | null {
  if (slug.startsWith("_")) return null; // dev-only; never deploys
  if (PRIVATE_SLUG_TOKEN_RE.test(slug)) return null;
  return {
    rule: "slug-token",
    detail: `posts/${slug}.html lacks the --<token> capability suffix (≥11 base64url chars; \`bun run new-post\` generates one)`,
  };
}

/** Audit robots.txt content. */
export function auditPrivateRobots(robotsTxt: string): PrivacyViolation[] {
  return /^Sitemap:/m.test(robotsTxt)
    ? [{ rule: "robots-sitemap", detail: "robots.txt carries a Sitemap: pointer" }]
    : [];
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();
  const violations: Array<{ where: string; v: PrivacyViolation }> = [];
  const fail = (where: string, v: PrivacyViolation) => violations.push({ where, v });

  if (!isPrivateBlog()) {
    // Loud by design: this script in the build chain DECLARES the repo
    // private. Don't no-op — a lost BLOG_PRIVATE must not quietly ship a
    // public deploy of private content.
    console.error(
      "Privacy audit FAILED: BLOG_PRIVATE is not set, but audit-private.ts is in the build chain.\n" +
        "  This repo declares itself private; set BLOG_PRIVATE=1 in .env (or remove the audit, deliberately).",
    );
    process.exit(1);
  }

  for (const name of FORBIDDEN_DIST_FILES) {
    if (existsSync(join(paths.distDir, name))) {
      fail(`dist/${name}`, { rule: "forbidden-file", detail: "post-enumerating artifact present" });
    }
  }

  const robotsPath = join(paths.distDir, "robots.txt");
  if (existsSync(robotsPath)) {
    for (const v of auditPrivateRobots(readFileSync(robotsPath, "utf8"))) fail("dist/robots.txt", v);
  }

  for (const dist of await collectDistHtml(paths.distDir)) {
    const rel = relative(paths.distDir, dist).split(sep).join("/");
    const isPost = rel.startsWith("posts/");
    for (const v of auditPrivateHtml(readFileSync(dist, "utf8"), { isPost })) fail(`dist/${rel}`, v);
  }

  for (const full of collectHtmlFiles(paths.postsDir)) {
    const slug = relative(paths.postsDir, full).split(sep).join("/").replace(/\.html$/, "");
    const v = auditPrivateSlug(slug);
    if (v) fail(`posts/${slug}.html`, v);
  }

  for (const name of FORBIDDEN_ANNOUNCE_VARS) {
    if ((process.env[name] ?? "").trim() !== "") {
      fail(`env:${name}`, { rule: "announce-env", detail: "announce channel configured on a private blog" });
    }
  }

  if (violations.length > 0) {
    console.error(`Privacy audit FAILED: ${violations.length} violation(s):`);
    for (const { where, v } of violations) console.error(`  ✗ ${where} [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log("Privacy audit OK: no enumeration artifacts, no post links off-post, noindex everywhere, capability slugs throughout.");
}

async function collectDistHtml(distDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".html")) out.push(full);
    }
  };
  await walk(distDir);
  return out;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
