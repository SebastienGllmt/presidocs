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
// Each bespoke rule mirrors a Lighthouse/axe audit that is purely structural:
//   title              — Lighthouse SEO `document-title`
//   html-lang          — Lighthouse SEO `html-has-lang`
//   meta-description   — Lighthouse SEO `meta-description`
//   landmark-one-main  — axe `landmark-one-main` (the static part)
//   image-alt          — axe `image-alt` (a static <img> with no alt attribute)
//
// On top of those five hand-rolled invariants, this gate also runs an offline
// HTML5 conformance + structural sub-check via `html-validate` (MIT, build-time
// only, zero client JS) over the same served markup — the render-INDEPENDENT
// structural checks axe deliberately drops (its best-practice tag isn't failed)
// and `audit-posts` never had: duplicate `id` (which silently breaks
// `aria-labelledby`/fragment links/`position-anchor`), invalid HTML5 nesting /
// content-model violations, skipped heading levels, non-unique landmarks, and an
// ARIA-validity cluster. It is ONE gate, not two: the html-validate rule set is
// kept DISJOINT from the five bespoke checks above (we don't enable html-validate's
// own title/alt/lang rules), so nothing is double-reported. The rule set is
// curated (not the full `recommended` preset) so it's green on the current served
// markup and fails only real regressions; `aria-label-misuse` is ratcheted to a
// non-failing WARNING (w=0) — exactly as the axe tier ratchets
// `label-content-name-mismatch` — because an authored roleless container carrying
// `aria-label` is ineffective-not-broken (see methodology → WCAG/landmark
// conformance). NB: duplicate-id/well-formedness is HYGIENE (broken id-dependent
// machinery), NOT a WCAG 4.1.1 bar — SC 4.1.1 was obsoleted in WCAG 2.2.

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { HtmlValidate, type ConfigData } from "html-validate";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { isValidFigureSrc } from "../shared/figureSource.ts";

export type AuditViolation = { rule: string; detail: string };

/**
 * The distinct, validated `data-figure-src` module basenames a served post
 * references (proposal 58). HTMLRewriter to stay browser-free like the rest of
 * this gate. Exported for unit tests. The existence check (does `figures/<src>.ts`
 * exist?) needs the filesystem, so it lives in main(), not the pure auditor —
 * this just enumerates the references.
 */
export function figureSrcRefs(html: string): string[] {
  const refs = new Set<string>();
  new HTMLRewriter()
    .on("figure[data-figure-src]", {
      element(el) {
        const src = (el.getAttribute("data-figure-src") ?? "").trim();
        if (src && isValidFigureSrc(src)) refs.add(src);
      },
    })
    .transform(html);
  return [...refs].sort();
}

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

// Curated html-validate rule set for the structural sub-check. Deliberately a
// hand-picked list, NOT `extends: ["html-validate:recommended"]`: the recommended
// preset fights authored prose and vendored (Shikwasa) markup and would fail the
// build on day one. Every rule here is DISJOINT from the five bespoke checks above
// (no title/alt/lang rules) so the same invariant is never reported twice.
//
// `aria-label-misuse` started as a w=0 warning while the one pre-existing finding
// stood (an authored roleless `<div ... aria-label="Chapters">` — the narration
// chapter strip). That markup was fixed (`role="group"` makes the label effective),
// so the rule is now a hard `error` like the rest: any future aria-label on an
// element/role that can't expose it (an ineffective accessible name) blocks the gate.
export const HTML_VALIDATE_CONFIG: ConfigData = {
  root: true,
  rules: {
    "no-dup-id": "error", // duplicate id breaks aria-labelledby / fragment links / position-anchor
    "element-permitted-content": "error", // invalid HTML5 nesting / content model
    "no-implicit-close": "error", // an element implicitly closed by the parser changing the tree
    "heading-level": "error", // no skipped heading levels (document outline)
    "unique-landmark": "error", // same-type landmarks must be distinguishable by name
    "aria-hidden-body": "error",
    "aria-label-misuse": "error", // aria-label on an element/role that can't expose it
    "no-abstract-role": "error",
    "no-redundant-aria-label": "error",
    "no-redundant-role": "error",
  },
};

/**
 * Offline HTML5 structural validation of one served post via html-validate.
 * Returns violations split by severity: html-validate `error`s (severity 2) fail
 * the gate; `warn`s (severity 1) are reported-not-failed (the w=0 ratchet).
 * Exported for unit tests. Pass a shared `HtmlValidate` instance to avoid
 * reconstructing it per file.
 */
export async function validateHtmlStructure(
  html: string,
  filename = "post.html",
  hv: HtmlValidate = new HtmlValidate(HTML_VALIDATE_CONFIG),
): Promise<{ errors: AuditViolation[]; warnings: AuditViolation[] }> {
  const report = await hv.validateString(html, filename);
  const errors: AuditViolation[] = [];
  const warnings: AuditViolation[] = [];
  for (const result of report.results) {
    for (const m of result.messages) {
      const v: AuditViolation = { rule: m.ruleId, detail: `${m.message} (${m.line}:${m.column})` };
      (m.severity === 2 ? errors : warnings).push(v);
    }
  }
  return { errors, warnings };
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

  // One shared validator instance for the structural sub-check, reused per file.
  const hv = new HtmlValidate(HTML_VALIDATE_CONFIG);
  const figuresDir = join(paths.contentRoot, "figures");
  let failed = 0;
  let warnings = 0;
  for (const file of files) {
    const html = await Bun.file(file).text();
    const rel = relative(paths.contentRoot, file);
    // Bespoke SEO/a11y invariants (all hard errors) + the html-validate structural
    // sub-check (errors fail; warnings are reported-not-failed).
    const struct = await validateHtmlStructure(html, rel, hv);
    const errors = [...auditPostHtml(html), ...struct.errors];

    // Figure-source mapping (proposal 58): target-exists-WHEN-PRESENT. An animated
    // figure's `data-figure-src` must resolve to a real module; a figure without
    // the attribute is fine (static SVG, no source) — never warn on absence.
    for (const src of figureSrcRefs(html)) {
      if (!existsSync(join(figuresDir, `${src}.ts`))) {
        errors.push({
          rule: "figure-src",
          detail: `data-figure-src="${src}" but figures/${src}.ts does not exist`,
        });
      }
    }

    if (struct.warnings.length > 0) {
      warnings += struct.warnings.length;
      console.warn(`  ~ ${rel}`);
      for (const { rule, detail } of struct.warnings) console.warn(`      [${rule}] ${detail} (warn)`);
    }
    if (errors.length === 0) continue;
    failed++;
    console.error(`  ✗ ${rel}`);
    for (const { rule, detail } of errors) console.error(`      [${rule}] ${detail}`);
  }

  if (failed > 0) {
    console.error(
      `Post audit FAILED: ${failed}/${files.length} post(s) have accessibility/SEO/structural regressions (see above).`,
    );
    process.exit(1);
  }
  const warnNote = warnings > 0 ? ` (${warnings} non-failing warning(s))` : "";
  console.log(
    `Post audit: ${files.length} post(s) OK — title/lang/meta-description/one-main/img-alt + html-validate structural (dup-id, nesting, heading-level, landmark, ARIA)${warnNote}.`,
  );
}

// CLI only — importing the helpers (tests) must not run the gate.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { postHtmlFiles };
