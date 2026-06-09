// happy-dom coverage of the AI-search client: prompt construction, provider-URL
// building (empty → home, non-empty → encoded deep link), live href sync on
// input, Enter → default provider via window.open, and idempotent install.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { buildAiSearchHtml } from "../shared/injectAiSearch.ts";
import {
  buildProviderUrl,
  buildPrompt,
  installAiSearch,
  resolveSiteBase,
} from "./aiSearch.ts";

const SITE = "https://blog.example.com";

function mount(siteUrl: string | null = SITE): HTMLElement {
  document.body.innerHTML = buildAiSearchHtml({ siteUrl });
  return document.querySelector<HTMLElement>(".presidocs-ai-search")!;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

test("buildPrompt: instructs to use the blog, points at llms.txt, carries the query", () => {
  const p = buildPrompt("https://blog.example.com/", "How do offer files work?");
  expect(p).toContain("https://blog.example.com"); // trailing slash trimmed
  expect(p).not.toContain("blog.example.com//"); // no double slash before llms.txt
  expect(p).toContain("https://blog.example.com/llms.txt");
  expect(p).toContain("How do offer files work?");
});

test("buildProviderUrl: empty query → provider home; whitespace counts as empty", () => {
  expect(buildProviderUrl("claude", SITE, "")).toBe("https://claude.ai/new");
  expect(buildProviderUrl("chatgpt", SITE, "   ")).toBe("https://chatgpt.com/");
});

test("buildProviderUrl: non-empty query → encoded deep link for the chosen provider", () => {
  const url = buildProviderUrl("chatgpt", SITE, "what is zswap?");
  expect(url.startsWith("https://chatgpt.com/?q=")).toBe(true);
  const q = decodeURIComponent(url.slice("https://chatgpt.com/?q=".length));
  expect(q).toContain("what is zswap?");
  expect(q).toContain(`${SITE}/llms.txt`);
});

test("buildProviderUrl: unknown provider falls back to Claude", () => {
  const url = buildProviderUrl("bing", SITE, "hi");
  expect(url.startsWith("https://claude.ai/new?q=")).toBe(true);
});

test("resolveSiteBase: prefers data-site-url, falls back to location.origin", () => {
  const withBaked = mount(SITE);
  expect(resolveSiteBase(withBaked)).toBe(SITE);
  const noBaked = mount(null);
  expect(resolveSiteBase(noBaked)).toBe(location.origin);
});

test("installAiSearch: typing syncs BOTH provider anchors' hrefs with the query", () => {
  const section = mount(SITE);
  installAiSearch(section);
  const input = section.querySelector<HTMLInputElement>(".ai-search-input")!;
  const [claude, chatgpt] = [
    ...section.querySelectorAll<HTMLAnchorElement>(".ai-search-go"),
  ];

  // Before typing: bare provider homes.
  expect(claude!.getAttribute("href")).toBe("https://claude.ai/new");
  expect(chatgpt!.getAttribute("href")).toBe("https://chatgpt.com/");

  input.value = "explain commitments";
  input.dispatchEvent(new Event("input"));

  expect(claude!.href.startsWith("https://claude.ai/new?q=")).toBe(true);
  expect(chatgpt!.href.startsWith("https://chatgpt.com/?q=")).toBe(true);
  expect(decodeURIComponent(claude!.href)).toContain("explain commitments");
});

test("installAiSearch: Enter (form submit) opens the default provider (Claude)", () => {
  const section = mount(SITE);
  installAiSearch(section);
  const input = section.querySelector<HTMLInputElement>(".ai-search-input")!;
  const form = section.querySelector<HTMLFormElement>(".ai-search-form")!;

  const opened: string[] = [];
  (window as unknown as { open: (u: string) => null }).open = (u: string) => {
    opened.push(u);
    return null;
  };

  input.value = "what is a nullifier?";
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

  expect(opened.length).toBe(1);
  expect(opened[0]!.startsWith("https://claude.ai/new?q=")).toBe(true);
  expect(decodeURIComponent(opened[0]!)).toContain("what is a nullifier?");
});

test("installAiSearch: empty submit does not navigate", () => {
  const section = mount(SITE);
  installAiSearch(section);
  const form = section.querySelector<HTMLFormElement>(".ai-search-form")!;
  let opened = 0;
  (window as unknown as { open: (u: string) => null }).open = () => {
    opened++;
    return null;
  };
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  expect(opened).toBe(0);
});

test("installAiSearch: idempotent — marks the section ready and skips re-install", () => {
  const section = mount(SITE);
  installAiSearch(section);
  expect(section.getAttribute("data-ai-search-ready")).toBe("true");
  // Second call returns immediately (no throw, still exactly one ready marker).
  installAiSearch(section);
  expect(section.getAttribute("data-ai-search-ready")).toBe("true");
});

test("the input carries an accessible name", () => {
  const section = mount(SITE);
  const input = section.querySelector<HTMLInputElement>(".ai-search-input")!;
  expect(input.getAttribute("aria-label")).toBe("Your question about this blog");
});
