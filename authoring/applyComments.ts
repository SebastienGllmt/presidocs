#!/usr/bin/env bun
//
// Apply unresolved reader comments to a blog post.
//
// Usage:
//   bun authoring/applyComments.ts <slug> [--model sonnet|opus] [--in-place]
//
// What it does:
//   1. Aggregates every reader's unresolved comment threads for the
//      post from the local dev fsAdapter (`generated/.comments-dev/`).
//      In prod the same blobs sit in R2 — pull them down with
//      `wrangler r2 object get` before running, or wire an R2 adapter
//      as a follow-up.
//   2. Copies `posts/<slug>.html` to `posts/<slug>.ai-draft.html` (or
//      keeps editing in place with `--in-place`).
//   3. Shells out to `claude -p` with the threads + an authoring
//      system prompt, letting Claude Code's built-in Edit/Read tools
//      apply the changes directly to the draft file.
//   4. Prints a summary; the author reviews via `diff` and `mv`s to
//      accept.
//
// Why `claude -p` and not the Anthropic SDK directly:
//   - Uses the author's existing Claude Code auth (no API key plumbing).
//   - Edit/Read are already wired with the right ergonomics; we'd
//     re-implement them in less polished form against the raw
//     Messages API.
//   - The exact-text Edit-tool model is what makes "AI edits a real
//     file" reviewable — every change is a focused diff hunk, not a
//     full-file rewrite that could silently drop a <script> block.
//
// Safety choices:
//   - Default to a sidecar (`.ai-draft.html`) so the author can `diff`
//     before accepting and so accidental runs don't trash uncommitted
//     work in `posts/<slug>.html`.
//   - `--allowedTools Read Edit Grep Glob` — no Bash, no Web. Even
//     under `acceptEdits`, Claude can't touch anything but file reads
//     and the draft's contents.
//   - Resolved threads are filtered up-front so Claude never sees
//     them.

import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadUnresolvedThreads, type UnresolvedThread } from "./loadUnresolvedThreads.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

type CliArgs = {
  slug: string;
  model: "sonnet" | "opus" | "haiku" | string;
  inPlace: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  let slug: string | null = null;
  let model = "sonnet";
  let inPlace = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model") {
      const next = argv[++i];
      if (!next) throw new Error("--model requires a value");
      model = next;
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a === "--in-place") {
      inPlace = true;
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (slug === null) {
      slug = a;
    } else {
      throw new Error(`unexpected positional arg: ${a}`);
    }
  }

  if (!slug) {
    printUsage();
    process.exit(1);
  }
  return { slug, model, inPlace };
}

function printUsage(): void {
  console.error(`
Usage: bun authoring/applyComments.ts <slug> [options]

  <slug>           post stem under posts/, e.g. "hash-functions"

Options:
  --model <name>   model alias passed to claude -p (default: sonnet)
  --in-place       edit posts/<slug>.html directly instead of writing
                   a posts/<slug>.ai-draft.html sidecar
  --help           show this help
`.trimStart());
}

function formatThreadForPrompt(t: UnresolvedThread, index: number): string {
  const a = t.thread.anchor;
  const anchorBlock =
    a.kind === "text"
      ? [
          `  anchor: text in ${a.context}`,
          `  anchor block ids: ${a.segments.map((s) => s.id).join(", ")}`,
          `  anchor quote: ${JSON.stringify(a.quote)}`,
        ].join("\n")
      : [
          `  anchor: graphic (figure id=${JSON.stringify(a.id)}) in ${a.context}`,
        ].join("\n");

  const replies = t.thread.replies
    .map(
      (r, i) =>
        `  reply #${i + 1} — ${r.authorName} <${r.authorEmail}>: ${r.body}`,
    )
    .join("\n");

  return [
    `Thread #${index + 1} (id=${t.thread.id}, by ${t.ownerUserId}):`,
    anchorBlock,
    replies,
  ].join("\n");
}

