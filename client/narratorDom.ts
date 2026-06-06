// Narrator helpers extracted from narrator.ts so they can be unit-tested
// without standing up a Shikwasa Player or pulling in the player's CSS.
//
// Three categories of helper live here:
//
//   1. DOM-bound but pure-of-Shikwasa — `firstMarkAfter` (divider-speaker
//      "first below" resolver). Needs a real document but no audio.
//   2. Pure logic that the production code wraps around DOM side-effects
//      — `parseSpokenHash`, `loadCaptureControls`, `saveCaptureControls`,
//      `topLevelChapterByNumber`, `shouldIgnoreKeyboardShortcut`. These
//      were inline in narrator.ts; lifting them lets the tests pin the
//      edge cases (empty hash, no chapters, focus in <textarea>, etc.)
//      without the rest of narrator.ts evaluating.
//   3. The `SPOKEN_ID_PREFIX` constant the drawer + applyHashIfMatching
//      both agree on. Imported by narrator.ts so the two paths can't
//      drift.
//
// Nothing here imports Shikwasa or the player CSS. That's the property
// that keeps the test file fast and free of CSS-loader surprises.

import type { Milliseconds } from "../shared/time.ts";

// Stable ID prefix for spoken segments inside the drawer. Kept separate
// from the article's element ids (which marks already reference by name)
// so `#title` lands on the article and `#spoken-title` lands on the drawer.
export const SPOKEN_ID_PREFIX = "spoken-";

export const spokenSegmentId = (markName: string): string =>
  SPOKEN_ID_PREFIX + markName;

// Read back the mark name from a `#spoken-foo` URL fragment, or null for
// anything else (plain article anchors, empty hash, malformed). Pure: no
// document lookup, no side effects — applyHashIfMatching does the seek.
export function parseSpokenHash(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  // `decodeURIComponent` can throw on a malformed `%xx`; treat that as
  // "not our hash" rather than crashing the rAF tick.
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  if (!id.startsWith(SPOKEN_ID_PREFIX)) return null;
  return id.slice(SPOKEN_ID_PREFIX.length);
}

// Structural mark shape. Same fields as narrator.ts's ManifestMark; the
// helpers here only need `name` and `time`.
export type MarkRef = {
  readonly name: string;
  readonly time: Milliseconds;
};

// Structural chapter shape (subset). The keyboard 1-9 mapper only reads
// `parentId` — present on level-2 sub-chapters, absent on top-level.
export type ChapterRef = {
  readonly id: string;
  readonly parentId?: string | undefined;
};

/**
 * Earliest mark whose article element is the divider itself or follows it
 * in document order. Drives the labeled-divider speaker button.
 *
 * "First below" deliberately means "first by *document position*", not
 * "first by *time*" — narration is non-linear, so a chapter sitting later
 * in the audio can still anchor to a divider higher in the prose, and the
 * speaker has to play *that* mark even though a numerically earlier one
 * sits below in time order. The manifest's `marks[]` is already time-
 * ordered, so we walk it once and keep the first match — that match is the
 * earliest spoken touch of anything at-or-after the divider.
 */
export function firstMarkAfter<M extends MarkRef>(
  divider: Element,
  marks: readonly M[],
  root: ParentNode,
): M | null {
  for (const m of marks) {
    const el = root.querySelector(`#${CSS.escape(m.name)}`);
    if (!el) continue;
    if (
      el === divider ||
      divider.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      return m;
    }
  }
  return null;
}

// Minimal Storage shape we read/write from. Anything supporting
// `getItem(key) → string | null` and `setItem(key, value)` works — happy-
// dom's localStorage, our in-memory shim, or a Map-backed test stub.
export type CaptureStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const CAPTURE_KEY = "narrate-capture-controls";

/**
 * Read the persisted media-key-capture pref, defaulting to ON when absent
 * or unreadable. The "absent ⇒ ON, "off" ⇒ OFF" rule is part of the
 * methodology contract (Audio Player § headset-glyph toggle), so the
 * default is asymmetric on purpose.
 *
 * Throws are swallowed and treated as "default ON" — private-mode Safari
 * and a few enterprise lockdown profiles refuse storage entirely.
 */
