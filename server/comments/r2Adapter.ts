// CommentChangeStore over a Cloudflare R2 bucket binding. Used by
// the Worker in prod; the dev path uses `fsAdapter.ts` instead.

import type { R2Bucket } from "@cloudflare/workers-types";
import {
  changeHashFromKey,
  changeKey,
  postPrefix,
  resolutionKey,
  resolutionPrefix,
  threadIdFromResolutionKey,
  userIdFromKey,
  userPrefix,
  type ChangeListEntry,
  type CommentChangeStore,
  type PutChangeResult,
  type ResolutionListEntry,
} from "./store.ts";

export function r2Adapter(bucket: R2Bucket): CommentChangeStore {
  return {
    async getChange(post, userId, changeHash) {
      const obj = await bucket.get(changeKey(post, userId, changeHash));
      if (!obj) return null;
      const buf = await obj.arrayBuffer();
      return new Uint8Array(buf);
    },

    async putChange(post, userId, changeHash, bytes): Promise<PutChangeResult> {
      const key = changeKey(post, userId, changeHash);
      // R2 PUT is overwrite-by-default. Since the key is the content
      // hash, re-uploading the same bytes is a no-op (same content,
      // same key). Re-uploading *different* bytes at the same hash
      // would be a hash collision — Automerge's SHA-256 hashes make
      // this so improbable we can ignore it.
      const head = await bucket.head(key);
      if (head) return { kind: "already_present" };
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      return { kind: "ok" };
    },

    async listChanges(post, userId): Promise<ChangeListEntry[]> {
      // Paginated cursor in R2; at our expected change volume per
      // user (single-digit), one page is plenty.
      const result = await bucket.list({ prefix: userPrefix(post, userId) });
      const out: ChangeListEntry[] = [];
      for (const obj of result.objects) {
        const hash = changeHashFromKey(obj.key);
        if (!hash) continue;
        out.push({ hash, size: obj.size, uploaded: obj.uploaded });
      }
      return out;
    },

    async listUsers(post): Promise<string[]> {
      // Delimiter-based list gives back "common prefixes" — the
      // unique userId folders directly under the post path. Avoids
      // listing every change individually just to extract the
      // distinct userIds.
      const result = await bucket.list({
        prefix: postPrefix(post),
        delimiter: "/",
      });
      // R2's list returns delimitedPrefixes for the directory-like
      // entries; we trim the trailing slash to get just the userId.
      const users: string[] = [];
      for (const p of result.delimitedPrefixes ?? []) {
        const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
        const id = userIdFromKey(`${trimmed}/.bin`);
        if (id) users.push(id);
      }
      return users;
    },

    async getResolution(post, threadId) {
      const obj = await bucket.get(resolutionKey(post, threadId));
      if (!obj) return null;
      const buf = await obj.arrayBuffer();
      return new Uint8Array(buf);
    },

    async putResolution(post, threadId, bytes): Promise<void> {
      // Overwrite-by-default; resolutions are mutable single-writer
      // blobs (the post author writes; concurrent author devices
      // produce near-identical bytes, last-write-wins is fine).
      await bucket.put(resolutionKey(post, threadId), bytes, {
        httpMetadata: { contentType: "application/json" },
      });
    },

    async listResolutions(post): Promise<ResolutionListEntry[]> {
      const result = await bucket.list({ prefix: resolutionPrefix(post) });
      const out: ResolutionListEntry[] = [];
      for (const obj of result.objects) {
        const threadId = threadIdFromResolutionKey(obj.key);
        if (!threadId) continue;
        out.push({
          threadId,
          size: obj.size,
          uploaded: obj.uploaded,
        });
      }
      return out;
    },
  };
}
