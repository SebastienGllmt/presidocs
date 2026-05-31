// Public per-post "last updated" map served at /assets/post-versions.json.
//
// The full version record (current hash + history) is gated behind login in
// `/post-version`, because the hash + per-build timestamps double as a
// version-tracking pixel. The "last updated" date is a different surface: it's
// what we already show crawlers as `dateModified` in JSON-LD, so there is
// nothing to gate. Exposing only the most recent `builtAt` (no hash, no
// per-build history) gives the byline a human-readable date without leaking
// anything new.
//
// Keyed by post path (`/posts/<slug>`) to match `/assets/authors.json`. Dev
// and prod build the file from the same on-disk source (`posts/versions.json`)
// so the byline date matches across both.
//
// Built from `posts/versions.json` directly rather than the in-memory
// PostVersionIndex so the same helper works in the offline build context
// (copy-static) without depending on the dev-server's index assembly.

import { readFile } from "node:fs/promises";

export type PublicPostVersion = {
  /** ISO-8601 timestamp of the build that first observed the current hash. */
  lastUpdated: string;
};

type HistoryEntry = { hash?: unknown; builtAt?: unknown };
type HistoryFile = Record<string, HistoryEntry[]>;

export async function buildPublicPostVersionsMap(
  versionsJsonPath: string,
): Promise<Record<string, PublicPostVersion>> {
  let history: HistoryFile;
  try {
    history = JSON.parse(await readFile(versionsJsonPath, "utf8")) as HistoryFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const out: Record<string, PublicPostVersion> = {};
  for (const [postPath, entries] of Object.entries(history)) {
    // History is most-recent-first by convention; pick the first entry whose
    // builtAt is a usable string. A malformed file degrades to "no date" for
    // that post — same posture as a missing author profile.
    const newest = Array.isArray(entries)
      ? entries.find((e) => typeof e?.builtAt === "string" && e.builtAt)
      : undefined;
    if (newest && typeof newest.builtAt === "string") {
      out[postPath] = { lastUpdated: newest.builtAt };
    }
  }
  return out;
}
