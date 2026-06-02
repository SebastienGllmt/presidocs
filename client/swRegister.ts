// Service worker registration. Imported once per page from the post HTMLs
// (same shape as analytics.ts / byline.ts / headerLinks.ts).
//
// __BUN_DEV__ is a build-time define plumbed via Bun.build's `define` map
// in generate/build-html.ts:
//   - Bun inner loop (no bundle step): the identifier stays undeclared at
//     runtime, the typeof check yields "undefined", isBunDev resolves true,
//     and the SW never registers — instead dev TEARS DOWN any SW left behind
//     by a prior dev:edge/prod run on this origin (keeping HMR clean and
//     avoiding a wedged-SW localhost; see methodology → Offline / PWA).
//   - dev:edge + prod: `define: { __BUN_DEV__: "false" }` substitutes the
//     identifier to the literal `false` at parse time, the gate folds, and
//     the SW registers as designed.

declare const __BUN_DEV__: boolean | undefined;
const isBunDev = typeof __BUN_DEV__ === "undefined" ? true : __BUN_DEV__;

if (isBunDev) {
  // Dev (`bun --hot`) ships no service worker. But `dev:edge` (a prod-like
  // build) and any production preview register one — and they share this
  // origin (both serve localhost:3000). That SW PERSISTS across runs, so a
  // later `bun run dev` is silently haunted by it: it keeps cache-first-serving
  // `/generated/*` from a stale snapshot (e.g. an old narration manifest,
  // surfacing as a wrong/short audio length) and the dev server never even sees
  // the request. Skipping registration isn't enough — actively tear down any
  // existing registration AND purge its caches so dev is always SW-free. This
  // is the "avoiding a wedged-SW localhost" guarantee the gate was meant to
  // give. No-op when nothing is registered.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {});
  }
  if ("caches" in globalThis) {
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .catch(() => {});
  }
} else if ("serviceWorker" in navigator) {
  // Defer registration until after first paint so the SW install doesn't
  // compete with the article-render critical path on cold load.
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        console.warn("SW registration failed:", err);
      });
  });
}
