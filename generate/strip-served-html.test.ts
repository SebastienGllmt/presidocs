import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { readSitePublisher, rewriteNarrationManifestSrc } from "./strip-served-html.ts";

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

// --- rewriteNarrationManifestSrc: content-address the manifest URL ---

// Stand up a temp generated/<slug>/ with the given manifest filename, then run
// the rewrite against an authored article that points at the bare manifest.json.
async function withGeneratedManifest(
  slug: string,
  manifestFile: string | null,
  html: string,
  fn: (out: string) => Promise<void>,
): Promise<void> {
  const generatedDir = await mkdtemp(join(tmpdir(), "presidocs-gen-"));
  try {
    if (manifestFile) {
      await mkdir(join(generatedDir, slug), { recursive: true });
      await writeFile(join(generatedDir, slug, manifestFile), "{}", "utf8");
    }
    const out = await rewriteNarrationManifestSrc(html, `/posts/${slug}`, generatedDir);
    await fn(out);
  } finally {
    await rm(generatedDir, { recursive: true, force: true });
  }
}

const HASH = "0123456789abcdef";
const AUTHORED = `<article data-narration-src="/generated/offer-files/manifest.json"></article>`;

test("rewriteNarrationManifestSrc: rewrites the bare URL to the hashed manifest", async () => {
  await withGeneratedManifest("offer-files", `manifest.${HASH}.json`, AUTHORED, async (out) => {
    expect(out).toContain(`data-narration-src="/generated/offer-files/manifest.${HASH}.json"`);
    expect(out).not.toContain(`manifest.json"`);
  });
});

test("rewriteNarrationManifestSrc: is idempotent (already-hashed src is untouched)", async () => {
  const hashed = `<article data-narration-src="/generated/offer-files/manifest.${HASH}.json"></article>`;
  await withGeneratedManifest("offer-files", `manifest.${HASH}.json`, hashed, async (out) => {
    expect(out).toBe(hashed);
  });
});

test("rewriteNarrationManifestSrc: leaves a legacy bare manifest.json untouched", async () => {
  await withGeneratedManifest("offer-files", "manifest.json", AUTHORED, async (out) => {
    expect(out).toBe(AUTHORED);
  });
});

test("rewriteNarrationManifestSrc: no-op when the post has no manifest", async () => {
  await withGeneratedManifest("offer-files", null, AUTHORED, async (out) => {
    expect(out).toBe(AUTHORED);
  });
});

test("rewriteNarrationManifestSrc: ignores non-post pages", async () => {
  const generatedDir = await mkdtemp(join(tmpdir(), "presidocs-gen-"));
  try {
    const out = await rewriteNarrationManifestSrc(AUTHORED, "/index", generatedDir);
    expect(out).toBe(AUTHORED);
  } finally {
    await rm(generatedDir, { recursive: true, force: true });
  }
});
