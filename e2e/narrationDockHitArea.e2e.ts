// Tier-2 e2e: the narration dock's seek bar must not overlap the close × in the
// horizontal layout.
//
// Regression guard for a real hit-area bug. The compact dock reserves a corner
// for the always-visible close × via `padding-right: 44px`, which insets the
// in-flow button row — but the seek bar (`.shk-bar_wrap`) is absolutely
// positioned against `.shk-player`, ignored that padding, and overshot into the
// corner under the ×. Both sit at z-index 1 and the × is appended last, so it
// won the overlap: a click near the bar's right end closed the player instead
// of seeking. The fix insets the bar's right edge by the same 44px so it spans
// exactly the content width and the corner is the ×'s alone. This test pins
// that the bar's hit area never reaches the × in the horizontal layout, and
// that the bar still spans (essentially) the full content width.
//
// Chromium-only — this is CSS geometry, engine-agnostic. Needs a post with
// narration; the content-repo fixture's first post (hello) has a manifest.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Page } from "playwright";
import { firstPostSlug, resolveBlogDir, startBlogServer, type BlogServer } from "./harness.ts";

const CHROME = process.env.PRESIDOCS_E2E_CHROME || "/usr/bin/google-chrome";

let server: BlogServer;
beforeAll(async () => { server = await startBlogServer(); });
afterAll(async () => { await server?.stop(); });

type Rect = { x: number; right: number; y: number; bottom: number; width: number };

async function rectsAt(page: Page, width: number): Promise<{ bar: Rect | null; close: Rect | null; main: Rect | null }> {
  await page.setViewportSize({ width, height: 900 });
  await page.locator("#narrate-player .shk-player").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(400); // let layout settle after the resize
  return page.evaluate(() => {
    const r = (sel: string): Rect | null => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, right: b.right, y: b.y, bottom: b.bottom, width: b.width };
    };
    return {
      bar: r("#narrate-player .shk-bar_wrap"),
      close: r(".narrate-close-btn"),
      main: r("#narrate-player .shk-main"),
    };
  });
}

test("[chromium] the seek bar's hit area never overlaps the close × (horizontal layout)", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const slug = firstPostSlug(resolveBlogDir());
    await page.goto(`${server.baseURL}/posts/${slug}`, { waitUntil: "domcontentloaded", timeout: 15000 });

    // The dock is horizontal at ≥641px (it switches to a vertical column below
    // that, where the bar is in-flow above the controls and never near the ×).
    for (const width of [1400, 760]) {
      const { bar, close, main } = await rectsAt(page, width);
      expect(bar, `bar present @ ${width}`).not.toBeNull();
      expect(close, `close × present @ ${width}`).not.toBeNull();
      expect(main, `main present @ ${width}`).not.toBeNull();

      // The core invariant: the bar's right edge stops at or before the ×'s
      // left edge — no horizontal overlap, so a click on the bar can't land on
      // the ×. (Vertically they share a band, which is exactly why a horizontal
      // gap is the thing that must hold.)
      expect(
        bar!.right,
        `seek bar right (${bar!.right}) must clear the close × left (${close!.x}) @ ${width}`,
      ).toBeLessThanOrEqual(close!.x);

      // And the bar still spans the content width (it shouldn't have been
      // shrunk to a stub to dodge the ×) — its right edge tracks the button
      // row's content box, within a px or two of rounding.
      expect(Math.abs(bar!.right - main!.right), `bar spans content width @ ${width}`).toBeLessThanOrEqual(2);
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);