const SYSTEM_PROMPT = `
You are helping the author of a single-file HTML technical blog apply
reader feedback to one of their posts. Each post is one self-contained
.html file under posts/<slug>.html, containing:

- The article (visible HTML — <article>, <h*>, <p>, <figure>, etc.).
- <script type="text/narration" data-chapter-id="…" data-chapter-title="…">
  blocks holding the spoken-track script. This narration is NOT a
  read-aloud — it's a parallel presenter's voice that paraphrases,
  reorders, or skips article content. <mark name="X"/> inside a
  narration block points at the article element with id="X" so the
  player highlights + auto-scrolls to that element when the narration
  reaches that mark.
- <script type="application/pls+xml"> blocks: PLS pronunciation
  lexicon for technical terms — used only by the offline audio
  pipeline, not by readers.
- Infrastructure tags you must NOT touch: <meta name="author-email">,
  <link rel="stylesheet" href="../client/…">, <script type="module"
  src="../client/…">. These wire the post to the runtime and break
  the page if edited.

Rules for applying comments:
1. Use the Edit tool for each change. The user has set permission
   mode acceptEdits so you do not need to ask. Read first, then Edit.
2. Edit ONLY the file the user told you to. Do not touch other posts,
   client/, server/, or anything else.
3. Preserve every id="…" on a block that is the target of a <mark
   name="…"/> in a narration script. Breaking that pairing
   silently breaks the audio sync.
4. If you edit text inside a narration <script type="text/narration">
   block, that's fine — it just means the offline TTS will resynth
   that segment on next bun run generate. Don't add SSML tags other
   than <mark/> (the project deliberately supports only <mark/>).
5. Some comments are typo-fixes — apply directly. Some are questions
   or rewording requests — rewrite the relevant paragraph(s). Some
   disagree with the substance or are out of scope — do NOT silently
   apply those; use the "note" mechanism described below instead.
6. Keep article ↔ narration in sync. If a comment makes you change
   how something is explained in the article, decide whether the
   narration for the same section needs the same edit. Often it
   does. Mention this explicitly in your final summary.
7. Do NOT change SVG diagram content unless the comment explicitly
   asks for it — diagrams are deliberate.

Your final output (after all edits) MUST be a short structured summary,
one section per thread, in this exact form:

  Thread #N (id=…): APPLIED | PARTIAL | NOTE-ONLY
    What changed (or what you flagged for the author to handle manually).

This is the only thing the author reads after the run, so it has to
be the ground truth of what you did.
`.trim();

const USER_PROMPT_PROLOGUE = `
Below are unresolved reader comments on a post. Edit the post file as
specified to address them, following the rules in your system prompt.
`.trim();

// One row from Claude's structured-summary block at the end of the
// run. Parsed out of stdout (we ask Claude for an exact, greppable
// format in the system prompt). The verdict is the author's signal:
// only APPLIED threads get auto-resolved on promote.
export type ThreadVerdict = {
  threadId: string;
  status: "APPLIED" | "PARTIAL" | "NOTE-ONLY";
};

// Sidecar JSON written next to the draft. `promoteDraft.ts` reads
// this to know which threads Claude said were APPLIED so it can write
// resolutions for them on accept. Keeping it next to the draft (not
// in `generated/`) makes it obvious that the two files share a
// lifecycle: review the draft, accept → both get cleaned up; discard
// the draft → discard the meta too.
export type DraftMeta = {
  slug: string;
  model: string;
  ranAt: string;
  verdicts: ThreadVerdict[];
  /** Full captured stdout — handy for audit / re-reading Claude's reasoning. */
  claudeOutput: string;
};

// Matches the format the system prompt makes Claude emit, e.g.:
//   Thread #2 (id=abc123): APPLIED
// We deliberately don't anchor on a leading "^" so indented
// summaries (markdown-ish bullet style) still match.
const VERDICT_RE =
  /Thread\s+#\d+\s+\(id=([A-Za-z0-9_-]+)\):\s+(APPLIED|PARTIAL|NOTE-ONLY)\b/g;

