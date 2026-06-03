// Unit test for the batch driver's post-partitioning — the rule that decides
// which posts a no-argument `bun run generate:prod` generates over. The spawn
// loop in `runBatch` is exercised end-to-end by running the script with `--mock`
// and no path; here we pin the "excluding posts that have no narration" contract
// in isolation, including the recursive walk into subdirectories.

import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partitionPosts } from "./generate-all.ts";

const narrated = (id: string) =>
  `<!doctype html><html><body><article>
<script type="text/narration" data-chapter-id="${id}"><mark name="m"/>Hello there.</script>
</article></body></html>`;

const disabled = `<!doctype html><html><body><article data-narration="none">
<script type="text/narration" data-chapter-id="x"><mark name="m"/>Ignored.</script>
</article></body></html>`;

const noNarration = `<!doctype html><html><body><article><p>Just prose, no spoken script.</p></article></body></html>`;

test("partitionPosts: keeps narrated posts, skips disabled and script-less ones (recursively)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presidocs-batch-"));
  try {
    await writeFile(join(dir, "a.html"), narrated("intro"));
    await writeFile(join(dir, "b.html"), disabled);
    await writeFile(join(dir, "c.html"), noNarration);
    // Non-HTML and nested posts: the .pls is ignored; the nested post is found.
    await writeFile(join(dir, "common-terms.pls"), "<lexicon/>");
    await mkdir(join(dir, "series"), { recursive: true });
    await writeFile(join(dir, "series", "d.html"), narrated("part1"));

    const { narrated: keep, skipped } = await partitionPosts(dir);

    expect(keep.sort()).toEqual([join(dir, "a.html"), join(dir, "series", "d.html")].sort());
    const skippedPaths = skipped.map((s) => s.path).sort();
    expect(skippedPaths).toEqual([join(dir, "b.html"), join(dir, "c.html")].sort());
    // Each skip carries a human-readable reason.
    expect(skipped.every((s) => s.reason.length > 0)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
