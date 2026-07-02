// "Ask this blog" — the engine-injected AI-search affordance on the landing.
//
// This is NOT a search index. Instead of crawling the corpus, it hands the
// reader's question to an external chat model (Claude or ChatGPT) together with
// a link to this blog and its full Markdown index (llms.txt), so the model can
// fetch the posts and answer grounded in them. The whole feature is a contextual
// hand-off URL — no server, no index build, no reader-facing search backend.
//
// Why it lives here (build-time injection, like generate/help-page.ts's feature
// chips) rather than in each blog's source index.html: it's ENGINE behaviour
// that every presidocs site should get for free. The companion client module
// (client/aiSearch.ts) progressively enhances the markup — it reads the typed
// query at click time and builds the provider URL from `location.origin`, so the
// static markup degrades to plain "open Claude/ChatGPT" links when JS is off.
//
// Navigation rationale: the provider hand-off is a top-level navigation via
// <a> (and window.open in the client), NOT a cross-origin <form> submit — the
// engine CSP pins `form-action 'self' …` (server/securityHeaders.ts), which
// would BLOCK a `<form action="https://claude.ai/…">`. Anchors / window.open are
// navigations, which `form-action` does not govern, so they're CSP-clean.
//
// Injected by generate/bunHtmlHeadPlugin.ts during the HTML bundle (dev server +
// prod build-html.ts), so the `<script src>` it adds is bundled like the
// landing's other module scripts (verified: Bun bundles a plugin-injected
// <script src> into a hashed chunk). Idempotent via the `presidocs-ai-search`
// marker — a second pass is a no-op.

import { escapeHtmlAttr } from "../shared/htmlEscape.ts";

// Relative to the landing entry (contentRoot/index.html); `engine/` is the
// per-blog symlink to this package, so this resolves to client/aiSearch.ts —
// the same `./engine/client/<mod>.ts` form index.html uses for analytics.ts.
const AI_SEARCH_SCRIPT_SRC = "./engine/client/aiSearch.ts";

export type AiSearchOptions = {
  /**
   * Canonical site origin (no trailing slash), or null when SITE_URL is unset.
   * Baked into `data-site-url` so the client can build an absolute blog link
   * (and `<origin>/llms.txt`) deterministically; when absent the client falls
   * back to `location.origin` at runtime.
   */
  siteUrl?: string | null;
};

// The landing markup. Two real <a> provider links (so the no-JS / pre-hydration
// state still opens the chat app) plus a search <input> the client wires up. The
// <input> sits inside a `role="search"` form; the buttons are anchors, not
// submit buttons, because the destination is cross-origin (see CSP note above).
export function buildAiSearchHtml(opts: AiSearchOptions = {}): string {
  const siteUrl = opts.siteUrl ?? null;
  const dataSiteUrl = siteUrl ? ` data-site-url="${escapeHtmlAttr(siteUrl)}"` : "";
  return (
    `<section class="presidocs-ai-search" aria-labelledby="presidocs-ai-search-title"${dataSiteUrl}>` +
    `<h2 id="presidocs-ai-search-title">Ask this blog</h2>` +
    `<p class="ai-search-blurb">Search by asking an AI. Your question is handed to ` +
    `Claude or ChatGPT with a link to this blog and its full Markdown index, so the ` +
    `answer is grounded in these posts.</p>` +
    `<form class="ai-search-form" role="search">` +
    `<input class="ai-search-input" type="search" name="q" autocomplete="off" ` +
    `enterkeyhint="search" aria-label="Your question about this blog" ` +
    `placeholder="Ask a question…" />` +
    `<span class="ai-search-actions">` +
    `<a class="ai-search-go" data-provider="claude" rel="noopener nofollow" ` +
    `target="_blank" href="https://claude.ai/new">Ask Claude</a>` +
    `<a class="ai-search-go" data-provider="chatgpt" rel="noopener nofollow" ` +
    `target="_blank" href="https://chatgpt.com/">Ask ChatGPT</a>` +
    `</span>` +
    `</form>` +
    `</section>`
  );
}

// Inject the AI-search section into the landing and its client <script> into
// <head>. The section is placed immediately before the first `<ul class="posts">`
// (every landing template has one); with no post list it's appended to the end
// of <main>. Mirrors injectFeatureChips' placement so the two engine-injected
// landing blocks sit together (this one above the chips — see bunHtmlHeadPlugin,
// which injects AI search before the chips). Idempotent.
export function injectAiSearch(landingHtml: string, opts: AiSearchOptions = {}): string {
  if (landingHtml.includes("presidocs-ai-search")) return landingHtml;
  const section = buildAiSearchHtml(opts);
  const script = `<script type="module" src="${AI_SEARCH_SCRIPT_SRC}"></script>`;

  let rw = new HTMLRewriter().on("head", {
    element(el) {
      el.append(script, { html: true });
    },
  });
  if (landingHtml.includes('class="posts"')) {
    rw = rw.on("ul.posts", {
      element(el) {
        el.before(section, { html: true });
      },
    });
  } else {
    rw = rw.on("main", {
      element(el) {
        el.append(section, { html: true });
      },
    });
  }
  return rw.transform(landingHtml);
}
