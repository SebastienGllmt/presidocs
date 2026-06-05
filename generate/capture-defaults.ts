// The defaults that determine a captured figure's pixels — settle time, clip
// fps, and the capture viewport. In their own dependency-free module so the
// video cache (render-video.ts `figureEnvHash`) can fingerprint them WITHOUT
// importing capture-figures.ts, which transitively pulls in Playwright — the
// whole point of caching is to skip booting a browser when nothing changed.
//
// Single source of truth: capture-figures.ts imports these. A change here must
// invalidate every cached figure capture (it does — it feeds the env hash).
export const CAPTURE_DEFAULTS = {
  settleMs: 1200,
  fps: 30,
  viewportW: 1366,
  viewportH: 1200,
  deviceScaleFactor: 2,
} as const;

// NOTE on fonts: there used to be a `fontFamily` here + a `FIGURE_FONT_PIN_CSS`
// the capture and height gate injected, to dodge headless Chromium resolving the
// figures' `system-ui` to the wide DejaVu fallback. That workaround is gone: the
// blog now self-hosts Red Hat Text / Red Hat Mono (base.css `@font-face` +
// `--font-sans`/`--font-mono`), so figures render the same font for every reader
// AND in headless capture — no pin needed. The capture just waits for
// `document.fonts.ready` so the woff2 is loaded before the first screenshot.
