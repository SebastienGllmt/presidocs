# Release checklist

Five-minute manual sweep run on a real laptop + real phone before pushing a release. Covers the substrate behaviours `bun test` cannot — real audio playback, OS lock-screen widgets, real CSS layout under narrow viewports, OAuth redirects to live providers — that no automated harness (happy-dom or Playwright) can verify meaningfully today.

This is the procedural complement to the [Testing layout](../methodology.md#testing-layout) section in `methodology.md`. Each item is a behaviour the methodology calls out as load-bearing; the test layer covers the JS surface, this list covers the integration. When an item here turns into "we've shipped a regression here twice in a row," that's the signal to lift it from manual to automated (and to revisit whether a real-browser harness is worth standing up — see the trigger in `methodology.md`'s "No real-browser harness (today)" paragraph).

The list is short on purpose. Adding a check that the automated layer already covers is dead weight.

## 1. Playback ↔ highlight integration

- Open any post with narration in Chrome desktop.
- Press play. The first paragraph's `<mark>` element gains the highlight within ~1 second.
- Drag the scrub bar to the middle. The highlight jumps to the new section within ~1 second (forward seek).
- Drag the scrub bar *backwards* to the start. The highlight returns to the first paragraph (backward seek must NOT stick on the prior mark — the pure helpers in `shared/narratorTiming.ts` enforce this, but the integration is here).

## 2. Mobile popover positioning

- Open any post with comments on a real phone (iOS Safari + Android Chrome each ≥1× per quarter is enough).
- Tap a highlight near the top of the article. Popover lands below the anchor, fully visible, not behind the dock.
- Tap a highlight near the bottom. Popover lands *above* the anchor, fully visible.
- Scroll the page while the popover is open. The popover stays anchored to its element.
- Tap a *different* highlight. The popover switches to the new thread; the old card dismisses.
- Tap an empty area. Light-dismiss closes the popover (the platform handles this — no JS outside-tap handler).
- Press ESC on a desktop browser narrowed to <1100px. The popover dismisses.
- Tap a highlight, then focus the reply textarea. The soft keyboard pops up; the popover stays usable (the browser re-evaluates its anchor against the contracted visual viewport — there is no JS placement pass to "compute placement before focus()" anymore, so this is the engine's job to get right).

## 3. Sign-in flow

- Logged-out tab → click Google → completes the redirect → lands on the post with avatar + name visible.
- Same for Microsoft.
- Sign out → identity bar shows the logged-out CTA on the next paint.

## 4. OS lock-screen widget (macOS desktop)

- Press play on a post in Chrome desktop on macOS.
- macOS Now Playing widget (menu bar / Control Center) shows the post title + author.
- Press play/pause from a Bluetooth headset (or the keyboard media key). Audio responds.
- Toggle the in-player capture button OFF. Headset key no longer routes to the talk's `previoustrack` / `nexttrack`; play/pause may still — methodology documents why (the Media Session API gives no way to release default play/pause without releasing the loaded audio).

## 5. Touch / hold-arrows / smooth-scroll

- Open a post with >9 chapters. The hold-arrows appear on the chapter strip (desktop only — confirm they DON'T appear on a touch device per the methodology's `@media (hover: hover)` gate).
- Hold ‹ for 1 second. Strip eases in scrolling, not a jump (no scroll-snap regression).
- Click a heading's deep-link icon. URL updates, *no scroll jolt*, "Copied!" feedback appears.

## 6. Reduced-motion

- System Settings → Accessibility → Display → Reduce motion: ON (macOS) / equivalent (other OSes).
- Reload a post with an animated figure. The figure renders the final frame directly (no scramble/pop-in).
- Click a heading deep-link. Native instant-scroll (no smooth).

## 7. Audio cache freshness (the sticky-mp3-bug substrate)

- `bun run generate` on a post you've already loaded once today.
- Reload the post in Chrome. The new audio is fetched — verifiable via DevTools → Network → click the `full.<hash>.mp3` request and confirm the hash matches the new manifest entry.
- (The contract is enforced by `manifest.audio` carrying a content-hashed filename; the test for that contract lives in `generate/generate.test.ts`. This check exists to catch a hypothetical regression where the manifest hash is right but `copy-static` ships stale bytes under the same hash — vanishingly unlikely, but cheap to verify.)

## Promotion criteria

If any item here ever turns into "this is the third time we've shipped a regression here in this corner," lift it to the automated layer:

- If the bug surface is the JS-visible API (state transitions, parsed responses, store wiring) → write a happy-dom test, even if it duplicates a manual check.
- If the bug surface is *real browser behaviour* (audio decoding, real layout, lock-screen widget, OS clipboard) → that's the threshold for revisiting the "no real-browser harness today" decision. The Playwright wiring path is documented in `methodology.md`'s "Testing layout" section.
- If a real-browser harness IS the answer, replace the manual item here with a one-line reference to the new test file.

What does NOT belong in the automated lift:

- Anything that requires checking the *OS surface* (lock-screen widget rendering, headset-tap routing) — no automated test can verify these even with a real browser.
- Anything that needs a real human ear / eye (TTS voice quality, animation feel) — wrong tool.
