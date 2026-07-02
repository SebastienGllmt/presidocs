// "Ask this blog" — client enhancement for the engine-injected AI-search block
// (markup from generate/injectAiSearch.ts). It turns the reader's typed question
// into a contextual prompt for an external chat model and hands it off via a
// top-level navigation to Claude or ChatGPT.
//
// Progressive enhancement: the static markup already carries real <a> links to
// each provider's home, so with JS off (or before this runs) the buttons still
// open the chat app — the reader just pastes their own question. Once this runs,
// the two anchors' hrefs are kept in sync with the input on every keystroke, so
// a right-click / middle-click / "open in new tab" all carry the full query.
//
// Why anchors + window.open, never a <form action="https://…">: the destination
// is cross-origin and the engine CSP pins `form-action 'self' …`
// (server/securityHeaders.ts), which blocks a cross-origin form submit. A
// top-level navigation is not governed by `form-action`, so this stays CSP-clean
// (and opens in a new tab, leaving the blog open behind it).

type ProviderId = "claude" | "chatgpt";

// Each provider's deep-link (`?q=` prefilled chat) and its bare home (the
// query-less fallback shown before the reader types). The home URLs match the
// static hrefs in generate/injectAiSearch.ts.
const PROVIDERS: Record<ProviderId, { query: string; home: string }> = {
  claude: { query: "https://claude.ai/new?q=", home: "https://claude.ai/new" },
  chatgpt: { query: "https://chatgpt.com/?q=", home: "https://chatgpt.com/" },
};

// The default provider when the reader presses Enter (the leftmost button).
const DEFAULT_PROVIDER: ProviderId = "claude";

function isProvider(s: string): s is ProviderId {
  return s === "claude" || s === "chatgpt";
}

// Build the prompt handed to the model: an instruction to use THIS blog as the
// source, the blog's URL, and a pointer to its full Markdown index (llms.txt,
// emitted by generate/site-discovery.ts) so the model can fetch and read the
// relevant posts before answering — then the reader's question.
export function buildPrompt(siteBase: string, query: string): string {
  const origin = siteBase.replace(/\/+$/, "");
  return (
    `Use the blog at ${origin} as the primary source to answer my question. ` +
    `A full index of every post, in Markdown, is at ${origin}/llms.txt — follow ` +
    `it to read the relevant posts before answering.\n\n` +
    `My question: ${query}`
  );
}

// The href for a provider button given the current query. Empty query → the
// provider's bare home (no prompt to send yet).
export function buildProviderUrl(provider: string, siteBase: string, query: string): string {
  const p = PROVIDERS[isProvider(provider) ? provider : DEFAULT_PROVIDER];
  const q = query.trim();
  if (!q) return p.home;
  return p.query + encodeURIComponent(buildPrompt(siteBase, q));
}

// Resolve the blog's absolute origin: the build bakes `data-site-url` when
// SITE_URL is set; otherwise fall back to the current origin at runtime.
export function resolveSiteBase(section: Element): string {
  const baked = section.getAttribute("data-site-url");
  if (baked && baked.trim()) return baked.trim().replace(/\/+$/, "");
  return location.origin;
}

export function installAiSearch(section: HTMLElement): void {
  // Idempotent — never wire the same section twice.
  if (section.getAttribute("data-ai-search-ready") === "true") return;

  const input = section.querySelector<HTMLInputElement>(".ai-search-input");
  const anchors = [...section.querySelectorAll<HTMLAnchorElement>(".ai-search-go")];
  const form = section.querySelector<HTMLFormElement>(".ai-search-form");
  if (!input || anchors.length === 0) return;

  const siteBase = resolveSiteBase(section);

  // Keep each provider anchor's href in step with the input so a click (or
  // open-in-new-tab) always carries the current query.
  const sync = (): void => {
    const q = input.value;
    for (const a of anchors) {
      const provider = a.getAttribute("data-provider") ?? DEFAULT_PROVIDER;
      a.href = buildProviderUrl(provider, siteBase, q);
    }
  };
  input.addEventListener("input", sync);
  // Initial pass: handles a value restored from bfcache / autofill.
  sync();

  if (form) {
    form.addEventListener("submit", (e) => {
      // No cross-origin form submit (CSP form-action) — navigate ourselves.
      e.preventDefault();
      const q = input.value.trim();
      if (!q) {
        input.focus();
        return;
      }
      // Enter runs the default (leftmost) provider; the two buttons are the
      // explicit "ask Claude vs ask ChatGPT" choice.
      const first = anchors[0];
      const provider = first?.getAttribute("data-provider") ?? DEFAULT_PROVIDER;
      window.open(buildProviderUrl(provider, siteBase, q), "_blank", "noopener");
    });
  }

  section.setAttribute("data-ai-search-ready", "true");
}

function boot(): void {
  const section = document.querySelector<HTMLElement>(".presidocs-ai-search");
  if (!section) return;
  installAiSearch(section);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
