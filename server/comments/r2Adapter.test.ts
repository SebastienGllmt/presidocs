// Listing pagination in the R2 adapter: a single `bucket.list()` call
// returns one page — workerd's local R2 (behind the dev server's
// getPlatformProxy binding and `wrangler dev`) caps a page at 100 objects
// even when `limit: 1000` is passed, and real R2 pages at 1000. Reading
// only the first page silently drops everything past it; this bit for
// real when a comment-sync pull mirrored just 100 of a user's 130
// change-objects. These tests pin that every listing in the adapter
// follows the `truncated`/`cursor` contract to exhaustion.

import { describe, expect, test } from "bun:test";
import type { R2Bucket, R2ListOptions } from "@cloudflare/workers-types";
import { r2Adapter } from "./r2Adapter.ts";
import { changeKey, resolutionKey } from "./store.ts";

const POST = "/posts/pagination-test";
const PAGE = 100; // workerd's observed local page cap

type StoredObject = {
  key: string;
  size: number;
  uploaded: Date;
  customMetadata?: Record<string, string>;
};

// Minimal paginating R2 fake: key-ordered listing, `PAGE` rows per page
// regardless of any requested `limit` (exactly what workerd does locally),
// delimited prefixes counting toward the page like objects do, and an
// opaque cursor. Only the surface the adapter touches is implemented.
function fakeBucket(stored: StoredObject[]): R2Bucket {
  const sorted = [...stored].sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    async list(options?: R2ListOptions & { cursor?: string }) {
      const prefix = options?.prefix ?? "";
      const delimiter = options?.delimiter;
      const matching = sorted.filter((o) => o.key.startsWith(prefix));

      // Merge objects and delimited "folders" into one key-ordered row
      // sequence, then paginate over the rows — mirroring R2, where
      // delimitedPrefixes share the page budget with objects.
      type Row =
        | { kind: "object"; obj: StoredObject }
        | { kind: "prefix"; prefix: string };
      const rows: Row[] = [];
      const seenPrefixes = new Set<string>();
      for (const obj of matching) {
        const rest = obj.key.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        if (cut === -1) {
          rows.push({ kind: "object", obj });
        } else {
          const p = prefix + rest.slice(0, cut + delimiter!.length);
          if (!seenPrefixes.has(p)) {
            seenPrefixes.add(p);
            rows.push({ kind: "prefix", prefix: p });
          }
        }
      }

      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = rows.slice(start, start + PAGE);
      const truncated = start + PAGE < rows.length;
      return {
        objects: page
          .filter((r) => r.kind === "object")
          .map((r) => (r as Extract<Row, { kind: "object" }>).obj),
        delimitedPrefixes: page
          .filter((r) => r.kind === "prefix")
          .map((r) => (r as Extract<Row, { kind: "prefix" }>).prefix),
        truncated,
        ...(truncated && { cursor: String(start + PAGE) }),
      };
    },
  } as unknown as R2Bucket;
}

function hash(i: number): string {
  return String(i).padStart(4, "0").repeat(16); // 64 chars, key-sortable
}

describe("r2Adapter listing pagination", () => {
  test("listChanges returns every change past the 100-per-page cap, metadata intact", async () => {
    const user = "google:10625197866142730445";
    const stored: StoredObject[] = [];
    for (let i = 0; i < 130; i++) {
      stored.push({
        key: changeKey(POST, user, hash(i)),
        size: 7,
        uploaded: new Date(0),
        customMetadata: { origin: "localhost" },
      });
    }
    const entries = await r2Adapter(fakeBucket(stored)).listChanges(POST, user);
    expect(entries.length).toBe(130);
    expect(new Set(entries.map((e) => e.hash)).size).toBe(130);
    // Origin provenance must survive on every page, not just the first.
    expect(entries.every((e) => e.origin === "localhost")).toBe(true);
  });

  test("listUsers returns every user folder past the page cap", async () => {
    const stored: StoredObject[] = [];
    for (let i = 0; i < 250; i++) {
      stored.push({
        key: changeKey(POST, `google:user-${String(i).padStart(3, "0")}`, hash(0)),
        size: 1,
        uploaded: new Date(0),
      });
    }
    const users = await r2Adapter(fakeBucket(stored)).listUsers(POST);
    expect(users.length).toBe(250);
    expect(new Set(users).size).toBe(250);
  });

  test("listResolutions returns every resolution past the page cap", async () => {
    const stored: StoredObject[] = [];
    for (let i = 0; i < 130; i++) {
      stored.push({
        key: resolutionKey(POST, `thread-${String(i).padStart(3, "0")}`),
        size: 2,
        uploaded: new Date(0),
      });
    }
    const resolutions = await r2Adapter(fakeBucket(stored)).listResolutions(POST);
    expect(resolutions.length).toBe(130);
    expect(new Set(resolutions.map((r) => r.threadId)).size).toBe(130);
  });
});
