// Batch driver for `generate.ts`: when `bun run generate[:prod]` is invoked
// with NO post path, generate over every post that actually ships narration.
//
// Why spawn one `generate.ts` subprocess per post rather than loop in-process:
// generate.ts is a single-post top-level script studded with `process.exit()`
// calls and a per-run TTS/aligner lifecycle (it loads — and `close()`s — a
// MOSS/Qwen3 worker per invocation). Running each post in its own process is
// the same thing the author does by hand today (`generate:prod posts/x.html`),
// keeps the model lifecycle clean, and isolates a crash/hang in one post from
// the rest of the batch. The engine stays content-agnostic — it discovers
// posts by convention from `contentRoot/posts` (see blogPaths.ts), never by
// name.
//
// "Excluding posts that have no narration" is enforced HERE by pre-filtering on
// `extractNarration`: a post is generated iff it has ≥1
// `<script type="text/narration">` block AND isn't opted out via
// `<article data-narration="none">`. Posts failing either test are skipped (and
// logged) rather than spawned — so the batch never burns a multi-GB model load
// on a post with nothing to say, and never trips generate.ts's
// "no narration blocks" hard error.

import { join, relative } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { collectHtmlFiles } from "../shared/walkHtml.ts";
import { extractNarration } from "./narration.ts";

export type BatchPartition = {
  narrated: string[];
  skipped: { path: string; reason: string }[];
};

// Split every post under postsDir into "has narration" vs "skip", reading each
// file once. Pure w.r.t. the filesystem read it does — exported so it's
// unit-testable without spawning subprocesses.
export async function partitionPosts(postsDir: string): Promise<BatchPartition> {
  const htmlPaths = collectHtmlFiles(postsDir);
  const narrated: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const p of htmlPaths) {
    const { disabled, chapters } = extractNarration(await Bun.file(p).text());
    if (disabled) skipped.push({ path: p, reason: 'narration disabled (data-narration="none")' });
    else if (chapters.length === 0) skipped.push({ path: p, reason: "no narration script blocks" });
    else narrated.push(p);
  }
  return { narrated, skipped };
}

// Run generate.ts once per narrated post, sequentially, forwarding the original
// flags (e.g. `--tts=moss --align=qwen3` from `generate:prod`). Continues past a
// failing post so one bad render doesn't abort an hours-long prod batch, then
// returns a non-zero exit code if any post failed. Returns the process exit
// code for the caller to hand to `process.exit`.
export async function runBatch(forwardedArgs: string[]): Promise<number> {
  const paths = resolveBlogPaths();
  const rel = (p: string) => relative(paths.contentRoot, p);

  let partition: BatchPartition;
  try {
    partition = await partitionPosts(paths.postsDir);
  } catch (err) {
    console.error(`Cannot read posts directory ${paths.postsDir}: ${(err as Error).message}`);
    return 1;
  }

  const { narrated, skipped } = partition;
  for (const s of skipped) console.log(`  · skip ${rel(s.path)} — ${s.reason}`);
  if (narrated.length === 0) {
    console.log("No narrated posts to generate.");
    return 0;
  }
  console.log(
    `Generating ${narrated.length} narrated post(s)${skipped.length ? `, skipped ${skipped.length}` : ""}:\n`,
  );

  // generate.ts lives next to this file; re-invoke it with `bun` so each post
  // gets a fresh single-post run with its own provider lifecycle.
  const generateScript = join(import.meta.dir, "generate.ts");
  const failed: string[] = [];
  for (const [i, postPath] of narrated.entries()) {
    console.log(`\n=== [${i + 1}/${narrated.length}] ${rel(postPath)} ===`);
    const proc = Bun.spawn(["bun", generateScript, postPath, ...forwardedArgs], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`  ✗ ${rel(postPath)} failed (exit ${code})`);
      failed.push(postPath);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (failed.length > 0) {
    console.error(`Batch generate: ${failed.length}/${narrated.length} post(s) FAILED:`);
    for (const p of failed) console.error(`  ✗ ${rel(p)}`);
    return 1;
  }
  console.log(`Batch generate: OK — ${narrated.length} post(s) generated.`);
  return 0;
}