export function parseVerdicts(claudeOutput: string): ThreadVerdict[] {
  const seen = new Set<string>();
  const out: ThreadVerdict[] = [];
  // Iterate in the order Claude emitted them — first verdict per
  // threadId wins. (If Claude double-mentions a thread, the second
  // is almost always an aside, not a re-classification.)
  for (const m of claudeOutput.matchAll(VERDICT_RE)) {
    const threadId = m[1]!;
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    out.push({
      threadId,
      status: m[2] as ThreadVerdict["status"],
    });
  }
  return out;
}

async function spawnClaude(
  fullPrompt: string,
  draftPath: string,
  model: string,
): Promise<{ code: number; captured: string }> {
  // Use --append-system-prompt rather than --system-prompt so Claude
  // Code's default tool-use ergonomics (the bits that make Edit
  // feel natural) stay intact and ours layers on top.
  //
  // --allowedTools is the whitelist: Edit + Read are the obvious
  // ones; Grep + Glob let Claude navigate the post when looking for
  // anchor text it has to match exactly. No Bash, no WebFetch — we
  // don't need those and they widen the blast radius.
  //
  // acceptEdits is the right permission mode: Claude can write to
  // files (we already constrained which file via the prompt) but
  // still has to surface Bash / network calls if it tries them.
  // bypassPermissions would skip the network safety net we didn't
  // ask for.
  const args = [
    "-p",
    "--model",
    model,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read,Edit,Grep,Glob",
    "--append-system-prompt",
    SYSTEM_PROMPT,
    "--add-dir",
    PROJECT_ROOT,
  ];

  console.log(
    `\nInvoking: claude -p --model ${model} --permission-mode acceptEdits ` +
      `--allowedTools Read,Edit,Grep,Glob (with authoring system prompt) …`,
  );
  console.log(`Editing: ${draftPath}`);
  console.log(`(streaming Claude's output below)\n${"─".repeat(64)}`);

  // Prompt goes over stdin so the (post + threads) payload isn't
  // capped by the OS argv-length limit (~256KB on macOS, smaller on
  // some Linuxes). claude -p reads from stdin when no positional
  // prompt is supplied — see `--input-format text` (the default).
  //
  // stdout is piped (not inherited) so we can both stream it to the
  // user AND capture it for verdict parsing. The captured text gets
  // tee'd into the user's terminal as bytes arrive, so the UX is the
  // same as if we'd inherited, but we keep a copy for the meta
  // sidecar.
  const proc = Bun.spawn(["claude", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: PROJECT_ROOT,
  });
  proc.stdin.write(fullPrompt);
  await proc.stdin.end();

  // Use the ReadableStream reader directly. Bun's stdout IS async-
  // iterable at runtime but the bun-types AsyncIterable typing is
  // patchy; the reader API is the portable, well-typed shape.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    captured += text;
    process.stdout.write(text);
  }
  // Flush any trailing multi-byte sequence the streaming decoder is
  // still holding onto.
  captured += decoder.decode();

  const code = await proc.exited;
  return { code, captured };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const srcPath = join(PROJECT_ROOT, "posts", `${args.slug}.html`);
  if (!existsSync(srcPath)) {
    console.error(`error: ${srcPath} does not exist`);
    process.exit(1);
  }

  const postPath = `/posts/${args.slug}`;
  const commentsDir = join(PROJECT_ROOT, "generated", ".comments-dev");

  console.log(`Loading comments for ${postPath} from ${commentsDir} …`);
  const { unresolved, resolvedCount, totalCount } = await loadUnresolvedThreads(
    {
      postPath,
      commentsDir,
    },
  );
  console.log(
    `Found ${totalCount} thread(s); ${resolvedCount} already resolved; ` +
      `${unresolved.length} unresolved.`,
  );

  if (unresolved.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Pick the working file. In-place edits land directly on the
  // source; sidecar mode writes a copy alongside and tells Claude to
  // edit that. We pass the *path Claude should edit* into the
  // prompt — Claude has Edit on the whole repo via acceptEdits but
  // we want it to touch only one file, and the only durable way to
  // communicate that is in the prompt itself.
  let editPath: string;
  if (args.inPlace) {
    editPath = srcPath;
  } else {
    editPath = join(PROJECT_ROOT, "posts", `${args.slug}.ai-draft.html`);
    await mkdir(dirname(editPath), { recursive: true });
    await copyFile(srcPath, editPath);
  }

  const threadsBlock = unresolved
    .map((t, i) => formatThreadForPrompt(t, i))
    .join("\n\n");

  // Relative path because it's nicer in the prompt + matches how the
  // user thinks about the file. claude -p starts in PROJECT_ROOT.
  const editPathRel = `posts/${args.slug}${args.inPlace ? "" : ".ai-draft"}.html`;

  const fullPrompt = [
    USER_PROMPT_PROLOGUE,
    "",
    `Target file (edit ONLY this file): ${editPathRel}`,
    `(For context, the original unedited source is at posts/${args.slug}.html — Read it if helpful, but never Edit it.)`,
    "",
    `Unresolved threads (${unresolved.length}):`,
    "",
    threadsBlock,
    "",
    "When you finish editing, emit the structured summary from your system prompt and stop.",
  ].join("\n");

  const { code, captured } = await spawnClaude(
    fullPrompt,
    editPathRel,
    args.model,
  );
  console.log(`${"─".repeat(64)}`);
  if (code !== 0) {
    console.error(`claude -p exited with code ${code}`);
    process.exit(code);
  }

  const verdicts = parseVerdicts(captured);
  const appliedIds = verdicts
    .filter((v) => v.status === "APPLIED")
    .map((v) => v.threadId);
  const partialIds = verdicts
    .filter((v) => v.status === "PARTIAL")
    .map((v) => v.threadId);
  const noteOnlyIds = verdicts
    .filter((v) => v.status === "NOTE-ONLY")
    .map((v) => v.threadId);

  // Defensive: warn if Claude omitted verdicts for some threads. Means
  // either Claude went off-script or the system prompt's required-
  // format rule didn't stick. Promote handles a missing verdict as
  // "not APPLIED" (i.e., leave unresolved), which is the safe default.
  const verdictIds = new Set(verdicts.map((v) => v.threadId));
  const missingVerdicts = unresolved.filter(
    (t) => !verdictIds.has(t.thread.id),
  );

  console.log(
    `\nVerdicts: ${appliedIds.length} APPLIED, ${partialIds.length} PARTIAL, ${noteOnlyIds.length} NOTE-ONLY` +
      (missingVerdicts.length > 0
        ? ` (warning: ${missingVerdicts.length} thread(s) with no verdict — see captured output)`
        : ""),
  );

  if (!args.inPlace) {
    // Write the meta sidecar so promoteDraft can pick up the APPLIED
    // list later. The file lives alongside the draft so
    // accept-or-discard is a "both or neither" gesture.
    const metaPath = join(
      PROJECT_ROOT,
      "posts",
      `${args.slug}.ai-draft.meta.json`,
    );
    const meta: DraftMeta = {
      slug: args.slug,
      model: args.model,
      ranAt: new Date().toISOString(),
      verdicts,
      claudeOutput: captured,
    };
    await Bun.write(metaPath, JSON.stringify(meta, null, 2) + "\n");

    console.log(
      `\nDraft written to ${editPathRel}.` +
        `\nReview with:` +
        `\n  diff posts/${args.slug}.html ${editPathRel}` +
        `\nPromote when satisfied (moves the draft into place + auto-resolves the ${appliedIds.length} APPLIED thread(s)):` +
        `\n  bun run promote-draft ${args.slug}` +
        `\nOr discard:` +
        `\n  rm posts/${args.slug}.ai-draft.*\n`,
    );
  } else {
    // In-place edits don't write a meta sidecar — the verdict list is
    // already in this terminal, and there's no separate "accept" step
    // to tie auto-resolution to. The author can re-run via the
    // sidecar workflow if they want auto-resolve.
    console.log(
      `\nEdited posts/${args.slug}.html in place. Review with:\n` +
        `  git diff posts/${args.slug}.html\n` +
        `\nNote: --in-place skips auto-resolve. Use the default sidecar workflow + promote-draft to auto-resolve APPLIED threads.\n`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
