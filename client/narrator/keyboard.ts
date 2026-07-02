// methodology.md → Narrator — page-global keyboard shortcuts (Space / arrows /
// 1-9) dispatched off the shared KEY_BINDINGS table, plus the per-event handler
// the loader's cold-start replay reuses.

import type { Narrator } from "../narrator.ts";
import {
  shouldIgnoreKeyboardShortcut,
  KEY_BINDINGS,
  matchesKeyBinding,
  topLevelChapterByNumber,
} from "../narratorDom.ts";
import { asMs } from "../../shared/time.ts";

export class NarratorKeyboard {
  constructor(private readonly sys: Narrator) {}

  // Page-global keyboard shortcuts (Space / arrows / 1-9). Armed from
  // init, not gated on engagement — Space/1-9 are how a reader who
  // knows the shortcut starts the talk cold, mirroring the in-page
  // play button. Skipped while typing in a form field or with a
  // modifier held.
  //
  // The narrator now boots lazily (`client/narratorLoader.ts`), so the loader
  // *also* arms these keys from page load off the SAME `narratorDom` table and
  // hands the first one to `init(pendingKey)`, which replays it here once the
  // player exists (see `handleKeyboardEvent`). So the cold-start press still
  // controls playback even though Shikwasa hadn't loaded when the key was hit.
  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => this.handleKeyboardEvent(e));
  }

  // The per-event dispatch, shared by the live document listener and the
  // boot-time replay of the loader's captured cold-start key. Idempotent and
  // self-guarding: a no-op until the player + manifest are ready.
  handleKeyboardEvent(e: KeyboardEvent) {
    if (!this.sys.player || !this.sys.manifest) return;
    // Modifier-and-focus filter lives in ./narratorDom.ts so the unit
    // tests can exercise it directly without spinning up the rest of
    // the narrator.
    if (shouldIgnoreKeyboardShortcut(e.target, e)) return;

    // Dispatch off the shared KEY_BINDINGS table (narratorDom.ts) — the same
    // declaration the build-time help page renders, so the bindings and their
    // documentation can't drift. Run the first matching binding and stop.
    for (const binding of KEY_BINDINGS) {
      if (!matchesKeyBinding(binding, e)) continue;
      switch (binding.id) {
        case "play-pause":
          // Override the default Space-activates-focused-button behavior so a
          // focused chapter pill or the visibility toggle doesn't intercept
          // playback control. Buttons remain activatable via Enter.
          e.preventDefault();
          this.sys.lastPlayTrigger = "space";
          this.sys.player.toggle();
          return;
        case "skip-back":
          e.preventDefault();
          this.sys.skipBy(asMs(-10_000));
          return;
        case "skip-forward":
          e.preventDefault();
          this.sys.skipBy(asMs(10_000));
          return;
        case "jump-chapter": {
          // 1-9 index the TOP-LEVEL chapters (parts + flat chapters),
          // matching the number shown on the level-1 pills. Sub-chapters are
          // reached by click or MediaSession next-track, not by number.
          // Resolution (including the >9 truncation rule, and declining when
          // there's no Nth chapter) lives in topLevelChapterByNumber — so a
          // digit with no matching chapter falls through doing nothing, as
          // before.
          const chapter = topLevelChapterByNumber(this.sys.manifest.chapters, e.key);
          if (chapter) {
            e.preventDefault();
            this.sys.jumpToChapter(chapter);
          }
          return;
        }
      }
    }
  }
}
