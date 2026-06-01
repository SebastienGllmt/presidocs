// Service worker registration. Imported once per page from the post HTMLs
// (same shape as analytics.ts / byline.ts / headerLinks.ts).
//
// __BUN_DEV__ is a build-time define plumbed via Bun.build's `define` map
// in generate/build-html.ts:
//   - Bun inner loop (no bundle step): the identifier stays undeclared at
//     runtime, the typeof check yields "undefined", isBunDev resolves true,
//     and the SW never registers — keeping HMR clean and avoiding a wedged-SW
//     localhost (see methodology → Offline / PWA).
//   - dev:edge + prod: `define: { __BUN_DEV__: "false" }` substitutes the
//     identifier to the literal `false` at parse time, the gate folds, and
//     the SW registers as designed.

declare const __BUN_DEV__: boolean | undefined;
const isBunDev = typeof __BUN_DEV__ === "undefined" ? true : __BUN_DEV__;

if (!isBunDev && "serviceWorker" in navigator) {
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
