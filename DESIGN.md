# DESIGN.md — the engine's UI design & accessibility reference

The normative reference for **all** reader-facing UI in this engine — article chrome, the comments column, the narrator/player, the landing page, and animated figures. It's where visual + accessibility *standards* live, so any UI work (not just figures) cites one source.

Division of labour:
- **`methodology.md`** documents what the system *does* (behaviour, architecture).
- **`DESIGN.md`** (this file) sets what UI *must satisfy* (the standards).
- **The `figure-journey` skill** is the figure-authoring playbook; its accessibility rule (Rule 17) **points here** rather than restating thresholds.

> **Status:** the **Colour & contrast** section (§1–2) is complete and enforced (landed 2026-06): the `--fig-*` palette, the hard axe text gate, and the per-frame `figureContrast` gate are all live. Type, spacing, focus, and motion sections are stubs to grow as the design system is written down.

---

## 1. Colour & contrast (WCAG 2.2)

Spec mirror: [`specs/WCAG22-spec.html`](./specs/WCAG22-spec.html). Two success criteria bind every coloured surface:

- **SC 1.4.3 Contrast (Minimum)** — **text**: ≥ **4.5:1**, or ≥ **3:1 for large text** (≥ 18pt, or ≥ 14pt bold) against its background.
- **SC 1.4.11 Non-text Contrast** — **non-text**: ≥ **3:1** for (a) UI components — the visual info needed to identify a control and its state — and (b) graphical objects — the parts of a graphic *required to understand the content*. This is the criterion for figure bars/segments/legend swatches, focus rings, and state fills. **axe-core and Lighthouse do NOT check 1.4.11** (their `color-contrast` rule is text-only), so non-text contrast is gated by our own figure tool (§2).

**Contrast ratio** = `(L1 + 0.05) / (L2 + 0.05)`, where `L` is WCAG relative luminance (sRGB-linearized: `0.2126·R + 0.7152·G + 0.0722·B`). The ratio is **symmetric** — `ratio(fg, bg) == ratio(bg, fg)` — so a colour that passes as text-on-white also passes as white-text-on-that-colour, and vice versa.

