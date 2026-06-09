// Unit tests for the r2Sync CLI surface: flag parsing and the localhost
// fence on `--local`. The sync flows themselves are exercised against a
// running dev server / prod R2 and aren't unit-testable here.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalDevUrl, parseArgs, stampOrigin } from "./r2Sync.ts";

describe("parseArgs", () => {
  test("remote pull (existing surface, unchanged)", () => {
    expect(parseArgs(["pull", "my-post"])).toEqual({
      mode: "pull",
      slug: "my-post",
      local: false,
      url: null,
    });
  });

  test("local push with flag after slug", () => {
    expect(parseArgs(["push", "my-post", "--local"])).toEqual({
      mode: "push",
      slug: "my-post",
      local: true,
      url: null,
    });
  });

  test("--url with --local", () => {
    expect(parseArgs(["pull", "my-post", "--local", "--url", "http://localhost:4000"])).toEqual({
      mode: "pull",
      slug: "my-post",
      local: true,
      url: "http://localhost:4000",
    });
  });

  test("flags may precede the positionals (bun run passthrough order)", () => {
    expect(parseArgs(["--local", "pull", "my-post"])).toMatchObject({
      mode: "pull",
      slug: "my-post",
      local: true,
    });
  });
});

describe("assertLocalDevUrl", () => {
  test("accepts localhost and loopback literals", () => {
    expect(assertLocalDevUrl("http://localhost:3000").origin).toBe(
      "http://localhost:3000",
    );
    expect(assertLocalDevUrl("http://127.0.0.1:8080").origin).toBe(
      "http://127.0.0.1:8080",
    );
    // WHATWG URL reports an IPv6 hostname with its brackets.
    expect(assertLocalDevUrl("http://[::1]:3000").hostname).toBe("[::1]");
  });

  test("refuses any non-localhost origin (the minted-token fence)", () => {
    expect(() => assertLocalDevUrl("https://example.com")).toThrow(
      /refusing non-localhost/,
    );
    // A lookalike that *resolves* to loopback still isn't a loopback literal.
    expect(() => assertLocalDevUrl("http://localhost.evil.com:3000")).toThrow(
      /refusing non-localhost/,
    );
  });

  test("refuses garbage", () => {
    expect(() => assertLocalDevUrl("not a url")).toThrow(/invalid dev-server URL/);
  });
});

describe("stampOrigin (one-way provenance rule)", () => {
  async function blob(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "stamp-test-"));
    const dest = join(dir, "abc.bin");
    await writeFile(dest, "bytes");
    return dest;
  }
  const stampOf = (dest: string) => readFile(`${dest}.src`, "utf8");

  test("localhost stamps an unstamped blob", async () => {
    const dest = await blob();
    await stampOrigin(dest, "localhost");
    expect(await stampOf(dest)).toBe("localhost");
  });

  test("production upgrades a localhost stamp", async () => {
    const dest = await blob();
    await stampOrigin(dest, "localhost");
    await stampOrigin(dest, "production");
    expect(await stampOf(dest)).toBe("production");
  });

  test("localhost never downgrades a production stamp (order-independence)", async () => {
    const dest = await blob();
    await stampOrigin(dest, "production");
    await stampOrigin(dest, "localhost");
    expect(await stampOf(dest)).toBe("production");
  });
});
