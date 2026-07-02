// CommentChangeStore backed by the local filesystem. Used in dev so
// the same route handlers exercised in prod (with R2) run unchanged.
// Files land under `<rootDir>/<key>` with the same key shape as R2.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import {
  changeHashFromKey,
  changeKey,
  postPrefix,
  resolutionKey,
  resolutionPrefix,
  threadIdFromResolutionKey,
  userPrefix,
  type ChangeListEntry,
  type ChangeOrigin,
  type CommentChangeStore,
  type ResolutionListEntry,
} from "../server/comments/store.ts";

function safeResolve(rootDir: string, key: string): string {
  const safe = normalize(key);
  if (safe.startsWith("..") || safe.includes("\0")) {
    throw new Error(`unsafe key: ${key}`);
  }
  return join(rootDir, safe);
}

// Origin provenance lives in a `<blob>.src` sidecar — the same format the
// authoring pulls write (authoring/r2Sync.ts → stampOrigin), so the
// offline tools and this adapter read one convention. Listings filter on
// `.bin`/`.json`, so sidecars never surface as entries themselves.
async function readOriginSidecar(path: string): Promise<ChangeOrigin | undefined> {
  try {
    const text = (await readFile(`${path}.src`, "utf8")).trim();
    return text === "production" || text === "localhost" ? text : undefined;
  } catch {
    return undefined;
  }
}

// One-way toward `production` (see ChangeOrigin in store.ts): a declared
// `localhost` never overwrites an existing stamp.
async function writeOriginSidecar(path: string, origin: ChangeOrigin): Promise<void> {
  if (origin === "localhost" && (await readOriginSidecar(path)) !== undefined) {
    return;
  }
  await writeFile(`${path}.src`, origin);
}

export function fsAdapter(rootDir: string): CommentChangeStore {
  return {
    async getChange(post, userId, changeHash) {
      const path = safeResolve(rootDir, changeKey(post, userId, changeHash));
      try {
        const buf = await readFile(path);
        return new Uint8Array(buf);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async putChange(post, userId, changeHash, bytes, origin): Promise<void> {
      const path = safeResolve(rootDir, changeKey(post, userId, changeHash));
      try {
        await stat(path);
        // Already present — content-addressed key + idempotent. A declared
        // origin still upgrades the provenance sidecar (one-way).
        if (origin) await writeOriginSidecar(path, origin);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      if (origin) await writeOriginSidecar(path, origin);
    },

    async listChanges(post, userId): Promise<ChangeListEntry[]> {
      const dir = safeResolve(rootDir, userPrefix(post, userId));
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: ChangeListEntry[] = [];
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith(".bin")) continue;
        const hash = ent.name.slice(0, -".bin".length);
        const path = join(dir, ent.name);
        const s = await stat(path);
        const origin = await readOriginSidecar(path);
        out.push({
          hash,
          size: s.size,
          uploaded: s.mtime,
          ...(origin !== undefined && { origin }),
        });
      }
      return out;
    },

    async listUsers(post): Promise<string[]> {
      const dir = safeResolve(rootDir, postPrefix(post));
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    },

    async getResolution(post, threadId) {
      const path = safeResolve(rootDir, resolutionKey(post, threadId));
      try {
        const buf = await readFile(path);
        return new Uint8Array(buf);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async putResolution(post, threadId, bytes): Promise<void> {
      const path = safeResolve(rootDir, resolutionKey(post, threadId));
      await mkdir(dirname(path), { recursive: true });
      // Overwrite: last-write-wins. Resolutions are single-writer per
      // post (the author); two author devices racing produce
      // near-identical bytes anyway.
      await writeFile(path, bytes);
    },

    async listResolutions(post): Promise<ResolutionListEntry[]> {
      const dir = safeResolve(rootDir, resolutionPrefix(post));
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: ResolutionListEntry[] = [];
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
        const threadId = ent.name.slice(0, -".json".length);
        const s = await stat(join(dir, ent.name));
        out.push({ threadId, size: s.size, uploaded: s.mtime });
      }
      return out;
    },
  };
}
