# DESIGN.md — the engine's UI design & accessibility reference

The normative reference for **all** reader-facing UI in this engine — article chrome, the comments column, the narrator/player, the landing page, and animated figures. It's where visual + accessibility *standards* live, so any UI work (not just figures) cites one source.

Division of labour:
- **`methodology.md`** documents what the system *does* (behaviour, architecture).
- **`DESIGN.md`** (this file) sets what UI *must satisfy* (the standards).
- **The `figure-journey` skill** is the figure-authoring playbook; its accessibility rule (Rule 17) **points here** rather than restating thresholds.

> **Status:** seeded 2026-06 from the contrast work in [proposal 54](./proposals/54-contrast-conformance.md). Colour/contrast is filled in; type, spacing, focus, and motion sections are stubs to grow as the design system is written down. Items still pending author sign-off are marked **(pending)**.

---

## 1. Colour & contrast (WCAG 2.2)

Spec mirror: [`specs/WCAG22-spec.html`](./specs/WCAG22-spec.html). Two success criteria bind every coloured surface:

- **SC 1.4.3 Contrast (Minimum)** — **text**: ≥ **4.5:1**, or ≥ **3:1 for large text** (≥ 18pt, or ≥ 14pt bold) against its background.
- **SC 1.4.11 Non-text Contrast** — **non-text**: ≥ **3:1** for (a) UI components — the visual info needed to identify a control and its state — and (b) graphical objects — the parts of a graphic *required to understand the content*. This is the criterion for figure bars/segments/legend swatches, focus rings, and state fills. **axe-core and Lighthouse do NOT check 1.4.11** (their `color-contrast` rule is text-only), so non-text contrast is gated by our own figure tool (§4).

**Contrast ratio** = `(L1 + 0.05) / (L2 + 0.05)`, where `L` is WCAG relative luminance (sRGB-linearized: `0.2126·R + 0.7152·G + 0.0722·B`). The ratio is **symmetric** — `ratio(fg, bg) == ratio(bg, fg)` — so a colour that passes as text-on-white also passes as white-text-on-that-colour, and vice versa.

### Decided tokens (engine chrome)
- **`--accent: #0969da`** (one blue sitewide — `--accent` now equals `--cmt-accent`). Replaced `#58a6ff` (2.53:1, failing) → **5.19:1**, clearing both its uses (link/icon text on white, and white text on the active chapter-pill fill) in one change.
- Muted greys **`--page-fg-muted` / `--cmt-fg-muted` = `#57606a`** already pass (6.17:1 / 6.39:1 on the page/white backgrounds). Body `--page-fg #1f2328` = 15.25:1.

### Figure palette **(pending sign-off)**
Figure colours are currently hardcoded per-figure. The plan ([proposal 54](./proposals/54-contrast-conformance.md)) is a small **shared `--fig-*` palette** (muted/ink/faint + accent–tint *pairs*) defined once in the engine, each value chosen to meet ≥ 4.5:1 (text) / ≥ 3:1 (graphical) against its actual background. Figures inherit the tokens instead of hardcoding hex; a shade tweak is then a few edits, not 45. **The exact shades await author sign-off.**

### Light-only
The blog is **light-only by design** (no `prefers-color-scheme` dark tokens; computed `color-scheme` stays `normal`). Contrast is evaluated against the light palette only — don't invent dark-mode values.

### Authoring convention for figures (non-text contrast)
Figures mark intent for the non-text gate:
- `data-contrast="graphic"` — a load-bearing graphical node; gated at ≥ 3:1 (SC 1.4.11).
- `data-contrast="exempt"` — deliberately decorative; skipped.
- Text nodes are auto-sampled at ≥ 4.5:1 (SC 1.4.3) without annotation.

---

## 2. Enforcement (how the standards are kept)

- **Text contrast (SC 1.4.3)** — `e2e/axe.e2e.ts` runs axe-core over the landing + every post. `color-contrast` is currently a *ratchet* (reported, not failing — [proposal 29](./proposals/29-lighthouse-web-vitals.md) §2.7); it flips to a **hard gate** once the engine + figure-text tokens clear 4.5:1.
- **Non-text contrast (SC 1.4.11)** — a **figure contrast gate** (`e2e/figureContrast.e2e.ts`, planned in proposal 54 §3.2) samples figure graphical/text nodes **per driven frame** (figures animate; a swatch can drop below 3:1 mid-journey), reusing the figure harness + `figureCacheKey` cache model. axe can't do this.

---

## 3. Type · 4. Spacing · 5. Focus & states · 6. Motion

*(Stubs — to be written as the design system is documented. Type tokens are `--font-sans` / `--font-mono`, see methodology → Typography. Reduced-motion handling is honoured site-wide, see methodology.)*
