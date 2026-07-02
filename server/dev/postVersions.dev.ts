// Dev-only: builds the per-post version index from `posts/*.html`
// (current hash) plus `posts/versions.json` (committed history). Used
// by `index.ts` (the Bun dev server). The Worker prod path imports
// the pre-generated map instead.
//
// On dev startup we compute each post's current hash fresh from its
// source file, then read whatever history is recorded in versions.json.
// If the dev hash doesn't match the latest history entry (the author
// just edited a post without running `bun run build`), the banner UI
// still triggers — but the history view will be one entry behind
// until the next build.

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { collectHtmlFiles } from "../../shared/walkHtml.ts";
import {
  createPostVersionIndex,
  sha256Hex,
  type PostVersionIndex,
  type PostVersion,
  type PostVersionRecord,
} from "../postVersions.ts";

export async function loadDevPostVersionIndex(
  postsDir: string,
  versionsJsonPath: string,
): Promise<PostVersionIndex> {
  const history = await loadHistoryFile(versionsJsonPath);
  const map: Record<string, PostVersionRecord> = {};
  // Recursive `**/*.html` under posts/, ENOENT → empty (no posts/ yet).
  for (const full of collectHtmlFiles(postsDir, { onMissing: "empty" })) {
    const bytes = await readFile(full);
    const currentHash = await sha256Hex(bytes);
    const relPath = relative(postsDir, full).split(sep).join("/");
    const noExt = relPath.replace(/\.html$/, "");
    const postPath = `/posts/${noExt}`;
    // If the dev hash doesn't match the most-recent recorded history entry,
    // prepend an in-memory "now" entry so the history view reflects the current
    // state. Not persisted — `bun run build` is the one writing back to disk.
    const recorded = history[postPath] ?? [];
    const augmented: PostVersion[] =
      recorded.length === 0 || recorded[0]!.hash !== currentHash
        ? [{ hash: currentHash, builtAt: new Date().toISOString() }, ...recorded]
        : recorded;
    map[postPath] = { currentHash, history: augmented };
  }
  return createPostVersionIndex(map);
}

async function loadHistoryFile(
  jsonPath: string,
): Promise<Record<string, PostVersion[]>> {
  try {
    const text = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, PostVersion[]>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`postVersions.dev: failed to read ${jsonPath}:`, err);
    }
  }
  return {};
}
