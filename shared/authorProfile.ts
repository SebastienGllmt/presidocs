// Per-author public profile resolution: the display name, social links, and
// avatar shown in a post's byline.
//
// Keyed by `<author-email>`, the same key as the post→email index
// (`server/postMeta.ts`): a post carries its author's email, and everything
// author-level hangs off that one key in a single per-author folder. One author
// onboarding is a few file commits under `authors/`, discoverable by listing —
// no central config to keep in sync, no env-var fallback.
//
//   authors/<author-email>.json   { name, handle?, links?, avatar? }
//   authors/<author-email>.png    avatar (or .jpg/.jpeg/.webp; an explicit
//                                  "avatar" field overrides discovery)
//   authors/<author-email>.wav    MOSS voice-clone clip (build-only input,
//                                  never served — see shared/voiceResolution.ts)
//
// THE LOAD-BEARING CONSTRAINT: the served byline must NOT re-leak the email.
// `<meta name="author-email">` is deliberately stripped from served HTML
// (shared/stripServedHtml.ts) so the address stays out of crawlers' hands. So
// the email is only ever a *disk/join* key here — every value that reaches the
// client (avatar URL, anchor text) is derived from the public `handle`/`name`,
// never the email. The served avatar lives at `/assets/authors/<handle>.<ext>`,
// not `/.../<email>.<ext>`.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { safeEmailComponent } from "./voiceResolution.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";

// What the client byline renders. No `handle` field and no email: the avatar
// URL already embeds the public handle, and nothing else needs it.
export type PublicAuthorProfile = {
  name: string;
  links: Record<string, string>;
  /** Served URL `/assets/authors/<handle>.<ext>`, or null when no avatar file. */
  avatar: string | null;
};

// The on-disk profile JSON shape. Only `name` is required.
type ProfileJson = {
  name?: unknown;
  handle?: unknown;
  links?: unknown;
  avatar?: unknown;
};

export type ResolvedAuthor = {
  profile: PublicAuthorProfile;
  /** Absolute path to the source avatar on disk, or null. */
  avatarSrcPath: string | null;
  /** Served filename `<handle>.<ext>` (the public name), or null. */
  avatarServedName: string | null;
};

export type AuthorProfileResolution =
  | { ok: true; author: ResolvedAuthor }
  | { ok: false; reason: string };

const AVATAR_EXTS = ["png", "jpg", "jpeg", "webp"] as const;

// A public, URL- and filename-safe slug. Lowercased so the served path is
// case-stable across filesystems; only `[a-z0-9._-]` survive. `@` and other
// X-handle punctuation collapse to `-`. This is what keeps the email out of the
// served URL — the slug derives from the public handle/name, never the address.
function slugifyHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

// Derive the public handle, in priority order: explicit `handle`, then the X
// link's last path segment, then a slug of the display name. Always sanitized.
function resolveHandle(
  explicit: string | undefined,
  links: Record<string, string>,
  name: string,
): string {
  if (explicit && explicit.trim()) return slugifyHandle(explicit);
  const x = links.x;
  if (x) {
    const seg = x.replace(/\/+$/, "").split("/").pop();
    if (seg) return slugifyHandle(seg);
  }
  return slugifyHandle(name) || "author";
}

