// Origin provenance in the fs adapter: PUT-declared origin lands in a
// `.src` sidecar, LIST exposes it, and the one-way upgrade rule holds
// (`production` wins; `localhost` never downgrades). The sidecar format is
// shared with the authoring pulls (r2Sync.ts → stampOrigin), so this also
// pins the convention the offline loader reads.

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsAdapter } from "./fsAdapter.ts";

const POST = "/posts/origin-test";
const USER = "google:reader-1";
const HASH = "a".repeat(64);
const BYTES = new Uint8Array([1, 2, 3]);

async function freshStore() {
  return fsAdapter(await mkdtemp(join(tmpdir(), "fs-origin-")));
}

async function originOf(store: ReturnType<typeof fsAdapter>) {
  const entries = await store.listChanges(POST, USER);
  expect(entries.length).toBe(1);
  return entries[0]!.origin;
}

describe("fsAdapter origin provenance", () => {
  test("PUT without origin → LIST entry has none", async () => {
    const store = await freshStore();
    await store.putChange(POST, USER, HASH, BYTES);
    expect(await originOf(store)).toBeUndefined();
  });

  test("PUT with origin → LIST exposes it", async () => {
    const store = await freshStore();
    await store.putChange(POST, USER, HASH, BYTES, "production");
    expect(await originOf(store)).toBe("production");
  });

  test("already-present blob: production upgrades a missing stamp", async () => {
    const store = await freshStore();
    await store.putChange(POST, USER, HASH, BYTES);
    const result = await store.putChange(POST, USER, HASH, BYTES, "production");
    expect(result.kind).toBe("already_present");
    expect(await originOf(store)).toBe("production");
  });

  test("localhost never downgrades production (either order)", async () => {
    const store = await freshStore();
    await store.putChange(POST, USER, HASH, BYTES, "production");
    await store.putChange(POST, USER, HASH, BYTES, "localhost");
    expect(await originOf(store)).toBe("production");
  });

  test("localhost does not overwrite an existing localhost stamp but sets a missing one", async () => {
    const store = await freshStore();
    await store.putChange(POST, USER, HASH, BYTES);
    await store.putChange(POST, USER, HASH, BYTES, "localhost");
    expect(await originOf(store)).toBe("localhost");
  });
});
