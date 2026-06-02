// Tier 1.1 — happy-dom coverage of the narrator helpers that don't live
// inside the Shikwasa wrapper. The Player itself isn't testable without a
// real browser (no `<audio>` decoding under happy-dom — see methodology →
// Testing layout),
// but the math + DOM-resolution pieces around it absolutely are, and most
// historic narrator regressions have lived in those pieces.
//
// Why a separate file from headerLinks.test.ts: keeping one test file per
// module makes it easy to delete a test along with its production module
// during a refactor. The harness is identical (per-file `import` of
// happydom).

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { asMs } from "../shared/time.ts";
import {
  firstMarkAfter,
  loadCaptureControls,
  parseSpokenHash,
  saveCaptureControls,
  shouldIgnoreKeyboardShortcut,
  SPOKEN_ID_PREFIX,
  spokenSegmentId,
  topLevelChapterByNumber,
  KEY_BINDINGS,
  matchesKeyBinding,
  type KeyBinding,
} from "./narratorDom.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

// ---- parseSpokenHash --------------------------------------------------

test("parseSpokenHash extracts mark name from #spoken-<name>", () => {
  expect(parseSpokenHash("#spoken-intro")).toBe("intro");
  expect(parseSpokenHash("#spoken-problem-statement")).toBe(
    "problem-statement",
  );
});

test("parseSpokenHash returns null for empty / short / plain anchor", () => {
  expect(parseSpokenHash("")).toBeNull();
  expect(parseSpokenHash("#")).toBeNull();
  // Plain `#anchor` (no spoken- prefix) belongs to the browser, not us;
  // narrator must NOT swallow it.
  expect(parseSpokenHash("#problem-statement")).toBeNull();
});

test("parseSpokenHash handles percent-encoding (round-trip)", () => {
  // The drawer-link writer in narrator.ts uses location.hash = "spoken-" + name
  // unencoded, but a copy-pasted URL can arrive percent-encoded — and a
  // mark name with a `:` (theoretically legal) needs decoding to match.
  expect(parseSpokenHash("#spoken-foo%3Abar")).toBe("foo:bar");
});

test("parseSpokenHash treats malformed percent-encoding as 'not our hash'", () => {
  // `%XY` raises URIError under decodeURIComponent — we swallow and bail
  // rather than crashing the rAF tick.
  expect(parseSpokenHash("#spoken-%XY")).toBeNull();
});

test("SPOKEN_ID_PREFIX + spokenSegmentId stay in sync", () => {
  // Both pieces drive the deep-link contract — if the prefix ever drifts,
  // the segmentEls keys won't match the parsed hash and applyHash silently
  // no-ops. Lock them together.
  expect(spokenSegmentId("foo")).toBe(`${SPOKEN_ID_PREFIX}foo`);
  expect(parseSpokenHash("#" + spokenSegmentId("foo"))).toBe("foo");
});

// ---- firstMarkAfter (divider-speaker "first below" resolver) ----------

test("firstMarkAfter — returns the first mark whose element follows the divider in DOM order", () => {
  document.body.innerHTML = `
    <article>
      <p id="lede">lede paragraph</p>
      <div class="section-divider-labeled" id="part-one">Part One</div>
      <h2 id="problem">Problem</h2>
      <p id="body-1">first body</p>
    </article>
  `;
  const divider = document.getElementById("part-one")!;
  const root = document.querySelector("article")!;
  const marks = [
    { name: "lede", time: asMs(0) },
    { name: "problem", time: asMs(3_000) },
    { name: "body-1", time: asMs(8_000) },
  ];
  const m = firstMarkAfter(divider, marks, root);
  // "problem" sits AFTER the divider in DOM order, even though "lede" has
  // a smaller `time` — divider speakers route by DOM position, not time.
  expect(m?.name).toBe("problem");
});