export function loadCaptureControls(storage?: CaptureStorage | null): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(CAPTURE_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Persist the media-key-capture pref. ON is encoded as *removal of the
 * key*, not as an explicit value — keeps the storage clean for the
 * majority case (where the pref never changed from the default).
 */
export function saveCaptureControls(
  storage: CaptureStorage,
  value: boolean,
): void {
  try {
    if (value) {
      // Removal API isn't on `CaptureStorage` to keep the type tight;
      // duck-typed call so production Storage's `removeItem` is used
      // when present, falling back to setting `""` as a sentinel.
      const removeItem = (storage as { removeItem?: (k: string) => void })
        .removeItem;
      if (typeof removeItem === "function") removeItem.call(storage, CAPTURE_KEY);
      else storage.setItem(CAPTURE_KEY, "");
    } else {
      storage.setItem(CAPTURE_KEY, "off");
    }
  } catch {
    // Storage refused; the pref is a UI nicety so we drop it silently.
  }
}

// ---- Keyboard shortcuts (single source of truth) ---------------------------
//
// The narrator binds a handful of page-global shortcuts (narrator.ts
// `setupKeyboardShortcuts`). This table is the ONE place they're declared: the
// player's keydown handler dispatches off it, and the build-time help page
// (generate/help-page.ts) renders the same `label`/`description` pairs into its
// shortcuts table. Adding a binding here updates both the behavior and its
// documentation, so the two can't drift. Importable from a Bun build step —
// nothing in this file touches the DOM at module load.

export type KeyMatch =
  // matches `KeyboardEvent.code` (used for Space, which has a non-printing key)
  | { readonly kind: "code"; readonly code: string }
  // matches `KeyboardEvent.key` (ArrowLeft / ArrowRight)
  | { readonly kind: "key"; readonly key: string }
  // any of "1".."9" — the handler still resolves the actual chapter via
  // topLevelChapterByNumber, which may decline if there's no Nth chapter
  | { readonly kind: "digit" };

export type KeyBindingId =
  | "play-pause"
  | "skip-back"
  | "skip-forward"
  | "jump-chapter";

export type KeyBinding = {
  /** Stable id the handler switches on to run the side-effect. */
  readonly id: KeyBindingId;
  /** Key chip(s) for the help table (display form). */
  readonly label: string;
  /** One-line description for the help table. */
  readonly description: string;
  /** How the keydown handler recognizes this binding. */
  readonly match: KeyMatch;
};

// Order matters: the handler runs the FIRST binding that matches and stops.
// Space / arrows / digits don't overlap, so order is for readability — but
// keeping it stable also keeps the rendered help table stable.
export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "play-pause",
    label: "Space",
    description: "Play or pause the narration",
    match: { kind: "code", code: "Space" },
  },
  {
    id: "skip-back",
    label: "←",
    description: "Skip back 10 seconds",
    match: { kind: "key", key: "ArrowLeft" },
  },
  {
    id: "skip-forward",
    label: "→",
    description: "Skip forward 10 seconds",
    match: { kind: "key", key: "ArrowRight" },
  },
  {
    id: "jump-chapter",
    label: "1–9",
    description: "Jump to the 1st through 9th chapter",
    match: { kind: "digit" },
  },
];

/**
 * Does this keydown event match a binding's key rule? Pure — takes only the two
 * fields it reads, so both the production `KeyboardEvent` and a test stub work.
 * The `digit` rule checks only the 1-9 SHAPE; whether an Nth chapter exists is
 * the handler's call (via {@link topLevelChapterByNumber}).
 */
export function matchesKeyBinding(
  b: KeyBinding,
  e: { readonly code: string; readonly key: string },
): boolean {
  switch (b.match.kind) {
    case "code":
      return e.code === b.match.code;
    case "key":
      return e.key === b.match.key;
    case "digit":
      return e.key.length === 1 && e.key >= "1" && e.key <= "9";
  }
}

/**
 * Resolve a "1"-"9" keypress to the top-level chapter at that 1-based
 * index, or `null` if there isn't one. Top-level = no `parentId`.
 *
 * Posts with >9 top-level chapters truncate at 9 — methodology calls this
 * out as "coarser but strictly more complete than indexing the flat leaf
 * list."
 */
export function topLevelChapterByNumber<C extends ChapterRef>(
  chapters: readonly C[],
  key: string,
): C | null {
  if (key.length !== 1 || key < "1" || key > "9") return null;
  let count = 0;
  for (const c of chapters) {
    if (c.parentId !== undefined) continue;
    count++;
    if (count === Number(key)) return c;
  }
  return null;
}

/**
 * `true` when a keyboard event should bypass the global narrator
 * shortcut handlers — modifier held, OR focus is in a typing surface.
 *
 * Modifier guard is symmetric: Cmd, Ctrl, Alt all block. `Shift+Space`
 * is allowed through because some browsers map it to "scroll up" only
 * when no handler claims Space, and the player's whole reason for
 * binding Space is to *be* the claimant for an engaged reader.
 */
export function shouldIgnoreKeyboardShortcut(
  target: EventTarget | null,
  modifiers: { metaKey: boolean; ctrlKey: boolean; altKey: boolean },
): boolean {
  if (modifiers.metaKey || modifiers.ctrlKey || modifiers.altKey) return true;
  if (!target || !(target instanceof Element)) return false;
  const el = target as HTMLElement;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Drawer lazy-build contract (narrator ↔ comments)
// ---------------------------------------------------------------------------
// The spoken-script drawer's BODY (per-chapter sections + per-segment
// `<article id="spoken-…">` + per-word `<span class="spoken-word">`) is the
// bulk of the narrator's DOM — thousands of nodes on an aligned post. The
// narrator builds only the drawer SHELL (the `<aside>` + tab handle) eagerly
// and defers the body, populating it on demand: when the reader opens the
// drawer, on a `#spoken-…` deep link, or when the comment system asks for it.
//
// The comment system needs the body only when LOGGED IN (a logged-out reader
// sees no comments and can't create any — the common case, and the case
// Lighthouse measures — so the body never builds for them until they open the
// script). These three strings are the cross-module handshake. The narrator
// can't cheaply tell logged-in from out (the session cookie is HttpOnly), so it
// never tries: it defers by default and the comment system — which already
// resolves identity — is the only thing that requests the body. Both modules
// boot lazily in an unknown order, so the handshake is order-independent: the
// requester sets the ATTR (read by the narrator if it boots later) AND fires the
// REQUEST event (caught if the narrator booted already); the narrator fires the
// READY event when the body exists (awaited by a requester that ran first).

// Sentinel on <html> a requester sets so a not-yet-booted narrator builds the
// body as soon as it boots, instead of deferring it.
export const DRAWER_BODY_WANTED_ATTR = "data-narrate-drawer-wanted";
// Fired at `document` to ask an already-booted narrator to build the body now.
export const REQUEST_DRAWER_BODY_EVENT = "narrate:request-drawer-body";
// Fired at `document` once the body exists; the drawer also gets
// `[data-body-ready]` so a late listener can detect the built state directly.
export const DRAWER_BODY_READY_EVENT = "narrate:drawer-body-ready";
