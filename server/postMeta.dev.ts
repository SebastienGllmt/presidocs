// Dev-only: scans `posts/*.html` at startup and builds a PostMetaIndex
// in memory. Used by `index.ts` (the Bun dev server). The Worker prod
// path imports the pre-generated map instead (see postMeta.generated.ts).
//
// We deliberately use a recursive scan with `.html` filtering so new
// posts get picked up without a config change — just drop another
// HTML in `posts/` and restart `bun --hot`.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  createPostMetaIndex,
  parseAuthorEmailFromHtml,
  type PostMeta,
  type PostMetaIndex,
} from "./postMeta.ts";

export async function loadDevPostMetaIndex(
  postsDir: string,
): Promise<PostMetaIndex> {
  const map: Record<string, PostMeta> = {};
  await walk(postsDir, postsDir, map);
  return createPostMetaIndex(map);
}

async function walk(
  rootDir: string,
  currentDir: string,
  out: Record<string, PostMeta>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const ent of entries) {
    const full = join(currentDir, ent.name);
    if (ent.isDirectory()) {
      await walk(rootDir, full, out);
    } else if (ent.isFile() && ent.name.endsWith(".html")) {
      const html = await readFile(full, "utf8");
      const email = parseAuthorEmailFromHtml(html);
      if (!email) continue;
      // Convert filesystem path to the URL post path. `posts/hash-
      // functions.html` becomes `/posts/hash-functions` to match the
      // route mounted in `index.ts`.
      const relPath = relative(rootDir, full).split(sep).join("/");
      const noExt = relPath.replace(/\.html$/, "");
      // `rootDir` is the `posts/` directory, so we prepend it back to
      // get the URL prefix.
      out[`/posts/${noExt}`] = { authorEmail: email };
    }
  }
}
