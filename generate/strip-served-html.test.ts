import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSitePublisher } from "./strip-served-html.ts";

async function withTempPosts(
  files: Record<string, string>,
  fn: (postsDir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "presidocs-strip-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body, "utf8");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readSitePublisher: preserves an apostrophe inside the attribute value", async () => {
  // Regression: the prior regex `[^"']+` truncated at the FIRST apostrophe
  // of either kind, so "Author's blog" became "Author".
  await withTempPosts(
    {
      "a.html": `<article data-narration-artist="Sebastiengllmt's blog"></article>`,
    },
    async (postsDir) => {
      expect(await readSitePublisher(postsDir)).toBe("Sebastiengllmt's blog");
    },
  );
});

test("readSitePublisher: also reads single-quoted attributes", async () => {
  await withTempPosts(
    {
      "a.html": `<article data-narration-artist='My Blog "Inc"'></article>`,
    },
    async (postsDir) => {
      expect(await readSitePublisher(postsDir)).toBe('My Blog "Inc"');
    },
  );
});

test("readSitePublisher: returns empty string when no post declares the attribute", async () => {
  await withTempPosts(
    { "a.html": `<article></article>`, "b.html": `<p>nothing</p>` },
    async (postsDir) => {
      expect(await readSitePublisher(postsDir)).toBe("");
    },
  );
});

test("readSitePublisher: returns the first declared value (sampling, not merging)", async () => {
  await withTempPosts(
    {
      // alphabetical sort puts a.html first.
      "a.html": `<article data-narration-artist="first"></article>`,
      "b.html": `<article data-narration-artist="second"></article>`,
    },
    async (postsDir) => {
      expect(await readSitePublisher(postsDir)).toBe("first");
    },
  );
});
