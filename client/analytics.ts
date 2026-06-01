// Engagement-analytics beacon. Three events, each a `navigator.sendBeacon`
// POST to `/_a` — fire-and-forget, survives page unload, no response read.
// See methodology.md → "Engagement analytics (Analytics Engine)".
//
// Anonymous by construction: no cookie, no localStorage, no per-session ID,
// no client-side identifier of any kind. The server side reinforces this —
// `server/analyticsRoute.ts` writes only what we send here and never reads
// the request's IP/cookies into any blob.
//
// The page_view side effect runs at module load (guarded against double-fire
// across multiple `<script>` graphs). Posts pick it up via narrator.ts
// importing this module; landing pages add a dedicated `<script type=module>`
// tag pointing at this file.

import type { PlayTrigger, Quartile } from "../shared/analyticsSchema.ts";

const ENDPOINT = "/_a";

// Send a single beacon. Returns `false` if `sendBeacon` rejected the payload
// (queue full / no network) — but every caller treats analytics as best-effort
// so the return is informational, never load-bearing.
function send(payload: object): boolean {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }
  try {
    // `Blob` so the request goes out as `application/json` rather than the
    // default `text/plain` — the route reads JSON, and a plain content-type
    // would force a different parser branch (or be rejected by a stricter
    // future Worker). Same shape several beacon libraries use.
    const body = new Blob([JSON.stringify(payload)], { type: "application/json" });
    return navigator.sendBeacon(ENDPOINT, body);
  } catch {
    return false;
  }
}

// Page view — fired once on page load. The "once" property is enforced via
// a window-scoped flag, NOT a module-level one: this file may be loaded into
// multiple `<script type=module>` graphs on the same page (e.g. a post loads
// narrator.ts which imports analytics.ts, AND also loads comments.ts which
// could import it too). Each graph instantiates its own module, so a
// module-level flag wouldn't dedupe. The window flag works because every
// script on the page shares it.
type PageViewGlobal = { __blogPageViewSent?: boolean };

export function emitPageView(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as PageViewGlobal;
  if (w.__blogPageViewSent) return false;
  w.__blogPageViewSent = true;

  // Only send hostname, not the full referrer URL — a full URL can carry
  // tracking params (utm_*, gclid, etc.) and partial reading context, which
  // is more than we need and more than the privacy posture allows. Failure
  // to parse (`document.referrer` may be empty or a weird scheme) → empty.
  let referrerHost = "";
  try {
    if (document.referrer) {
      referrerHost = new URL(document.referrer).hostname;
    }
  } catch {
    referrerHost = "";
  }
  // Drop a same-origin referrer (intra-blog navigation between posts) — it
  // adds no analytic signal we care about, and would clutter the top-N
  // referrer breakdown with our own hostname.
  if (referrerHost && referrerHost === location.hostname) {
    referrerHost = "";
  }

  return send({
    event: "page_view",
    post: location.pathname,
    referrerHost,
  });
}

export function emitNarrationPlay(
  post: string,
  trigger: PlayTrigger,
  durationMs: number,
): boolean {
  return send({ event: "narration_play", post, trigger, durationMs });
}

export function emitNarrationQuartile(post: string, quartile: Quartile): boolean {
  return send({ event: "narration_quartile", post, quartile });
}

// Module-load side effect: fire the page view as soon as the page is ready.
// Deferred to DOMContentLoaded (or fired immediately if already past it) so
// the beacon doesn't compete with the critical-path resources.
//
// Wrapped in a typeof-check so this file remains importable from tests /
// build-time tooling without an Error reference shortcut.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => emitPageView(), { once: true });
  } else {
    emitPageView();
  }
}
