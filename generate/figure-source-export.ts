// Build step: copy each post's referenced figure SOURCE — the authored,
// unminified `figures/<module>.ts` (+ its optional `.css`) — to a per-post,
// self-origin path `dist/posts/<slug>/figures/<module>.ts`, so the Markdown
// twin's figure notes can link an AI to a figure's real code (methodology →
// Copy as Markdown, figure source pointers).
//
// Sibling to markdown-export.ts and runs in the same place: over the FINAL
// served HTML in `dist/posts/`, after strip-served-html.ts, before
// markdown-export.ts (which emits the links pointing here). Idempotent.
//
// Why co-locate under the post (not a flat `dist/figures-src/` mirror): the
// source is then reachable exactly when the post is. On a PRIVATE blog the slug
// carries the `--<token>` capability suffix, so the source inherits the gate
// with no public/private branch — a flat, guessable, post-enumerating dir would
// be the exact leak class the private-blog byline gate fixed. audit-private.ts
// asserts every emitted `dist/posts/<slug>/` dir carries the token.
//
// Why only `.ts` + `.css` and no import-tree walk: every figure module imports
// just `gsap` (vendor) and the shared engine `figureAnimation.ts` contract — no
// figure imports a sibling or author helper — so a
// figure's authored logic is single-file. Vendor and the engine contract are
// deliberately NOT copied (they're not the figure).
//
// The mapping is explicit: an animated `<figure id>` carries `data-figure-src="X"`
// naming its module; a static SVG figure carries none and gets nothing. The
// value is validated as a safe basename (shared/figureSource.ts).

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parseHTML } from "linkedom";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveLicenseConfig } from "../shared/licenseConfig.ts";
import { isValidFigureSrc, spdxHeader } from "../shared/figureSource.ts";
import { collectHtmlFiles } from "../shared/walkHtml.ts";

// Re-exported from its shared home so existing importers/tests keep their path.
export { spdxHeader } from "../shared/figureSource.ts";

/**
 * The distinct, validated `data-figure-src` module basenames a post references,
 * sorted for deterministic output. Build-only linkedom extraction (per the
 * engine's HTML parsing conventions); the audit uses HTMLRewriter for the same
 * data, each in its own file's idiom. Exported for unit tests.
 */
export function collectFigureSrc(html: string): string[] {
  const { document } = parseHTML(html);
  const out = new Set<string>();
  for (const fig of document.querySelectorAll("figure[data-figure-src]")) {
    const src = (fig.getAttribute("data-figure-src") ?? "").trim();
    if (src && isValidFigureSrc(src)) out.add(src);
  }
  return [...out].sort();
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();
  const distPostsDir = join(paths.distDir, "posts");
  const files = collectHtmlFiles(distPostsDir, { onMissing: "empty" });
  if (files.length === 0) {
    console.warn(
      `Figure-source export: no built posts under ${relative(paths.contentRoot, distPostsDir)} — did \`bun run build\` run the earlier steps?`,
    );
    return;
  }

  const figuresDir = join(paths.contentRoot, "figures");
  const license = resolveLicenseConfig();
  const published = (process.env.SITE_URL ?? "").trim() !== "";

  // Discover (slug → modules) across all posts first, so the license gate is
  // decided once, before anything is written.
  const work: Array<{ slug: string; modules: string[] }> = [];
  let totalRefs = 0;
  for (const file of files) {
    const modules = collectFigureSrc(await Bun.file(file).text());
    if (modules.length === 0) continue;
    const slug = file.split(/[\\/]/).pop()!.replace(/\.html$/, "");
    work.push({ slug, modules });
    totalRefs += modules.length;
  }

  if (work.length === 0) {
    console.log("Figure-source export: no `data-figure-src` figures — nothing to emit.");
    return;
  }

  // The promote-to-error that audit-license.ts anticipated: advertising figure
  // source on a PUBLISHED build (SITE_URL set) without a code license would ship
  // those files all-rights-reserved while a twin invites their reuse —
  // contradictory. Fail loudly. Local/preview builds (no SITE_URL) are exempt and
  // just emit headerless source.
  if (published && !license.code) {
    console.error(
      "Figure-source export FAILED: posts declare `data-figure-src` (advertising figure source) " +
        "on a published build (SITE_URL is set) but CODE_LICENSE is unset.\n" +
        "  Set CODE_LICENSE (e.g. `CODE_LICENSE=MIT`) so the emitted source states its reuse terms " +
        "(see methodology → Licensing: content vs code). Builds without SITE_URL are exempt.",
    );
    process.exit(1);
  }

  let wrote = 0;
  for (const { slug, modules } of work) {
    const outDir = join(distPostsDir, slug, "figures");
    for (const mod of modules) {
      const srcTs = join(figuresDir, `${mod}.ts`);
      if (!existsSync(srcTs)) {
        // audit-posts.ts gates this structurally too, but the emitter can't copy
        // a file that isn't there — fail at the source of truth.
        console.error(
          `Figure-source export FAILED: a post references data-figure-src="${mod}" ` +
            `but ${relative(paths.contentRoot, srcTs)} does not exist.`,
        );
        process.exit(1);
      }
      await mkdir(outDir, { recursive: true });
      await Bun.write(join(outDir, `${mod}.ts`), spdxHeader(license.code, "ts") + (await Bun.file(srcTs).text()));
      wrote++;
      const srcCss = join(figuresDir, `${mod}.css`);
      if (existsSync(srcCss)) {
        await Bun.write(join(outDir, `${mod}.css`), spdxHeader(license.code, "css") + (await Bun.file(srcCss).text()));
        wrote++;
      }
    }
    console.log(`  posts/${slug}/figures/ ← ${modules.length} module(s)`);
  }

  console.log(
    `Figure-source export: wrote ${wrote} file(s) for ${totalRefs} figure ref(s) across ${work.length} post(s).`,
  );
}

// CLI only — importing the helpers (tests) must not run the build pass.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
