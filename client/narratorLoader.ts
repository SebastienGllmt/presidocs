// Narrator — lazy loader. This is the module the post's `<script>` loads
// eagerly; it ships almost nothing (just the keybinding table it shares with
// the narrator). The narrator itself (`./narrator.ts`, ~2000 lines) STATICALLY
// imports Shikwasa (`import { Player } from "shikwasa"` + its stylesheet) and is
// the largest non-reading-critical slice of a post's *eager* JS — Shikwasa is
// parsed and compiled on the main thread at module load even though `init()`
// doesn't touch the audio until the reader presses play. So this loader
// `import()`s the narrator — emitted as its own chunk (Bun `splitting: true`) —
// only when the reader engages (a player key / pointer) or the page deep-links
// to a spoken segment, with a `requestIdleCallback` fallback so a passive reader
// still gets the dock mounted (and live-narration figure driving armed). The
// heavy parse/exec then happens off the critical FCP/TBT path. Guarded by
// `narrator.budget.test.ts` so Shikwasa can't silently get pulled back into this
// eager loader. See methodology.md → Narrator ("Loading: a lazy boot").
//
// Cold-start keyboard shortcuts are preserved. The methodology (Audio Player)
// commits to Space/1-9/arrows being armed FROM PAGE LOAD — "how a reader who
// knows the convention starts the talk cold." Deferring the whole narrator
// would break that (the first Space would just trigger the load — and scroll
// the page — instead of playing). So this loader arms the SAME `narratorDom`
// keybinding table eagerly: the first matching key is `preventDefault`-ed,
// captured, and handed to `boot(pendingKey)`, which replays it once the player
// is live. `narratorDom` is light (no Shikwasa/GSAP), so arming it costs nothing
// against the budget.

import {
  KEY_BINDINGS,
  matchesKeyBinding,
  shouldIgnoreKeyboardShortcut,
} from "./narratorDom.ts";
import { cancelIdle, scheduleIdle } from "./idleFallback.ts";

// Only narrated posts carry this marker; an opt-out post (`data-narration="none"`)
// has no `[data-narration-src]`, so it arms nothing and pays nothing here. The
// dock ships `data-hidden` (CSS-hidden, no JS) so an unbooted post paints no box.
const ROOT_SELECTOR = "[data-narration-src]";

// A spoken-segment deep link (`#spoken-<mark>`) means the reader arrived to
// listen / land on a specific line — boot eagerly so the hash-seek fires on
// load. Mirrors narratorDom's `SPOKEN_ID_PREFIX = "spoken-"`.
const SPOKEN_HASH_PREFIX = "#spoken-";

const POINTER_OPTS: AddEventListenerOptions = { capture: true, passive: true };
// Keydown can't be passive: a player key (Space) must `preventDefault` to stop
// the page scrolling while the narrator loads.
const KEY_OPTS: AddEventListenerOptions = { capture: true, passive: false };

let idleHandle: number | undefined;
let started = false;
let pendingKey: KeyboardEvent | undefined;

function onPointer(): void {
  start();
}

// Recognize a player shortcut from page load off the shared table. On the first
// one, swallow it (so Space doesn't scroll), remember it, and start the load;
// the narrator replays it once the player exists.
function onKeydown(e: KeyboardEvent): void {
  if (shouldIgnoreKeyboardShortcut(e.target, e)) return;
  if (!KEY_BINDINGS.some((b) => matchesKeyBinding(b, e))) return;
  e.preventDefault();
  pendingKey = e;
  start();
}

function disarm(): void {
  document.removeEventListener("pointerdown", onPointer, POINTER_OPTS);
  document.removeEventListener("keydown", onKeydown, KEY_OPTS);
  if (idleHandle !== undefined) cancelIdle(idleHandle);
}

function start(): void {
  if (started) return;
  started = true;
  disarm();
  void import("./narrator.ts").then((m) => m.boot(pendingKey));
}

function arm(): void {
  if (!document.querySelector(ROOT_SELECTOR)) return; // not a narrated page
  // Deep link straight to audio ⇒ boot now; the hash-seek can't wait for idle.
  if (location.hash.startsWith(SPOKEN_HASH_PREFIX)) {
    start();
    return;
  }
  document.addEventListener("pointerdown", onPointer, POINTER_OPTS);
  document.addEventListener("keydown", onKeydown, KEY_OPTS);
  // Idle fallback so a passive (never-interacting) reader still gets the dock
  // mounted and live figure-driving armed.
  idleHandle = scheduleIdle(start);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", arm);
} else {
  arm();
}