test("firstMarkAfter — returns a mark targeting the divider itself when present", () => {
  document.body.innerHTML = `
    <article>
      <div class="section-divider-labeled" id="part-one">Part One</div>
      <h2 id="problem">Problem</h2>
    </article>
  `;
  const divider = document.getElementById("part-one")!;
  const root = document.querySelector("article")!;
  const marks = [
    // Section-intro chapter anchors its first mark ON the divider.
    { name: "part-one", time: asMs(3_000) },
    { name: "problem", time: asMs(8_000) },
  ];
  const m = firstMarkAfter(divider, marks, root);
  // "at or after" — the section-intro is the right thing to play when the
  // divider speaker is clicked. NOT "strictly after" (which would skip the
  // intro and start with the first content section).
  expect(m?.name).toBe("part-one");
});

test("firstMarkAfter — null when no mark is at or below the divider", () => {
  document.body.innerHTML = `
    <article>
      <h2 id="problem">Problem</h2>
      <div class="section-divider-labeled" id="trailer">Trailer</div>
    </article>
  `;
  const divider = document.getElementById("trailer")!;
  const root = document.querySelector("article")!;
  const marks = [{ name: "problem", time: asMs(3_000) }];
  expect(firstMarkAfter(divider, marks, root)).toBeNull();
});

test("firstMarkAfter — skips marks whose article element doesn't exist (no crash)", () => {
  document.body.innerHTML = `
    <article>
      <div class="section-divider-labeled" id="part-one">Part One</div>
      <h2 id="problem">Problem</h2>
    </article>
  `;
  const divider = document.getElementById("part-one")!;
  const root = document.querySelector("article")!;
  const marks = [
    { name: "ghost-id-not-in-article", time: asMs(1_000) },
    { name: "problem", time: asMs(5_000) },
  ];
  // The ghost mark is skipped (the methodology calls this out as the
  // "fallback to stacking at the page bottom" case for comments, but for
  // divider speakers it just means "keep looking").
  expect(firstMarkAfter(divider, marks, root)?.name).toBe("problem");
});

test("firstMarkAfter — handles CSS-special characters in mark names via CSS.escape", () => {
  // Mark names CAN contain characters that need escaping in a CSS
  // selector (a colon is the realistic case — comments.ts uses
  // `article:__b-7` for synthesized block ids). We use CSS.escape so it
  // doesn't blow up.
  document.body.innerHTML = `
    <article>
      <div class="section-divider-labeled" id="d">D</div>
      <p id="article:body-1">colon</p>
    </article>
  `;
  const divider = document.getElementById("d")!;
  const root = document.querySelector("article")!;
  const marks = [{ name: "article:body-1", time: asMs(1_000) }];
  expect(firstMarkAfter(divider, marks, root)?.name).toBe("article:body-1");
});

// ---- captureControls round-trip --------------------------------------

const inMemoryStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
};

test("loadCaptureControls — absent ⇒ ON (default)", () => {
  const s = inMemoryStorage();
  expect(loadCaptureControls(s)).toBe(true);
});

test("loadCaptureControls — \"off\" ⇒ OFF", () => {
  const s = inMemoryStorage();
  s.setItem("narrate-capture-controls", "off");
  expect(loadCaptureControls(s)).toBe(false);
});

test("loadCaptureControls — any other value ⇒ ON (only 'off' is special)", () => {
  // Defensive: if a future feature ever writes a different value, we
  // should NOT silently disable capture. The string contract is "off ⇒
  // off, anything else ⇒ on."
  const s = inMemoryStorage();
  s.setItem("narrate-capture-controls", "weird");
  expect(loadCaptureControls(s)).toBe(true);
});

test("loadCaptureControls — null/undefined storage returns ON (private mode)", () => {
  expect(loadCaptureControls(null)).toBe(true);
  expect(loadCaptureControls(undefined)).toBe(true);
});

test("loadCaptureControls — getItem throw is swallowed (returns ON)", () => {
  const throwy: Storage = {
    ...inMemoryStorage(),
    getItem: () => {
      throw new Error("storage disabled");
    },
  };
  expect(loadCaptureControls(throwy)).toBe(true);
});

test("saveCaptureControls — ON removes the key (not 'on' string)", () => {
  // Methodology: "absent ⇒ ON; 'off' ⇒ OFF." Setting ON must clear, not
  // set a sentinel — otherwise a returning reader's storage is bloated.
  const s = inMemoryStorage();
  s.setItem("narrate-capture-controls", "off");
  saveCaptureControls(s, true);
  expect(s.getItem("narrate-capture-controls")).toBeNull();
});

