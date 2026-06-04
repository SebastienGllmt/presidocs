// Service-Worker / PWA tier: registration, app-shell precache, and the
// online → offline navigation fallback (proposal 22 §1 — the highest-value
// real-browser tier, and the reason the harness exists).
//
// This is the tier the fast Bun dev server CANNOT cover: `client/swRegister.ts`
// gates registration on `__BUN_DEV__`, so under plain `bun run dev` the SW never
// registers (dev actively tears down any SW left behind). So this drives the
// **built** worker under `wrangler dev` (`startWranglerServer` = `bun run build`
// + `wrangler dev`), where `dist/sw.js` ships with `__SW_VERSION__` substituted
// and the registration path is live — i.e. exactly what a reader's browser runs.
//
// NOT named `*.e2e.ts` on purpose: like `prodAudioSmoke.ts` it's a heavy tier
// (a full build + wrangler boot), run only via its own script —
// `bun run test:e2e:sw` — never by the default `bun test` or the Chrome
// `test:e2e` lane. `PRESIDOCS_E2E_SKIP_BUILD=1` reuses an existing fresh `dist/`
// for faster local iteration (and to avoid the build's source-rewrite).
//
// Precondition: the harness runs `bun run build`, which rewrites source posts
// (managed <script> tags) + versions.json per normal build behavior — run on an
// ephemeral/CI checkout, or `git checkout` those afterward.
//
// What stays out of scope here (proposal 22 §1, deferred): the cross-deploy
// cache reap (vN → vN+1 needs a second build with a fresh VERSION mid-test) and
// the `cacheFirstRanged` 206 path (covered for the prod Worker by
// `prodAudioSmoke.ts`; the SW's own Range branch awaits a fixture with audio).

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchChrome, startWranglerServer, type BlogServer } from "./harness.ts";

let browser: Browser;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startWranglerServer()]);
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

/**
 * Navigate to `url` and return once the SW *controls* the page. The document
 * that triggers `register()` isn't controlled until the SW claims it, so we wait
 * for `ready` (an active registration), reload once, then wait for a non-null
 * `controller` — after which same-origin navigations run through the SW.
 */
async function loadControlled(ctx: BrowserContext, url: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20_000 });
  return page;
}

test("the Service Worker activates, controls the page, and precaches the app shell", async () => {
  const ctx = await browser.newContext();
  try {
    const page = await loadControlled(ctx, `${server.baseURL}/`);
    const r = await page.evaluate(async () => {
      const names = await caches.keys();
      const staticName = names.find((n) => n.startsWith("static-"));
      const staticCache = staticName ? await caches.open(staticName) : null;
      const has = async (u: string) => (staticCache ? !!(await staticCache.match(u)) : false);
      return {
        controller: !!navigator.serviceWorker.controller,
        names,
        precached: { root: await has("/"), manifest: await has("/manifest.webmanifest"), wasm: await has("/assets/automerge.wasm") },
      };
    });
    // An active SW is in control of the page (network goes through its fetch handler).
    expect(r.controller, "navigator.serviceWorker.controller is non-null").toBe(true);
    // Caches are deploy-versioned (`static-<VERSION>`) — the key the activate reap keys on.
    expect(r.names.some((n) => /^static-\d/.test(n)), `a versioned static cache exists (${JSON.stringify(r.names)})`).toBe(true);
    // The app shell is precached at install: the three PRECACHE_URLS.
    expect(r.precached.root, "/ is precached").toBe(true);
    expect(r.precached.manifest, "/manifest.webmanifest is precached").toBe(true);
    expect(r.precached.wasm, "/assets/automerge.wasm is precached").toBe(true);
  } finally {
    await ctx.close();
  }
}, 120_000);

test("a previously-visited post still loads offline — network-first nav falls back to cache", async () => {
  const ctx = await browser.newContext();
  try {
    const page = await loadControlled(ctx, `${server.baseURL}/`);

    // Visit the post ONLINE first → the SW's network-first handler caches the
    // response into `runtime-<VERSION>`.
    await page.goto(`${server.baseURL}/posts/offer-files`, { waitUntil: "load", timeout: 30_000 });
    const onlineTitle = await page.title();
    expect(onlineTitle.length, "the post loads online with a title").toBeGreaterThan(0);

    // Cut the network, then re-navigate to the SAME post. With no network, a
    // network-first nav can only resolve if the SW serves the cached copy.
    await ctx.setOffline(true);
    const resp = await page.goto(`${server.baseURL}/posts/offer-files`, { waitUntil: "load", timeout: 30_000 });
    expect(resp?.ok(), "the offline navigation resolves (served from the SW cache)").toBe(true);

    const offline = await page.evaluate(() => ({ title: document.title, bodyLen: document.body.innerText.length }));
    expect(offline.title, "the cached post renders its real title while offline").toBe(onlineTitle);
    expect(offline.bodyLen, "the cached post renders its full article body offline").toBeGreaterThan(1000);

    await ctx.setOffline(false);
  } finally {
    await ctx.close();
  }
}, 120_000);
