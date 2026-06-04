// Mobile tier: behaviour that only appears under real device emulation — a
// touch device with a coarse pointer and no hover, at a phone-width viewport.
//
// The other e2e tiers run a desktop context (1400×900 mouse). A narrow viewport
// alone does NOT reproduce a phone: it keeps a fine pointer and `hover: hover`,
// so `@media (pointer: coarse)` / `(hover: none)` rules and touch-only input go
// untested. This tier uses Playwright's device descriptor (harness MOBILE_DEVICE
// → isMobile + hasTouch + mobile UA) so the blog's mobile-only surfaces — the
// hide-all FAB (hidden ≥1100px) and the tap-to-popover comment cards — run the
// way a reader on a phone actually drives them.
//
// Chromium-only: device emulation (isMobile) is a Chromium feature, which suits
// this Chromium-primary harness. See methodology → Testing layout.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import {
  launchChrome,
  mintSessionCookie,
  newMobileContext,
  resolveBlogDir,
  startBlogServer,
  type BlogServer,
} from "./harness.ts";

let browser: Browser;
let server: BlogServer;
let nonce = 0;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
});
afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

/** Navigate to a path, retrying past the dev server's brief post-routes regen window. */
async function gotoPost(page: Page, path: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await page.goto(`${server.baseURL}${path}`, { waitUntil: "domcontentloaded", timeout: 8000 });
      if (resp && resp.ok()) {
        await page.waitForLoadState("networkidle").catch(() => {});
        return;
      }
    } catch {
      /* retry */
    }
    await page.waitForTimeout(700);
  }
  throw new Error(`could not load ${path}`);
}

/** Follow the first post link from the landing page — blog-agnostic. */
async function gotoFirstPost(page: Page): Promise<void> {
  await gotoPost(page, "/");
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  expect(href, "landing should link to a post").toBeTruthy();
  await gotoPost(page, new URL(href!, server.baseURL).pathname);
}

test("the mobile context emulates a real touch device (coarse pointer, no hover, device-width)", async () => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  try {
    await gotoFirstPost(page);
    const env = await page.evaluate(() => ({
      touch: navigator.maxTouchPoints,
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      width: window.innerWidth,
    }));
    // These are exactly the things a bare narrow viewport can't fake.
    expect(env.touch, "touch points").toBeGreaterThan(0);
    expect(env.coarse, "pointer: coarse").toBe(true);
    expect(env.noHover, "hover: none").toBe(true);
    // The blog ships <meta name="viewport" content="width=device-width">, so a
    // real post lays out at the phone width — below the 1100px mobile cutoff.
    expect(env.width, "device-width layout (< 1100px)").toBeLessThan(1100);
  } finally {
    await ctx.close();
  }
});

test("the hide-all-highlights FAB is mobile-only and toggles on TAP", async () => {
  // Desktop contrast first: the FAB is display:none ≥1100px, so it's not in the
  // accessibility tree at all — proving the emulation, not the test, drives the
  // responsive rule.
  const desktop = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    const dpage = await desktop.newPage();
    await gotoFirstPost(dpage);
    // Let the comment layer mount, then confirm the FAB is absent at desktop width.
    await dpage.locator('[data-narration-src], [role="main"]').first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
    expect(await dpage.getByRole("button", { name: "Toggle comment highlights" }).count()).toBe(0);
  } finally {
    await desktop.close();
  }

  // Mobile: the FAB is exposed and a real touch tap toggles aria-pressed.
  const ctx = await newMobileContext(browser);
  const cookie = await mintSessionCookie(resolveBlogDir(), `mobile-fab-${++nonce}-${server.baseURL.split(":").pop()}`);
  await ctx.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();
  try {
    await gotoFirstPost(page);
    const fab = page.getByRole("button", { name: "Toggle comment highlights" });
    await fab.waitFor({ state: "visible", timeout: 15_000 });
    const before = await fab.getAttribute("aria-pressed");
    expect(before === "true" || before === "false", "aria-pressed is a boolean").toBe(true);
    // A genuine touchscreen tap (hasTouch), not a mouse click. `force` because
    // Playwright's actionability hit-test mis-resolves the tap point on this
    // small (44px) position:fixed target under the device's 2.75 scale factor —
    // the element is already asserted visible + in the a11y tree above, and a
    // real 44px touch target is tappable; force sends the touch at its center.
    await fab.tap({ force: true });
    const after = await fab.getAttribute("aria-pressed");
    expect(after === "true" || after === "false").toBe(true);
    expect(after, "a tap flips the pressed state").not.toBe(before);
  } finally {
    await ctx.close();
  }
}, 60_000);
