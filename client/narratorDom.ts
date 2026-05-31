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
