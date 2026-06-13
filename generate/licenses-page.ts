// Build step: emit the blog's combined license + third-party acknowledgements
// page (proposal 60). We minify-bundle third-party code into the client and
// serve it to every reader; several of those licenses (MIT "in all copies",
// Apache-2.0 §4, and CC-BY's *visible* attribution for the Font Awesome icons)
// require their notice to travel with the distribution. Nothing in the engine
// served those notices before; the minified bundle buries them. This emits:
//
//   dist/licenses.html   A served, human-readable page: the blog's OWN license
//                        (content + code, from licenseConfig + /license), the
//                        self-hosted fonts' OFL, then the bundled dependencies
//                        GROUPED BY LICENSE — MIT and Apache-2.0 hold the bulk,
//                        and any non-standard license (CC-BY for the icons,
//                        GreenSock's custom license for GSAP) lands in its own
//                        group, which is what makes the outliers stand out
//                        without a hand-placed callout (proposal 60, Q4).
//   dist/licenses.txt    The same notices as concatenated raw text, for anyone
//                        auditing compliance programmatically.
//
// Engine-owned, same family as generate/help-page.ts: same SITE_URL gate (a prod
// artifact linking absolute-ish paths), same dist-gather + chrome, same
// fail-silent posture. The WHICH-deps-ship decision is mechanical
// (generate/clientDeps.ts, from the real bundle's metafile); the notice text per
// dep comes from its own LICENSE file (generate/licenseFiles.ts). Both pages are
// per-blog constants — they list dependencies and the blog's own terms, never a
// post — so they're safe to serve on a private blog (carrying the same noindex
// every private page gets; see strip-served-html.ts / the isPrivateBlog branch).

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { isPrivateBlog } from "../shared/blogPrivacy.ts";
import { injectSiteFooterFromEnv } from "../shared/bunFooterPlugin.ts";
import { resolveFeedConfig } from "../shared/feedConfig.ts";
import { injectPwaHead } from "../shared/injectPwaHead.ts";
import { type License, resolveLicenseConfig } from "../shared/licenseConfig.ts";
import {
  ACKNOWLEDGEMENTS_PATH,
  hasOwnLicenseFile,
  OWN_LICENSE_FILENAME,
} from "../shared/servedLicense.ts";
import { deriveShippedClientPackages } from "./clientDeps.ts";
import { readSiteMeta } from "./feeds.ts";
import { escHtml, extractStylesheetLinks } from "./help-page.ts";
import { type DepLicense, resolveDepLicenses } from "./licenseFiles.ts";

const paths = resolveBlogPaths();

/** URL the combined page is served at; the footer "Acknowledgements" link target. */
export const LICENSES_PATH = ACKNOWLEDGEMENTS_PATH;

