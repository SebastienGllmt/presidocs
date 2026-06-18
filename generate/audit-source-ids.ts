// Duplicate-`id` checker for the AUTHORED post source in `posts/*.html`. NOT a
// build gate — the build/deploy backstop is audit-posts.ts, which runs
// html-validate's `no-dup-id` over the FINAL served markup in `dist/posts/`.
// This is the *source-layer*, build-free counterpart, used where audit-posts
// can't reach because it needs a built `dist/`:
//   - the PostToolUse hook (scripts/hook-dup-ids.ts) — warns the agent the
//     instant an Edit/Write to a post introduces a collision, so it self-corrects
//     before the author ever references the now-ambiguous id; and
//   - `bun generate/audit-source-ids.ts` as a manual full-corpus scan.
// The source `posts/*.html` is the layer the author (and the agents the author
// drives with "change the table/figure with this id") actually edit and address
// by id, so catching a duplicate there — fast, no build — is the point.
//
// Browser-free and parser-correct: HTMLRewriter collects `[id]` from real
// elements only. It does NOT match `data-chapter-id` (the narration DSL pairs a
// chapter's `data-chapter-id` with the divider's `id` on purpose — those are not
// id collisions), and it treats `<script type="text/narration">` content as raw
// text, so `<mark/>` sentinels inside it never register as id-bearing elements.

import { relative } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { type AuditViolation, postHtmlFiles } from "./audit-posts.ts";

/**
 * The ids that appear more than once in one post's HTML, sorted. Empty = clean.
 * HTMLRewriter to stay browser-free and to count only real `id` attributes
 * (never `data-*-id`, never script-text). Exported for unit tests.
 */
export function duplicateIds(html: string): string[] {
  const counts = new Map<string, number>();
  new HTMLRewriter()
    .on("[id]", {
      element(el) {
        const id = el.getAttribute("id");
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      },
    })
    .transform(html);
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();
}

// Pure audit of one source post: one violation per duplicated id. Exported for
// unit tests.
export function auditSourceIds(html: string): AuditViolation[] {
  return duplicateIds(html).map((id) => ({
    rule: "no-dup-id",
    detail: `id="${id}" appears on more than one element — fragment links, aria-labelledby, position-anchor, and id-addressed edits all become ambiguous`,
  }));
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();
  const files = await postHtmlFiles(paths.postsDir);
  if (files.length === 0) {
    console.warn(`Source-id audit: no source posts under ${relative(paths.contentRoot, paths.postsDir)}.`);
    return;
  }

  let failed = 0;
  for (const file of files) {
    const html = await Bun.file(file).text();
    const violations = auditSourceIds(html);
    if (violations.length === 0) continue;
    failed++;
    console.error(`  ✗ ${relative(paths.contentRoot, file)}`);
    for (const { rule, detail } of violations) console.error(`      [${rule}] ${detail}`);
  }

  if (failed > 0) {
    console.error(
      `Source-id audit FAILED: ${failed}/${files.length} source post(s) have duplicate ids (see above).`,
    );
    process.exit(1);
  }
  console.log(`Source-id audit: ${files.length} source post(s) OK — no duplicate ids.`);
}

// CLI only — importing the helpers (tests) must not run the gate.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
