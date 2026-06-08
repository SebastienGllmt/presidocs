// Per-post resolutions store + sync.
//
// Resolutions are author-only writes to a per-post namespace
// (`/resolutions?post=X&thread=T`). One mutable blob per resolved
// thread. The store keeps a local Map<threadId, ResolutionEnvelope>
// in sync with the server and persists it to localStorage so a
// reload doesn't have to re-fetch every entry.
//
// Why a dedicated store (vs. piggybacking on CommentStore):
//   - Storage path is *per post*, not per user. The author writes;
//     all logged-in readers may read.
//   - No CRDT required: a single writer per post means
//     last-write-wins is correct (the same threadId resolution from
//     two author devices differs only in timestamp/timing, and
//     either is a valid "this thread is resolved" signal).
//   - Keeping it out of CommentDoc means the author's own
//     threads/replies stay private; only the resolutions themselves
//     are public to logged-in readers.

import {
  getResolution,
  listResolutions,
  putResolution,
  type ResolutionEnvelope,
} from "./resolutionsApi.ts";
import {
  CachedResolutions,
  type CachedResolution,
} from "../shared/commentSchemas.ts";

function storageKey(postPath: string): string {
  return `blog-resolutions:${postPath}`;
}

// The cached entry shape is the `z.infer` of the shared `CachedResolution`
// schema (composing `ResolutionEnvelope`), so the type and the read-time
// validator can't drift.
type CachedShape = CachedResolution;

export class ResolutionStore {
  private readonly resolutions = new Map<string, CachedShape>();

  // Fired when the local set of resolutions changes (a hydrate
  // brought in new entries, or a local resolve() landed). The
  // comments UI hooks this to re-render.
  onChange: (() => void) | null = null;

  constructor(private readonly postPath: string) {
    this.loadFromLocalStorage();
  }

  // ---------- Reads ----------

  isResolved(threadId: string): boolean {
    return this.resolutions.has(threadId);
  }

  get(threadId: string): ResolutionEnvelope | null {
    return this.resolutions.get(threadId)?.envelope ?? null;
  }

  // All currently-known resolutions, for the author's history /
  // debugging panel. Snapshot copy — callers may iterate freely.
  all(): ResolutionEnvelope[] {
    return Array.from(this.resolutions.values(), (c) => c.envelope);
  }

  // ---------- Writes ----------

  // Resolve a thread. Author-only at the route layer; we don't
  // re-check here (the server returns 403 on non-author PUTs).
  // Writes to the server and only persists locally on success — a
  // failed PUT leaves the UI as if nothing happened, matching what
  // the user can see (no notion of "I tried but the network
  // rejected"). Re-resolving is idempotent (server overwrites).
  async resolve(envelope: ResolutionEnvelope): Promise<void> {
    await putResolution(this.postPath, envelope.threadId, envelope);
    this.resolutions.set(envelope.threadId, {
      uploadedAt: new Date().toISOString(),
      envelope,
    });
    this.persist();
    this.onChange?.();
  }

  // ---------- Sync ----------

  // Pull-only sync: LIST + diff-fetch any threadId whose server
  // upload timestamp doesn't match our cache. Mutations are pushed
  // directly by `resolve()`, so there's no "push" half.
  //
  // Reentrant — the polling layer may call this overlapping with a
  // boot-time call; the second one will just see the same LIST
  // entries the first one already fetched and short-circuit.
  async hydrate(): Promise<void> {
    let entries;
    try {
      entries = await listResolutions(this.postPath);
    } catch (err) {
      console.warn("resolutions hydrate (list) failed:", err);
      return;
    }
    const seen = new Set<string>();
    const toFetch: string[] = [];
    for (const e of entries) {
      seen.add(e.threadId);
      const cached = this.resolutions.get(e.threadId);
      if (!cached || cached.uploadedAt !== e.uploaded) {
        toFetch.push(e.threadId);
      }
    }
    // Drop entries the server no longer has (an unresolve-by-delete
    // path doesn't exist yet, but be defensive: if it ever does, the
    // local cache shouldn't keep a stale resolution).
    let changed = false;
    for (const id of this.resolutions.keys()) {
      if (!seen.has(id)) {
        this.resolutions.delete(id);
        changed = true;
      }
    }

    if (toFetch.length > 0) {
      const fetched = await Promise.all(
        toFetch.map(async (id) => {
          try {
            const envelope = await getResolution(this.postPath, id);
            return envelope ? { id, envelope } : null;
          } catch (err) {
            console.warn(`resolutions hydrate (get ${id}) failed:`, err);
            return null;
          }
        }),
      );
      // Index each fetched envelope with its server upload time so
      // the next hydrate can short-circuit unchanged entries.
      const byId = new Map(
        entries.map((e) => [e.threadId, e.uploaded] as const),
      );
      for (const item of fetched) {
        if (!item) continue;
        this.resolutions.set(item.id, {
          uploadedAt: byId.get(item.id) ?? new Date().toISOString(),
          envelope: item.envelope,
        });
        changed = true;
      }
    }

    if (changed) {
      this.persist();
      // Deliberately NOT firing onChange — hydrate is sync-driven,
      // not user-driven. The boot flow renders explicitly after init
      // completes; the poll callback re-renders after every tick.
      // Firing onChange here would cause a redundant render whenever
      // a poll brought in new entries.
    }
  }

  // ---------- Persistence ----------

  private loadFromLocalStorage(): void {
    try {
      const raw = localStorage.getItem(storageKey(this.postPath));
      if (!raw) return;
      // Validate the cache instead of blind-casting it: a malformed entry (a
      // stale shape from an older engine version, or another same-origin script)
      // drops the whole cache and re-fetches from the server, rather than
      // flowing a wrong shape into the comments UI as a typed value. The catch
      // below already maps any failure onto that same warn-and-return path.
      const result = CachedResolutions.safeParse(JSON.parse(raw));
      if (!result.success) return;
      for (const [id, cached] of Object.entries(result.data)) {
        this.resolutions.set(id, cached);
      }
    } catch (err) {
      console.warn("Failed to load resolutions from localStorage:", err);
    }
  }

  private persist(): void {
    try {
      const obj: Record<string, CachedShape> = {};
      for (const [id, cached] of this.resolutions) obj[id] = cached;
      localStorage.setItem(storageKey(this.postPath), JSON.stringify(obj));
    } catch (err) {
      console.warn("Failed to persist resolutions:", err);
    }
  }
}
