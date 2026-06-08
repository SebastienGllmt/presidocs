// Local-only persistence for unsubmitted comment drafts.
//
// Drafts are deliberately NOT part of the CRDT: an in-progress thought
// isn't something a user wants synced to their other devices or visible
// in any aggregating viewer until they hit "Comment". But losing them on
// every page reload (the v1 behavior) was a frequent papercut — close
// the wrong tab and the half-typed comment is gone.
//
// localStorage is the right primitive here: per-origin, synchronous,
// invisible to other devices, and exactly the same scoping as the
// CRDT blob already uses. The key embeds both the post path and the
// userId so a multi-account browser (or a logout+login) doesn't surface
// the wrong drafts.
//
// Stored payload is plain JSON — drafts have no merge requirements and
// no need for the binary Automerge format.

import type { Thread } from "./commentsStore.ts";

export type DraftEntry = {
  thread: Thread;
  body: string;
};

function storageKey(postPath: string, userId: string): string {
  return `blog-drafts:${postPath}:user:${userId}`;
}

export class DraftsStorage {
  constructor(
    private readonly postPath: string,
    private readonly userId: string,
  ) {}

  load(): DraftEntry[] {
    try {
      const raw = localStorage.getItem(storageKey(this.postPath, this.userId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Deliberately a partial structural guard, NOT a full zod schema. A
      // faithful `Thread` schema means mirroring the whole W3C Web Annotation
      // target model (a `TextTarget | GraphicTarget` union with nested
      // selector tuples) in zod and keeping it in sync with the canonical TS
      // types in commentsStore.ts — a sizeable parallel schema that would
      // *re-introduce* the drift zod is meant to kill. And the blast radius is
      // tiny: a draft is local-only, never reaches the server or the CRDT, so a
      // corrupt one only ever harms the user who corrupted their own
      // localStorage, and it already degrades into this `[]`/skip path. (The
      // server-synced resolutions cache — a shared-surface blast radius — IS
      // fully validated; see `client/resolutionsStore.ts`.) Revisit only if the
      // `Thread`/`Target` types are migrated to be zod-inferred, so a draft
      // schema is reused rather than a throwaway parallel one.
      return parsed.filter((e): e is DraftEntry =>
        e && typeof e === "object"
        && typeof e.body === "string"
        && e.thread && typeof e.thread.id === "string"
      );
    } catch (err) {
      console.warn("drafts: load failed:", err);
      return [];
    }
  }

  save(entries: DraftEntry[]): void {
    try {
      const key = storageKey(this.postPath, this.userId);
      if (entries.length === 0) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(key, JSON.stringify(entries));
    } catch (err) {
      // Quota-exceeded is the realistic failure here; silently dropping
      // is fine because the in-memory copy still reflects the draft.
      console.warn("drafts: save failed:", err);
    }
  }
}
