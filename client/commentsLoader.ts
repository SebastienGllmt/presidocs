// Comments — lazy loader. This is the module the post's `<script>` loads
// eagerly; it ships almost nothing. The comment system itself (`CommentSystem`
// + the Automerge / sync / DOM modules, ~150 KB) lives in `./comments.ts` and
// is the largest non-reading-critical slice of a post's JS, so this loader
// `import()`s it — emitted as its own chunk — only when the reader first engages
// (pointer / key / selection / scroll), with a `requestIdleCallback` fallback so
// a passive reader still gets existing-comment highlights. The heavy parse/exec
// then happens off the critical FCP/TBT path. (Automerge was already lazy; see
// commentsStore.ts.) The split is guarded by `comments.budget.test.ts`, so the
// heavy graph can't silently get pulled back into this eager loader.
// See methodology.md → Comments ("Loading: a lazy boot").
//
// `comments.ts`'s `init()` re-evaluates the current selection on start, so a
// selection made *before* the load completes (the gesture that triggered it, or
// a test's programmatic Range) still raises the action bar.

// Only commentable pages carry an article root; non-article pages pay nothing.
const ROOT_SELECTOR = "[data-narration-src]";

// All four also surface on `document` (selectionchange ONLY does), so binding
// every trigger there keeps arming + teardown uniform. Capture + passive: we
// only need to observe the first one, never to intercept it.
const TRIGGERS = ["pointerdown", "keydown", "scroll", "selectionchange"] as const;
const LISTENER_OPTS: AddEventListenerOptions = { capture: true, passive: true };

let idleHandle: number | undefined;
let started = false;

function start(): void {
  if (started) return;
  started = true;
  for (const t of TRIGGERS) document.removeEventListener(t, start, LISTENER_OPTS);
  if (idleHandle !== undefined) {
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(idleHandle);
    else clearTimeout(idleHandle);
  }
  void import("./comments.ts").then((m) => m.boot());
}

function arm(): void {
  if (!document.querySelector(ROOT_SELECTOR)) return; // not a commentable page
  for (const t of TRIGGERS) document.addEventListener(t, start, LISTENER_OPTS);
  // Idle fallback so a passive (never-interacting) reader still gets existing
  // highlights — bounded, but long enough not to pre-empt the engagement
  // triggers on a fast load. `requestIdleCallback` where available, else a timer.
  if (typeof requestIdleCallback === "function") {
    idleHandle = requestIdleCallback(start, { timeout: 4000 });
  } else {
    idleHandle = setTimeout(start, 2500) as unknown as number;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", arm);
} else {
  arm();
}
