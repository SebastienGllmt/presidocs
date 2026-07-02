// Public source-repo config for the reader-facing "View on GitHub" control
// (client/viewSource.ts) — the post-level affordance that links a reader to the
// post's own source on the blog's public repo. Opt-in and env-driven, the same
// config-as-data shape as SITE_URL / CONTENT_LICENSE / PODCAST_LICENSE.
//
//   SOURCE_REPO_URL    — the repo's web base, e.g. https://github.com/you/blog.
//                        Unset → no control (the default; a blog need not have a
//                        public repo).
//   SOURCE_REPO_BRANCH — the branch the live posts track (default `main`).
//
// The per-post URL is `<SOURCE_REPO_URL>/blob/<branch>/posts/<slug>.html`, which
// mirrors the site path: a post served at `/posts/<slug>` is authored at
// `posts/<slug>.html` in the repo, so the URL path appends `.html` to the site
// path. GitHub is the assumed host (the `/blob/<branch>/` shape); a non-GitHub
// forge would need its own URL template — out of scope until one is used.
//
// PRIVATE BLOGS GET NOTHING, unconditionally: a public-repo link would reveal
// that a capability-gated post exists in public and hand out an off-capability
// URL — exactly the leak the private model forbids. So `resolveSourceRepo`
// returns null when BLOG_PRIVATE is set even if SOURCE_REPO_URL is too (belt over
// the suspenders that a private blog simply wouldn't set the var); the head-plugin
// injection is gated on this, and audit-private.ts asserts no `vcs-github` link
// reaches a private build.

import { isPrivateBlog } from "../shared/blogPrivacy.ts";

/** Resolved repo location: a web base already including `/blob/<branch>`. */
export type SourceRepo = { base: string };

export function resolveSourceRepo(env: Record<string, string | undefined> = process.env): SourceRepo | null {
  if (isPrivateBlog(env)) return null; // never expose a public source link on a private blog
  const url = (env.SOURCE_REPO_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return null;
  const branch = (env.SOURCE_REPO_BRANCH ?? "").trim() || "main";
  return { base: `${url}/blob/${branch}` };
}

/**
 * The repo URL for a post given its site path. `/posts/<slug>` →
 * `<base>/posts/<slug>.html` (the repo file path mirrors the site path + `.html`).
 * Pure; the head plugin precomputes this so the client only reads the href.
 */
export function sourceUrlForPostPath(repo: SourceRepo, postPath: string): string {
  return `${repo.base}${postPath.replace(/\/+$/, "")}.html`;
}
