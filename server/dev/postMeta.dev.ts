// Dev-only: scans `posts/*.html` at startup and builds a PostMetaIndex
// in memory. Used by `index.ts` (the Bun dev server). The Worker prod
// path imports the pre-generated map instead (see postMeta.generated.ts).
//
// We deliberately use a recursive scan with `.html` filtering so new
// posts get picked up without a config change — just drop another
// HTML in `posts/` and restart `bun --hot`.

import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { collectHtmlFiles } from "../../shared/walkHtml.ts";
import {
  createPostMetaIndex,
  parseAuthorEmailFromHtml,
  type PostMeta,
  type PostMetaIndex,
} from "../postMeta.ts";

export async function loadDevPostMetaIndex(
  postsDir: string,
): Promise<PostMetaIndex> {
  const map: Record<string, PostMeta> = {};
  // Recursive `**/*.html` under posts/, ENOENT → empty (a content repo may have
  // no posts/ yet). This is the "drop another HTML in posts/ and restart
  // bun --hot" contract — a new post is picked up with no config change.
  for (const full of collectHtmlFiles(postsDir, { onMissing: "empty" })) {
    const html = await readFile(full, "utf8");
    const email = parseAuthorEmailFromHtml(html);
    if (!email) continue;
    // Filesystem path → URL post path: `posts/hash-functions.html` →
    // `/posts/hash-functions`, matching the route mounted in `index.ts`.
    const relPath = relative(postsDir, full).split(sep).join("/");
    const noExt = relPath.replace(/\.html$/, "");
    map[`/posts/${noExt}`] = { authorEmail: email };
  }
  return createPostMetaIndex(map);
}
