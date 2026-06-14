// Shared figure-source helpers (methodology → Copy as Markdown, figure source
// pointers). Three small, browser-safe pieces
// that the figure-source feature's separate parts must agree on:
//
//   - the filename-safe token rule for a `data-figure-src` value,
//   - the per-post relative href the Markdown twin emits for it,
//
// One definition so the linker (shared/htmlToMarkdown.ts), the emitter
// (generate/figure-source-export.ts), and the two audits (generate/audit-posts.ts,
// generate/audit-private.ts) never drift on what a valid token is.
//
// Deliberately dependency-free (no linkedom, no DOM): this module is imported by
// `htmlToMarkdown.ts`, which the dev-server route pulls in, so it must stay
// worker-/browser-safe. The HTML *parsing* that finds `<figure data-figure-src>`
// lives in the build-only callers, each in its own idiom (linkedom for the
// emitter, HTMLRewriter for the audit) — never here.

// A `data-figure-src` value is a bare figure-module basename (no extension), e.g.
// `hashAvalanche`, `offerVolume`, `deltasVanish`. It must be a single safe path
// segment: it becomes a filename (`<src>.ts`) and a URL path component, so we
// forbid anything that could traverse (`/`, `.`, `..`) or need escaping. Module
// names are camelCase identifiers in practice; the alphabet is letters/digits
// plus `_`/`-`, and the first char must be alphanumeric.
export const FIGURE_SRC_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** True iff `src` is a safe figure-module token (see FIGURE_SRC_TOKEN_RE). */
export function isValidFigureSrc(src: string): boolean {
  return FIGURE_SRC_TOKEN_RE.test(src);
}

/**
 * The href from a post's twin to a figure's co-located source
 * (`<base>/figures/<src>.ts`). `base` is the post's location — an **absolute**
 * URL (`https://blog/posts/<slug>`) when the site origin is known, so the link is
 * self-contained for a twin pasted as raw text into an LLM; or the bare `<slug>`
 * (a **relative** path resolved against the `.md`'s own URL) as a local/preview
 * fallback. Either form carries the post's slug — and its private `--<token>`
 * capability suffix — so the source inherits the post's gate with no
 * public/private branch. The caller (markdown-export.ts /
 * createDevServer.ts) decides absolute-vs-relative; this just appends the figure
 * path, since the source dir sits one level below the post.
 */
export function figureSourceHref(base: string, src: string): string {
  return `${base}/figures/${src}.ts`;
}

/**
 * The one-line SPDX header stamped atop each emitted/served figure-source file,
 * so the reuse terms travel with the artifact when it's fetched standalone
 * (detached from the twin's `code_license` front-matter). Empty when no code
 * license is set — omission, never a guessed default (the opt-in
 * posture). Shared by the build emitter (`generate/figure-source-export.ts`) and
 * the dev-server route so dev and prod serve byte-identical source. Typed
 * structurally (`{ id } | null`) to keep this module dependency-free.
 */
export function spdxHeader(license: { id: string } | null, kind: "ts" | "css"): string {
  if (!license) return "";
  const line = `SPDX-License-Identifier: ${license.id}`;
  return kind === "css" ? `/* ${line} */\n` : `// ${line}\n`;
}