### Decided tokens (engine chrome)
- **Neutrals:** `--page-fg #1f2328` (15.25:1, body) · `--page-fg-muted #57606a` (6.17:1, the focal muted shade — meta, captions) · **`--page-fg-faint #6b727a`** (4.85:1 — the *faintest legible* grey; the floor for de-emphasised text). `--cmt-fg-muted #57606a` matches on the comments rail.
- **The accent is SPLIT, not a single swap.** The narrator UI spans two backgrounds, and contrast is background-dependent, so one blue can't serve both:
  - **`--accent #58a6ff`** — the **dark dock** only (Shikwasa primary, the progress bar/handle, dock icons). White text never sits on it; the darker blue is lost on `rgba(22,27,34,0.85)`.
  - **`--accent-strong #0969da`** (== `--cmt-accent`, the sitewide blue) — every **light** surface: the article "you are here" divider, the **active chapter-pill fill** (white text on it → 5.19:1, was 2.52:1), and the light transcript drawer. On white `#58a6ff` is 2.53:1 (text) / <3:1 (fill); `#0969da` clears both 1.4.3 and 1.4.11.
  - *(An earlier plan was to darken the single `--accent` to `#0969da`; measuring the rendered dock showed that would fail the dock's graphical uses, so it split instead.)*

### The opacity trap (the #1 way good tokens fail)
**Never stack `opacity` on text (or a coloured graphic) to de-emphasise it.** `opacity` composites the element *toward its backdrop*, so a token that passes on its own silently drops below threshold once rendered. Measured cases that fooled an earlier audit: `.post-meta` (`opacity:.75`) + `.post-meta-label` (nested `.85`) pulled the 6.17:1 muted grey down to **2.8–3.5:1**; the logged-out comments identity card (`opacity:.35`) reads at **1.68:1**. **Mute with an opaque token instead** (`--page-fg-muted` / `--page-fg-faint`), which is contrast-guaranteed by construction. Corollary: audit/measure the **rendered pixel** (the reporter in §2 does), never the token value — they diverge exactly here.

### Figure palette — a born-compliant *default*, not a cage **(landed 2026-06-06)**

The blog is HTML-first and the figures are deliberately diverse; a palette must give **confidence without confinement**. So the model is:

1. **A small shared `--fig-*` palette** (defined once in the engine) that every figure *defaults* to → new figures are born compliant, and a shade tweak is ~6 edits, not 45.
2. **Bespoke colour stays legal.** A figure that needs a colour outside the palette just uses it — the **gates (§2) are the backstop**: text is measured by axe, load-bearing graphics by the figure gate. Freedom to pick any colour, with a floor that catches a bad one. The palette is the easy path, the gate is the guarantee — neither is a straitjacket.

The tokens live in `client/base.css` `:root` (each a *pair* where it tints): a neutral ramp + semantic accents, chosen to clear **≥4.5:1 as text / ≥3:1 as graphic on their paired tint** (tints are darker than white, so they — not white — are the binding background). Values were derived from the figures' existing hues so migration was near-zero visual change:

| token | role | value | pairs with (tint) |
|---|---|---|---|
| `--fig-ink` | primary label | `#24292f` | — |
| `--fig-muted` | secondary label | `#555c63` | — |
| `--fig-faint` | faintest legible (on a tint) | `#656c74` | — (a touch darker than `--page-fg-faint`) |
| `--fig-green` / `-bg` | "good" / settled | `#147a35` | `#e6f6ec` |
| `--fig-red` / `-bg` | "bad" / cost | `#b3261e` | `#fbeded` |
| `--fig-blue` / `-bg` | neutral accent / link | `#0969da` | `#eef3fb` |
| `--fig-amber` / `-bg` | warning / pending | `#8a5a16` | `#faf2dd` |
| `--fig-purple` / `-bg` | crypto / privacy | `#5a45a8` | `#efeafb` |

The greys `#777`–`#aaa` and the marginal accents (`#1f8a4c`/`#2f7d4d` green, `#2f7bb0` blue, `#8a7bbf`/`#7a6bb0` purple, `#b06a2f`/`#a83` amber) collapsed onto these. **Migration result (`contrastReport.ts`): 178 → 17 failing text nodes**; the rest are non-figure deliberate-dimming patterns exempted per-node (the logged-out comments card — slated for a fundamental redesign; the narrator sub-chapter segments). **Every figure text node passes**. A recurring figure anti-pattern surfaced and was fixed: dimming an inactive step/node via container `opacity` (0.5–0.55) dragged its label below 4.5:1 — floored at ~0.78 with a dark base, or the opacity dropped where typography already de-emphasised the text.

### Light-only
The blog is **light-only by design** (no `prefers-color-scheme` dark tokens; computed `color-scheme` stays `normal`). Contrast is evaluated against the light palette only — don't invent dark-mode values.

### Authoring convention for figures (non-text contrast)
Figures mark intent for the non-text gate:
- `data-contrast="graphic"` — a load-bearing graphical node; gated at ≥ 3:1 (SC 1.4.11).
- `data-contrast="exempt"` — deliberately decorative; skipped.
- Text nodes are auto-sampled at ≥ 4.5:1 (SC 1.4.3) without annotation.

---

## 2. Enforcement (how the standards are kept)

- **Detect / triage (text)** — **`bun run scripts/contrastReport.ts [slug]`** runs axe's `color-contrast` over every page and prints each failing element's fg/bg/measured-ratio/required-ratio, **grouped by colour pair, worst-first**, with a PASS/FAIL trailer. This is the "what do I fix, and when do I pass" view (axe's gate only prints counts). Run it after any colour edit, and on a new figure, before trusting the eye.
- **Gate: text contrast (SC 1.4.3)** — `e2e/axe.e2e.ts` runs axe-core over the landing + every post. As of 2026-06 `color-contrast` is a **HARD GATE** (no longer ratcheted): any text below 4.5:1 (3:1 large) anywhere fails the suite. **Two** surfaces are exempted per-node via `CONTRAST_EXEMPT_SELECTORS` — `.cmt-identity-loggedout` (login card, dimmed-until-engaged, pending a fundamental redesign) and `.ch-seg[data-sub]` (subordinate-by-dim sub-chapter pills). These are a **fixed, non-extensible roster of deliberate design decisions**, stripped per-node so every *other* rule still applies to them and any contrast failure *elsewhere* still hard-fails (proven by a negative test). Do not grow the list to silence a real failure — fix the colour (`contrastReport.ts` shows what).
- **Gate: per-frame figure contrast (SC 1.4.3 + 1.4.11)** — **`e2e/figureContrast.e2e.ts`** (built 2026-06) drives every figure through its journey and checks contrast at each **held state** (frame 0 + every step boundary), reusing the figure harness + `figureCacheKey` cache. It computes the WCAG ratio from `getComputedStyle` (compositing opacity + ancestor backgrounds), so it sees what axe can't: **graphics** (1.4.11, opt-in via `data-contrast="graphic"`, ≥3:1) and **text shown at full strength in a failing colour at a non-zero animation frame** (≥4.5:1) — axe only ever checks frame 0. To stay low-noise it judges text only where fully presented (opacity ≈1, so transient fades / dimmed-inactive / disabled controls don't false-positive), and skips `data-contrast="exempt"` (decorative). On its first run it caught **4 real mid-journey text failures axe had missed** (a green delta, a "posted" badge, purple captions, a status mark). This is the backstop that makes bespoke figure colour safe.

---

## 3. Type · 4. Spacing · 5. Focus & states · 6. Motion

*(Stubs — to be written as the design system is documented. Type tokens are `--font-sans` / `--font-mono`, see methodology → Typography. Reduced-motion handling is honoured site-wide, see methodology.)*
