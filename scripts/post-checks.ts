// Claude Code Stop hook: when the agent finishes a turn, lint any blog post it
// touched and WARN (non-blocking) if something's off. Runs at the *settled*
// end-of-turn state, NOT per-edit — so a mid-refactor HTML (block duplicated
// then renamed, section being moved) is never flagged while it's transiently
// "bad". It only sees the post once the agent has come to rest.
//
// Scope comes from git: we ask the blog repo which posts differ from HEAD
// (staged, unstaged, or untracked) and check only those. No post changed this
// session → silent no-op. Over-firing (re-checking a file every turn while it
// has uncommitted changes) is harmless — the checks are read-only and only
// surface on a real problem. Once the author commits, the file drops out of the
// diff and stops being checked.
//
// Non-blocking by design: we emit a `systemMessage` and exit 0, so the turn ends
// normally and the warning surfaces to the author (who can relay it, or fix it
// next turn). No `decision:"block"` → the agent is never re-invoked, so there is
// no Stop-hook loop to guard against. Escalate an individual check to blocking
// later if warnings prove too easy to ignore.
//
// Adding a check is a one-liner: push another { name, run } onto CHECKS. `run`
// takes the post HTML and returns a list of human-readable issue strings.
//
// Usage (from .claude/settings.json): bun post-checks.ts <blog-root>
// <blog-root> defaults to $CLAUDE_PROJECT_DIR/personal-blog.

import { join } from "node:path";
import { duplicateIds } from "../generate/audit-source-ids.ts";

type Check = { name: string; run: (html: string) => string[] };

// Narration chapter ids that two `<script type="text/narration">` blocks both
// claim. Each chapter id must be unique — a duplicate makes the manifest's
// chapter→divider driving ambiguous (same failure mode as a duplicate element
// id, one level up). HTMLRewriter reads the attribute off the <script> element;
// the narration `<mark/>` DSL inside the script stays raw text, so a stray
// `data-chapter-id="…"` in narration prose is never miscounted.
function duplicateChapterIds(html: string): string[] {
  const counts = new Map<string, number>();
  new HTMLRewriter()
    .on('script[type="text/narration"]', {
      element(el) {
        const id = el.getAttribute("data-chapter-id");
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      },
    })
    .transform(html);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
}

// The check registry. Add a check by appending { name, run }: `run` takes the
// post HTML and returns a list of human-readable issue strings (empty = clean).
// A check can be an imported module (duplicate-id) or defined right here
// (duplicate-chapter-id) — both are just functions of the HTML.
const CHECKS: Check[] = [
  {
    name: "duplicate-id",
    run: (html) => duplicateIds(html).map((id) => `duplicate id="${id}" (id-addressed edits become ambiguous)`),
  },
  {
    name: "duplicate-chapter-id",
    run: (html) =>
      duplicateChapterIds(html).map(
        (id) => `duplicate narration data-chapter-id="${id}" (chapter→divider driving becomes ambiguous)`,
      ),
  },
];

// Repo-relative paths of posts/*.html that differ from HEAD (tracked changes +
// untracked new files). Empty if the repo is unavailable or nothing changed.
async function changedPosts(blogRoot: string): Promise<string[]> {
  const git = async (args: string[]): Promise<string[]> => {
    try {
      const proc = Bun.spawn(["git", "-C", blogRoot, "-c", "core.quotePath=false", ...args], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };
  const tracked = await git(["diff", "--name-only", "HEAD", "--", "posts"]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "--", "posts"]);
  const posts = new Set([...tracked, ...untracked].filter((f) => f.endsWith(".html")));
  return [...posts];
}

const blogRoot = process.argv[2] || join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "personal-blog");

const issues: string[] = [];
for (const rel of await changedPosts(blogRoot)) {
  let html: string;
  try {
    html = await Bun.file(join(blogRoot, rel)).text();
  } catch {
    continue; // deleted or unreadable — nothing to check
  }
  for (const check of CHECKS) {
    for (const issue of check.run(html)) issues.push(`  ${rel}: ${issue}`);
  }
}

if (issues.length > 0) {
  const systemMessage = `Post checks flagged the just-edited post(s):\n${issues.join("\n")}`;
  console.log(JSON.stringify({ systemMessage }));
}
process.exit(0);
