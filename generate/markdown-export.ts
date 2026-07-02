// Build step: emit a Markdown twin of every built post — `dist/posts/<slug>.md`
// next to `dist/posts/<slug>.html` — for the "Copy as Markdown" feature
// (methodology.md → "Copy as Markdown"). The client button fetches
// this static file; it doubles as an LLM-readable artifact (advertised via the
// `<link rel="alternate" type="text/markdown">` that strip-served-html.ts
// injects into each post, and listable in llms.txt).
//
// Runs over the FINAL served HTML in `dist/posts/` — same input as
// audit-posts.ts, after strip-served-html.ts has run — so the Markdown reflects
// exactly what's deployed. The HTML at this point is still pre-JS (the comment
// column, the populated dock, and the enhanced figures are all runtime), which
// is precisely why a build-time extract is clean: the chrome we'd otherwise
// fight off in a live-DOM reader pass simply isn't present yet. The pure
// transform lives in shared/htmlToMarkdown.ts (browser-free, golden-tested).
//
// Idempotent: re-running overwrites each `.md` with byte-identical output for
// unchanged input.

import { join, relative } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveLicenseConfig } from "../shared/licenseConfig.ts";
import { collectHtmlFiles } from "../shared/walkHtml.ts";
import {
  htmlToMarkdown,
  renderMarkdownDocument,
  type FrontMatter,
} from "../shared/htmlToMarkdown.ts";

type VersionEntry = { hash: string; builtAt: string };
type VersionsFile = Record<string, VersionEntry[]>;

// dist/posts/offer-files.html → "/posts/offer-files" (the versions.json key and
// the canonical URL path).
function distFileToPostPath(distDir: string, file: string): string {
  const rel = relative(distDir, file).split(/[\\/]/).join("/").replace(/\.html$/, "");
  return `/${rel}`;
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();
  const distPostsDir = join(paths.distDir, "posts");
  const files = collectHtmlFiles(distPostsDir, { onMissing: "empty" });
  if (files.length === 0) {
    console.warn(
      `Markdown export: no built posts under ${relative(paths.contentRoot, distPostsDir)} — did the earlier build steps run?`,
    );
    return;
  }

  // Canonical site origin for the `source:` front-matter URL. Unset → omit the
  // URL (same fail-silent posture as the structured-data / feed steps); the
  // Markdown is still emitted and the button still works.
  const siteUrl = (process.env.SITE_URL ?? "").trim().replace(/\/+$/, "");

  // Reuse terms stamped into every twin's front-matter: a post is
  // prose (the content license) plus code snippets (the code license). Both omit
  // when unset — the engine declares no license the operator didn't choose.
  const license = resolveLicenseConfig();

  // Per-post last-updated date — the newest `builtAt`, the same field published
  // as JSON-LD `dateModified` and on the byline's "Last updated". Absent file
  // or post → omit the `updated:` line.
  let versions: VersionsFile = {};
  try {
    versions = (await Bun.file(paths.versionsJson).json()) as VersionsFile;
  } catch {
    versions = {};
  }

  let written = 0;
  for (const file of files) {
    const html = await Bun.file(file).text();
    const postPath = distFileToPostPath(paths.distDir, file);

    // Base for figure-source links: a `<figure data-figure-src>`
    // resolves to the co-located `<base>/figures/<src>.ts` emitted by
    // figure-source-export.ts. Prefer the **absolute** post URL when SITE_URL is
    // known — the published case, where the twin is most often *pasted as raw
    // text into an LLM* with no base URL to resolve a relative link against, so a
    // relative path would be unresolvable. Falls back to the bare slug (a
    // relative path, resolved against the `.md`'s own URL) for local/preview
    // builds with no SITE_URL. Either way the base carries the private `--<token>`
    // slug suffix, so the source stays gated with no public/private branch.
    const slug = file.split(/[\\/]/).pop()!.replace(/\.html$/, "");
    const figureSrcBase = siteUrl ? `${siteUrl}${postPath}` : slug;
    const extract = htmlToMarkdown(html, { figureSrcBase });
    const fm: FrontMatter = { title: extract.title };
    if (siteUrl) fm.url = `${siteUrl}${postPath}`;
    const history = versions[postPath];
    if (history && history.length > 0) fm.updated = history[0]!.builtAt;
    if (license.content) fm.license = license.content.id;
    if (license.code) fm.codeLicense = license.code.id;

    const doc = renderMarkdownDocument(extract, fm);
    const outPath = file.replace(/\.html$/, ".md");
    await Bun.write(outPath, doc);
    written++;
    const via = extract.usedReadability ? "readability" : "article-root";
    console.log(`  ${relative(paths.contentRoot, outPath)} (${via}, ${doc.length} bytes)`);
  }

  console.log(`Markdown export: wrote ${written}/${files.length} post(s).`);
}

// CLI only — importing must not run the build pass.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