// HTML double-quoted-attribute escape (escHtml comes from help-page.ts).
function escAttr(s: string): string {
  return escHtml(s).replace(/"/g, "&quot;");
}

// ---- self-hosted fonts (engine constant) ------------------------------------
// The Red Hat Text/Mono woff2 ship from client/fonts and are redistributed under
// the SIL OFL 1.1; copy-static serves the license at /fonts/OFL.txt. They aren't
// an npm dep (so they never appear in the client metafile) — surfaced here by
// hand as the one engine-owned bundled asset that owes a notice.
export type FontNotice = { name: string; license: string; noticeUrl: string };
export const SELF_HOSTED_FONTS: FontNotice = {
  name: "Red Hat Text & Red Hat Mono",
  license: "OFL-1.1",
  noticeUrl: "/fonts/OFL.txt",
};

// Blanket note for the build-tool gray area: a bundler can inline its OWN runtime
// helper snippets into the output (not resolved node_modules modules, so they
// never appear in the client metafile clientDeps.ts reads). This covers them
// without singling any tool out. (There are no polyfill/transpile injectors
// pulling third-party code into the bundle — verified; see proposal 60, Q2.)
export const BUILD_TOOLS_NOTE =
  "Built with other open-source build tools; any build-tool-injected runtime helpers remain under their respective licenses.";

// ---- grouping ---------------------------------------------------------------

export type LicenseGroup = { license: string; deps: DepLicense[] };

// Group deps by their license string. MIT and Apache-2.0 sort first (they hold
// the bulk); every other license follows alphabetically, each in its own group —
// so a non-standard license (CC-BY, GSAP's custom line) is visually isolated.
// Deps within a group sort by name.
export function groupByLicense(deps: DepLicense[]): LicenseGroup[] {
  const byLicense = new Map<string, DepLicense[]>();
  for (const d of deps) {
    const key = d.license || "Unknown";
    let arr = byLicense.get(key);
    if (!arr) {
      arr = [];
      byLicense.set(key, arr);
    }
    arr.push(d);
  }
  const PRIORITY = ["MIT", "Apache-2.0"];
  const rank = (lic: string) => {
    const i = PRIORITY.indexOf(lic);
    return i === -1 ? PRIORITY.length : i;
  };
  return [...byLicense.entries()]
    .map(([license, ds]) => ({
      license,
      deps: ds.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) =>
        rank(a.license) - rank(b.license) || a.license.localeCompare(b.license),
    );
}

// ---- page context -----------------------------------------------------------

export type LicensesContext = {
  siteTitle: string;
  lang: string;
  cssLinks: string;
  private: boolean;
  /** Resolved own content/code licenses (proposal 59), null when unset. */
  ownContent: License | null;
  ownCode: License | null;
  /** True → link the self-hosted full text at /license. */
  ownLicenseServed: boolean;
  /** Raw LICENSE.md text, for the .txt sidecar (null when the blog ships none). */
  ownLicenseText: string | null;
  fonts: FontNotice;
  groups: LicenseGroup[];
};

// ---- HTML page --------------------------------------------------------------

function ownLicenseSectionHtml(ctx: LicensesContext): string {
  const rows: string[] = [];
  const line = (label: string, lic: License | null) =>
    lic
      ? `<li>${escHtml(label)}: <a href="${escAttr(lic.url)}" rel="license">${escHtml(lic.id)}</a></li>`
      : "";
  rows.push(line("Prose, figures & audio", ctx.ownContent));
  rows.push(line("Code samples & figure source", ctx.ownCode));
  const list = rows.filter(Boolean).join("");
  const fullText = ctx.ownLicenseServed
    ? `<p>The full license text is served at <a href="/license" rel="license">/license</a>.</p>`
    : "";
  if (!list && !fullText) {
    return `<p>This blog has not declared its own reuse license.</p>`;
  }
  return (list ? `<ul class="license-own">${list}</ul>` : "") + fullText;
}

function depEntryHtml(d: DepLicense): string {
  const home = d.homepage
    ? ` — <a href="${escAttr(d.homepage)}" rel="noopener">${escHtml(d.homepage)}</a>`
    : "";
  const notice = d.licenseText
    ? `<details><summary>License text</summary><pre class="license-text">${escHtml(d.licenseText)}</pre></details>`
    : "";
  const apacheNotice = d.noticeText
    ? `<details><summary>NOTICE</summary><pre class="license-text">${escHtml(d.noticeText)}</pre></details>`
    : "";
  const supplement = d.supplement
    ? `<p class="license-supplement">${escHtml(d.supplement)}</p>`
    : "";
  return (
    `<li><strong>${escHtml(d.name)}</strong>${d.version ? ` ${escHtml(d.version)}` : ""}${home}` +
    supplement +
    notice +
    apacheNotice +
    `</li>`
  );
}

function groupHtml(g: LicenseGroup): string {
  const items = g.deps.map(depEntryHtml).join("");
  return `<section class="license-group"><h3>${escHtml(g.license)}</h3><ul>${items}</ul></section>`;
}

export function buildLicensesHtml(ctx: LicensesContext): string {
  const title = ctx.siteTitle || "this blog";
  const metaDesc = `The license for ${title} and the open-source notices for the code it bundles.`;
  const groups = ctx.groups.map(groupHtml).join("");
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="${escAttr(ctx.lang || "en")}">\n` +
    `<head>\n` +
    `<meta charset="UTF-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    // Private blogs noindex every page; this page is emitted AFTER the
    // strip-served-html rewrite, so it carries its own meta (same as help.html).
    (ctx.private ? `<meta name="robots" content="noindex" />\n` : "") +
    `<title>Licenses &amp; acknowledgements — ${escHtml(title)}</title>\n` +
    `<meta name="description" content="${escAttr(metaDesc)}" />\n` +
    ctx.cssLinks +
    `\n</head>\n` +
    `<body>\n` +
    `<main class="legal licenses">\n` +
    `<p class="legal-back"><a href="/">&larr; Back to the blog</a></p>\n` +
    `<h1>Licenses &amp; acknowledgements</h1>\n` +
    `<section id="own"><h2>This blog</h2>\n${ownLicenseSectionHtml(ctx)}</section>\n` +
    `<section id="fonts"><h2>Fonts</h2>\n` +
    `<p><strong>${escHtml(ctx.fonts.name)}</strong> — ${escHtml(ctx.fonts.license)} ` +
    `(<a href="${escAttr(ctx.fonts.noticeUrl)}">${escHtml(ctx.fonts.noticeUrl)}</a>), self-hosted and served with the site.</p>\n` +
    `</section>\n` +
    `<section id="third-party"><h2>Built with</h2>\n` +
    `<p>This site bundles the open-source code below and reproduces each project's notice as its license requires.</p>\n` +
    groups +
    `<p class="license-build-tools">${escHtml(BUILD_TOOLS_NOTE)}</p>\n` +
    `</section>\n` +
    `</main>\n` +
    `</body>\n</html>\n`
  );
}

// ---- machine sidecar (raw text) --------------------------------------------

export function buildLicensesTxt(ctx: LicensesContext): string {
  const out: string[] = [];
  const rule = "=".repeat(72);
  out.push(
    `${ctx.siteTitle || "This blog"} — licenses and third-party notices`,
    "",
  );

  out.push(rule, "THIS BLOG'S OWN CONTENT AND CODE", rule, "");
  if (ctx.ownContent)
    out.push(
      `Prose / figures / audio: ${ctx.ownContent.id} (${ctx.ownContent.url})`,
    );
  if (ctx.ownCode)
    out.push(
      `Code samples / figure source: ${ctx.ownCode.id} (${ctx.ownCode.url})`,
    );
  out.push("");
  if (ctx.ownLicenseText) out.push(ctx.ownLicenseText.trimEnd(), "");

  out.push(rule, "FONTS", rule, "");
  out.push(
    `${ctx.fonts.name} — ${ctx.fonts.license} — ${ctx.fonts.noticeUrl}`,
    "",
  );

  out.push(rule, "THIRD-PARTY CODE BUNDLED INTO THIS SITE", rule, "");
  for (const g of ctx.groups) {
    for (const d of g.deps) {
      out.push(`${"-".repeat(72)}`);
      out.push(`${d.name} ${d.version} — ${d.license}`);
      if (d.homepage) out.push(d.homepage);
      out.push("");
      if (d.supplement) out.push(d.supplement, "");
      if (d.licenseText) out.push(d.licenseText.trimEnd(), "");
      if (d.noticeText) out.push("NOTICE:", d.noticeText.trimEnd(), "");
    }
  }
  out.push(`${"-".repeat(72)}`, BUILD_TOOLS_NOTE, "");
  return `${out.join("\n")}\n`;
}

// ---- context assembly -------------------------------------------------------

export async function buildLicensesContext(
  cssLinks: string,
): Promise<LicensesContext> {
  const meta = await readSiteMeta();
  const cfg = resolveFeedConfig();
  const licenses = resolveLicenseConfig();
  const ownLicenseText = await readOwnLicenseText();
  const packages = await deriveShippedClientPackages(paths);
  const deps = resolveDepLicenses(packages, paths.engineRoot);
  return {
    siteTitle: meta.title,
    lang: (cfg.language || "en").split("-")[0] || "en",
    cssLinks,
    private: isPrivateBlog(),
    ownContent: licenses.content,
    ownCode: licenses.code,
    ownLicenseServed: hasOwnLicenseFile(paths.contentRoot),
    ownLicenseText,
    fonts: SELF_HOSTED_FONTS,
    groups: groupByLicense(deps),
  };
}

async function readOwnLicenseText(): Promise<string | null> {
  const p = join(paths.contentRoot, OWN_LICENSE_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

// PWA <head> + footer chrome, so /licenses isn't an outlier among served pages.
// The footer (Home / Help / Privacy / License / Acknowledgements) is composed by
// the same env-derived helper every other served page uses, so all pages render
// the identical footer — including the License + Acknowledgements links this very
// page is the target of.
async function applyChrome(html: string): Promise<string> {
  let out = html;
  const manifestSrc = join(paths.contentRoot, "manifest.webmanifest");
  if (existsSync(manifestSrc)) {
    try {
      const m = (await Bun.file(manifestSrc).json()) as {
        theme_color?: string;
        icons?: { src?: string }[];
      };
      out = injectPwaHead(out, {
        themeColor: m.theme_color,
        appleTouchIcon: m.icons?.[0]?.src,
      });
    } catch {
      // malformed manifest → skip PWA head
    }
  }
  return injectSiteFooterFromEnv(out);
}

/** Render the page on the fly from source, for the dev server (no dist/). */
export async function renderLicensesHtmlFromSource(
  cssLinks: string,
): Promise<string | null> {
  if (!resolveFeedConfig().baseUrl) return null;
  const ctx = await buildLicensesContext(cssLinks);
  return applyChrome(buildLicensesHtml(ctx));
}

async function main(): Promise<void> {
  const cfg = resolveFeedConfig();
  if (!cfg.baseUrl) {
    console.log("Licenses page: no SITE_URL — skipping.");
    return;
  }
  const distDir = paths.distDir;
  if (!existsSync(distDir)) {
    console.warn(
      "  dist/ does not exist — run `bun build` first; skipping licenses page.",
    );
    return;
  }
  const landingPath = join(distDir, "index.html");
  if (!existsSync(landingPath)) {
    console.warn("  dist/index.html missing — skipping licenses page.");
    return;
  }
  const cssLinks = extractStylesheetLinks(await Bun.file(landingPath).text());
  const ctx = await buildLicensesContext(cssLinks);

  const html = await applyChrome(buildLicensesHtml(ctx));
  await writeFile(join(distDir, "licenses.html"), html, "utf8");
  await writeFile(join(distDir, "licenses.txt"), buildLicensesTxt(ctx), "utf8");

  const depCount = ctx.groups.reduce((n, g) => n + g.deps.length, 0);
  console.log(
    `Licenses page: dist/licenses.html + dist/licenses.txt ` +
      `(${depCount} client dep${depCount === 1 ? "" : "s"} in ${ctx.groups.length} license group${ctx.groups.length === 1 ? "" : "s"})`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