test("saveCaptureControls — OFF writes 'off'", () => {
  const s = inMemoryStorage();
  saveCaptureControls(s, false);
  expect(s.getItem("narrate-capture-controls")).toBe("off");
});

test("saveCaptureControls — round-trip OFF then load reads OFF", () => {
  // The persistence story methodology calls out: a returning reader who
  // released last session stays released across page loads.
  const s = inMemoryStorage();
  saveCaptureControls(s, false);
  expect(loadCaptureControls(s)).toBe(false);
});

test("saveCaptureControls — fall-back path when storage has no removeItem", () => {
  // Some lockdown stubs don't expose removeItem; the helper degrades by
  // writing an empty string, which loadCaptureControls reads as "not
  // 'off'" ⇒ ON. Validates the contract holds across implementations.
  const m = new Map<string, string>();
  const noRemove = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
  };
  saveCaptureControls(noRemove, true);
  expect(noRemove.getItem("narrate-capture-controls")).toBe("");
  expect(loadCaptureControls(noRemove)).toBe(true);
});

// ---- topLevelChapterByNumber -----------------------------------------

test("topLevelChapterByNumber — picks the Nth top-level chapter, skipping subs", () => {
  const chapters = [
    { id: "intro" },
    { id: "problem" },
    { id: "problem-detail-a", parentId: "problem" },
    { id: "problem-detail-b", parentId: "problem" },
    { id: "solution" },
    { id: "outro" },
  ];
  // Key "1" → "intro" (1st top-level), "2" → "problem", "3" → "solution".
  // The sub-chapters under "problem" are NOT counted.
  expect(topLevelChapterByNumber(chapters, "1")?.id).toBe("intro");
  expect(topLevelChapterByNumber(chapters, "2")?.id).toBe("problem");
  expect(topLevelChapterByNumber(chapters, "3")?.id).toBe("solution");
  expect(topLevelChapterByNumber(chapters, "4")?.id).toBe("outro");
});

test("topLevelChapterByNumber — null when the index is beyond the top-level count", () => {
  const chapters = [{ id: "a" }, { id: "b" }];
  expect(topLevelChapterByNumber(chapters, "3")).toBeNull();
});

test("topLevelChapterByNumber — null for non-digit keys", () => {
  const chapters = [{ id: "a" }];
  expect(topLevelChapterByNumber(chapters, "0")).toBeNull(); // 0 doesn't index
  expect(topLevelChapterByNumber(chapters, "x")).toBeNull();
  expect(topLevelChapterByNumber(chapters, "")).toBeNull();
  expect(topLevelChapterByNumber(chapters, "12")).toBeNull(); // multi-char
});

