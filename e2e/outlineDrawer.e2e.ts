// Tier-1 e2e for the script-&-outline drawer (client/narrator.ts). The drawer
// is ONE element hosting two panels, so "script and outline can't both be
// open" is a DOM-shape invariant — these tests pin the visible halves of that
// contract: two stacked edge tabs that each open straight to a panel, the
// header panel-switcher swapping in place, outline navigation closing the
// drawer and scrolling the article, and the scroll-spy highlighting the
// current section. None of this is observable under happy-dom (the narrator
// imports Shikwasa, the drawer rides real layout/scroll), so it lives here.
//
// Narration bootstrap: the drawer only builds after a successful manifest
// fetch, and the fixture blog ships without generated audio — `beforeAll`
// runs `generate --mock` (silent audio, no TTS needed) once if the post has
// no manifest on disk.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "bun";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  launchChrome,
  startBlogServer,
  resolveBlogDir,
  firstPostSlug,
  type BlogServer,
} from "./harness.ts";

let browser: Browser;
let context: BrowserContext;
let server: BlogServer;
let slug: string;

beforeAll(async () => {
  const blogDir = resolveBlogDir();
  slug = firstPostSlug(blogDir);
  // Ensure the post has narration so the narrator boots and builds the
  // drawer. Skipped when a manifest already exists (e.g. a prior run's mock,
  // or a real render) to keep the loop fast.
  const genDir = resolve(blogDir, "generated", slug);
  const hasManifest =
    existsSync(genDir) &&
    readdirSync(genDir).some((f) => /^manifest(\..*)?\.json$/.test(f));
  if (!hasManifest) {
    const gen = spawnSync(["bun", "run", "generate", `posts/${slug}.html`, "--mock"], {
      cwd: blogDir,
    });
    if (gen.exitCode !== 0) {
      throw new Error(`generate --mock failed:\n${gen.stderr.toString()}`);
    }
  }
  [browser, server] = await Promise.all([launchChrome(), startBlogServer(blogDir)]);
  context = await browser.newContext();
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop();
}, 60_000);

/** Open the fixture post and wait for the narrator to boot (edge tabs built). */
async function openPostWithDrawer(page: Page): Promise<void> {
  await page.goto(`${server.baseURL}/posts/${slug}`, { waitUntil: "domcontentloaded" });
  // The narrator is lazy (narratorLoader.ts): it boots on first pointer/key
  // or after the idle fallback. A synthetic pointerdown on an empty corner
  // arms it now instead of waiting out requestIdleCallback's 4 s timeout.
  await page.mouse.move(2, 2);
  await page.mouse.down();
  await page.mouse.up();
  await page
    .locator('.narrate-drawer-tab[data-panel-target="outline"]')
    .waitFor({ state: "visible", timeout: 15_000 });
}

test("two edge tabs; the outline tab opens the drawer straight to the outline panel", async () => {
  const page = await context.newPage();
  try {
    await openPostWithDrawer(page);

    const scriptTab = page.locator('.narrate-drawer-tab[data-panel-target="script"]');
    const outlineTab = page.locator('.narrate-drawer-tab[data-panel-target="outline"]');
    expect(await scriptTab.isVisible()).toBe(true);
    expect(await outlineTab.isVisible()).toBe(true);

    await outlineTab.click();
    const drawer = page.locator("#narrate-drawer");
    expect(await drawer.getAttribute("data-open")).toBe("true");
    expect(await drawer.getAttribute("data-panel")).toBe("outline");

    // Outline panel visible, script panel hidden — the panels share the slot.
    await page.locator(".narrate-drawer-outline").waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator(".narrate-drawer-body").isVisible()).toBe(false);

    // Both edge tabs fold away while open (the header switcher takes over).
    expect(await scriptTab.isVisible()).toBe(false);
    expect(await outlineTab.isVisible()).toBe(false);

    // The outline lists the post's h2 sections as links to their ids.
    const links = page.locator(".narrate-drawer-outline .outline-link");
    expect(await links.count()).toBeGreaterThanOrEqual(2);
    const hrefs = await links.evaluateAll((as) =>
      as.map((a) => a.getAttribute("href")),
    );
    expect(hrefs).toContain("#how-heading");
    expect(hrefs).toContain("#features-heading");
  } finally {
    await page.close();
  }
}, 60_000);

