// Per-author MOSS reference-clip resolution.
//
// A blog can have multiple authors (`<meta name="author-email">` is per-post),
// and each author's voice is a different clone reference clip — so any
// regeneration that touches a post MUST be told which clip to use for THAT
// post, not the blog-global one. Letting a single env var drive every spawn
// (the model we had before) silently re-rolled posts in the wrong voice on a
// multi-author blog (and overwrote `full.<hash>.<ext>` with that wrong-voice
// audio — voice IS part of the TTS cache key, but the *current* delivered
// track is whatever the last spawn wrote).
//
// Convention: `<contentRoot>/authors/<author-email>.wav` — the per-author
// folder that also holds the author's profile (`<email>.json`) and avatar
// (`<email>.<ext>`); see shared/authorProfile.ts. Discoverable by file listing,
// no config artifact to keep in sync, one author onboarding is a few file
// commits keyed by the same email. Mirrors how `postMeta` discovers authors by
// scanning `posts/*.html`. Returns a structured failure when nothing resolves
// — callers surface the gap to the user (which post, which file is missing)
// rather than silently picking the wrong voice. (The `.wav` is a build-only
// input — never served — even though it shares the folder with the served
// avatar; only the build/dev tools read it.)
//
// There is intentionally NO env-var fallback. A single global default would
// re-introduce the very bug the per-post lookup exists to fix: the moment a
// second author shows up, the default becomes "the wrong voice" for half the
// posts, silently. Single-author blogs aren't disadvantaged — they just put
// their one voice at `authors/<their-email>.wav`, which is one file, not an
// env var. See also the "one voice per post" non-requirement in
// methodology.md.

import { existsSync } from "node:fs";
import { join } from "node:path";

export type VoiceResolution =
  | { ok: true; clipPath: string }
  | { ok: false; reason: string };

// Email-shaped strings can in principle contain awkward characters; refuse the
// few that would let one escape `authors/` (path separators, NUL) or shadow a
// hidden file (leading dot). Anything else (including `@`, `.`, `+`, …) goes
// through verbatim — `authors/alice@example.com.wav` is the intended shape.
// Exported because `shared/authorProfile.ts` keys per-author profile files by
// the same `<author-email>` convention and must reject the same hostile inputs.
export function safeEmailComponent(email: string): string | null {
  const s = email.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) return null;
  if (s.startsWith(".")) return null;
  return s;
}

export function resolveAuthorVoice(
  contentRoot: string,
  authorEmail: string | null | undefined,
): VoiceResolution {
  const safe = authorEmail ? safeEmailComponent(authorEmail) : null;
  if (!safe) {
    return {
      ok: false,
      reason: authorEmail
        ? `author email "${authorEmail}" is not usable as a filename`
        : `no author-email available`,
    };
  }
  const path = join(contentRoot, "authors", `${safe}.wav`);
  if (!existsSync(path)) {
    return { ok: false, reason: `no authors/${safe}.wav` };
  }
  return { ok: true, clipPath: path };
}
