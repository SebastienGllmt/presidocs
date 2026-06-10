// Scaffold a new post in a content repo: `bun run new-post <slug>` (wired in
// the content repo's package.json like the other engine scripts).
//
// On a PRIVATE blog (BLOG_PRIVATE — shared/blogPrivacy.ts) the filename gets
// the `--<token>` capability suffix (16 base64url chars ≈ 96 bits, CSPRNG):
// the URL is the secret, and authors must never hand-invent tokens
// (methodology → Private blogs). audit-private.ts enforces the suffix at
// build, so this helper is the paved path, not the only door. On a public
// blog the slug is used as-is — one script, behavior keyed on the data.
//
// The skeleton is the minimum that passes the build gates (audit-posts wants
// lang/title/author-email/landmark; the meta description is injected from the
// lede at build): edit everything, it's a starting point.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { isPrivateBlog, PRIVATE_SLUG_TOKEN_CHARS } from "../shared/blogPrivacy.ts";

function slugToken(): string {
  // base64url, trimmed to length (each char carries 6 bits).
  return randomBytes(PRIVATE_SLUG_TOKEN_CHARS).toString("base64url").slice(0, PRIVATE_SLUG_TOKEN_CHARS);
}

function main(): void {
  const slug = (process.argv[2] ?? "").trim();
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.includes("--")) {
    console.error(
      "Usage: bun run new-post <slug>\n" +
        "  <slug>: lowercase letters/digits/single hyphens (the readable part; on a\n" +
        "  private blog the unguessable --<token> suffix is appended automatically).",
    );
    process.exit(1);
  }

  const paths = resolveBlogPaths();

  // Author email: the single profile under authors/, or an explicit 2nd arg.
  const explicit = (process.argv[3] ?? "").trim();
  const profiles = existsSync(join(paths.contentRoot, "authors"))
    ? readdirSync(join(paths.contentRoot, "authors")).filter((f) => f.endsWith(".json"))
    : [];
  const authorEmail = explicit || (profiles.length === 1 ? profiles[0]!.replace(/\.json$/, "") : "");
  if (!authorEmail) {
    console.error(
      `new-post: pass the author email as the 2nd argument (authors/ holds ${profiles.length} profile(s), so it can't be inferred).`,
    );
    process.exit(1);
  }

  const filename = isPrivateBlog() ? `${slug}--${slugToken()}` : slug;
  const outPath = join(paths.postsDir, `${filename}.html`);
  if (existsSync(outPath)) {
    console.error(`new-post: posts/${filename}.html already exists.`);
    process.exit(1);
  }

  const title = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  writeFileSync(
    outPath,
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="author-email" content="${authorEmail}" />
<title>${title}</title>
<link rel="stylesheet" href="../engine/client/base.css" />
<link rel="stylesheet" href="../engine/client/narrator.css" />
<link rel="stylesheet" href="../engine/client/comments.css" />
<script type="module" src="../engine/client/narratorLoader.ts"></script>
<script type="module" src="../engine/client/commentsLoader.ts"></script>
<script type="module" src="../engine/client/byline.ts"></script>
<script type="module" src="../engine/client/headerLinks.ts"></script>
<script type="module" src="../engine/client/citationLink.ts"></script>
<script type="module" src="../engine/client/backLink.ts"></script>
<script type="module" src="../engine/client/swRegister.ts"></script>
<script type="module" src="../engine/client/figureCopyId.ts"></script>
<script type="module" src="../engine/client/copyMarkdown.ts"></script>
</head>
<body>
  <!-- data-narration-src is the article-root marker the byline + comments
       layers key on (present on EVERY post, even narration-free ones — the
       manifest just 404s harmlessly until \`bun run generate\` makes audio). -->
  <article role="main"
           data-narration-src="/generated/${filename}/manifest.json"
           data-narration-title="${title}"
           data-narration-artist="${authorEmail}">
    <h1 id="title">${title}</h1>
    <p id="lede">
      One-paragraph summary of the post — this becomes the meta description
      and the share-card/OG description at build time.
    </p>
  </article>
</body>
</html>
`,
    "utf8",
  );
  console.log(`new-post: posts/${filename}.html`);
  if (isPrivateBlog()) {
    console.log(`  capability URL: /posts/${filename} — the token IS the secret; renaming the file rotates it.`);
  }
}

main();
