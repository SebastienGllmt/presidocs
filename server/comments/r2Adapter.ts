// CommentChangeStore over a Cloudflare R2 bucket binding. Used by
// the Worker in prod; the dev path uses `fsAdapter.ts` instead.

import type {
  R2Bucket,
  R2ListOptions,
  R2Object,
} from "@cloudflare/workers-types";
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
  type ChangeOrigin,
  type CommentChangeStore,
  type PutChangeResult,
  type ResolutionListEntry,
} from "./store.ts";

// Origin provenance lives in R2 customMetadata. Validate on read — the
// metadata is writer-declared, so an unexpected value degrades to
// "no provenance" rather than flowing into the wire shape.
function originFromMetadata(
  meta: Record<string, string> | undefined,
): ChangeOrigin | undefined {
  const v = meta?.origin;
  return v === "production" || v === "localhost" ? v : undefined;
}

// Exhaustive list: follow R2's pagination cursor until `truncated` clears.
// A single `bucket.list()` call returns ONE page — and workerd's local R2
// (Miniflare, behind both the dev server's getPlatformProxy binding and
// `wrangler dev`) caps a page at 100 objects even when `limit: 1000` is
// passed (verified empirically; real R2 pages at up to 1000). Reading just
// the first page silently drops everything past it — which surfaced as a
// comment-sync pull mirroring only 100 of a user's 130 change-objects.
// Every listing in this adapter must go through this helper.
async function listAll(
  bucket: R2Bucket,
  options: R2ListOptions,
): Promise<{ objects: R2Object[]; delimitedPrefixes: string[] }> {
  const objects: R2Object[] = [];
  const delimitedPrefixes: string[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const result = await bucket.list({ ...options, cursor });
    objects.push(...result.objects);
    delimitedPrefixes.push(...(result.delimitedPrefixes ?? []));
    if (!result.truncated) break;
    cursor = result.cursor;
  }
  return { objects, delimitedPrefixes };
}

export function r2Adapter(bucket: R2Bucket): CommentChangeStore {
  return {
    async getChange(post, userId, changeHash) {
      const obj = await bucket.get(changeKey(post, userId, changeHash));
      if (!obj) return null;
      const buf = await obj.arrayBuffer();
      return new Uint8Array(buf);
    },

    async putChange(post, userId, changeHash, bytes, origin): Promise<PutChangeResult> {
      const key = changeKey(post, userId, changeHash);
      const options = {
        httpMetadata: { contentType: "application/octet-stream" as const },
        ...(origin !== undefined && { customMetadata: { origin } }),
      };
      // R2 PUT is overwrite-by-default. Since the key is the content
      // hash, re-uploading the same bytes is a no-op (same content,
      // same key). Re-uploading *different* bytes at the same hash
      // would be a hash collision — Automerge's SHA-256 hashes make
      // this so improbable we can ignore it.
      const head = await bucket.head(key);
      if (head) {
        // Provenance upgrade on an already-present blob: a declared
        // `production` origin overwrites missing/weaker metadata
        // (one-way — see ChangeOrigin in store.ts). Same bytes, so the
        // re-put only refreshes metadata.
        if (
          origin === "production" &&
          originFromMetadata(head.customMetadata) !== "production"
        ) {
          await bucket.put(key, bytes, options);
        }
        return { kind: "already_present" };
      }
      await bucket.put(key, bytes, options);
      return { kind: "ok" };
    },

    async listChanges(post, userId): Promise<ChangeListEntry[]> {
      // `include` is required at runtime for customMetadata to ride on
      // list results (origin provenance lives there) — verified live
      // against Miniflare, which returns no metadata without it. The
      // installed workers-types dropped the field from R2ListOptions,
      // hence the cast.
      const result = await listAll(bucket, {
        prefix: userPrefix(post, userId),
        include: ["customMetadata"],
      } as R2ListOptions);
      const out: ChangeListEntry[] = [];
      for (const obj of result.objects) {
        const hash = changeHashFromKey(obj.key);
        if (!hash) continue;
        const origin = originFromMetadata(obj.customMetadata);
        out.push({
          hash,
          size: obj.size,
          uploaded: obj.uploaded,
          ...(origin !== undefined && { origin }),
        });
      }
      return out;
    },

    async listUsers(post): Promise<string[]> {
      // Delimiter-based list gives back "common prefixes" — the
      // unique userId folders directly under the post path. Avoids
      // listing every change individually just to extract the
      // distinct userIds.
      const result = await listAll(bucket, {
        prefix: postPrefix(post),
        delimiter: "/",
      });
      // R2's list returns delimitedPrefixes for the directory-like
      // entries; we trim the trailing slash to get just the userId.
      const users: string[] = [];
      for (const p of result.delimitedPrefixes) {
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
      const result = await listAll(bucket, { prefix: resolutionPrefix(post) });
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
