# Release checklist

Five-minute manual sweep run on a real laptop + real phone before pushing a release. Covers the substrate behaviours `bun test` cannot — real audio playback, OS lock-screen widgets, real CSS layout under narrow viewports, real `prefers-reduced-motion`, OAuth redirects to live providers, screen-reader semantics — that no automated harness (happy-dom or Playwright) can verify meaningfully today.

Most items run **every release**; §8 (screen-reader smoke) runs **quarterly or when the comments UI changes**, and §9 (push) is **gated** — inert until Web Push ships. Items 2 and 8 need a real phone / a real screen reader, so "once per quarter" is the honest floor for those.

This is the procedural complement to the [Testing layout](../methodology.md#testing-layout) section in `methodology.md`. Each item is a behaviour the methodology calls out as load-bearing; the test layer covers the JS surface, this list covers the integration. When an item here turns into "we've shipped a regression here twice in a row," that's the signal to lift it from manual to automated (and to revisit whether a real-browser harness is worth standing up — see the trigger in `methodology.md`'s "No real-browser harness (today)" paragraph).

The list is short on purpose. Adding a check that the automated layer already covers is dead weight.

## 1. Playback ↔ highlight integration

- Open any post with narration in Chrome desktop.
- Press play. The first paragraph's `<mark>` element gains the highlight within ~1 second.
- Drag the scrub bar to the middle. The highlight jumps to the new section within ~1 second (forward seek).
- Drag the scrub bar *backwards* to the start. The highlight returns to the first paragraph (backward seek must NOT stick on the prior mark — the pure helpers in `client/narratorTiming.ts` enforce this, but the integration is here).

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
- Open a post **with comments**. Click a highlight: the card and its article-side anchor get **no** ~1 s pulse (`.cmt-card-pulse` / `.cmt-anchor-pulse` are silenced), and they scroll into view **instantly**, not smoothly (`scrollBehavior()` in `client/comments.ts` reads `"auto"` under the OS pref — happy-dom's `matchMedia` returns `matches: false`, so this reduce branch is *only* exercisable here).

## 7. Audio cache freshness (the sticky-mp3-bug substrate)

- `bun run generate` on a post you've already loaded once today.
- Reload the post in Chrome. The new audio is fetched — verifiable via DevTools → Network → click the `full.<hash>.mp3` request and confirm the hash matches the new manifest entry.
- (The contract is enforced by `manifest.audio` carrying a content-hashed filename; the test for that contract lives in `generate/generate.test.ts`. This check exists to catch a hypothetical regression where the manifest hash is right but `copy-static` ships stale bytes under the same hash — vanishingly unlikely, but cheap to verify.)

## 8. ARIA / screen-reader smoke (comments)

Run quarterly, or whenever the comments UI structure changes — one screen reader is enough (VoiceOver on macOS). These are *announcement* and *computed-tree* properties: happy-dom builds no accessibility tree, so none of them is assertable in `bun test`.

- The comments column is announced as a **complementary** region named "Comments" — *not* a `feed` (`role="complementary"` + `aria-label="Comments"`; the `feed` upgrade was audited and deliberately rejected). **Now also guarded automatically** by the Tier-1 real-browser test (`e2e/articleA11y.e2e.ts`, `bun run test:e2e` — see [methodology → Testing layout](../methodology.md#testing-layout)); the manual pass still confirms it's *spoken* correctly, which the tree snapshot can't.
- Moving through cards, each is announced as an **article**; the reader is *not* told a misleading "item X of Y" (no `aria-posinset` / `aria-setsize` — the inert pagination hint the audit warned against).
- The version-history control announces as **expandable** (collapsed/expanded) and toggles on Enter/Space (native `<details>` disclosure).
- The hide-all button announces its **pressed** state (`aria-pressed`).
- *(Only if the deferred `aria-live` reply announcement or `aria-describedby` action-bar context ever ship — see `methodology.md` → Comments UI — verify a newly-posted reply is actually **spoken**, and that focusing the action bar speaks the selection context. These announcement claims are the ones no DOM/tree snapshot can reach, which is why the audit deferred them pending exactly this manual pass.)*

## 9. Push notification end-to-end (gated — only once Web Push ships)

Not active yet: Web Push is deferred to [proposal 21](../proposals/21-pwa-offline-followups.md). When the `push` / `notificationclick` handlers land in `client/sw.js`, run this on a real device per browser (the fan-out is server-side and unit-testable; the notification *render* is OS surface — unobservable from any test, so this is manual or nothing):

- Reader posts a comment from a logged-out tab.
- Author tab (a different browser, on a different OS where possible) receives a notification *with the post title and a snippet*.
- Tapping the notification opens the right post and scrolls to the right thread.
- Repeat on Chrome desktop, Safari desktop, and the iOS Safari PWA (each implements Push differently; Safari ignores notification `actions`).

## 10. Secret scan (tracked-file credential sweep)

Opt-in, per content repo (the engine ships a recommended config template, not a forced gate — see [methodology → Secrets](../methodology.md#secrets)). Run before every push from the content repo:

- `bun run secret-scan` — [secretlint](https://github.com/secretlint/secretlint) over the tracked tree (preset-recommend for generic vendor token shapes + a project `pattern` rule for this engine's own credential shapes: `SESSION_SECRET(S)`, `*_OAUTH_CLIENT_SECRET`, `VAPID_PRIVATE_KEY`, `whsec_…` signing secrets, and Discord/Slack webhook URLs with embedded tokens). Exit 0 = clean; any finding fails with the file + line (value masked via `--maskSecrets`).
- This catches the one path the [gitignored-`.env` + Cloudflare-secret-store posture](../methodology.md#secrets) doesn't: a real credential pasted into a *tracked* file (a post's HTML while debugging an auth flow, a code sample with a real token, a `.dev.vars` that escaped `.gitignore`). The real secret stores (`.env`/`.dev.vars`) and the `engine` symlink are excluded via `.secretlintignore`, so a legitimately-placed secret never trips it.
- Manual rung on purpose. Promote to a pre-commit hook and/or a CI lane (blocking) only once it catches a real near-miss or the false-positive set is tuned out — the same manual-then-automate ladder this list uses. Until then it's a "remember to run it" item, kept advisory so it can't surprise an author mid-flow.

## Promotion criteria

If any item here ever turns into "this is the third time we've shipped a regression here in this corner," lift it to the automated layer:

- If the bug surface is the JS-visible API (state transitions, parsed responses, store wiring) → write a happy-dom test, even if it duplicates a manual check.
- If the bug surface is *real browser behaviour* that a headless Chromium **can** reach (real layout, the accessibility tree, the Service-Worker lifecycle, Popover/anchor placement) → add a test to the real-browser harness (`e2e/*.e2e.ts`, `bun run test:e2e` — see [methodology → Testing layout](../methodology.md#testing-layout)). Live today: layout, the a11y landmark, and the full comment-positioning set (cards/drafts/overlap/rail/mobile popover). Remaining tiers (comment-card accessibility-tree snapshot; Service-Worker lifecycle) are specified in [proposal 22](../proposals/22-real-browser-e2e-remaining.md).
- When a harness test covers an item, replace the manual bullet here with a one-line reference to the new `e2e/*.e2e.ts` file.

What does NOT belong in the automated lift:

- Anything that requires checking the *OS surface* (lock-screen widget rendering, headset-tap routing) — no automated test can verify these even with a real browser.
- Anything that needs a real human ear / eye (TTS voice quality, animation feel) — wrong tool.
