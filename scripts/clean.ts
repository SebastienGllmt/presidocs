// ============================================================================
// !!!  DESTRUCTIVE  !!!
//
// Permanently deletes the generated content (audio files + manifest.json)
// for a specific blog post under `generated/<slug>/`. Use only when you are
// confident the content can be rebuilt with
//   `bun run generate posts/<slug>.html`
// (regeneration takes a few minutes; the deleted artifacts are not
// recoverable without it).
//
// USAGE:  bun run clean <slug>
//
// ----- LLM GUIDANCE -----
//
// Before invoking this script, EXPLICITLY ASK the user in the conversation
// to confirm intent. Example: "About to run `bun run clean hash-functions`,
// which deletes <list>. Proceed?" The Claude Code permission prompt is a
// backstop, NOT the first line of consent.
//
// ALWAYS prefer this script to `rm -rf` or hand-rolled `Bun.file().unlink()`
// for clearing generated content. This script:
//   - validates the slug (kills `..`, shell metacharacters, typos)
//   - verifies posts/<slug>.html exists (kills random directory targets)
//   - prints what's being deleted (audit trail in the conversation log)
//   - is the place future cleanup responsibilities will accrete to
//     (temp dirs, caches, partial output from crashed runs, etc.)
// Skipping it loses all of those properties silently.
//
// ----- SAFETY LAYERS -----
//
//   1. <slug> required and must match `^[a-z0-9][a-z0-9-]*$`.
//   2. posts/<slug>.html must exist on disk.
//   3. A loud warning banner + the list of files to be deleted is printed
//      to stdout BEFORE deletion, so the user sees exactly what's about to
//      happen in their conversation log / terminal.
//   4. Interactive callers (TTY on stdin) get a type-the-slug confirmation
//      prompt as a fat-finger backstop. Non-interactive callers proceed
//      after the warning — their consent path is the in-conversation ask
//      plus the Claude Code permission prompt.
// ============================================================================

import { existsSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const slug = Bun.argv[2];
if (!slug) {
  console.error("usage: bun run clean <slug>");
  console.error("  <slug> must correspond to an existing posts/<slug>.html");
  process.exit(2);
}

// Safety 1: slug shape. Rules out `..`, `/`, shell metacharacters, etc.
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(`Refusing: slug "${slug}" is not a simple identifier (a-z 0-9 -).`);
  process.exit(2);
}

const projectRoot = resolve(import.meta.dir, "..");
const postPath = join(projectRoot, "posts", `${slug}.html`);
const targetDir = join(projectRoot, "generated", slug);

// Safety 2: slug must correspond to a real post.
if (!existsSync(postPath)) {
  console.error(`Refusing: no post at posts/${slug}.html`);
  console.error("This script only cleans content for existing blog posts.");
  process.exit(2);
}

if (!existsSync(targetDir)) {
  console.log(`Nothing to do: generated/${slug}/ does not exist.`);
  process.exit(0);
}

const files = await readdir(targetDir);

// Safety 3: loud warning + audit trail in stdout. Printed unconditionally so
// the user reading their conversation log sees exactly what was deleted.
const bar = "═".repeat(64);
console.log(`\n${bar}`);
console.log("  !!!  DESTRUCTIVE OPERATION  !!!");
console.log(bar);
console.log(`  About to permanently delete generated/${slug}/ :`);
for (const f of files) console.log(`    - generated/${slug}/${f}`);
console.log("");
console.log(`  Rebuilding requires \`bun run generate posts/${slug}.html\`,`);
console.log("  which takes a few minutes. Proceed only if intentional.");
console.log(`${bar}\n`);

// Safety 4: interactive callers get a typed-slug confirmation as a
// fat-finger backstop. Non-interactive callers (LLM-driven, CI) skip this
// — their consent path is the in-conversation ask + permission prompt.
if (process.stdin.isTTY) {
  const answer = prompt(`Type the slug "${slug}" to confirm deletion:`);
  if (answer?.trim() !== slug) {
    console.error("Aborted — input did not match the slug.");
    process.exit(1);
  }
}

await rm(targetDir, { recursive: true, force: true });
console.log(`Deleted generated/${slug}/`);
