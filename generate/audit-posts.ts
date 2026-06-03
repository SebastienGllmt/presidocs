// Build-time accessibility/SEO gate (Tier A). Runs over the FINAL served HTML
// in `dist/posts/` — after strip-served-html.ts has injected the structured
// data, the <meta name="description">, and the role="main" landmark — and
// fails the build if any post regresses on a *render-independent* invariant.
//
// Scope is deliberate: these are the checks that can be evaluated from the
// built markup alone, with no browser and no JS execution. The complementary
// *rendered* checks (colour contrast, the JS-generated ARIA of interactive
// figures, Label-in-Name) live in the axe-core e2e tier — see methodology.md →
// "WCAG, accessible-name, and landmark conformance" and proposal 29/30. Keeping
// this tier browser-free is what lets it run on every `bun run build` as a hard
// publish gate without a Chrome dependency.
//
// Each rule mirrors a Lighthouse/axe audit that is purely structural:
//   title              — Lighthouse SEO `document-title`
//   html-lang          — Lighthouse SEO `html-has-lang`
//   meta-description   — Lighthouse SEO `meta-description`
//   landmark-one-main  — axe `landmark-one-main` (the static part)
//   image-alt          — axe `image-alt` (a static <img> with no alt attribute)

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";

export type AuditViolation = { rule: string; detail: string };

// Pure, browser-free audit of one served post's HTML. Returns one violation per
// failed invariant (empty array = clean). Exported for unit tests.
export function auditPostHtml(html: string): AuditViolation[] {
  let title = "";
  let inTitle = false;
  let lang = "";
  let metaDescription: string | null = null;
  // Count main landmarks without double-counting a <main role="main">:
  // distinct = <main> + [role=main] − main[role=main].
  let mainEls = 0;
  let roleMainEls = 0;
  let bothEls = 0;
  let imgNoAlt = 0;

  new HTMLRewriter()
    .on("html", {
      element(el) {
        lang = el.getAttribute("lang") ?? "";
      },
    })
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        metaDescription = el.getAttribute("content") ?? "";
      },
    })
    .on("main", { element() { mainEls++; } })
    .on('[role="main"]', { element() { roleMainEls++; } })
    .on('main[role="main"]', { element() { bothEls++; } })
    .on("img", {
      element(el) {
        // A present-but-empty alt="" is valid (decorative); only a missing
        // attribute is a violation. Test presence, not value — HTMLRewriter's
        // getAttribute returns null for alt="" too, so hasAttribute is the
        // correct discriminator.
        if (!el.hasAttribute("alt")) imgNoAlt++;
      },
    })
    .transform(html);

  const v: AuditViolation[] = [];
  if (!title.trim()) v.push({ rule: "title", detail: "<title> is missing or empty" });
  if (!lang.trim()) v.push({ rule: "html-lang", detail: "<html> has no lang attribute" });
  if (metaDescription === null || !String(metaDescription).trim()) {
    v.push({ rule: "meta-description", detail: '<meta name="description"> is missing or empty' });
  }
  const mainCount = mainEls + roleMainEls - bothEls;
  if (mainCount !== 1) {
    v.push({
      rule: "landmark-one-main",
      detail: `expected exactly one main landmark (<main> or role="main"), found ${mainCount}`,
    });
  }
  if (imgNoAlt > 0) {
    v.push({ rule: "image-alt", detail: `${imgNoAlt} <img> element(s) missing an alt attribute` });
  }
  return v;
}

async function postHtmlFiles(postsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(postsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".html"))
    .map((e) => join(postsDir, e.name))
    .sort();
}

async function main(): Promise<void> {
  const paths = resolveBlogPaths();
  const postsDir = join(paths.distDir, "posts");
  const files = await postHtmlFiles(postsDir);
  if (files.length === 0) {
    console.warn(
      `Post audit: no built posts under ${relative(paths.contentRoot, postsDir)} — did \`bun run build\` run the earlier steps?`,
    );
    return;
  }

  let failed = 0;
  for (const file of files) {
    const html = await Bun.file(file).text();
    const violations = auditPostHtml(html);
    const rel = relative(paths.contentRoot, file);
    if (violations.length === 0) continue;
    failed++;
    console.error(`  ✗ ${rel}`);
    for (const { rule, detail } of violations) console.error(`      [${rule}] ${detail}`);
  }

  if (failed > 0) {
    console.error(
      `Post audit FAILED: ${failed}/${files.length} post(s) have accessibility/SEO regressions (see above).`,
    );
    process.exit(1);
  }
  console.log(`Post audit: ${files.length} post(s) OK (title, lang, meta-description, one-main, img-alt).`);
}

// CLI only — importing the helpers (tests) must not run the gate.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { postHtmlFiles };