function coerceLinks(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

// Resolve one author's public profile from `authors/<email>.{json,<avatar>}`.
// Returns a structured failure (named gap) rather than inventing an author —
// the same posture as `resolveAuthorVoice`. Callers degrade (skip the byline)
// rather than fail the build.
export async function resolveAuthorProfile(
  contentRoot: string,
  authorEmail: string | null | undefined,
): Promise<AuthorProfileResolution> {
  const safe = authorEmail ? safeEmailComponent(authorEmail) : null;
  if (!safe) {
    return {
      ok: false,
      reason: authorEmail
        ? `author email "${authorEmail}" is not usable as a filename`
        : `no author-email available`,
    };
  }
  const authorsDir = join(contentRoot, "authors");
  const jsonPath = join(authorsDir, `${safe}.json`);
  if (!existsSync(jsonPath)) {
    return { ok: false, reason: `no authors/${safe}.json` };
  }

  let parsed: ProfileJson;
  try {
    parsed = (await Bun.file(jsonPath).json()) as ProfileJson;
  } catch (err) {
    return { ok: false, reason: `authors/${safe}.json is not valid JSON (${err})` };
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) {
    return { ok: false, reason: `authors/${safe}.json has no "name"` };
  }
  const links = coerceLinks(parsed.links);
  const handle = resolveHandle(
    typeof parsed.handle === "string" ? parsed.handle : undefined,
    links,
    name,
  );

  // Avatar: explicit "avatar" filename (resolved under authors/) wins, else
  // discover authors/<email>.<ext> by the known extension list.
  let avatarSrcPath: string | null = null;
  let avatarExt: string | null = null;
  if (typeof parsed.avatar === "string" && parsed.avatar.trim()) {
    const candidate = join(authorsDir, parsed.avatar.trim());
    // Keep it inside authors/ — no path traversal out of the profile folder.
    if (
      candidate.startsWith(authorsDir + sep) &&
      existsSync(candidate)
    ) {
      avatarSrcPath = candidate;
      avatarExt = parsed.avatar.trim().split(".").pop()?.toLowerCase() ?? null;
    }
  }
  if (!avatarSrcPath) {
    for (const ext of AVATAR_EXTS) {
      const candidate = join(authorsDir, `${safe}.${ext}`);
      if (existsSync(candidate)) {
        avatarSrcPath = candidate;
        avatarExt = ext;
        break;
      }
    }
  }

  const avatarServedName =
    avatarSrcPath && avatarExt ? `${handle}.${avatarExt}` : null;
  const avatar = avatarServedName ? `/assets/authors/${avatarServedName}` : null;

  return {
    ok: true,
    author: { profile: { name, links, avatar }, avatarSrcPath, avatarServedName },
  };
}

// What the build (copy-static) and the dev server both need: the public map the
// client byline fetches (`/assets/authors.json`, keyed by post path) plus the
// avatar files to publish. One builder so dev and prod render identical bylines.
//
// Walks `posts/*.html` for the per-post author email (same convention as
// `generate/post-meta.ts`), then resolves each author's profile. A post whose
// author has no resolvable profile is logged and simply omitted from the map
// (no byline) — degrade, don't fail the build.
export type AuthorMap = {
  /** Post path → public profile, e.g. `/posts/offer-files` → {...}. */
  map: Record<string, PublicAuthorProfile>;
  /** Served avatar filename → absolute source path on disk. */
  avatars: Record<string, string>;
};

async function walkPostEmails(
  rootDir: string,
  currentDir: string,
  out: Record<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(currentDir, ent.name);
    if (ent.isDirectory()) {
      await walkPostEmails(rootDir, full, out);
    } else if (ent.isFile() && ent.name.endsWith(".html")) {
      const email = parseAuthorEmailFromHtml(await Bun.file(full).text());
      if (!email) continue;
      const noExt = relative(rootDir, full).split(sep).join("/").replace(/\.html$/, "");
      out[`/posts/${noExt}`] = email;
    }
  }
}

export async function buildAuthorMap(
  postsDir: string,
  contentRoot: string,
  warn: (msg: string) => void = () => {},
): Promise<AuthorMap> {
  const emails: Record<string, string> = {};
  await walkPostEmails(postsDir, postsDir, emails);

  const map: Record<string, PublicAuthorProfile> = {};
  const avatars: Record<string, string> = {};
  // Resolve each distinct email once, then fan back out to its posts.
  const cache = new Map<string, AuthorProfileResolution>();
  for (const [postPath, email] of Object.entries(emails)) {
    let res = cache.get(email);
    if (!res) {
      res = await resolveAuthorProfile(contentRoot, email);
      cache.set(email, res);
    }
    if (!res.ok) {
      warn(`  [byline] ${postPath} — ${res.reason}; no byline rendered`);
      continue;
    }
    map[postPath] = res.author.profile;
    if (res.author.avatarServedName && res.author.avatarSrcPath) {
      avatars[res.author.avatarServedName] = res.author.avatarSrcPath;
    }
  }
  return { map, avatars };
}
