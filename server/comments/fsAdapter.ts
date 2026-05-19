// CommentChangeStore backed by the local filesystem. Used in dev so
// the same route handlers exercised in prod (with R2) run unchanged.
// Files land under `<rootDir>/<key>` with the same key shape as R2.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import {
  changeHashFromKey,
  changeKey,
  postPrefix,
  userPrefix,
  type ChangeListEntry,
  type CommentChangeStore,
  type PutChangeResult,
} from "./store.ts";

function safeResolve(rootDir: string, key: string): string {
  const safe = normalize(key);
  if (safe.startsWith("..") || safe.includes("\0")) {
    throw new Error(`unsafe key: ${key}`);
  }
  return join(rootDir, safe);
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

    async putChange(post, userId, changeHash, bytes): Promise<PutChangeResult> {
      const path = safeResolve(rootDir, changeKey(post, userId, changeHash));
      try {
        await stat(path);
        // Already present — content-addressed key + idempotent.
        return { kind: "already_present" };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return { kind: "ok" };
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
        const s = await stat(join(dir, ent.name));
        out.push({ hash, size: s.size, uploaded: s.mtime });
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
  };
}