test("clicking an outline entry scrolls the article and keeps the drawer open for more browsing", async () => {
  const page = await context.newPage();
  try {
    await openPostWithDrawer(page);
    await page.locator('.narrate-drawer-tab[data-panel-target="outline"]').click();
    await page.locator(".narrate-drawer-outline").waitFor({ state: "visible", timeout: 5_000 });

    await page.locator('.outline-link[href="#features-heading"]').click();

    // Native anchor navigation: hash set, page smooth-scrolled to the heading.
    await page.waitForFunction(() => location.hash === "#features-heading", undefined, {
      timeout: 5_000,
    });
    await page.waitForFunction(
      () => {
        const h = document.getElementById("features-heading");
        if (!h) return false;
        const top = h.getBoundingClientRect().top;
        return top >= -8 && top < window.innerHeight / 2;
      },
      undefined,
      { timeout: 5_000 },
    );
    // The drawer stays open — the outline is a browsing surface — and the
    // scroll-spy follows the jump to light the clicked entry.
    const drawer = page.locator("#narrate-drawer");
    expect(await drawer.getAttribute("data-open")).toBe("true");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".outline-link.outline-active")
          ?.getAttribute("href") === "#features-heading",
      undefined,
      { timeout: 5_000 },
    );
  } finally {
    await page.close();
  }
}, 60_000);

test("the header panel tabs switch in place: outline → script keeps one drawer open", async () => {
  const page = await context.newPage();
  try {
    await openPostWithDrawer(page);
    await page.locator('.narrate-drawer-tab[data-panel-target="outline"]').click();
    await page.locator(".narrate-drawer-outline").waitFor({ state: "visible", timeout: 5_000 });

    const scriptPanelTab = page.getByRole("button", { name: "Spoken script" });
    const outlinePanelTab = page.getByRole("button", { name: "Outline", exact: true });
    expect(await outlinePanelTab.getAttribute("aria-pressed")).toBe("true");
    expect(await scriptPanelTab.getAttribute("aria-pressed")).toBe("false");

    await scriptPanelTab.click();
    const drawer = page.locator("#narrate-drawer");
    expect(await drawer.getAttribute("data-open")).toBe("true"); // still open
    expect(await drawer.getAttribute("data-panel")).toBe("script");
    expect(await scriptPanelTab.getAttribute("aria-pressed")).toBe("true");
    expect(await outlinePanelTab.getAttribute("aria-pressed")).toBe("false");

    // The script body built lazily on the switch and now shows its segments;
    // the outline panel is hidden — never two panels at once.
    await page.locator(".narrate-drawer-body").waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator(".narrate-drawer-outline").isVisible()).toBe(false);
    expect(await page.locator(".spoken-segment").count()).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
}, 60_000);

test("scroll-spy: opening the outline highlights the section the reader is in", async () => {
  const page = await context.newPage();
  try {
    await openPostWithDrawer(page);
    // Land inside the second section, then open the outline.
    await page.evaluate(() => {
      document
        .getElementById("features-heading")
        ?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.locator('.narrate-drawer-tab[data-panel-target="outline"]').click();
    await page.locator(".narrate-drawer-outline").waitFor({ state: "visible", timeout: 5_000 });

    const active = page.locator(".outline-link.outline-active");
    await active.waitFor({ state: "visible", timeout: 5_000 });
    expect(await active.getAttribute("href")).toBe("#features-heading");
    expect(await active.getAttribute("aria-current")).toBe("location");
  } finally {
    await page.close();
  }
}, 60_000);
