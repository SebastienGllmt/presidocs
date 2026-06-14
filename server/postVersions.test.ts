import { describe, expect, test } from "bun:test";
import {
  normalizePostPath,
  createPostVersionIndex,
  sha256Hex,
  type PostVersionRecord,
} from "./postVersions.ts";

describe("normalizePostPath", () => {
  test("strips a trailing .html (prod static-asset URL form)", () => {
    expect(normalizePostPath("/posts/hash-functions.html")).toBe("/posts/hash-functions");
  });

  test("leaves the extensionless dev URL form unchanged", () => {
    expect(normalizePostPath("/posts/hash-functions")).toBe("/posts/hash-functions");
  });

  test("dev and prod URL forms normalize to the same key", () => {
    expect(normalizePostPath("/posts/x.html")).toBe(normalizePostPath("/posts/x"));
  });

  test("strips a trailing /index.html before the .html rule", () => {
    expect(normalizePostPath("/posts/hash-functions/index.html")).toBe("/posts/hash-functions");
  });

  test("only strips a single trailing .html, not an embedded one", () => {
    expect(normalizePostPath("/posts/a.html.html")).toBe("/posts/a.html");
  });

  test("leaves a non-.html path untouched", () => {
    expect(normalizePostPath("/posts/already-clean")).toBe("/posts/already-clean");
  });
});

describe("createPostVersionIndex", () => {
  const rec: PostVersionRecord = {
    currentHash: "abc",
    history: [{ hash: "abc", builtAt: "2026-06-14T00:00:00.000Z" }],
  };

  test("looks up a record by its extensionless key", () => {
    const idx = createPostVersionIndex({ "/posts/x": rec });
    expect(idx.get("/posts/x")).toEqual(rec);
  });

  test("resolves the .html URL form to the same record (via normalization)", () => {
    const idx = createPostVersionIndex({ "/posts/x": rec });
    expect(idx.get("/posts/x.html")).toEqual(rec);
  });

  test("returns null for an unknown post rather than undefined", () => {
    const idx = createPostVersionIndex({ "/posts/x": rec });
    expect(idx.get("/posts/missing")).toBeNull();
  });
});

describe("sha256Hex", () => {
  const enc = new TextEncoder();

  test("matches the known SHA-256 vector for the empty input", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("matches the known SHA-256 vector for \"abc\"", async () => {
    expect(await sha256Hex(enc.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("returns 64 lowercase hex chars", async () => {
    const hex = await sha256Hex(enc.encode("hello"));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("accepts a raw ArrayBuffer", async () => {
    const buf = enc.encode("abc").buffer;
    expect(await sha256Hex(buf as ArrayBuffer)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("honours a view's byteOffset/byteLength (hashes the subarray, not the whole backing buffer)", async () => {
    // "XXabcXX" — take the inner "abc" as a subarray with a non-zero byteOffset.
    const full = enc.encode("XXabcXX");
    const view = full.subarray(2, 5);
    expect(await sha256Hex(view)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
