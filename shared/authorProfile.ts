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
//   authors/<author-email>.webp   avatar served to browsers (preferred); a
//                                  .png/.jpg/.jpeg is also discovered, and is
//                                  what the share-card renderer uses (it can't
//                                  decode WebP). An explicit "avatar" field
//                                  overrides discovery.
//   authors/<author-email>.wav    MOSS voice-clone clip (build-only input,
//                                  never served — see shared/voiceResolution.ts)
//
// THE LOAD-BEARING CONSTRAINT: the served byline must NOT re-leak the email.
// `<meta name="author-email">` is deliberately stripped from served HTML
// (generate/stripServedHtml.ts) so the address stays out of crawlers' hands. So
// the email is only ever a *disk/join* key here — every value that reaches the
// client (avatar URL, anchor text) is derived from the public `handle`/`name`,
// never the email. The served avatar lives at `/assets/authors/<handle>.<ext>`,
// not `/.../<email>.<ext>`.

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { safeEmailComponent } from "./voiceResolution.ts";
import { collectHtmlFiles } from "./walkHtml.ts";
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
  // `fatal` distinguishes an author MISCONFIGURATION the author must fix (e.g. a
  // non-romanizable handle) — which `buildAuthorMap` turns into a build-failing
  // throw — from a soft, degrade-and-skip gap (no profile json, no avatar).
  | { ok: false; reason: string; fatal?: boolean };

// WebP first: it's the optimized format we serve to browsers (a 192px PNG avatar
// is ~49 KB; the same at 144px WebP is ~2.5 KB — Lighthouse's image-delivery
// insight). PNG/JPEG follow as the raster source the share-card renderer needs
// (satori/resvg can't decode WebP), so an author who wants their photo on social
// cards keeps a `.png`/`.jpg` alongside the `.webp` — see share-card.ts's
// `avatarDataUri` sibling fallback.
const AVATAR_EXTS = ["webp", "png", "jpg", "jpeg"] as const;

// Derive a public, URL- and filename-safe ASCII slug from `raw` — the handle
// that lands in `/assets/authors/<handle>.<ext>` and the byline anchor (and is
// what keeps the email out of the served URL). Lowercased so the path is
// case-stable; only `[a-z0-9._-]` survive; `@` and other X-handle punctuation
// collapse to `-`.
//
// Latin accents fold deterministically via NFKD (`José`→`jose`, `café`→`cafe`)
// — the same fold the heading slugger (`client/headerLinks.ts`) uses, and an
// unambiguous one. But returns **null** when `raw` carries a letter NFKD can't
// fold to ASCII (Cyrillic, Greek, Arabic, Hebrew, CJK, Korean, or a
// non-decomposable Latin letter like `Ł`): those have no single correct
// romanization — a kanji name has several readings — so guessing one would
// silently mislabel the author and risk a `/assets/authors/...` collision. We
// refuse to guess; the caller turns a null into a build-failing error that
// tells the author to set an explicit ASCII `handle`.
function asciiHandle(raw: string): string | null {
  const folded = raw.trim().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // A letter that survived the accent-fold but isn't ASCII a–z is not
  // deterministically romanizable.
  if (/\p{L}/u.test(folded.replace(/[A-Za-z]/g, ""))) return null;
  const slug = folded
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || null;
}

// Derive the public handle, in priority order: explicit `handle`, then the X
// link's last path segment, then a slug of the display name. Returns null when
// no source yields a safe ASCII handle. An explicit `handle` is authoritative —
// if the author set one, it must be the (ASCII) slug; we do NOT silently fall
// back to the name when it isn't usable, so a bad explicit handle surfaces
// rather than hiding.
function resolveHandle(
  explicit: string | undefined,
  links: Record<string, string>,
  name: string,
): string | null {
  if (explicit && explicit.trim()) return asciiHandle(explicit);
  const x = links.x;
  const seg = x ? x.replace(/\/+$/, "").split("/").pop() : undefined;
  if (seg) {
    const h = asciiHandle(seg);
    if (h) return h;
  }
  return asciiHandle(name);
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
  if (handle === null) {
    // No source produced a safe ASCII handle (a non-Latin name/handle with no
    // explicit ASCII one). FATAL — fail the build rather than silently collide
    // every such author on `/assets/authors/author.<ext>`.
    return {
      ok: false,
      fatal: true,
      reason:
        `author "${name}" (authors/${safe}.json) has no ASCII-derivable handle ` +
        `— a non-Latin name/handle can't be romanized unambiguously, so set an ` +
        "explicit ASCII `handle` (a chosen romanization, e.g. \"tanaka\") in the profile",
    };
  }

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

export async function buildAuthorMap(
  postsDir: string,
  contentRoot: string,
  warn: (msg: string) => void = () => {},
): Promise<AuthorMap> {
  // Recursive `**/*.html` under posts/, ENOENT → empty (a content repo may have
  // no posts/ yet) — the same Bun.Glob helper the other engine `.html`
  // collectors use. Each post's author email comes from its
  // `<meta name="author-email">` (same convention as generate/post-meta.ts).
  const emails: Record<string, string> = {};
  for (const full of collectHtmlFiles(postsDir, { onMissing: "empty" })) {
    const email = parseAuthorEmailFromHtml(await Bun.file(full).text());
    if (!email) continue;
    const noExt = relative(postsDir, full).split(sep).join("/").replace(/\.html$/, "");
    emails[`/posts/${noExt}`] = email;
  }

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
      if (res.fatal) {
        // Author misconfiguration — fail the build (this runs in CI) instead of
        // degrading, so a non-romanizable handle can't silently ship.
        throw new Error(`[author] ${postPath} (${email}): ${res.reason}`);
      }
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