test("topLevelChapterByNumber — '9' on a >9-chapter post returns the 9th, not null", () => {
  // Methodology: ">9 parts still truncates at 9 — coarser but strictly
  // more complete than the old flat-leaf indexing." Verify the 9th is
  // reachable and the 10th-11th are not.
  const chapters = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}` }));
  expect(topLevelChapterByNumber(chapters, "9")?.id).toBe("c9");
});

// ---- shouldIgnoreKeyboardShortcut -----------------------------------

test("shouldIgnoreKeyboardShortcut — false on plain document body (active reader)", () => {
  document.body.innerHTML = "<p>just text</p>";
  expect(
    shouldIgnoreKeyboardShortcut(document.body, {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    }),
  ).toBe(false);
});

test("shouldIgnoreKeyboardShortcut — true when typing in a <textarea>", () => {
  document.body.innerHTML = '<textarea id="t"></textarea>';
  const t = document.getElementById("t");
  expect(
    shouldIgnoreKeyboardShortcut(t, {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    }),
  ).toBe(true);
});

test("shouldIgnoreKeyboardShortcut — true when typing in <input>", () => {
  document.body.innerHTML = '<input id="i" type="text">';
  const i = document.getElementById("i");
  expect(
    shouldIgnoreKeyboardShortcut(i, {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    }),
  ).toBe(true);
});

test("shouldIgnoreKeyboardShortcut — true in a contenteditable surface (comment composer)", () => {
  document.body.innerHTML = '<div id="ce" contenteditable="true"></div>';
  const ce = document.getElementById("ce");
  expect(
    shouldIgnoreKeyboardShortcut(ce, {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    }),
  ).toBe(true);
});

test("shouldIgnoreKeyboardShortcut — Cmd/Ctrl/Alt blocks regardless of focus target", () => {
  // Modifier guards exist so Cmd+1 (browser tab switch) doesn't jump
  // chapters; same for Ctrl+ArrowLeft (browser back) and Alt+Space.
  for (const mods of [
    { metaKey: true, ctrlKey: false, altKey: false },
    { metaKey: false, ctrlKey: true, altKey: false },
    { metaKey: false, ctrlKey: false, altKey: true },
  ]) {
    expect(shouldIgnoreKeyboardShortcut(document.body, mods)).toBe(true);
  }
});

test("shouldIgnoreKeyboardShortcut — null/non-Element target is not in a typing surface (false)", () => {
  expect(
    shouldIgnoreKeyboardShortcut(null, {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    }),
  ).toBe(false);
  // window keydown handlers can fire with target = document; that's not
  // an Element instance and must not be treated as a typing surface.
  expect(
    shouldIgnoreKeyboardShortcut(document, {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    }),
  ).toBe(false);
});

// ---- KEY_BINDINGS / matchesKeyBinding --------------------------------
//
// These guard the single-source-of-truth contract: the narrator's keydown
// handler dispatches off KEY_BINDINGS, and generate/help-page.ts renders the
// same table. A binding that the handler can't dispatch (or a stale duplicate)
// would silently break either the shortcut or its documentation.

const bindingById = (id: KeyBinding["id"]): KeyBinding => {
  const b = KEY_BINDINGS.find((x) => x.id === id);
  if (!b) throw new Error(`no binding ${id}`);
  return b;
};

test("KEY_BINDINGS — every binding has a unique id and a non-empty label/description", () => {
  const ids = KEY_BINDINGS.map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  for (const b of KEY_BINDINGS) {
    expect(b.label.length).toBeGreaterThan(0);
    expect(b.description.length).toBeGreaterThan(0);
  }
});

test("KEY_BINDINGS — the narrator's four shortcuts are all present", () => {
  // The handler's switch has an arm per id; if a binding is dropped here the
  // shortcut silently stops working AND drops off the help page. Pin the set.
  expect(KEY_BINDINGS.map((b) => b.id).sort()).toEqual([
    "jump-chapter",
    "play-pause",
    "skip-back",
    "skip-forward",
  ]);
});

test("matchesKeyBinding — Space matches by code, not key (Space's key is ' ')", () => {
  const play = bindingById("play-pause");
  expect(matchesKeyBinding(play, { code: "Space", key: " " })).toBe(true);
  // A literal "Space" string in `key` must NOT match — the binding keys off code.
  expect(matchesKeyBinding(play, { code: "", key: "Space" })).toBe(false);
});

test("matchesKeyBinding — arrows match by key", () => {
  expect(matchesKeyBinding(bindingById("skip-back"), { code: "ArrowLeft", key: "ArrowLeft" })).toBe(true);
  expect(matchesKeyBinding(bindingById("skip-forward"), { code: "ArrowRight", key: "ArrowRight" })).toBe(true);
  // Cross-match guard: left binding must not fire on a right arrow.
  expect(matchesKeyBinding(bindingById("skip-back"), { code: "ArrowRight", key: "ArrowRight" })).toBe(false);
});

test("matchesKeyBinding — jump-chapter matches 1-9 only, never 0 or multi-char", () => {
  const jump = bindingById("jump-chapter");
  for (const d of ["1", "5", "9"]) {
    expect(matchesKeyBinding(jump, { code: `Digit${d}`, key: d })).toBe(true);
  }
  expect(matchesKeyBinding(jump, { code: "Digit0", key: "0" })).toBe(false);
  expect(matchesKeyBinding(jump, { code: "", key: "12" })).toBe(false);
  expect(matchesKeyBinding(jump, { code: "KeyA", key: "a" })).toBe(false);
});
