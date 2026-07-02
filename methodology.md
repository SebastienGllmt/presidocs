# Methodology

## About this document (read before editing it)

This file is loaded as context by **every** agent working on this project, on every task. It exists to carry what the code cannot: the goal, the invariants, the trust boundaries, and the *why* behind non-obvious or rejected designs — so settled decisions don't get re-litigated and known traps don't get rebuilt.

**The test for every sentence:** an agent *not* working on that subsystem must be better off having read it, or an agent working on it would otherwise make a mistake the code can't warn about. A sentence that fails the test costs every future agent context for nothing — delete it or relocate it.

Rules for editing this document:

- **Describe the current design only.** No history ("we did X, then Y"), no migration stories, no references to deleted code. Git remembers. Exception: a rejected approach an agent might plausibly rebuild — phrase it as a warning ("Don't X: it breaks Y"), not chronology.
- **State rationale first-principles:** "We do X. Because ⟨constraint/benefit⟩. ⟨What breaks under the alternative, if non-obvious⟩."
- **Don't restate what code or tests already say.** Document the invariant a test enforces and point at it; never inventory test cases, walk through schemas, or tour functions.
- **No vendor or spec facts** (pricing, quota, metric weights, spec summaries) unless the engine depends on the specific delta — then state only the delta.
- **One owner per fact.** Cross-cutting facts are stated once, in one section; everywhere else links to it.
- **Rejected-design ledger entries** ("considered, not used", "excluded from v1") are kept forever, sized by how core the rationale is: core rationale gets the full first-principles form; evaluation artifacts get one line — *name, reason, revisit trigger*.
- **This document must stand alone.** `proposals/` is an ephemeral scratchpad — proposals are deleted once folded in here. Never cite a proposal for rationale (inline the rationale instead); naming one as pending future work is fine.
- **Bullets for enumerations, short prose for causal arguments. Bold marks rules and invariants only.**
- **Headings are unique; file paths go in the section body, not the heading** (path-bearing anchors break on rename).
- Before adding a section, check the size of what you're adding against its value under the test above. When updating code that this document describes, update the affected sentences in the same change — and delete any that the change made false.

## What we're building

A way to build explanatory technical blog posts that doubles as a talk via associated audio.

To ensure ease of AI authoring, each post is a self-contained HTML file that contains all relevant information inline (text, graphics — including animated, interactive figures — spoken script, etc.). Generator tools then parse this file to power things like a "Listen" button that plays a narration of the post.

The spoken track is deliberately **not** a read-aloud of the article - it's a parallel narrative that can paraphrase, reorder, skip over, or revisit visual elements the way a presenter does.

Key design decisions that shape the architecture:
- **The UI design & accessibility standard lives in a companion [`DESIGN.md`](./DESIGN.md).** It defines what every reader-facing surface must satisfy — colour & contrast (WCAG SC 1.4.3 for text, SC 1.4.11 for non-text/graphics), type, focus, motion, and the light-only rule — so all UI work (article chrome, the comments column, the narrator/player, animated figures, the landing page) cites one source rather than each surface re-deciding. The division of concerns: **`DESIGN.md` sets *what* UI must satisfy; this `methodology.md` documents *how* the system works.**
- **The engine is a separate git repo from the content it renders.** This repo (`presidocs`) is the reusable *engine* — player, comments, build/TTS pipeline, server, authoring tools — and holds **no posts of its own**. Each actual blog is its own git repo containing only content (posts, figures, landing, per-blog config) and depends on the engine through a `bun link` symlink to the sibling engine checkout (`"presidocs": "link:presidocs"`); its `index.ts`/`worker.ts` are thin wrappers that call engine factories. One fast-moving engine is shared across blogs without copy-paste drift, while each blog's content and deploy config stay independently versioned. The hard rule that falls out of this: **engine code never names a specific post** — it discovers content by convention from a *content root*. See [Repository layout](#repository-layout) for the two folder structures and the wiring between them.
- **One file per post.** Article + spoken script live in the same HTML
  so authoring tools (humans or LLMs) edit one document, not a
  bundle. No other content input is allowed (note: multiple files are allowed to be served, but they have to be generated from the single input)
- **Audio is generated offline**, then served as pre-rendered files. A `bun run generate` step turns the inline spoken script into MP3-shaped artifacts plus a JSON timing manifest. The runtime player never calls a TTS API.
- **The narration is in the *author's own voice*.** The production audio is voice-cloned from a reference clip of the real author, so a listener feels the presentation is genuinely being given by the person who wrote it — not read by a generic synthetic narrator. This authenticity is the whole point of the spoken track. Crucially, auto-generating that voice is what makes it *sustainable*: the author can iterate on the document in response to feedback (see [AI-assisted iteration](#ai-assisted-authoring)) without re-recording a long presentation on every revision — the next build just re-synthesizes the changed segments in their voice. (This is also why the production TTS provider is a voice-cloning model; see [Providers](#providers-say-for-iteration-moss-for-production).)
- **Segment-level audio cache.** Edit one sentence and only that sentence is re-synthesized — the rest comes from cache. See [Audio caching](#audio-caching).
- **Non-linear narration is a first-class case.** Presenters reference earlier slides; our highlight/scroll logic has to handle going backwards as gracefully as forwards. This rests on one invariant: narration may skip *backward* (revisit an earlier figure) but never *forward*, so the page is covered by a monotonic frontier and every article position is "owned" by the first narration to reach it — which is what lets a prose marker map unambiguously to a point in the spoken track.
- **Chapters group into *parts*, and a part is one entity with three faces.** A long post's many chapters are grouped into a few navigable parts. A part's boundary exists on all three surfaces at once — a labeled prose **divider** (read), a spoken **section-intro** transition (heard), and a **script-drawer** entry (listed) — wired together by the intro's first `<mark>` targeting the divider's `id`. The part name is authored once (the section-intro's title, shown verbatim on the divider) and the spoken transition paraphrases it, exactly as every `<mark>` paraphrases its element. Crucially the part name is **decoupled from the member chapters' own headings**, so a part's first content section keeps its heading instead of being conscripted into naming the whole part. See [Two-level chapters](#two-level-chapters-parts--sub-chapters).
- **No light/dark toggle**: we will never support a dark-mode/light-mode switch, because we need to ensure generated visuals for charts, etc. appear correctly (too hard to do this for both modes)
- **Figures are live and interactive.** Diagrams aren't static images or pre-rendered video — the `<figure>`'s markup is authored in the post and progressively enhanced into an animated, interactive diagram by a referenced [GSAP](#animated-figures) module (kept external, like the player's code, because the prod CSP forbids inline scripts/styles). The figure stays [comment-anchorable as a graphic](#anchoring-graphics) and can sync to narration. See [Animated figures](#animated-figures).
- **Objects are CRDT-based; the *production* server is dumb storage.** Objects are managed via Automerge (CRDT library) and synced as content-addressed change objects in R2. Following this CRDT paradigm, the **production** server (the Cloudflare Worker) never runs Automerge or holds any other reconciliation logic — it just shuffles bytes. This is a *production deployment* constraint, not a universal one: it's what lets the comment data survive a malicious / buggy / different-version edge server, and it's why per-reader writes don't need server-side merge. **Localhost is exempt.** The dev Bun server and the offline build/authoring tools (`bun run generate`, `authoring/*`) run on the developer's machine, fully trusted, and freely run Automerge — merging every reader's blob, snapshotting, serializing to other formats. So "the server is dumb" should be read as "the *edge* server is dumb"; anything that only ever runs on localhost may be as smart as it likes.
- **Authored content is trusted at its source; readers are not.** A presidocs blog is *single-tenant authoring*: everything under `posts/` — prose, figures, the spoken script — is written by the specific, trusted people who run the blog, never submitted by anonymous users. So we **don't defend the system against its own authors**. An author can already ship arbitrary HTML, scripts, and links to readers, so author-supplied text needs no sanitization *against itself* — e.g. a post title is forwarded verbatim to downstream channels (a publish-webhook to Discord/Slack passes a title through as-is, even one containing `@everyone`), because the author having that capability is not a new trust boundary. The party we *do* treat as untrusted is the **reader**: reader-contributed data (comments) is exactly what the dumb-edge-server + CRDT design above guards — a malicious or buggy edge server can't corrupt the merged comment history. The dividing line is *content authoring* (trusted) vs *reader interaction* (untrusted); if presidocs ever accepted untrusted multi-author content submission, that line would move and author-supplied text would need escaping — but today it does not.
- **A blog can be *private* (capability-URL posts), and that is a standing design constraint.** A deploy with `BLOG_PRIVATE=1` ([Private blogs](#private-blogs)) must reveal **no post URL to anyone who wasn't handed the link** and transmit **no post content to third parties** — the engine's whole discovery surface is *inverted*, not merely off. The hard rule for every new feature: if it emits, advertises, lists, or transmits a post URL or post content to anyone who didn't already have the capability link, it must consult `isPrivateBlog()` and `generate/audit-private.ts` must be taught to prove it stays suppressed. This is enumerated as axis 8 of the [new-feature privacy checklist](#considering-privacy-for-new-features), and every served surface's verdict is the [coverage ledger](#coverage-every-served-surface-has-a-verdict) under Private blogs. Treat "does this leak on a private blog?" as a release gate, not an afterthought.
- **Cloudflare ecosystem in prod, Bun in dev.** We focus on leveraging the Cloudflare ecosystem for production (Workers for the HTTP layer, R2 for any dynamic blob, the Static Assets binding for static content). Bun is dev-only (`bun --hot index.ts`) and build-time only (`bun run generate`)
- **Commenting as a core feature.** Comments are done via OAuth login with the user's email. This allows us to not only apply recommended changes if relevant, but also follow-up with any commenter (via email or otherwise) to engage.
- **AI-assisted iteration: the comment system *is* the editing surface.** The author leaves their own comments on a post via the same UI a reader does, interleaved with readers' feedback ("rephrase this paragraph", "add an example for X"). An offline tool then hands every unresolved thread — both sources, undifferentiated — to Claude, which edits the source HTML in one reviewable diff. No separate editor view, no parallel workflow for human-driven vs. reader-driven edits. The same mechanism that gathers reader questions is the mechanism that drives the next revision. See [AI-assisted authoring](#ai-assisted-authoring).

## Repository layout

Because the engine and the content live in **separate repos** (see the design decision above), there are two distinct layouts. The split rule is simple: a folder lives in the engine if it's reusable code that never names a post; it lives in the content repo if it's this-blog-specific input or config.

### Engine repo (`presidocs`)

Each top-level folder is one concern, so finding code is "pick the folder that matches what you want to change":

- `generate/` — offline pipeline that turns a post into audio + manifest, plus the build-time codegens (`post-meta`, `post-versions`, `post-routes`) and the `copy-static`/`strip-served-html`/`audit-posts` build steps (the last is the build-time accessibility/SEO publish gate)
- `client/` — client-run JS/CSS (audio player, comments, the page-global `base.css`). **No `figures/` here** — figures are per-post content and live in the content repo (see [Animated figures](#animated-figures))
- `server/` — server-side helpers and the two entry-point factories `createDevServer.ts` (Bun dev) and `createWorker.ts` (Cloudflare prod) that a content repo's thin `index.ts`/`worker.ts` call; plus `server/auth/` (OAuth + sessions), comments, post-meta/version
- `shared/` — types/helpers used by both sides, including **`blogPaths.ts`**, which resolves `engineRoot` (this repo, from the module's own location) vs `contentRoot` (`$BLOG_CONTENT_DIR ?? cwd`) and every content-relative path. This is how engine code stays content-agnostic while operating on whichever blog invoked it
- `authoring/` — offline authoring tools (comment export, resolution write-back) run from a content repo's cwd; they resolve content paths via `blogPaths.ts`
- `scripts/` — engine-side dev/diagnostic scripts invoked from a content repo's package.json, notably `dev.ts` (the dev-server wrapper — see [Dev server wrapper](#dev-server-wrapper))
- `specs/` — local copies of the W3C specs referenced above
- `templates/content-repo/` — the canonical starter a new blog copies: thin `index.ts`/`worker.ts`/`wrangler.toml`, `package.json` (with the `link:` dep + per-blog scripts), a sample post + figure, and the `process-comments` skill. `personal-blog` is a real instance of this template

The engine has **no `posts/`, `index.html`, `generated/`, or `client/figures/`** — those are content. It is not a deployable blog by itself; the `dev`/`build`/`deploy`/`generate` scripts live in each *content* repo's `package.json`, not here (here we keep only `test`).

### Content repo (e.g. `personal-blog`)

One git repo per blog, depending on the engine via `"presidocs": "link:presidocs"` — a `bun link` to the sibling `../presidocs` checkout (a one-time, per-machine `cd ../presidocs && bun link` registration; `bun install` in the blog then creates the symlink). `link:` is deliberate over `file:`: a `file:` dep installs a *per-file copy/symlink farm* fixed at install time, so editing an engine file (or adding a new one) doesn't take effect until you reinstall — exactly the footgun this live-codeveloped engine must avoid. `link:` makes `node_modules/presidocs` a single live symlink instead:

- `index.ts` / `worker.ts` — thin wrappers: import the engine factory + this blog's static post bundles (`.generated/postRoutes.ts`) / build-time maps (`.generated/`), and call it
- `wrangler.toml` / `.env` — per-blog deploy config (worker name, R2 bucket) and secrets
- `engine` — a symlink pointing **directly at the sibling engine checkout** (`../presidocs`), so a post can reference engine assets as `../engine/client/narrator.ts` and Bun's bundler resolves + bundles them into same-origin (`'self'`) assets. It's the real engine in one hop, not an indirection through `node_modules` (`node_modules/presidocs` is a *separate* single symlink to the same checkout, used only to resolve the bare `presidocs/…` imports in `index.ts`/`worker.ts`). The engine's own deps (shikwasa, Automerge, …) resolve from the engine's `node_modules` via the symlink; the content repo only declares deps its *own* authored code uses (e.g. `gsap` for figures)
- `posts/` — authored inputs (one HTML file per post + the shared `common-terms.pls` lexicon + the generator-managed `versions.json`)
- `figures/` — this blog's animated figures (`<name>.{ts,css}`). Content, not engine: each post references them relatively and Bun bundles them transitively, so the engine never enumerates them
- `index.html` — the landing page
- `authors/` — per-author assets, one set per author keyed by **`<author-email>`**: the profile (`<email>.json` — display name + social links), the avatar (`<email>.png`/`.jpg`/…), and the production-TTS voice-clone clip (`<email>.wav`). The `.json`/avatar power the reader-facing byline; the `.wav` is a build-only input (never served). One folder, one key. See [Author profiles and bylines](#author-profiles-and-bylines) and [Per-author voice resolution](#per-author-voice-resolution).
- `generated/` — pipeline output: audio, manifests, the dev comment store (gitignored)
- `.generated/` — per-build maps + dev route table the engine codegens emit (gitignored; regenerated by `dev`/`build`)
- `.claude/skills/process-comments/` — the in-session comment-applying workflow (a content-repo concern; it edits `posts/<slug>.html`)
- `research/` — **authoring inputs that are never published**: the context that helps generate a post — committed so it lives in git history (unlike `generated/`), but kept out of `posts/` because `posts/` is the *published* surface. **One self-contained folder per investigation** (e.g. `research/dexie-offers/`), so a reader can follow the whole thing — code, prose, and committed data — in one place rather than chasing it across the tree. The internal layout for a code-heavy investigation:
  - `README.md` — the entrypoint: dataset provenance, how to reproduce, open threads
  - `pipeline/` — data acquisition + substrate build (crawlers, `build-*.sql`)
  - `analysis/` — the per-thesis queries (`NN-*.sql` / `NN-*.ts`), numbered to bind query ↔ finding ↔ chart-data
  - `charts/` — scripts that turn finding CSVs into the post's figures
  - `findings/` — prose, one `NN-*.md` per thesis, with committed chart inputs under `findings/data/`
  - `sources/` — downloaded external docs we want offline (verbatim or clearly-labelled summaries)

  Heavy/regenerable artifacts (multi-GB dumps, DuckDB, parquet) stay in the gitignored `generated/` at repo root; the README documents the path mapping. Scripts are run from the content-repo root, so their cwd-relative `generated/…` paths resolve regardless of where the script file lives. Keep each investigation scoped to its own topic so it doesn't pollute an unrelated one (e.g. the dexie dataset stays about dexie/Chia, not the post's broader subject).

Folder boundaries follow runtime/process boundaries (offline build vs. browser runtime vs. authored input vs. derived output), not file kind — co-locate types and tests with the code that owns them rather than splitting them into `types/` or `tests/`.

## Animated figures

Since every post is already HTML in a browser, figures *move and respond*: a hash scrambling under the avalanche effect, a step-through the reader can scrub. The long-term goal is an animated, interactive educational book for math topics — "more than a fade-in" is the baseline.

The figure's **markup is authored in the post** (a `<figure id="…">` edited inline with the prose) and progressively enhanced by a small **referenced module**, the same way the post pulls in the player and comments. Inline animation *code* would be preferable but is blocked twice over: the production CSP forbids inline scripts/styles ([HTTP security headers](#http-security-headers)), and Bun's bundler duplicates rather than externalizes an inline `<script>`. So behaviour lives in the content repo's [`figures/`](#how-its-wired); the post owns the markup and references. The figure stays a real `<figure id>` in the DOM — [comment-anchorable as a graphic](#anchoring-graphics), never a baked asset.

### Requirements

In priority order: **text-only input** (authorable, diffable — no binary scenes, no GUI-only tools); **no React, in or out**; **runs in the browser** (not pre-rendered video); **more than basic animation** (timelines, staggering, SVG drawing/morph/motion-path — a math explainer's vocabulary); **no custom DSL of our own** (we'll write any existing tool's format, we won't maintain a bespoke language); **in-repo source near the post**; **interactivity** as a strong nice-to-have.

### Library choice — GSAP

The *same* figure (real in-browser SHA-256 avalanche) was prototyped under each candidate before committing:

- **Hand-written SVG/CSS/WAAPI** — fine for simple motion; sequenced educational animation gets verbose with no timeline-scrubbing story. Kept as the no-JS fallback, not the engine.
- **anime.js** — clean modern API (a full prototype was built), but a less mature timeline and no SVG-drawing/morph/motion-path toolkit.
- **Motion Canvas** — the best authoring experience ("Manim-class in TS"), rejected on three structural mismatches: playback-only (not interactive), scenes live in a separate project rendered to an asset (breaking one-file-per-post), and Vite-coupled (against the Bun rule).
- **Manim** — cinematic gold standard, but outputs video (no interactivity, flat-box commenting) outside the post. Like Motion Canvas, kept in the back pocket for a non-interactive cinematic set-piece rendered offline.
- **GSAP — picked.** Mature timeline control (`seek`/labels/nesting) suited to step-throughs and to slaving figures to the player's rAF clock; a free plugin toolkit (`DrawSVG`, `MotionPath`, `MorphSVG`) mapping near-1:1 onto math-explainer primitives; ergonomic imperative re-animation for explorables; no React. **Vendored and bundled locally, never a CDN** (CSP `'self'`); GSAP writes `element.style` via CSSOM, which CSP doesn't govern, so no policy relaxation.

### How it's wired

Code: the content repo's `figures/` (see [Repository layout](#repository-layout)).

The canonical example is the hash-avalanche diagram (`figures/hashAvalanche.{ts,css}`). The shape it establishes:

- **Progressive enhancement over a static fallback** — the post ships a static `<svg>` as the no-JS/initial frame; the module hides it and injects the live stage. Crawlers and no-JS readers still get a meaningful diagram.
- **Real computation** — genuine SHA-256 via `crypto.subtle`, so typing input shows the *true* avalanche effect, not a canned animation.
- **Narration-synced with no new player API** — the player already toggles `narration-active` on the element whose mark is playing; the figure observes that class on its own `<figure>` and replays on cue. An `IntersectionObserver` covers the silent reader. Rides the existing `<mark name>`↔`id` pairing; the audio script needed no change.
- **Reduced-motion aware** — under `prefers-reduced-motion`, skip the scramble and render the final state.
- **CSP-clean by construction** — no inline `style=`; dynamic visuals are CSSOM writes or class toggles.

### The FigureJourney contract

Code: `client/figureAnimation.ts`.

Ad-hoc observer hand-offs work for one figure; the moment the engine must *drive* figures deterministically — replay on the audio clock, step through labeled states, and above all **capture offline as video frames** — every figure needs one common surface. The contract is an **adapter surface over GSAP**, not a replacement.

**A pure renderer plus an external clock.** A journey is a finite, paused timeline exposing only `reset()` (snap to first frame, taking exclusive control) and `seek(ms)`, plus `durationMs` and a `steps[]` list projected from GSAP labels. **No transport on the figure** — playing, looping, holding, stepping are the job of a **driver** that owns a clock and calls `seek()`. Figures register into a window registry keyed by element id (= narration mark name); a `presidocs:figure-ready` event announces liveness. Three drivers consume the one primitive: **capture** (fixed-fps virtual clock), **narration** (real-time rAF, gated on the staged figure), and **autoplay** (the figure's own scroll-into-view loop, deliberately kept inside the figure).

**Forward-seek only — a locked decision against random access.** A journey advances monotonically; revisiting means `reset()` + forward replay in small steps, never a Remotion-style `render(t)`. The trade is GSAP-specific: roughly half of figure meaning is **discrete, non-numeric state** (`textContent`/`classList` via `tl.call(...)`), which GSAP doesn't make random-access; forcing `render(t)` would re-express every text change as a numeric-proxy `onUpdate` — a structural rewrite and permanent authoring tax — to buy render-farm benefits (parallel capture, free backward scrub) this project doesn't need. Replay costs milliseconds and covers every real case. Determinism falls out of the same discipline: seeking a paused timeline at fixed fps is byte-reproducible where fps-screenshotting a self-playing figure is not.

**Interactive mode detaches the driver** on the first reader interaction with the figure's own controls (clicks, not hover/scroll); "Resume journey" re-attaches from a clean `reset()`, discarding hand-set state.

**The authoring standard lives in the `figure-journey` skill** (`.claude/skills/figure-journey/`), used to create and audit figures rather than inlined here: build paused, no `Math.random`/wall-clock/detached tweens on journey paths, exclusive control on `reset()`, steps from labels, loop-dwell baked into `durationMs`, etc. The guarantee: a conforming figure is deterministically capturable/seekable (video renders are byte-reproducible and cache-safe) and drivable (page and video show the identical journey per playhead).

**The conformance gate (`e2e/figureJourney.e2e.ts`)** enforces the standard rather than trusting review: per registered journey it asserts the structural shape (contiguous increasing steps spanning `[0, durationMs]`), that a `reset()` + forward sweep at capture fps throws nothing and yields ≥2 distinct frames, and two deeper properties:

- **Determinism** — two full passes end byte-identical: the load-bearing catch for the no-random/no-wall-clock/no-`clearProps`/no-detached-tween rules.
- **Integrity** — `reset()` must not *collapse* the distinct-frame count vs a pristine pass. This guards the one class determinism can't see: a `reset()` that `killTweensOf(...)` reaches into its own paused timeline and silently **freezes** the journey — which is still perfectly deterministic, so the determinism check alone passes it green. (Figures that legitimately rebuild on `reset()` are exempt.)

A figure no published post embeds is exercised via a dev-only `_`-prefixed fixture post — served by the dev route table, skipped by the build.

**The height gate (`e2e/figureHeight.e2e.ts`).** A figure whose box height changes mid-animation shoves the paragraphs below it — and a perfectly conformant journey can still do that, so a separate gate replays each journey's sweep reading `offsetHeight` per frame, failing on variance across driven frames (frame 0, where the narrator never rests, warns instead). Failures name the reflowing descendant and the two differing frames, so the fix — reserve the tallest state — is mechanical. Measurement is reader-faithful (real column width, the real self-hosted font asserted loaded — fallback metrics would flag wraps no reader sees) and **cache-gated on the same figure key as video capture**, so figures re-measure only when source/CSS/fonts change. This enforces figure-journey skill rule 16 (reserve every variable-height region).

**The contrast gate (`e2e/figureContrast.e2e.ts`).** The colour analogue: a seekable, height-stable figure can still drop text or graphics below the WCAG floor mid-animation, and axe only ever sees frame 0 (and never checks non-text contrast). This gate drives each journey to its **held states** (frame 0 + step boundaries — where narration rests and readers read) and computes WCAG ratios from computed style (compositing opacity + ancestor backgrounds), checking graphics (SC 1.4.11 ≥ 3:1, opt-in `data-contrast="graphic"`) and full-strength text (SC 1.4.3 ≥ 4.5:1); transient fades, deliberately-dimmed labels, and `data-contrast="exempt"` don't false-positive. Same cache key. Thresholds and the `data-contrast` convention live in `DESIGN.md` §1; this enforces skill rule 17.

## SSML usage

[SSML] has historically represented spoken-text concepts, but it is losing traction: LLM-based TTS models favour natural-language hints over SSML-like DSLs. Technical blogs also don't need most delivery markup (dramatic pauses, emotional cues). We keep exactly two SSML concepts: pronunciation lexicons and `<mark>`.

### Representing word pronunciation

Technical terms need pronunciation hints (not every model supports them natively). We use [PLS] lexicons in two places:

1. `common-terms.pls` — shared across all posts, for common technical terms.
2. An inline `<script type="application/pls+xml">` — for post-specific terms.

#### Honoring PLS without a PLS-aware engine (substitution)

No engine we use has a native PLS API (`say` ignores PLS; MOSS is an autoregressive LLM that takes text). So the lexicon is honoured by **substitution**: each matched grapheme is rewritten to its pronunciation *in-band* before synthesis — the engine never knows a lexicon existed. Code: `generate/pronunciation.ts` (`parseLexicon` + `applyLexicon`), wired into the MOSS provider. PLS is real XML, so `parseLexicon` uses `fast-xml-parser` (already a build dependency); the **matcher** stays hand-rolled — no library does in-band PLS substitution. The cross-post lexicon **merge** (`mergeLexicons`) deliberately stays a string-stitch: its byte output feeds the [TTS cache key](#audio-caching), and round-tripping through an XML serializer would change whitespace and bust every cached segment for zero behavioural gain. `say`/`espeak-ng` warn-and-ignore (they're iteration tools; the cache keys on provider, so drafts and production renders never collide).

**Respelling (`<alias>`) is the only viable tool on the local MOSS model — IPA (`<phoneme>`) is not.** The author writes a plain-English respelling ("SHA-256" → "shah two fifty six"). The rationale is specific to *probabilistic* engines: an ambiguous term has several plausible readings, each a mode a high-temperature sampler can fall into — MOSS reads a term correctly ten times, then mangles the eleventh. Rewriting to one unambiguous form is **entropy reduction at the input**: the win isn't naturalness, it's *lower variance*.

Respelling rules, learned by ear (the bar is "one *obvious* reading"):

- **Use real words** — "sha" reads as "shay"; **"shah"** is a real word with one reading. Non-word respellings ("rype") come out *worse*: the model free-associates on them.
- **Letter-names are the hardest case; standalone CAPITAL letters win** — "RIPEMD-160" → "ripe M D one sixty". Capitals get spelled correctly and resist blending into neighbours (lowercase "ripe em dee" was read "rape em dey"). Punctuation isolation ("ripe, em") fixes the vowel but adds an awkward pause.
- **Verify by ear and iterate** — the [per-segment re-roll](#per-segment-regeneration-dev-author-only) makes each tuning cycle cheap.

**Why not IPA:** the local MOSS model does not usefully interpret it (confirmed by a 4-way test). Embedded in a sentence it reads the slashes literally; as the entire input it renders garbled noise — it likely accepts only the exact token format its own g2p emits, and hand-authored IPA is also unverifiable by an author who can't read it, where anyone can hear-check a respelling. The parser still reads `<phoneme>` and `applyLexicon` emits it to an engine declaring `ipaSupported` — MOSS sets it **false**, so on MOSS every entry must carry a working `<alias>`.

**Substitution is unconditional, never detection-gated.** "Only add a lexeme for terms MOSS gets wrong" fails under sampling: a clean take proves nothing — the synthesis you didn't audit can still betray you. Any term with an entry is substituted on every synthesis. Substitution lowers the bad-roll rate, not to zero; the residual is caught by the segment cache (a good take freezes once accepted; a bad roll costs one re-roll). Lowering `audio_temperature` is the blunt last resort; the per-term respelling is the surgical fix.

**The matcher is the real risk surface** (a PLS-aware engine would tokenize for us), so its rules are deliberate:

- **Alphanumeric boundary, not regex `\b`** — `\b` is defined against `\w` and misbehaves for graphemes that start/end in punctuation (`SHA-256`). A match is valid only when neither neighbour is `[A-Za-z0-9]`: `SHA-256` matches inside `(SHA-256),` but not inside `SHA-2560`.
- **Longest-match-first** — a `RIPEMD-160` entry beats a bare `RIPEMD`.
- **Case-sensitive** — graphemes match exactly as listed; a lexeme lists case variants as separate graphemes, which is also the escape valve: anything the matcher misses, the author fixes with another `<grapheme>`.

The merged inline lexicon is in the [TTS cache key](#audio-caching) (edit → affected segments re-synthesize); `common-terms.pls` is deliberately excluded from it.

#### Sound test (dev-only pronunciation audition)

Tuning a respelling is a listening loop, and doing it inside a post is awkward (the term is buried in a paragraph, and `common-terms.pls` edits don't invalidate the post cache). The sound test is the dedicated surface: a dev-only page at `/dev/sound-test` listing every `common-terms.pls` lexeme with its production-voice audio and a re-roll button — the audition counterpart of per-segment regeneration, for the shared lexicon.

- **It synthesizes the substituted pronunciation text directly** and **keys its store on that text** — the deliberate opposite of the post cache's `common-terms.pls` exclusion, because an audition tool *must* re-render when the respelling changes. Separate store: `generated/.sound-test/<hash>.wav` (hash = voice identity + synth text; the `.`-prefix keeps it clear of `clean.ts` and the prod glob).
- **Heavy work stays offline**: the page's buttons hit dev-only endpoints (`server/dev/soundTest.dev.ts`) that shell out to `generate/sound-test.ts` (loads the multi-GB MOSS model) with the same async start-then-poll job pattern as `/dev/regenerate`; imported only by the dev server, POST gated on a session. Clips are cache-busted by `?v=<mtime>` (a re-roll writes new bytes under the same name — same sticky-media-cache hazard the post track solves by content-hashing).
- **Per-lexeme cross-post regeneration closes the audit-to-fix loop.** Each row shows which posts use the lexeme and one button re-rolls exactly those segments everywhere. Safety properties: the "occurs" check **shares the substitution matcher** (`matchesAnyGrapheme` anchors on the same boundary/case rules as `applyLexicon` — anything looser would lie about audio identity); the regen is surgical via `--force-mark` per affected post (listed marks bypass the cache; everything else hits it); the session must author *every* affected post (refuse-with-list, never silent skip) and shares a single-flight lock with audition jobs (MOSS loads one model at a time); voice resolves **per post** ([Per-author voice resolution](#per-author-voice-resolution)), while the audition clip itself uses the *session user's* voice, keeping each author's clips separate.

Auditioning every word at once is what surfaced the [leading-silence guard](#generation-pipeline) (every "S"-initial term lost its onset); the fix lives in the shared trim path, not here. The page is an engine surface (discovers the lexicon by convention, never names a post); `bun run sound-test` is the CLI equivalent.

### Connecting spoken text to blog content

Spoken text highlights the HTML it refers to — listening should eventually walk you down the whole post (auto-scroll). Blog content carries `id`s; spoken text refers to them with SSML `<mark name="foo"/>` tags ([spec][SSML-mark]). Marks are also the **splitting boundaries**: they delimit the segments that are individually synthesized and cached ([Audio caching](#audio-caching)) and the unit of per-mark navigation in the player.

#### Staging a figure from narration (`marks[].figure`)

A `<mark>`'s `name` says what to **highlight**. A second, orthogonal attribute, **`figure`**, says which [animated figure](#the-figurejourney-contract) is *on stage and driven* during a segment — for both the live page and the [video export](#video-export):

```
<mark name="intro-para" figure="diagram-a"/>   stage diagram-a while reading the lead-up
<mark name="next-step"  figure="diagram-b"/>   switch the stage to diagram-b
<mark name="wrap-up"    figure="none"/>        clear the stage early
<mark name="aside"/>                           no figure attr → carry the current stage
```

**`figure` is deliberately not an overload of `name`.** The rejected single-pointer design (figure shows iff a mark's name equals a figure id, sticky until the next such mark) couples staging to highlighting and pins figures on screen long after they're discussed. Two honest fields let a segment highlight prose while staging a figure, stage with no highlight, or clear the stage mid-paragraph — staged ≠ highlighted.

- **One staging model, no implicit fallback.** `figure` is the sole mechanism and the stage defaults to **empty** — name-matching fallback would silently reintroduce the coupling. A post must annotate to get figures in its video; the default is a safe blank stage.
- **Sticky within a sub-chapter, auto-cleared at every sub-chapter boundary** — worst case is a blank stage, never a stale figure two sections later. Omit to carry; `none`/`""` to clear.
- **Staging holds a figure at frame 1** (its `reset()` state). Advancing is a separate driving event, so staging never weakens the forward-seek invariant. One figure on stage at a time.
- A third attribute, **`step="<label>"`**, drives the staged figure to a labeled step (below); "which figure?" is always the same mark's `figure`.

One source, three readers, kept in agreement by construction: the manifest emits `figure?`/`step?` via conditional spread (un-annotated marks stay byte-identical; `""`/`"none"` records an explicit clear); the narration parser reads each attribute independently (any order); and the video renderer's `deriveFigureOccurrences` and the live narrator's `stagedFigureAt` (`client/narratorTiming.ts`) do the **same sub-chapter-bounded walk** over the same marks — deliberate twins, so page and video can never disagree about what's on stage at a playhead.

#### Live figure driving (the narration driver)

The live narrator drives each staged figure off the audio clock in the same rAF tick that tracks the active mark (`client/narrator.ts` `updateActiveFigure`, backed by pure unit-tested helpers in `client/narratorTiming.ts`) — the live-page twin of the video capture driver.

- **Keys off the staged figure, not the mark name.** Each tick resolves `stagedFigureAt(marks, tMs)`; on a staged-id change it releases the old journey and **claims** the new one (`reset()` trips the figure's exclusive-control guard so self-play stands down); `null` releases. The highlight path stays independent.
- **Elapsed time is measured from the true span start** (`sinceMs` — the staging mark's time, continuous across attr-less carries), so scrubbing into mid-span resumes mid-animation, still forward-only via `reset()` + replay.
- **Continuous mode loops by `elapsed % durationMs`**; a looping figure bakes its loop-dwell into `durationMs` (a contract rule), so the driven loop holds the final frame exactly like self-play.
- **The seek decision is a pure function** — `figureSeekPlan(lastPos, target, stepMs)`: forward steps when target ≥ last; `reset()` + replay when target < last; a fresh claim forces a reset-and-sweep.

**Stepped (slideshow) mode.** An active `step` cue switches the driver from continuous to stepped: advance to the labeled step and **hold** until a later cue. The resolver returns the latest label in the current staged span (reset on figure change or sub-chapter boundary; `"none"` clears back to continuous). The target is **`steps[label].endMs`, not `startMs`** — a locked choice: play *through* the labeled segment and rest on its final frame, because a cue means "we've reached this state." Missing labels warn and hold. Stepped figures don't loop; continuous ones do. Scrub-correctness is free — the stepped position is a pure function of the active step at time `t`.

**Autoplay stays in the figure — declined, not deferred.** Outside narration each figure keeps its own scroll-into-view play/loop via `IntersectionObserver`. Moving autoplay onto an engine driver was considered and rejected: it has no external clock (fits the driver model least), the move touches every figure for no user-visible change, and "pure renderer" is unreachable anyway while interactivity lives in the figure. The one real win (the exclusive-control footgun) is already covered by the figure-contract rule plus the conformance gate.

**Interactive mode** detaches the active driver on reader interaction; "Resume journey" re-attaches from a clean `reset()` ([FigureJourney contract](#the-figurejourney-contract)).

### Word-level timing (drawer karaoke + subtitle sidecar)

An opt-in build flag (`--align=qwen3`) adds **per-word timing** so the drawer highlights the exact word being spoken (and a future social-media subtitle pipeline has data to burn captions from — out of scope; tracked in proposal 17).

**Acquisition: forced alignment, build-time only.** No TTS provider emits word timestamps, so an aligner runs per segment in `generate/`, gated by the same disk cache as TTS: words live at `generated/.tts-cache/<text-hash>/<full-hash>.words.json` *next to* their WAV, so a re-roll invalidates both atomically, and audio cached before alignment existed gets re-aligned without re-synthesis. The cached file is read back through a zod schema that validates the version literal **and each word's `{s,e,t,d}` offsets** — a corrupt cache falls through to a fresh align instead of feeding bad offsets to the manifest; the word schema is shared with the manifest's own (`shared/manifestSchema.ts`), so the two shapes can't drift. Backend: **Qwen3-ForcedAligner-0.6B** (Apache-2.0, local, pip-installable — no Kaldi toolchain; segments sit far under its chunk cap), configured via `QWEN3_ALIGNER_DIR`/`_PYTHON`/`_DEVICE` (same pattern as MOSS). `generate/align-check.ts` is the smoke tool.

**Long-lived worker, CPU by default.** Model load dominates (~6 s load vs ~1 s compute per call), so the aligner runs as a long-lived worker (`generate/align_worker.py`) on the same stdin/stdout JSON protocol as the MOSS worker — load once, ~234 ms warm per segment, explicit `close()` on teardown. It defaults to **CPU**: the warm compute is cheap there, it hands the whole GPU to MOSS (which already over-subscribes an 11 GB card — [Memory requirements](#memory-requirements-and-device-placement)), and alignment is a timing readout, so the device never affects audio.

**The PLS wrinkle: align against spoken text, anchor against displayed text.** MOSS is fed post-substitution text ("shah two fifty six"), so alignment must run on the *substituted* string — but the drawer renders the original `SHA-256`. `applyLexiconWithMap` therefore returns an index map alongside the substituted text (`applyLexicon` is the map-discarding wrapper), and aligned offsets are projected back to original-text positions; a term spoken as multiple words collapses to a *single* word entry spanning the full duration, so the drawer highlights the displayed term continuously through the respelling excursion — what a reader following along expects.

**One alignment table, two emitters** (same pattern as chapters: one table, in-MP3 frames + JSON sidecar):

- **The manifest's `marks[].words`** — read inline by the drawer (no fetch, no parser). Each word is `{s,e,t,d}`: character offsets into the mark's displayed `text`, plus master-track absolute ms. The existing rAF tick scans the active segment's words (~30–80) and toggles `.narration-active-word`. A post without alignment has no `words` field; the drawer renders flat.
- **`generated/<slug>/captions.vtt`** — a [WebVTT] sidecar: one cue per mark, intra-cue per-word timestamps. The drawer never fetches it; its consumers are the podcast feed's `<podcast:transcript type="text/vtt">` ([Subscription feeds](#subscription-feeds-atom--podcast-rss)) and future caption tooling. Skipped entirely on unaligned posts so their file set stays byte-identical.

**Why a custom JSON shape, not WebVTT, at runtime:** the drawer slices `text.slice(s, e)` — character-offset semantics. Element-id anchor models (EPUB Media Overlays, Sync Media Lite) would force a per-word `<span id>` expansion with no consumer; WebVTT's only native parsing surface (`<track>` + `cuechange`) exposes whole cues, never intra-cue tokens, so we'd hand-parse anyway *and* pay a second fetch. The hybrid (inline JSON + derived VTT) gives each layer its natural format.

### Chapters

All spoken content lives in `<script type="text/narration" data-chapter-id="…" data-chapter-title="…">` blocks — script blocks so the text never renders on the page. Each block is one **chapter** (the player's skip unit). The type is deliberately named `text/narration`, not "SSML": only `<mark>` is allowed, and calling it SSML invites an AI author to write general SSML (`<speak>`, prosody tags) we don't support.

#### Two-level chapters (parts → sub-chapters)

Chapters have an optional second level: a chapter joins a part by setting **`data-chapter-parent="<part id>"`**. The parent is the part's **section-intro chapter** — a short spoken transition whose **first `<mark>` targets the part's labeled divider** (`<mark name="<part id>"/>` ↔ `<div class="section-divider-labeled" id="<part id>">`), so the divider lights up while the intro plays.

- **A flat attribute pointer, not nested markup** — `<script>` blocks can't nest, so every chapter stays a sibling naming its parent by id (not a dotted `parent.child` id, which would overload the id that marks and deep-links key on). Level is *derived* from the pointer's presence, never declared separately, so the two can't disagree. Zero `data-chapter-parent` attributes → a flat post whose manifest carries no hierarchy at all.
- **Deliberately not tied to `<h2>`/`<h3>` levels** — narration paraphrases, reorders, and skips (parallel narrative, not read-aloud), so spoken position doesn't track heading position. The authoring *convention* is nonetheless to mirror the outline you already wrote — one hierarchy to maintain, not two.
- **Capped at two levels**, enforced at build (`normalizeChapterParents`): a parent-of-a-parent flattens to the grandparent; a missing/later parent degrades to top-level — both **warn, never hard-fail** (don't error a batch generate over one bad post).

**A part is one entity with three faces — divider (read), spoken intro (heard), drawer entry (listed).** The prose face is a labeled **presentational `<div>`** before the part's first section, deliberately **not a heading**: a part is an audio-navigation concept, and the document outline must not depend on whether a post has narration (a narration-opt-out companion post would otherwise carry a different heading structure). Section headings stay `<h2>` everywhere; the divider sits outside the outline. It's also not `role="separator"` — a widget role that may not contain the focusable speaker button the divider carries; a plain `<div>` hosts it validly, and the button's `aria-label` carries the part name to AT. The part name is authored once (the intro's title, shown verbatim on the divider); **the spoken transition paraphrases it** — the same displayed-vs-spoken split every mark has with its element. Payoff in the chapter strip: no member heading is conscripted into naming the part; the part's first content section keeps its own title.

**Labeled dividers and headings carry "play from here" speakers.** `narrator.ts` enhances each labeled divider (and each `<h2>`/`<h3>`/`<h4>` that [headerLinks](#heading-deep-links) targets) with a speaker button that seeks to **the earliest mark whose element is at or after it in document order** (`firstMarkAfter`) and plays. Document position, not chapter membership — narration is non-linear. A part's intro anchors its first mark *on* the divider, so the divider speaker plays the part from its transition ("at or after" also covers silent dividers). The target is recomputed on click (the DOM can change after enhancement), and the seek carries the same `+10ms` nudge as chapter jumps so a boundary mark lands inside the new chapter. No button when nothing is narrated below, and none on [`data-narration="none"`](#opting-out-of-narration) posts. Headings split their two jobs: deep-link left, speaker right.

**Manifest + player.** The manifest stays a **flat, leaves-only** array — each level-2 chapter carries an optional `parentId`; a part's time range is derived (min/max over members), never stored; flat posts are byte-identical. Shikwasa is fed the untouched leaves; the grouping lives only in our `renderChapters`: one pill per top-level chapter, a part rendering as a **segmented pill** (`[N «Part» Member A / Member B]`) whose group label is the section-intro (clicking it plays the transition) and whose de-emphasized member spans each jump to their sub-chapter. A single-member part collapses to a flat pill with the intro's title.

- **Click routing is strict containment, not nearest-by-X**: the pill is one `<button>` (one Tab stop), and a click jumps only when it lands on a segment or the group label — dead zones are predictable no-ops. Nearest-by-distance would let a click on a segment's tail silently jump to its neighbour; never moving when you didn't mean to beats a sliver of extra clickable surface. Keyboard activation jumps to the part opener. Segments are `inline-block` so the hit box matches the painted hover area (plain `inline` lets hit-testing leak past the painted background).
- **Navigation granularities are deliberately split — do not "correct" into uniformity**: keyboard `1-9` → top-level chapters (the pill number *is* the key); MediaSession `previoustrack`/`nexttrack` → leaf chapters (one hardware skip = one spoken section, what a podcast listener expects).
- The page-global key handler dispatches off **`KEY_BINDINGS` in `client/narratorDom.ts`** (DOM-free, importable from a build step) — the same table the [help page](#reader-facing-help--feature-discovery) renders, so behaviour and documentation can't drift.

**Drawer face.** The drawer renders the same hierarchy: top-level headings as labeled hairline dividers, sub-chapter headings visually distinct (no leading hairline) so they never read as part boundaries even out of sticky context. Both levels are **sticky-scrolled** (parent pins to the drawer top, sub-chapter just below via a shared offset) — which forces the one place the drawer DOM departs from the flat manifest: **sub-chapter `<section>`s nest inside their parent's**, because `position: sticky` is scoped to the containing block, and a flat layout would unstick the parent the moment its own segments ended.

**Podcast feed:** the chapters sidecar has no nesting primitive, so hierarchy degrades to a flat list with part-prefixed child titles (`"<part> — <chapter>"`) — accepted lowest-common-denominator, not a reason to flatten the rich in-page surface.

### Opting out of narration

A post opts out with **`data-narration="none"`** on its `<article>`. Honoured in two places: `generate.ts` skips it cleanly (exit 0 — a batch generate doesn't choke on it), and the player's `boot()` hides the dock without fetching a manifest. The "run `bun run generate`" message is deliberately kept for the *distinct* state of a narration-wanting post that hasn't been built (manifest 404s) — three states, not two.

- **Why an attribute, not inference from missing `text/narration` blocks:** those blocks are [stripped from served HTML](#build-time-html-strip), so the production client *cannot* see whether narration content existed. The signal must survive the strip, and both the offline build and the runtime player read it off the same attribute.
- **Keep `data-narration-src` even when opted out** — the comments layer uses `[data-narration-src]` as its article-root selector; removing it silently kills commenting. The opt-out suppresses only the player.
- **The page-global CSS rule this forced:** dropping `narrator.css` on a no-narration post once reverted the whole page to `content-box` and lost the theme, because that file was doing triple duty. The page-global layer (box-sizing, design tokens, html/body theme) now lives in **`client/base.css`**, linked first by every post. The standing rule: **anything page-global lives in `base.css`, never in a feature stylesheet a post might legitimately not load.**

### Generation pipeline

Different models differ in input format (SSML/PLS/custom/none), performance (fast-and-rough vs slow-and-good; `say` is macOS-only), and output format. So the pipeline splits into:

1. **`TtsProvider`** — synthesizes narration into audio (absorbs input-format differences).
2. **`AudioPipeline`** — processes audio buffers to servable form (absorbs output-format differences). Its operations:

- `silence` — a short `--segment-gap` (default 200 ms) spliced between segments/chapters at concat time; TTS engines leave almost no pause of their own and back-to-back sentences feel rushed. Mark/chapter times are computed against the gapped layout so highlighting stays in sync.
- `duration` — read **from the WAV header's data-chunk size**, no subprocess. ffmpeg's `-stats` reports the last fully-encoded packet, under-reporting by up to ~46 ms per buffer — invisible per segment but compounding to seconds of chapter-time drift over a long post (a chapter seek then lands in the previous chapter). `ffprobe` returns N/A on piped WAVs (it won't trust a header it can't seek). The header read is sample-accurate by construction.
- `concat` — an in-memory byte-splice under one fresh header (ffmpeg's concat demuxer can't take multiple stdin pipes; PCM needs no re-encode).
- `leadingSilenceMs` / `leadingSilenceTrimMs` — raw `silencedetect` onset vs what's *safe* to trim: `max(0, onset − guard)` with a 1 s guard. **The guard exists because `silencedetect` is an amplitude detector**: a soft word-initial fricative (the "s" of "Swap") sits below threshold, the detected onset lands at the following vowel, and trimming to it clips the fricative — the bug that cost every "S"-initial term its start. Up to a guard's worth of retained lead-in is accepted; swallowing the first phoneme is not. Both the post pipeline and the sound test trim through this one guarded path.
- `trim`, `encode` — trim the start (by `leadingSilenceTrimMs`); encode the final served format.

**Silent-take guard.** MOSS occasionally emits a segment of **pure silence**; on it, `leadingSilenceMs` equals the whole duration, the trim deletes the segment, and every aligned word drops from the manifest — surfacing only much later as a cryptic `verify-narration` failure. So `generate.ts` **fails at synthesis time** when a mark-bearing segment with real content comes back fully silent (`duration − leadingSilenceMs ≤ 50 ms`), naming the marks and printing the exact `--force-mark` re-roll fix. It reuses the same silence measurement that drives the trim (fires on exactly the inputs that would break it), runs on cached buffers too (a previously-cached bad take is caught next build), and is skipped under `--mock` and for punctuation-only segments. The build exits before writing artifacts, so a working manifest is never overwritten by a silent one. If re-rolls keep coming back silent, the *line* is the problem (MOSS can choke on constructs like a spaced `" - "`) — reword it.

**Encoding.** Final format is mp3, 64 kbps mono (spoken audio; quality loss immaterial), encoded **once** at the end — concat operates on working PCM. **No loudness normalization**: measured across chapters, MOSS is uniform to ~0.3 LU with almost no dynamic range, so a gain pass is a near-no-op that risks flattening deliberate level. (The [video export](#video-export) runs its own `loudnorm` for the mux — that's the video, not this track.) The track sits ~5.6 LU below the −16 LUFS podcast convention; matching it would be one uniform-gain flag, declined as not worth it. Output is content-hash-named (`full.<hash>.mp3`) — see [Serving generated audio](#serving-generated-audio-content-hashed-filenames--dev-range-support).

**The mp3 encode writes to a seekable temp file, never `pipe:1`.** libmp3lame reserves a Xing/Info header in the first frame (carrying the exact duration) and backfills it at the end — which needs a seek. On a pipe, ffmpeg silently drops it, `HTMLMediaElement.duration` becomes `Infinity`, and Shikwasa displays **"LIVE"** instead of time remaining (its getter prefers the live element's duration, so passing the manifest duration doesn't save you — the file must carry the header). A unit test asserts the header's presence.

**Generating over a whole blog.** `generate.ts` takes one post; invoking with no path (including `bun run generate:prod`) batches over **every narrated post** via `generate/generate-all.ts`, which discovers posts by convention (recursively; never names a post) and runs each as its own subprocess with flags forwarded — the same isolated run the author would launch by hand, so provider lifecycle stays clean and one post's crash can't corrupt another. A post is generated iff it has narration blocks *and* isn't opted out (the filter reads them via `extractNarration` in `generate/narration.ts`). The batch continues past failures and exits non-zero with a summary; single-post knobs (`--chapters`, `--force-mark`) are rejected in batch mode rather than forwarded nonsensically.

### Providers: `say` for iteration, MOSS for production

Three providers behind `--tts=NAME` (default is platform-aware: `say` on macOS, `espeak-ng` elsewhere):

- **`say`** (macOS built-in) — fast, free, the iteration default; warns-and-ignores PLS.
- **`espeak-ng`** — the same iteration role on Linux (preflight prints the install command when missing); native output is already the working format, so the common path is a lossless pass-through.
- **`moss`** — production voice via the local OpenMOSS MOSS-TTS model, **voice-cloned** from a reference clip; slow and heavyweight, reserved for production renders.

They're interchangeable behind `TtsProvider`: same post, cache, pipeline, manifest code. The cache key includes provider + voice, so a `say` draft and a MOSS render coexist — re-running `--tts=say` after a production render is still instant.

#### Interchangeable to *run*, not equivalent in *output* — so production-grade is a publish gate

The artifacts differ: iteration engines skip PLS and continuity, and only production renders pair with forced alignment — yet nothing in an MP3's bytes reveals which engine made it. A stray default `bun run generate` silently overwrites a post with degraded audio (wrong voice, no word timing) that still plays. So the manifest records a **`provenance`** block (`tts`, `voice`, `aligner`, `mock`), and `generate/verify-narration.ts` — in the `deploy` chain ahead of the build, beside the audit gates — refuses to publish any manifest not built with the production voice *and* alignment, or built `--mock`. Provenance is deliberately **outside** the content-addressed manifest-name hash (the engine already shows up in the hashed audio bytes), so an unchanged regenerate stays byte-identical and cache-warm. The publish-time sibling of `audit-posts`.

**MOSS integration shape.** MOSS is a separate Python project (own multi-GB model + venv), located via `MOSS_TTS_DIR` (+ `_PYTHON`, `_DEVICE` — per-machine paths, hence env vars; the voice clip is per-blog and committed, hence not). The factory validates interpreter and clip up front — fail immediately, not 30 segments in.

- **Model load dominates → long-lived worker** (`generate/moss_worker.py`): spawn once, load once, one line-delimited-JSON request per segment (WAV to a temp path; stdout carries only protocol, chatter to stderr). Spawned **lazily on first cache miss** — a fully-cached rebuild never starts Python. The flip side: **`provider.close()` is mandatory teardown** — without it the worker's stdout reader keeps Bun's event loop alive and the process hangs *after* finishing (this also once left the regenerate endpoint's job stuck `running` forever). `close()` is optional in the `TtsProvider` contract; stateless providers omit it.
- **Voice cloning is per-call**, re-supplying the reference clip each generation — the amortized cost is the model load, not the cloning. The cache key hashes the clip's *contents* (`cacheVoiceId`), not its path. MOSS has no words/min knob (`--rate` warns-and-ignores); PLS is honoured via [substitution](#honoring-pls-without-a-pls-aware-engine-substitution).
- **Sample-rate matching is the provider's problem** — inherent to PCM, not a MOSS quirk: a WAV stores one rate in its header and `concat` is a byte-splice under a single header, so every segment must already be at the working rate. MOSS resamples 24 kHz → working rate **only when they differ** (a 24 kHz working rate makes production resample-free). The resample round-trips a temp file because the WAV muxer can't fix RIFF sizes on a non-seekable pipe.
- **Trailing-artifact trim**: autoregressive TTS appends a brief noise burst after the last word; the provider cuts a short (≤200 ms) post-silence tail per segment, keeping the silence as a natural pause. A structural no-op for engines without the artifact.

#### Cross-segment continuity (`SegmentContext`)

Per-`<mark>` synthesis makes expressive engines restart every sentence at top-of-paragraph energy — audible seams mid-chapter. Whole-paragraph synthesis would flow naturally but was rejected: one blob has no internal mark alignment (per-mark times would need forced alignment to recover) and the cache would collapse from per-sentence to per-paragraph. So synthesis stays per-segment and the engine gets **context about what came before** instead.

The contract is provider-agnostic: `synthesize(text, context?)` takes `{ continuesPrevious, previousText?, previousAudio? }`, each provider using what it supports (`say` ignores it). Continuity isn't a MOSS feature — every expressive engine has some version (request-stitching, style strings, prior-audio conditioning), which is why it lives in the generic contract. `continuesPrevious` derives from the narration's **paragraph structure** (blank line before a mark = fresh start; soft wrapping = continuation), so a paragraph break is the author's delivery-reset lever.

**`SegmentContext` never enters the TTS cache key** — it's best-effort conditioning, not identity. A segment is conditioned on its neighbour as of synth time and *not* re-synthesized when the neighbour drifts, preserving "edit one sentence → re-synthesize one sentence." Same staleness trade as the `common-terms.pls` exclusion; `rm -rf generated/.tts-cache` re-conditions everything.

Strategy is selected by `MOSS_TTS_CONTINUATION` (`instruction` default | `acoustic` | `off`):

- **`instruction` (default, the winner).** Continuing segments get a free-text delivery hint; fresh starts get none. Single-shot, cache-safe, and the most portable layer. The hard-won lesson: **a blunt, natural hint beats an elaborate one** — the production hint is essentially "talk like you're continuing an existing paragraph"; a wordier "even, conversational tone" backfired (too-soft, trailing-in first word). With the segment gap, output is effectively indistinguishable from human recording.
- **`acoustic` (opt-in; a net loss on the local 1.7B model).** Feeds the previous segment's actual audio as multi-turn context. In practice: tone drift, broken clips, and **quality compounding downhill across a chapter** — the tell that each continuation re-tokenizes our own already-degraded output (resampled + trimmed model audio), an accumulating feedback loop on top of a model size that reserves multi-turn coherence for larger variants. Kept behind the flag to retry on an 8B-class model — and if so, feed the *pre-resample, pre-trim* native audio to break the compounding.
- **`off`** — every segment a fresh utterance.

#### Per-author voice resolution

Multiple authors mean multiple clone clips, and re-rolling a post in someone else's voice is a **correctness** bug: voice is in the TTS cache key, but the current `full.<hash>` would still be overwritten with wrong-voice audio. So everything that touches a post — `generate.ts`, `/dev/regenerate`, the sound-test sweep — resolves the clip **per post** and passes an explicit `--voice=`.

Convention: **`authors/<author-email>.wav`** — the same per-author folder as the profile/avatar, same email key; discoverable by listing, no config to sync. A missing file is a **structured refusal naming the post and path** — never a silent fallback to the wrong voice. **No env-var default, on purpose**: a global default becomes "the wrong voice for half the posts" the moment a second author appears; a single-author blog just commits one file. Emails are lowercased and used verbatim as filenames; one containing a path-escaping character (`/`, `\`, NUL, leading dot) is **refused outright** — same structured-refusal path as a missing file. Cache identity is unaffected (the clip's *contents* are hashed).

**Deliberate non-requirement: one voice per post.** No multi-voice posts — the whole engine bakes it in (no voice in `SegmentContext`, one provider per spawn, one `cacheVoiceId` per segment). Content needing a different voice is its own post with its own `author-email`. The sound-test audition uses the session user's own voice for the same reason.

**Environment gotcha worth keeping:** MOSS decodes the reference clip through `torchcodec`, which `dlopen`s system FFmpeg libs — and a venv Python's loader path doesn't include them, so it fails even with a compatible FFmpeg installed (the error misleadingly blames every FFmpeg version; the real failure is "couldn't find `libavcodec` at all"). The provider adds FFmpeg's lib dir to the worker's loader path (`LD_LIBRARY_PATH`/`DYLD_FALLBACK_LIBRARY_PATH`, derived from the `ffmpeg` CLI's prefix, overridable via `MOSS_TTS_FFMPEG_LIB`).

#### Memory requirements and device placement

A production render (`--tts=moss --align=qwen3`) runs two torch models whose combined footprint exceeds an 11 GB GPU, so placement is deliberate (measured on an RTX 2080 Ti, WSL2):

- **MOSS LM — GPU, bf16, ≈6 GB.** The only piece in the autoregressive hot loop. (bf16 is fine here: the LM's output is sampled token IDs, not a waveform.)
- **MOSS audio codec — CPU, float32, ≈7.2 GB** (`MOSS_TTS_CODEC_DEVICE` overrides). Bigger, but used only to encode the reference clip and decode output codes — never in the hot loop; ~0.6 s/segment on CPU.
- **Qwen3 aligner — CPU, ≈1.85 GB.** ~234 ms warm per segment; a timing readout, so the device never affects audio.

Everything-on-GPU totals ≈15 GB (MOSS alone ≈13.4 GB) — over an 11 GB card. Native CUDA OOMs; **WSL2 instead pages overflow to host RAM over PCIe and thrashes**: measured on a stress segment, codec-on-GPU ran 4.55 s/token at 0 GB free vs codec-on-CPU at 0.43 s/token — ~10× faster with headroom. (Over-allocation surfaces *asynchronously* as a misleading `device not ready`/OOM at an unrelated call; `CUDA_LAUNCH_BLOCKING=1` pins the real site.) Unified-memory machines (Apple Silicon) have no separate VRAM ceiling and can keep the codec with the LM.

Two cache-integrity constraints: CPU decoding is **audio-neutral** (identical tokens decode to within float epsilon of the GPU result — RMS −118 dBFS, correlation 1.0), so CPU- and GPU-decoded segments are interchangeable in the cache; but casting the codec to **bf16** (which would fit it on-card at ≈3.6 GB) *perturbs the synthesized audio* and would invalidate every cached float32 segment — so the codec stays float32 on CPU.

**Don't set `PYTORCH_ALLOC_CONF=expandable_segments:True` under WSL2**: it's the textbook fragmentation fix, but it allocates via CUDA's virtual-memory API, which is incompatible with WSL2's system-memory fallback — MOSS then fails at model load with a misleading `CUDA driver error: device not ready`. Fragmentation is handled with `torch.cuda.empty_cache()` between segments instead (and is unlikely anyway with the codec and aligner off-GPU); a non-WSL box can opt in via the environment.

## Audio caching

Synthesis is slow (seconds-to-minutes per segment) and the authoring loop is "tweak one sentence, regenerate" — so audio is cached per **segment** (the text between two `<mark>` boundaries), never per chapter.

**The cache key** is a sha256 over every input that influences the synthesized bytes: provider name; **voice as a machine-independent id** (`say`'s is a stable name; MOSS's is a clip resolved to a per-machine absolute path, so the provider exposes `cacheVoiceId` = a content hash of the clip — a path key would miss on every other machine and re-cache a moved clip); rate; output format; the merged **inline** PLS lexicon XML — with each source labelled by its **repo-root-relative** path, never an absolute one (an absolute path once silently split the cache between the CLI and the regenerate endpoint, turning every button click into a cold re-render); and the segment text. An inline `<lexeme>` edit invalidates every segment in *that post* — coarse but correct (we can't cheaply tell which segments used which grapheme), and inline lexicons are small.

**`common-terms.pls` is deliberately excluded from the key**: including it would make one shared-lexicon edit invalidate every cached segment across every post. The trade: after editing it, force the affected segments by hand (the [sound test's cross-post sweep](#sound-test-dev-only-pronunciation-audition) is the tool).

**`figure=`/`step=` annotations must not invalidate this cache or the alignment cache — and don't, by construction**: the key is over the segment *text* (the prose between marks); mark attributes are never part of the synthesized string. Annotating a settled post costs a manifest-filename rehash, never a re-render. Re-*segmenting* prose into more marks does change segment texts and synthesizes the new ones once — an authoring cost, not a breach. A test pins this invariant (identical segment text ⇒ identical TTS key + alignment hash across bare/+figure/+step inputs) rather than leaving it to reasoning.

**The value** is the raw provider output (working-format WAV) captured *before* trim/concat/encode — the downstream ops are cheap and deterministic, so caching them would only bloat.

**Layout** is two-layer, `generated/.tts-cache/<text-hash>/<full-hash>.wav`, shared across posts: the text-hash bucket exists purely for GC. Each generate run overwrites `generated/<slug>/cache-keys.json` with the post's *current* text-hashes; `bun run clean <slug>` deletes the post's artifacts and reaps any bucket no other post's index references. So a removed sentence reaps its whole bucket (every voice/rate variant), while a voice change just adds files beside the old ones. `--mock` bypasses the cache entirely (placeholder silence is already instant).

**`--chapters=ID[,…]` truncates a build to named chapters** — the coarse sibling of `--force-mark`: synthesis is skipped entirely outside the kept chapters, and the audio/manifest/captions contain only them. Built for first end-to-end runs on long unbuilt posts (prove the pipeline on two chapters before committing hours). A kept sub-chapter whose parent is filtered re-parents to top level; unmatched IDs warn, never fail.

### Per-segment regeneration (dev, author-only)

MOSS is probabilistic — a term synthesizes correctly nine times and mangles the tenth — so the author needs to **re-roll one segment until it sounds right** without re-rendering the post: a button on each segment in the spoken-script drawer.

The mechanism reuses the cache because an isolated single-segment path *can't cleanly exist*: durations cascade (one segment's length shifts every later mark and chapter time, and the track must re-concatenate under a new hash). So "regenerate this segment" is really *force-resynthesize one, rebuild the whole post* — cheap, since every other segment is a cache hit:

- **`generate --force-mark=<name>`** bypasses the cache *hit* for that mark's segment, re-synthesizes, and **overwrites** the stored bytes — the accepted re-roll becomes the cached take. Everything else hits; manifest + track rebuild normally.
- **`POST /dev/regenerate`** (`server/dev/regenerate.dev.ts`) shells out to that command (`?tts` ∈ {say, moss}, defaulting to moss — the client always uses the default). Dev-only (imported only by the dev server — it loads a multi-GB model, exactly the trusted-localhost work the dumb-edge rule exempts) and author-only (the same server-authoritative `isPostAuthor` check as the version endpoint). Voice resolves [per the post's author](#per-author-voice-resolution); a missing clip refuses with a 400 before any spawn. **Async by design**: even a one-segment re-roll outlives `Bun.serve`'s idle timeout (the model load alone does), and an awaited subprocess would have its connection killed mid-run — so POST starts the job and returns `202`, `GET` reports status, the client polls. Single-flight (concurrent POST → 409).
- **Cold-cache caveat**: the button is "one segment fast" only when the rest of the post is cached for the *current* voice + lexicon (voice is in the key) — clicking after a voice change silently becomes a full re-synthesis. Workflow: one `generate:prod` to settle the post at its final voice, *then* per-segment re-rolls.
- **The client button** (localhost + `isAuthor` gated; readers short-circuit before any fetch) polls until the job finishes — the spinner tracks the render, not a connection that times out — then sets the URL hash to the segment and hard-reloads (deliberately: bulletproof, and dwarfed by the model-load latency). Each segment also shows its mark `name` as a click-to-copy label — the exact token `--force-mark` expects, so batch re-rolls read names off the drawer instead of the post source.

This is the operational backstop of the [pronunciation strategy](#representing-word-pronunciation): substitution lowers the bad-roll rate, the cache freezes good takes, per-segment re-roll cleans the residue.

## Audio Player

The player is [shikwasa](https://shikwasa.js.org/), wrapped with:

- **Chapter pills** (skip via strip or `1-9`), play/pause (button or **Space, armed from page load** — the shortcuts are how a convention-knowing reader starts the talk cold, and they're treated as one coherent group: no per-key engagement gating, and the lost default Space-scroll is an accepted trade on a player-bearing page).
- Speed control, ±10 s skip (arrows too), progress bar + timer.
- **Hide/show highlighting** — also pauses auto-scroll (for screenshots), snapping back on re-enable. Highlights stay logically processed while hidden: recomputing state on re-enable would be more complex and slower than just not painting.
- **Release/re-acquire the OS media surface** — a headset-glyph toggle; OFF tears down metadata + handlers and gates the position push, persisted globally (`narrate-capture-controls` in localStorage — it's about the reader's relationship to their own music, not one talk). On-screen controls are untouched. Partial by platform design — see [OS media controls](#os-media-controls-media-session-api).
- **Close/reopen**: the in-player × closes; a floating "Listen" pill (hidden while the dock is open) reopens. Both drive off one `dock.dataset.hidden` flag, so the two affordances never coexist on screen — which also prevents two headphone glyphs competing for meaning. One layout invariant with an e2e pin (`e2e/narrationDockHitArea.e2e.ts`): **the seek bar's hit area must never reach the ×** — the bar is absolutely positioned so `padding-right` doesn't move it, and it can't be z-lifted over the × without stealing the ×'s clicks, so its right edge is inset to the content box in the horizontal layout.

### Loading the player: a lazy boot, off the critical path

`narrator.ts` statically imports Shikwasa, making it the largest non-reading-critical slice of eager JS — so it doesn't load eagerly. A tiny `client/narratorLoader.ts` `import()`s it as its own chunk on first relevant engagement (player keystroke or `pointerdown`) or at a `requestIdleCallback` fallback, so a passive reader still gets the dock mounted and figure driving armed. A `#spoken-…` deep link boots eagerly so the hash-seek lands. GSAP and the figures stay eager (they must register on load) — the defer covers Shikwasa + the player only. This is a deliberate instance of the [paint-over-blocking-time trade](#performance--web-vitals-lighthouse-measurement): the idle parse can raise lab TBT while lowering FCP/LCP, and for a reader who reads before playing, the faster paint is the felt win.

**The drawer body defers a second level down — and the comment system, not the narrator, decides when to build it.** The script drawer's body (per-segment `<article>`s, per-word spans — thousands of nodes) is the bulk of the narrator's DOM and boot-time layout, so `boot()` builds only the shell and defers the body to an idempotent `ensureDrawerBody()`, triggered by: the reader opening the panel, a `#spoken-…` deep link, or — the subtle case — the comment system requesting it. The drawer is the narration-comment surface, so it must be fully built before comments touch it — but comments are login-gated, and logged-out is both the common case and what Lighthouse measures. The narrator never learns login state (it can't cheaply — the cookie is `HttpOnly`); the component that *does* resolve identity requests the body, only when logged in. The handshake is three constants in `narratorDom.ts` (sentinel + request event + ready event), order-independent; the logged-in order is always build → index → paint, so a highlight can't be clobbered by a later rebuild. Net: the logged-out majority skips the drawer DOM entirely until they open the script. (This is the worked example the [privacy checklist](#considering-privacy-for-new-features) cites against minting login-hint cookies.)

**Cold-start shortcuts survive the defer**: the loader arms the same `KEY_BINDINGS` table eagerly (light — no Shikwasa), `preventDefault`s the first matching key, and hands it to `boot(pendingKey)`, which replays it once the player is live — a cold Space still plays, absorbing one async import.

Like the comments split, this only works under **`Bun.build({ splitting: true })`**; the boundary is guarded by `client/narrator.budget.test.ts` (the loader must never statically import `narrator.ts`, Shikwasa, or the figure machinery).

### Chapter strip

Code: `client/narrator.ts` + `client/narrator.css`.

One pill per chapter in a **single horizontally-scrolling, fixed-height row** (a multi-row wrap would shove the article down). Scrolling is discoverable three ways: native touch swipe; wheel-over-strip (vertical wheel translated to horizontal — browsers don't do it reliably); and press-and-hold ‹/› arrows on fine-pointer devices when the strip actually overflows (eased-in speed, active pill auto-scrolled into view, edge fade hinting more content).

Two constraints worth keeping so they aren't reintroduced:

- **The strip floats over the white article, not the dark player card** — arrows styled to the dock palette would be white-on-white.
- **No CSS scroll-snap** — snapping reverts sub-pill increments to the nearest pill, silently swallowing the hold-arrows' per-frame nudges and the wheel's small deltas.

Shikwasa notes: its `seek()` calls `parseInt` (truncating fractions) — bypassed with our own `seekToMs`; chapter seeks add `+10 ms` so a mark on the exact boundary lands *inside* the new chapter for its range check; its `timeupdate`-driven progress bar (~4 Hz + transition) is replaced by a write from our rAF tick, so the bar advances smoothly; `theme: "dark"` is forced; and **CSS overrides win by cascade-layer order, not specificity** — Shikwasa's stylesheet routes through `@layer vendor`, our `.shk-*` overrides live in the later `engine-components` layer, so bare-class selectors win without `!important` ([Cascade-layer architecture](#cascade-layer-architecture)).

### Script & outline drawer: two panels, one slot

Code: `client/narrator.ts` + `client/narrator.css`.

The left-edge drawer hosts the spoken **script** and the article **outline**. Their exclusivity is **a DOM shape, not a rule**: one `<aside id="narrate-drawer">` with one `data-panel` attribute and two sibling bodies, exactly one non-`hidden` — a second drawer would make "only one open" a two-component protocol; one element makes it unrepresentable.

Closed, two stacked edge tabs open the drawer straight to a panel (both fold away while open). Open, the header carries the panel switcher (two `aria-pressed` buttons; the active panel's name *is* the title). Each panel's body builds deferred on first need.

**The outline sources from the article DOM, not the manifest** — it's a *reading* tool: every heading listed whether or not narration speaks it, linking the same ids [heading deep-links](#heading-deep-links) guarantee (`collectOutline` walks dividers + `h2`/`h3`; `h4` is deliberately out — noise at outline altitude). Entries are real `<a href="#id">`s, so navigation is native and **the drawer stays open** — a browsing surface dismisses on the reader's explicit ×, never as a navigation side effect. A scroll-spy (armed only on the open∧outline state edges, rAF-coalesced) marks the current section with `aria-current="location"`, reusing the chapter strip's active-pill treatment — one "you are here" vocabulary engine-wide.

**Comment-anchor invariant — why the chrome is shaped this way.** The comment indexer walks the whole drawer and hands out *positional* fallback ids, so restructuring the drawer could renumber every existing narration anchor into the stale state. Two measures keep the walker-visible block sequence byte-identical: **`walkBlocks` skips `<nav>` subtrees entirely** (navigation lists pointers to content, not content), so the switcher and the whole outline panel live in `<nav>` elements the indexer never sees; and the old drawer title survives as a **visually-hidden `<h2>` at the top of the script body** — same text, same walk position, so block numbering is unchanged (it also titles the panel for screen readers). The `<nav>` skip is load-bearing: outline entries get real `h3`/`ol`/`li` semantics precisely *because* the walker can't see them. `e2e/outlineDrawer.e2e.ts` pins the visible contract.

## Player & sync

Code: `client/narrator.ts`.

Highlight/scroll must stay in sync with the player through every control path. Two architectural points:

- Active-mark tracking reads `player.currentTime` on **`requestAnimationFrame`**, not the `timeupdate` event (~4 Hz — too coarse for sentence-level marks).
- Active mark = "latest mark whose `time` ≤ `currentTime`", recomputed each tick, so backward seeks cost nothing special.

### OS media controls (Media Session API)

`setupMediaSession()` wires the [Media Session API][MediaSession] so a talk behaves like any OS-known audio: lock screen / Now Playing metadata, hardware and Bluetooth keys, OS seek. It is **armed on the user's first explicit play**, not at `init()`: UAs only route media keys to a tab after a real `play()` anyway, so early registration bought nothing — and deferring means a passive reader's OS "now playing" is never polluted, and a reader listening to their own music doesn't get their headset tap silently reassigned by *visiting* a post. Pieces:

- **Metadata** from the same `data-narration-*` attributes the dock uses (artwork deliberately empty — no cover asset yet).
- **Action handlers route into the existing controls** — one code path per gesture:

  | MediaSession action | Routes to |
  |---|---|
  | `play` / `pause` / `stop` | `player.play()` / `pause()` (stop maps to pause) |
  | `seekforward` / `seekbackward` | `skipBy(±offset)` (the dock's 10 s buttons; OS offset honoured) |
  | `seekto` | `seekToMs()` |
  | `previoustrack` / `nexttrack` | `jumpToChapterDelta(∓1)` — a chaptered talk's "track" is its chapter; no wraparound |

  Registration goes through a `safeSet` that swallows per-action throws (UAs differ in exposed actions), so one unsupported action can't block the rest.
- **Position + state**: `setPositionState` is pushed from the same rAF tick as the highlight (the canonical clock), with position clamped to duration (the spec throws past it). `playbackState` is set explicitly in play/pause/ended — UA inference can disagree with reality right after a programmatic `currentTime` write, stranding the lock screen on the wrong icon.

Gated on `"mediaSession" in navigator`; pure runtime. It's the OS-surface input path; the document key listeners are the focused-window path; both call the same player methods.

**Releasing the surface.** The capture toggle's OFF path (`teardownMediaSession`) nulls every handler, clears metadata, and sets `playbackState = "none"`. Two `captureControls` guards — on the `setPlaybackState` helper and the rAF position push — are load-bearing: they're the chokepoints that stop the very next `onPlay` or tick from re-acquiring the session a frame after teardown. The preference is read at `init()` before first-play arming, so a returning released reader stays released.

**What release does NOT release — a platform constraint, not a bug.** The spec defines *default actions* for `play`/`pause`/`stop` when no handler is registered: they fall back to controlling the active media element directly, and our tab stays the active session while the `<audio>` holds a loaded source. Skip/seek actions have **no** defaults, so those genuinely release. Fully releasing play/pause would require clearing `audio.src` — stopping the talk and re-buffering on re-arm — considered and **rejected**: the common case is "keep listening, just give me my skip key back," not "stop my talk." The stronger guarantee for passive readers is the deferred arming itself: never played → nothing captured; the toggle is the escape hatch for readers who did engage.

## Manifest format

File: `generated/<slug>/manifest.<hash>.json`.

- Times are **absolute milliseconds in the master track** — the player never learns the audio was assembled from per-chapter files. Mark times account for silence trimming, so sync can't drift.
- `audio` points at the content-hashed track (`full.<hash>.mp3`); `audioDigest` is the **full** SHA-256 hex (the filename token is its 16-hex prefix), backing the stable URL's `Repr-Digest` and the feed's `<podcast:integrity>` — the surfaces needing a full, algorithm-tagged digest.
- Each `marks[]` entry is `{ name, time, chapter, text, words? }` plus the optional [`figure?`/`step?`](#staging-a-figure-from-narration-marksfigure) pointers, emitted by conditional-spread so an un-annotated mark stays byte-identical.
- **One schema, not four hand-rolls.** The manifest shape is declared once as a zod schema (`shared/manifestSchema.ts`); narrator, video renderer, and feeds import the `z.infer` types, so a producer↔consumer mismatch is a compile error. Time fields reuse the branded milliseconds schema. Crucially the schema is **a type/validation layer only, never the serializer**: `generate.ts` owns the write verbatim — its conditional-spreads keep absent keys *absent*, which is what holds the byte-identical cache invariant; routing the write through zod would flip absent to present and bust every cached manifest. The narrator additionally `safeParse`s the fetched manifest (under the shared `zodJitless` CSP discipline), so a stale/half-written manifest fails into the existing "Narration unavailable" branch instead of a later `undefined.marks`.

## Serving generated audio (content-hashed filenames + dev range support)

The final track is **`full.<hash>.mp3`** — a 16-hex content hash in the filename, referenced by the manifest's `audio` URL. That is the cache-busting contract for dev and prod both: the URL changes whenever the bytes change, so a regenerated track always fetches fresh and an unchanged one caches forever; the player only ever reads `manifest.audio`, so the scheme is invisible to it. The track is served **from R2, not the asset bundle** (a long track exceeds the 25 MiB per-asset cap): `copy-static` excludes it, the deploy uploads it (`upload-audio-r2.ts`), the Worker streams it from `env.AUDIO` (falling back to the bundle for repos without the binding). Everything below applies identically from either source.

**Why R2, not the two obvious dodges.** Serving the per-chapter tracks (each under the cap) would fracture the one contract everything keys on — *a single continuous track with absolute mark times*: word sync, figure staging, auto-scroll, the video's master track, and the single-enclosure podcast episode all ride one monotonic timeline. Hosting off-Cloudflare dodges the cap but changes the enclosure URL, splits the origin (re-opening CORS/CORP questions), and forfeits the unified Range/`Repr-Digest`/canonical-link path. R2 removes the limit with no contract change and no egress charge through the Worker.

**`preload="none"` — a passive reader pays no audio bytes.** A 30-minute talk is ~14 MB, and Chrome's `preload="auto"` pulls most of it eagerly. Shikwasa gets the duration from `manifest.duration`, so the scrub bar is correct with no metadata fetch; the first play pays one ~200–500 ms connection cost, then Range takes over. This shares the "first explicit play" signal that arms OS media controls and global shortcuts — one mental model: take nothing from a reader who hasn't pressed play.

**Why hash the filename rather than tune cache headers.** Chrome keeps a dedicated media cache for `<audio>` that a hard refresh does **not** evict, and `no-cache` without a validator doesn't reliably dislodge it — a regenerated stable-named track keeps replaying stale bytes (masked on small tracks, which play from cache regardless; fatal on long ones). Content-hashing sidesteps the class: a fresh URL is in *no* cache, so correctness stops depending on revalidation headers anyone can misconfigure. Each generate run **sweeps** superseded `full.*` files; the R2 uploader reconciles to the live track **plus one prior** per post — grace for an in-flight client racing a deploy (a podcast app mid-download, a warm edge entry); nothing current references a superseded hash, so the extra copy just ages out a deploy later. The uploader keeps a **separate upload-state index per mode** (real R2 vs Miniflare) — a shared index would let a local seed convince a real deploy a track is already uploaded, leaving prod to 404.

**The manifest is content-addressed too** (`manifest.<hash>.json`, hashed over its narration-bearing fields so an unchanged regenerate stays cache-warm). It's the index that discovers the current track URL, so at a stable name it would carry the same hazard one level up — the SW's cache-first store and the CDN both pin it, and a stale index points at a swept track (`NotSupportedError`, or a stand-in's wrong duration). The author writes a stable `data-narration-src=".../manifest.json"`; the build's HTML strip rewrites it to the hashed name, and the dev server resolves the bare name on the fly. Superseded manifests sweep like tracks.

**`immutable` is the header-side half of the contract** ([RFC 8246][ImmutableResponses]): a content-hashed URL asserts the bytes never change; `Cache-Control: … immutable` tells clients to skip revalidation even on explicit reload (and Chrome's media cache honours `immutable` where it ignores `no-cache`). Both servers set it on hashed assets — the Worker gates on `isContentHashedAsset` (hash-bearing `full.*`/`manifest.*`/`video.*`/`chunk-*`), never on stable names. **The invariant that keeps it safe: `immutable` is only ever valid on a URL whose bytes are pinned by the URL itself.** Setting it on a stable-named mutable file (`chapters.json`, a bare `manifest.json`) recreates exactly the staleness class content-addressing closes. One deliberate exception: **`/fonts/`** — stable-named woff2 served `immutable` anyway, because the faces change so rarely that saving every returning reader's conditional GET outweighs a rare font change having to wait out the cache (the header was chosen over content-hashing the names, which would re-add build machinery for an asset this stable). The hashed audio also carries `Link: <…/episode.<ext>>; rel="canonical"` — the HTTP face of the resource-vs-representation split. None of this can ride `dist/_headers`: under `run_worker_first` it isn't applied to Worker responses, so the policy lives in code, where the same predicate bounds which names qualify.

**Dev range support.** A browser media element won't *start* a large audio file it can't seek into — it needs `206` + `Accept-Ranges`. The dev server's `serveFromDir` honours `Range` (suffix and open-ended forms included); without it a multi-MB track streams unbounded with no length and Chrome refuses to begin (small files buffer whole and mask the bug). Prod's asset layer already does ranges, so this keeps dev aligned. The parser is `shared/httpRange.ts`, shared by **all three** consumers (dev server, the prod Worker's `applyRangeSupport` — `env.ASSETS` ignores `Range` — and the copy-time splice into the [service worker](#offline--pwa)). `HEAD` returns a bodyless `200`, never `206` — RFC 9110 defines range handling for `GET` only.

### Stable shareable episode URL

URL: `/generated/<slug>/episode.<ext>`.

The hashed URL is perfect for the player and wrong for anything that *freezes* — a copied link, a chat message, a subscriber's cached `podcast.xml` — because the next generate sweeps the old hash and the frozen link 404s. So each episode has a second, **stable** URL that always resolves to the current track: hashed for the player, stable for sharing and the feed `<enclosure>`.

**Why a stable URL is safe *here* specifically:** content-hashing exists to defeat version skew across interdependent assets; a standalone MP3 has no dependents — you get the whole old file or the whole new one, either plays. So the hazard doesn't apply, and stable-URL-plus-**revalidation** is principled: cache-busting moves off URL identity (impossible once a link freezes) onto the validator.

Served identically in both runtimes, headers computed in shared code (`shared/stableAudio.ts`). Dev globs for the current hashed file; prod resolves via a build-time `slug → {audio, digest}` map and fetches the hashed bytes — **pure indirection, never a physical copy** (a copy would double every track and split the header logic). The header contract is the exact inverse of the hashed path:

- **Strong `ETag` = the content hash**, on `200` *and* `206` — strong so it validates `If-Range` and so caches may combine partials only within one version.
- `Cache-Control: no-cache` to the browser (store-but-revalidate; a `304` is cheap) + `CDN-Cache-Control: max-age=60, stale-while-revalidate=604800` to the edge — offload without an immutable-style stale window. **Never `immutable`** (the hashed path's directive) and **never `must-revalidate`** (it would forbid the stale-while-revalidate serving).
- **`If-Range` honoured** — a stale validator makes the server ignore `Range` and send the full current file, so a client seeking across a regeneration can't stitch two versions; the ETag on every `206` protects bare-`Range` clients that never send it.
- `Content-Disposition: inline; filename=<slug>.<ext>` — inline so players stream, but "Save As" gets a per-post name. Built by jshttp `content-disposition` **v2 specifically**: v1/tinyhttp emit a latin1 `filename` fallback that corrupts under the UTF-8 header serialization workerd uses, where v2 emits a pure-ASCII token plus an always-present RFC 5987 `filename*`, so non-ASCII slugs round-trip.

**The service worker passes this URL through** (no `respondWith`): every other `/generated/*` URL is content-addressed and cache-first, but this is the lone mutable one — cache-first would re-pin it stale, the exact failure it exists to avoid.

**Integrity surfaces.** From `manifest.audioDigest`, the stable response carries `Repr-Digest: sha-256=:…:` (representation-level, so valid unchanged on `206`/`304`), and the feed advertises `<podcast:alternateEnclosure>` with both URLs plus an SRI integrity tag — derived in `shared/audioDigest.ts`, kept out of the client bundle. The hex↔base64 conversions here use the native `Uint8Array.fromHex()`/`toBase64()` codecs (present in Bun and the pinned workerd, alphabet-correct by default); the two *reader-facing* copies of those loops stay deliberately hand-rolled — see [Storage layer](#storage-layer) for the Baseline-availability reasoning.

**Rejected alternatives:** a `?v=<hash>` query param (a copied URL freezes the old value and CDNs key on the query — stale forever); a 302 to the hashed file (podcast clients persist the *resolved* URL, and permanent redirects are heuristically cacheable, re-pinning a deleted hash); a retention window for old hashes (only delays the 404 and reintroduces the stale-file hazard the mirror removes).

## Video export

Code: `generate/render-video.ts`.

A narrated post renders offline into a content-addressed `video.<hash>.mp4` — narration with burned karaoke captions, a centred voice equalizer, chapter chrome, and every [figure](#the-figurejourney-contract) animated, driven, and stepped exactly as on the live page. **Local-only**: the author uploads to platforms and prunes by hand; it is never served ([Copying static artifacts](#copying-static-artifacts-into-dist)). The renderer consumes only artifacts the build already emits (manifest, audio track, `captions.vtt`) plus one headless figure-capture pass, and composites with an ffmpeg filtergraph — no per-frame JS render loop.

### Invocation: a manual CLI, never the build

`bun run video <slug> [startMs] [endMs]` (the script lives in the *content* repo), run after audio generation. **The build never invokes it, so it can't fail a build.** The `VIDEO=` gate in `.env.example` is documentation-only — not wired. The pipeline degrades rather than fails: a non-animated figure composites as a still, and marks without word timings simply get no caption cue (there is no sentence-level fallback — full captions need an aligned post).

### Inputs and output geometry

| Ingredient | Source |
|---|---|
| Audio | `generated/<slug>/full.<hash>.mp3` (one `loudnorm` pass → AAC) |
| Captions | `captions.vtt` → karaoke `.ass` (`buildKaraokeAss`) |
| Title/intro plate | satori-rendered in-pipeline (via the share card's shared `renderElementToPng` — the function, not the PNG) |
| Timeline | the manifest — `duration`, `chapters[]`, `marks[]` (incl. `words`/`figure`/`step`); authoritative, nothing re-derived from audio |
| Figures | headless capture → `.video-cache/fig-<key>.{mp4,png}` |

Figure timing, captions, chapters, and staging all come from the same manifest the live narrator consumes — the renderer's `deriveFigureOccurrences` and the page's `stagedFigureAt` are the deliberate [twins](#staging-a-figure-from-narration-marksfigure), so page and video cannot silently disagree.

The default cut is the **full** post; a shorter cut is a manual `endMs`, **snapped forward to a mark** so it never clips mid-word — there is no separate teaser mode, and differently-windowed cuts hash separately and coexist. Aspect is hardcoded 1080×1920 (9:16), recorded in the sidecar; no aspect knob.

### The visual layer model

A layer model built from the manifest, composited with ffmpeg `overlay` + `enable='between(t,…)'` gates on mark boundaries: brand base; per-chapter satori backgrounds + slides (crossfade peaking on the boundary); figure clips/stills on their derived spans; the continuous voice equalizer; burned karaoke captions (aligned marks only); and chrome (chapter title, author handle).

### Two render paths: single-pass and layered

Chosen by input count (`VIDEO_RENDER` forces):

- **`renderSinglePass`** — one filtergraph; right for short/medium spans.
- **`renderLayered`** — the full-length path, which exists because of a locked pitfall: **`enable='between(...)'` skips compositing but not input *decode*** — a single-pass 40-min render keeps ~83 overlay inputs decoding for the whole duration (measured ~0.09× realtime, ≈7 h).

The layered plan splits layers by **shape, not time**. *Continuous* layers — audio (`loudnorm`), the equalizer (temporal smoothing spans frames), burned captions — are rendered **once, end-to-end** in one final composite pass, never temporally concatenated (concat would seam them). *Discrete* layers (backgrounds, slides, figure clips) are segmented at safe boundaries into small few-input video-only encodes (parallelized by `VIDEO_SEG_CONCURRENCY`), concatenated, then composited with the continuous layers once. Full cut: ~7 h → ~32 min. Two more locked rules: **`loudnorm` runs once over the whole track, never per-segment** (per-segment varies gain across seams), and **visual cuts land mid-chapter dwell, never on a chapter boundary** (the slide crossfade straddles it and a cut would tear it).

### The voice visualizer (`showfreqs`)

A frequency-spectrum equalizer (symmetric bars from centre), not an oscilloscope — native ffmpeg `showfreqs` inside the final composite: no browser, no extra input, deterministic. It reads the loudness-normalized audio (split *after* `loudnorm`, so quiet narration still fills the band) **downmixed to mono** (a stereo feed makes `showfreqs` paint the second channel white; the audible track stays stereo, pinned before the split so layout negotiation succeeds). Why not the JS route (Web Audio + MediaRecorder on a headless page): ~1× realtime (+40 min) and **non-deterministic** (rAF jitter → no byte-identical rebuilds → the cache can't trust it). Any equalizer knob change requires bumping `CACHE_VERSION`, else stale whole-render caches serve the old look.

### Output, sidecar, and determinism

Encoded bytes hash into `video.<hash>.mp4` (recognized by `VIDEO_HASHED_RE`), with a `video.<hash>.json` sidecar (`url,type,bytes,durationMs,width,height,bitrate,codecs`) so a future feed consumer needn't ffprobe. **No auto-sweep** — every render is kept, because differently-windowed cuts have different hashes and sweeping would silently destroy the other cut; the author prunes.

Output is **bitexact-deterministic**: identical inputs → byte-identical bytes. `-map_metadata -1`/`-map_chapters -1` strip inherited metadata, and ffmpeg's bitexact flags remove the muxer's own `encoder=Lavf<version>` tag and codec-version SEI — without them the ffmpeg version leaks into the hash. Determinism is what makes the content-hash cache safe, and it threads through every subsystem: figure capture is reproducible because the FigureJourney contract bans random/wall-clock on journey paths; the equalizer is native because the JS port wasn't deterministic; stepped scrubbing is inherently reproducible because position is a pure function of the active step.

Env knobs actually read: `VIDEO_FIGURES` (skip capture), `VIDEO_RENDER`, `VIDEO_SEG_CONCURRENCY`, and the test-only `VIDEO_DEMO_FIG_CUT_MS`. Nothing else.

### Caching and incremental rebuild

Two content-addressed caches under `generated/<slug>/.video-cache/`, placed where the cost sits (satori plates and `.ass` builds are sub-second — recompute beats lookup):

- **`fig-<key>`** — `key = hash(figureEnvHash + figureId + figureSubtree)` (`generate/figureCacheKey.ts`, shared verbatim with the figure height/contrast gates so they invalidate in lockstep). `figureEnvHash` folds in *every* pixel-moving input: capture defaults and code, `figureAnimation.ts`, the figure-styling stylesheets, the font binaries, the GSAP version. Only misses boot a browser — prose iteration re-captures nothing.
- **`render-<key>`** — hash of all layer files by content + placements/holds + audio filename + burned `.ass` text + encode params + `CACHE_VERSION`. A no-op rebuild skips segments and the long encode (measured ~54 s → ~0.3 s, identical output hash).

Keys are conservative on purpose: a false miss re-renders; a false hit ships a stale video. `CACHE_VERSION` is the manual escape hatch (bump after an ffmpeg upgrade or capture/equalizer change). Neither cache evicts.

**Per-segment renders are deliberately not cached**: a narration *hold* (silence spliced in when a figure outlasts its discussion) shifts every later chapter's video-time, so one clip-length change invalidates that segment and everything after it — a correct per-segment key would have to include the whole hold layout, which the whole-render key already does.

### Per-step video capture

Stepped figures become **held-frame schedules**, so the video matches the page by construction: the page driver snaps to `steps[label].endMs` and holds, and a held frame is exactly the renderer's existing `still` layer — no new compositor primitive. A stepped occurrence decomposes into a continuous prefix `[spanStart, firstCue)` plus one deduped `still` per step, extracted from the already-captured clip with one `ffmpeg -vf select=eq(n\,idx) -frames:v 1` per distinct `(figure, label)` (`heldFrameIndex` is pure index math; a missing label warns and uses the last frame, mirroring the page). Stepped spans add no narration holds (a held frame has nothing to finish).

- **Snap-and-hold, not play-the-transition (locked).** Playing the eased tween into each state and freezing would read richer but would *diverge from the page*, which doesn't show it either; the held-frame schedule is the substrate that approach would extend if the slideshow ever reads too static.
- **The caption-lead gotcha:** holding at `endMs` rests on the labeled segment's *final* frame — the start of the next label. A figure that sets each step's caption via a `.call()` at the *next* label shows step *i*'s visual with step *i+1*'s caption — **on page and video identically** (both seek `endMs`), so it's a content-side bug: set a step's caption in that step's own `onStart`.

### Disclosure & licensing of the clip

The *stance* is settled, consistent with the [feed's](#subscription-feeds-atom--podcast-rss): the clip is **not self-labelled "AI-generated content"** on platform toggles — it's human-written, human-reviewed prose in the author's own voice; voice-synthesis disclosure, where wanted, goes in prose (the upload description), which the author writes at upload time. The *automated* halves — an attribution line (author + post URL, from `CONTENT_LICENSE`) baked into an end-card, and a generated default description — are **design intent, not yet implemented**: the renderer currently emits no end-card, no description, and reads no license config. Until built, attribution on a re-shared clip is the author's manual step.

### Video pipeline tests

Pure builders (`render-video.test.ts`: ass timing, word chunking, cut snapping, placements, occurrence/step derivation, held-frame index) and the timing twins (`narratorTiming.test.ts`) are unit-covered; attribute parsing + cache neutrality in `narration.test.ts`. The figure gates (conformance/determinism/integrity, height, contrast) are the [FigureJourney gates](#the-figurejourney-contract). `videoStepRender.e2e.ts` is the ffmpeg golden for held-frame extraction (catches the `select=eq(n,idx)` off-by-one). `copy-static.test.ts` asserts the video never ships. The full real-post render and audio-synced stepping are verified by manual render + playback — the headless harness can't drive the detached `<audio>`.

### Excluded from v1 / future directions

None built, none blocking: configurable aspect (16:9 long cut); a real teaser mode (auto-selected `<mark name="soundbite">` span, shared with a future `<podcast:soundbite>`); wiring the `VIDEO` build gate; `og:video`/`<video>` on-page surfacing (gated behind re-enabling serving); a music/SFX track (no multi-track audio model exists); caption themes, chapter transitions, stings; per-platform presets; an author-supplied figure-poster override; an ffmpeg filter preflight; a caption sidecar for a *served* video (moot while local-only — `captions.vtt` already ships for podcasts).

## Comments

Code: `client/comments.ts`.

Google-Docs-style threads anchored to selections in the article body, selections in the spoken-script drawer, or whole graphics. Every thread (and every in-progress draft) renders as its own card in a right-side margin column that scrolls with the article.

### Loading comments: a lazy boot, off the critical path

The comment system (~150 KB, the largest non-reading-critical slice of a post's JS, and login-gated anyway) never loads eagerly. The post loads a tiny `client/commentsLoader.ts` that wires a one-shot trigger — first `pointerdown`/`keydown`/`selectionchange`/`scroll`, or a `requestIdleCallback` fallback so a passive reader still gets existing highlights — then `import()`s the real module as its own chunk and boots it after first paint. `init()` re-evaluates the current selection on start, so the very gesture that triggered the load still raises the action bar.

**This only works under `Bun.build({ splitting: true })`** (`generate/build-html.ts`): without the flag Bun *inlines* a dynamic `import()` back into the importer and the split silently does nothing (same for the lazy Automerge import in `commentsStore.ts`). `client/comments.budget.test.ts` guards the boundary — the eager entry must never statically import the heavy graph.

### Why a column, not one popover for everything

One floating popover per span breaks the moment two threads land on the same selection — a real case once comments sync across users. The column sidesteps disambiguation entirely: every thread is always visible, stacked next to its anchor; two threads on the same selection are just two cards at the same height. Clicking a highlight scrolls to its card and pulses it; clicking a card scrolls back to its anchor. (Below the column breakpoint, cards become per-thread popovers — see [Responsive](#responsive) — still never one-popover-for-everything.)

### Anchoring: the Web Annotation target model

Anchors are stored as W3C [Web Annotation][AnnotationModel] *targets* — a `source` IRI plus selectors. Types live in `client/commentsStore.ts`; all selector-shape knowledge funnels through a few helpers (`makeTextTarget`/`makeGraphicTarget` to build, `textTargetParts`/`graphicTargetId`/`contextOf`/`isTextTarget` to read), so UI and offline tools read plain fields, never raw selector arrays. The spec shape costs nothing (near-1:1 with what we need), buys shared vocabulary and interop with annotation tooling ([exporting](#exporting-to-the-web-annotation-wire-format)).

A **text** target carries a `RangeSelector` (block span) + `TextQuoteSelector` (verbatim text + a little context, stored against a possible future fuzzy re-anchor) + one project extension, **`x-blog:segmentHashes`** — a content hash of every touched block, driving [stale detection](#stale-anchors-orphan--flag). The WA model has selectors, not integrity checks, so the hashes live in the extension. The `source` distinguishes article body vs drawer; the full post IRI is resolved only at the export boundary.

**Narration comments carry a derived audio time range — never typed.** A comment on the drawer is implicitly about a slice of audio; the segment's `<mark>` times (computed by `bun run generate`) become a W3C Media Fragments selector alongside the text ones, so it survives export. The card gets a speaker button that plays the segment.

**That stored range is best-effort, never ground truth.** Audio is regenerated every revision, so a `t=` is exactly valid only for its build. Usually harmless — a comment is typically resolved by the very edit that changes the audio. The sharp case is [per-segment regeneration](#per-segment-regeneration-dev-author-only): re-rolling one segment's audio changes its duration, which **cascades absolute times through every later segment with no text change at all** — so the text-hash stale detection never fires and the drift is silent. Deliberate: the orphan-and-flag machinery guards *text* anchors (the durable ones); an audio-time integrity check would be a parallel mechanism judged not worth building. A consumer needing an accurate time must re-derive it from the segment's current `<mark>` via the still-valid text anchor.

Narration cards are violet (article cards blue) and are **positioned by the article element their segment refers to, not by the drawer** — cards anchored to a fixed side panel would all cluster at its scroll position. The `<mark name>` ↔ article `id` pairing the player already uses supplies the position, so narration and article comments interleave down the column. A mark with no paired article id stacks at the page bottom (click scrolls the drawer instead); one mark resolves to one id today, and a future multi-element mapping would anchor to the first.

**Block ids** (needed to reference blocks) are chosen in order:

1. The author's own `id` attribute — usually present because the block is already a narration `<mark>` target, and stable across document moves.
2. Otherwise a synthesized `<context>:__b-<n>` positional id. It shifts when an earlier paragraph is inserted — which is fine, because the block's text shifts too, the stored hash mismatches, and the thread flags as outdated instead of silently pointing at the wrong sentence.

Narration anchors cover only the spoken words — the indexer and quote-capture exclude the segment's play-button/clock chrome, so quotes and hashes track the text, including across multi-segment selections.

### Stale anchors: orphan + flag

Every render recomputes each block's hash against `x-blog:segmentHashes`; any mismatch marks the thread **outdated**:

- Its highlight is not drawn (never point at the wrong sentence).
- Its card still renders, tagged "outdated," with the original `quote` intact so the reader can find what it pointed at. With no highlight, the card anchors to the first segment block; if even that is gone, the CSS `anchor(top, 0px)` fallback pins it to the column top.
- Stale cards **bypass the hide list and lose their Hide button** — Hide's contract is "click the highlight to bring it back," and a stale thread has no highlight, so hiding would orphan it with no recovery.

Rejected: silently dropping stale comments (data loss); fuzzy re-anchoring (too hard to get right).

### Anchoring (graphics)

Whole-graphic only in v1, scoped to `<figure>`: a `source` plus a single `FragmentSelector` naming the figure id — no hash, because a graphic's content isn't text-comparable across edits. A replaced figure (same id, new content) keeps its comments deliberately: that's the right behaviour when an author iterates on a diagram. Standalone `<svg>`/`<img>`/`<canvas>` are deferred (void element / foreign namespace — both need a wrapper before a trigger button can sit inside); the figure-only rule keeps the indexer free of those edge cases.

### Exporting to the Web Annotation wire format

The in-memory shape is already the spec model; `authoring/annotationExport.ts` is the pure transform that turns a merged snapshot into spec-valid JSON-LD — each thread an `Annotation` (`motivation: "commenting"`), each reply a `TextualBody` (`text/markdown`), wrapped in an `AnnotationCollection`. Non-WA data becomes `x-blog:*` extensions; **`authorEmail` is dropped** (author-eyes-only data has no place in a portable export). IRIs are `urn:blog:<slug>:thread:<id>` — deliberately not `urn:uuid:`, because the ids aren't RFC-4122 UUIDs and claiming otherwise is a lie a strict consumer could reject.

**Never a Worker route.** An export endpoint would force the edge to run Automerge (merge every reader's blob), violating the dumb-edge rule. The merge-and-serialize lives only where Automerge already runs trusted: the offline authoring tool (`bun authoring/exportAnnotations.ts <slug>`, reusing `loadUnresolvedThreads` — also the input the [`process-comments` skill](#ai-assisted-authoring) consumes) and the author's browser (which holds the merged snapshot via the aggregator; a download affordance is a few lines on the same serializer, not yet wired to a button).

**The inbound [Annotation Protocol][AnnotationProtocol] / LDN inbox is skipped, and the localhost exemption doesn't rescue it**: an inbox is an inbound *networked* surface — a production endpoint under the dumb-server rule — and the local AI pipeline reads blobs straight off disk, so an LDN layer would be plumbing it routes around. The standard *vocabulary* is the whole benefit; the standard *protocol* adds nothing here.

Read boundaries (`commentsStore.snapshot()` and the offline loader) defensively **skip threads lacking a `target` field** (pre-WA-model change-objects produce them) rather than crash; to purge stale local test data, wipe `generated/.comments-dev/` and the `blog-comments:*` localStorage keys.

### Storage layer

Code: `client/commentsStore.ts`.

Comments live in an **Automerge document** (CRDT); the store owns the doc, `comments.ts` is purely UI reading snapshots and routing mutations through the store API.

**Why a CRDT with this little concurrency.** Concurrent writes happen only when one reader uses two devices — but the CRDT makes that case trivial (`LIST + GET + applyChanges` over content-addressed changes; the author aggregator is `applyChanges` per reader — both fall out of commutativity), and adopting the model up front forced a merge-friendly data shape (maps not lists, tombstones not deletions). **Automerge over Yjs**: its plain-object mutation API maps 1:1 onto the thread/reply types; Yjs's `Y.Map` wrappers would tax every read path for rich-text power comments don't need. The WASM core is <1 MB and loads on first interaction only.

**Doc shape — deliberately flat.** Threads and replies are *sibling* top-level maps; each reply points back via `threadId`:

```ts
type CommentDoc = {
  threads: { [id: string]: { target: Target, createdAt: number, resolvedAt?: number } },
  replies: { [replyId: string]: Reply & { threadId: string } },
}
```

`snapshot()` buckets replies by `threadId` in one pass. Flat means the unit of human action equals the unit of server change: adding a reply is a write to a brand-new key in a top-level map.

**The server is — and must remain — dumb storage.** Clients PUT/GET opaque bytes; all CRDT logic runs client-side. That's what lets the data survive a malicious/buggy/different-version edge server and makes merge correctness a *library* guarantee rather than something to re-verify when the server changes. Running Automerge on the server (load → applyChanges → save) is ruled out even as a future direction.

**One R2 object per Automerge change**, at `comments/<post>/<userId>/<changeHash>.bin` — the content hash Automerge already computes. Content-addressed → globally unique, deduplicating by construction (a re-upload short-circuits `already_present`; the one metadata-only exception: a PUT declaring `origin=production` still upgrades provenance metadata on an existing blob — see [Syncing production comments](#syncing-production-comments)). Sync is therefore **pure set-diff over hashes** — no etags, no `If-Match`, no 412 retry loop:

```
hydrate:  LIST own hashes → GET the ones we lack → applyChanges
push:     PUT each local change whose hash the server lacks
aggregate (author): per other user, LIST → GET missing → applyChanges into that user's doc
```

Two devices uploading concurrently write to different hash-keyed URLs — both succeed, nothing collides. A zero-delta page load costs one LIST per user. The mutable-blob alternative would pay for its simplicity in the sync layer (etag bookkeeping, 412-refetch-merge-retry, serialization chains); immutable per-action objects make that whole state machine disappear.

**On GC:** change objects live forever — tombstones *are* deletion in a CRDT, and history must be retained to merge correctly. At single-digit comments per reader per post the accumulation is trivial; at scale, a periodic compactor can replace many change-objects with one canonical `Automerge.save` blob (a storage reshape, not deletion). Optional, future, not blocking.

#### Why flat — fine-grained updates

The flat shape is also exactly what Automerge's modelling guide recommends: update at the most fine-grained level, never replace a whole object to change one property. A nested `threads[T].replies[id]` schema forces the worst merge shape — two devices independently assigning `d.threads[T]` (an author "materializing" a foreign thread) create a multi-value register whose losing value survives only in `getConflicts`. The flat schema makes every add a brand-new unique key, where nothing needs resolving.

**Shared seed.** Every `CommentDoc` starts from an identical 127-byte Automerge blob (`SEED_BYTES_B64` in `commentsStore.ts`). Without it, each device's independent `Automerge.from({threads:{}, replies:{}})` produces genesis ops with different op IDs, and merges surface same-key conflicts. The hardcoded seed gives every device literally the same genesis ops — the workaround the Automerge docs themselves recommend. **Regenerating the seed breaks compatibility with every existing blob; never run the regen one-liner casually.**

**Schema-evolution gotcha — don't change `CommentDoc`'s shape.** A reshaped doc means a new seed, and every existing R2 change was authored against the *old* seed as parent. `Automerge.applyChanges` **silently skips** changes whose dependencies are absent — old comments just vanish from view with no log line and nothing to debug from. If evolution is ever needed, the recovery is the Automerge docs' migration-change pattern: a pinned migration change depending on the old seed's tip, shipped as a second hardcoded blob, applied once on first load. Until then, the shape is frozen.

**Reader identity** comes from [auth](#auth--login): a stable `<provider>:<sub>` userId keys the store and the per-change R2 folder, so one user's devices merge cleanly. No per-device identity, no anonymous fallback — login is required to comment.

**Persistence.** `Automerge.save(doc)` is base64-encoded into `localStorage` (`blog-comments:<path>:user:<userId>.amrg`). The base64/hex round-trips are **hand-rolled on purpose** rather than the native `Uint8Array.toBase64()`/`toHex()` codecs: those reached Baseline *Newly available* only in late 2025, and a comments store that can't deserialize on a slightly-stale browser is a data-loss failure, not cosmetic. Revisit when they reach Baseline *Widely available* (or if `uint8array-extras` arrives for another reason).

**Author identity on replies**: `authorId`, `authorName`, optional `authorPicture` render on every reply; `authorEmail` is stored but **never rendered to other readers** — only the blog author needs it, for follow-up by mail.

### Draft persistence

Code: `client/draftsStorage.ts`.

Drafts — unsubmitted threads plus their in-progress textarea contents — are kept **out of the CRDT** and persisted to localStorage (`blog-drafts:<path>:user:<userId>`). Why not the CRDT: a draft is private uncommitted thinking — CRDT-syncing it would surprise-sync to other devices, bloat the blob with cancelled text, and leak half-typed thoughts to the author's aggregating viewer the moment it polls. localStorage is exactly the right scope: this browser, this user, this post. A separate key (not the store's Automerge blob) keeps the two persistence stories independently erasable and migratable.

Each draft persists as `{ thread, body }` — the thread object (same shape as saved, never handed to the CRDT) plus the live textarea contents, written on every `input` event (payloads are hundreds of bytes; debouncing isn't worth it). On boot, drafts load before the first render, so cards appear as if created mid-session — no late pop-in.

**Surviving re-renders.** `renderAll` tears down and rebuilds every card, and an *involuntary* render (the poll, tab re-focus, an aggregator update) can land mid-sentence. Two-layer defence — minimise the teardowns, then survive the rest:

- *Minimise*: the poll's `backgroundRender` **skips entirely when a digest of what it draws hasn't changed** (the common no-new-comments tick does zero DOM work) and **defers while an IME composition is active** (flushing on `compositionend`) — tearing a textarea down mid kana→kanji conversion drops the uncommitted pre-edit text, which lives only in the DOM. The composer's Enter/Esc handlers likewise bail on `e.isComposing`.
- *Survive*: every composer mirrors its text into a per-thread body map on `input`, and rebuilds re-seed from it — drafts via the persisted `draftBodies`, replies via an **in-memory-only** `replyBodies` (a reply on an open thread is less "work in progress" than an unsubmitted comment; it survives any re-render but not a reload — revisit if that's a papercut). A **focus + caret snapshot** across the teardown restores cursor position and focus (`preventScroll: true`, since the trigger may be a background event). The snapshot rescues only the *focused* composer — and selecting text to open a *new* comment blurs the reply you were typing — which is why the focus-independent body buffer is the load-bearing half.

Rejected alternatives: a virtual-DOM reconciler (framework-scale machinery for a handful of cards; React is barred anyway); modelling caret/IME/undo into the data layer (they have no serializable form — the fix is avoiding the destroy, not modelling harder); debouncing the poll (lowers frequency; one ill-timed tick still kills a live composer — the digest gate fixes the cause).

Draft anchor validity isn't re-checked on load: a draft against an out-of-date post still renders at its last-known position with its quote preserved — same orphan-and-flag philosophy as saved threads; silently dropping the user's work was rejected.

### Sync

Code: `client/commentsSync.ts`, `client/commentsAggregator.ts`.

**Boot** (`sync.hydrate()`): LIST own hashes → set-diff against local → parallel GET + apply → run the origin-derivation pass *only if* the listing carried `origin` tags (true only on a seeded dev store; zero extra requests otherwise) → record the union as `serverKnownHashes` → one `requestSync()` to push anything local the server lacks (covers a crash mid-push).

**Write**: every store mutation fires `requestSync()`: filter local changes to those not in `serverKnownHashes` (initialized with `SEED_CHANGE_HASH` — the seed never uploads), parallel PUT, record. Content addressing handles concurrency; the single in-flight `pushing` flag with a `dirty` re-run exists to coalesce write bursts, not for correctness.

**Visibility- and connectivity-gated polling.** `CommentPolling` re-runs hydrate/aggregate every 60 s while the tab is visible **and** online; hidden or offline cancels the timer outright (no fetches the user can't see; no console-spamming failures on an offline PWA). On re-focus or reconnect, it polls immediately if more than an interval has elapsed. A single-flight guard stops slow networks stacking sweeps.

- **No cross-tab live channel.** Two same-user tabs converge on the next poll; correctness never depended on faster (content addressing makes concurrent pushes safe), and the audience is narrow. If it ever earns a fix, the mechanism is the `storage` event — `persist()`'s `setItem` already fires it in every other tab — not `BroadcastChannel`, whose extra powers buy nothing here and add a long-lived object to tear down (deferred design: proposal 28). The SW can't observe localStorage, so routing freshness through it is more plumbing, not less.
- **No Web Locks.** `navigator.locks` would only deduplicate cross-tab LISTs — invisible to users, a rounding error at this scale — while threading async lock acquisition through the hot path.
- **No positional cursor (`?since=`).** The wire unit is a content-addressed change: its key is a hash with **no order**, and the dumb edge can't read timestamps out of opaque bytes to order by (that would be exactly the reconciliation it must never run). The stateless cursor already exists in a better form — the set of hashes a client holds: LIST is cheap metadata, a zero-delta poll is one LIST and no GETs, and a hash set is order-free and dedups by construction. For "what still needs attention," the cursor is *resolution state*, not position: resolution blobs are keyed by threadId (plain R2 keys the edge can list), while the thread set lives inside opaque bytes only the trusted client/CLI merges. The growth lever for LIST payloads is the compactor, not a cursor.

#### Author aggregating viewer

When `isAuthorMode()` is true (it reads the server-authoritative `docVersion.isAuthor` flag), `aggregateOtherReaders` runs fire-and-forget in the background: per non-self user, the same LIST/set-diff/GET dance into a **separate `others` map** — never merged into the author's own doc — so `snapshot()` reads `merge(doc, ...others)` (author sees everything) while `getAllLocalChanges()` reads only `doc` (the author's R2 folder never bloats with others' content).

The `others` map persists to localStorage (one blob per reader + a per-post index), so the store — not the aggregator — is the source of truth for foreign changes already held: a reload renders everyone's comments and the correct unresolved count from first paint, and the aggregator GETs only genuinely new changes **across reloads**, not just within a page. Per-user pull failures log and skip rather than aborting the sweep.

### Author-resolution

Code: `client/resolutionsStore.ts`, `server/comments/resolutionsRoutes.ts`.

The author can resolve *any* thread, including foreign ones — but can't write into a foreign commenter's doc (the auth layer rejects cross-user PUTs), and "materializing" the foreign thread into their own doc hits the multi-value-register conflict [above](#why-flat--fine-grained-updates). So resolutions live in a separate per-post namespace that is **not a CRDT at all**: `resolutions/<post>/<threadId>.json`, one small mutable JSON envelope per resolved thread, opaque to the server. Single-writer (only the post author can PUT — authz table under [Hardening](#hardening)), so last-write-wins is harmless. Automerge here would mean a second seed, a second sync loop, and content addressing — for data with one logical writer and no history.

**Reads are open to any logged-in user** so the original commenter can pull the resolution that hides *their own* thread. Third parties receive opaque random threadIds that are meaningless without the corresponding thread (which lives only in its commenter's private blob) — which is what lets the author's full comment blob stay private.

Client side: `ResolutionStore` mirrors the server into a localStorage-persisted map, hydrates on boot and every poll tick, and `threadIsResolved(thread)` unifies the two sources — own `resolvedAt` OR an author resolution — either hides the card and unwraps the highlight. The Resolve button routes by case: own thread → self-resolve in the CRDT; foreign thread + viewer is author → `ResolutionStore.resolve()`; foreign + not author → suppressed (would be a no-op). `ownsThread(threadId)` (true iff the id is in *our own* doc) tells the UI which case applies.

### Document version

Code: `client/postVersion.ts`, `server/postVersionsRoute.ts`.

Each post has a SHA-256 content hash of its source bytes, bumped by the build. Two surfaces:

1. **Commenter "doc changed" banner** — the client compares the fetched `currentHash` to the last-seen value in localStorage; a mismatch shows "The post has been updated since your last visit…", which explains both stale anchors and threads the author resolved away. The last-seen value bumps on first render, so a reload clears it.
2. **Author-only version history** — the same endpoint adds the chronological hash list (with `builtAt` timestamps) only when the session is the post's author, rendered as an expandable panel in the column.

History lives in `posts/versions.json` (committed; `generate/post-versions.ts` prepends an entry when a post's hash changes — idempotent) and is compiled into `.generated/postVersions.ts` for the Worker. Dev recomputes the current hash from source at startup and, when the author has edited but not built, synthesizes an in-memory "now" entry so the panel reflects disk (never persisted — the build stays the only writer).

**Two surfaces, two audiences**: `GET /post-version` requires login (per-build cadence would otherwise be a version-tracking pixel for drive-bys), and `history` is author-only. The public **`/assets/post-versions.json`** exposes only the newest `builtAt` per post — no hashes — feeding the byline's "Last updated" and matching what JSON-LD `dateModified` already publishes. Both derive from the same `versions.json`.

### UI

- **Selection → action bar.** A "Comment" pill appears above any selection in a commentable root; clicking creates a draft card, scrolls to it, focuses its textarea.
- **Cards are CSS-anchor-positioned; the column must stay unpositioned.** The `<aside>` column is `position: static` and the cards inside are absolute, each tied to its highlight/figure/article element via `anchor-name`/`position-anchor` with `top: anchor(top, 0px)`. **The static column is load-bearing**: `anchor()` only resolves anchors inside the positioned element's containing block, so a positioned column would become that block, exclude the article highlights, and collapse every card to the top. The browser re-evaluates `anchor()` per scroll frame — no JS scroll listener. Highlights are drawn for saved threads *and drafts* (a highlight-less draft would fall to the column top and yank the viewport while composing); stale threads anchor to their first segment block; a thread with no resolvable anchor drops to the top via the `0px` fallback. No `position-try` on desktop cards — a `{top: 0}` fallback fires for *every* below-fold anchor, not just detached ones.
- **Overlap cascade.** `adjustCardStacking` (per render + resize, not per scroll — relative positions don't change while scrolling) pushes overlapping cards down via a per-card `--cmt-stack-offset`, added to the live `anchor()` value so cards still track anchors in the compositor. The cascade is seeded with the pinned header rail's bottom edge, so a card anchored near the article top settles below the rail rather than under it; rail-height changes re-run the pass.
- **Bottom clearance.** `updateBottomSpacer()` (after render + on resize) sizes an invisible spacer so the lowest card scrolls clear of the fixed player dock.
- **Drafts vs threads.** A draft is an unsubmitted thread outside the CRDT (localStorage-persisted, above). Its card carries a "Draft" tag in the slot a saved thread's id chip occupies — an unposted comment must not read as published, since a never-submitted comment silently doesn't count. The author-only unresolved badge counts drafts too (`(+N draft)` suffix, or `N unsent drafts` alone) and clicking it steps through both unresolved threads and drafts in document order. Esc on a still-empty composer discards the draft (popover-style light dismiss, inert the moment there's text); Cancel discards; Comment promotes into the CRDT.
- **Highlight colour** is soft blue, deliberately not yellow — narration already paints the active sentence yellow/orange, and a sentence that's both read-aloud and commented must stay unambiguous. Overlapping threads compose to darker blue, reading as "denser commentary."
- **Layout reservation.** At ≥1100px, `body { padding-right: max(0px, 1460px - 100vw) }` shifts the article left exactly as far as needed to clear the pinned column — tapering to zero at ≥1460px where no shift is needed.
- **Author-only thread-id chip.** Each saved card shows its `threadId` (author only, gated on the server-authoritative `isAuthor` flag; click copies). It closes the loop with [`process-comments`](#ai-assisted-authoring), which reports verdicts keyed by that id — without the chip the printed id matched nothing visible on the page.

### Lifecycle: Hide vs Resolve

| | Trigger | UI effect | Storage effect | Undo |
|---|---|---|---|---|
| **Hide** | "Hide" on a non-stale saved card | Card removed; highlight stays | None (session-only set) | Click the highlight, or reload |
| **Self-resolve** | "Resolve" on an owned card | Card + highlight removed | `resolvedAt` on the thread | Not in v1 — permanent |
| **Author-resolve** | "Resolve" on a foreign card, viewer is author | Removed everywhere (commenter's next poll honors it) | Resolution blob (`resolutions/<post>/<threadId>.json`) | Not in v1 — permanent |
| **Delete reply** | "x" on a reply | Reply removed; an *owned* thread auto-resolves when its last visible reply goes | `deletedAt` on the reply (+ `resolvedAt` if last, owned threads only) | Not in v1 — permanent |

Hide is casual ("done looking for now"), Resolve is decisive, reply-delete is surgical; conflating them makes every dismissal either too cavalier or too confirm-happy.

Resolved/deleted records stay in localStorage as **tombstones**, filtered from render — in the CRDT the tombstone *is* the deletion (dropping it would un-delete on the next merge from a peer holding the original). They accumulate indefinitely; the future compactor (Storage layer → GC) is the shrink lever. A `syncedAt` field enabling "never-synced → remove outright" is deferred; the flat shape means adding it later needs no migration.

### Responsive

- **≥1100px (column mode):** highlight clicks navigate to the card; a *second* consecutive click on the same highlight hides it again (tracked in `lastFocusedThreadId`, reset on unhide/other-anchor/card-vanish) — the highlight is a "show me / hide me again" primitive, not one-way navigation.
- **<1100px (one button, one menu):** no ambient comments chrome at all — no standing identity pill, no floating CTA, no over-selection action bar. One circular button pinned top-right is the only resting surface; cards keep `popover="auto"` (top layer, platform light-dismiss + ESC) but re-anchor under the button instead of their highlights. Tapping a highlight shows its card's popover; re-tapping the same anchor hides it (explicitly — `auto` popovers don't toggle from arbitrary invokers); a different highlight swaps (the platform enforces one-at-a-time). ESC on an empty draft still discards outright.

**The single button and menu.** Commenting on a phone is occasional, not ambient, so everything funnels through the button's menu: signed out → sign-in only; signed in → identity + sign-out, a Show/Hide-highlights toggle (the engine's only mute-all affordance; persisted), and — when a selection is held — "Leave comment on selection" with a snippet. The menu and every card anchor to the button via CSS Anchor Positioning (`position-area: block-end span-inline-start`, width-capped, `position-try-fallbacks` to a bottom sheet above the dock only when the dropdown can't fit). Only the card's `position-anchor` differs by breakpoint, so the same cards serve both layouts with no rebuild. Anchoring under a *top* button is also why composing survives the on-screen keyboard — a bottom sheet would sit under it.

**Selection → comment without racing the OS callout.** Selecting text pops the platform callout (Copy/Look Up/Share), and **web pages cannot add an item to it** for non-editable content. Any in-page affordance near the selection competes with the callout for the same strip of screen — so the trigger lives in the fixed corner instead, collision-proof *by construction*: the callout works untouched, the button pulses (`body.cmt-has-selection`; static accent under reduced motion), and its menu offers the compose entry. The load-bearing detail is **selection capture on `pointerdown`** — the earliest event, while the selection is still live, since the tap itself collapses it (a `click`-time re-capture covers keyboard activation). Logged out, the menu shows sign-in only even with a selection held — a compose entry could only route to the sign-in already shown. **Accepted limitation:** the selection is not resumed across the OAuth redirect (a pre-auth stash has no userId-scoped store to live in; first-time commenters mid-selection are rare enough to accept the re-select).

Rejected placements: integrating into the OS callout (impossible on the web — listed to close it off); a Medium-style spatial dodge (probabilistic — callout placement varies by OS and can itself flip); `-webkit-touch-callout: none` (kills Copy/Look-Up for readers who quote); a bottom action bar (collision-free but a standing-ish surface the single button obviates); rendering threads *inside* one panel (placement unification via re-anchored popovers keeps the CRDT/anchor/draft wiring untouched while looking like one surface). The collision-avoidance claim can't be proven headless (no OS callout renders) — it rests on the by-construction argument, confirmed manually on iOS Safari + Android Chrome.

**Popover vs `<dialog>` — the modal line.** Every current surface is non-modal by construction (light-dismissable, page stays interactive) and uses the Popover API. A genuinely *blocking* decision — a destructive confirm, say — must use `<dialog>.showModal()` (native inert page, focus trap, `::backdrop`) rather than stretching a light-dismiss popover over it (a stray tap silently cancelling a destructive action is a footgun) or hand-rolling a focus trap. Each primitive stays on its side of the line.

**Desktop sign-in card: hidden until the reader engages** (≥1100px rail only). A bright sign-in card at first paint is a nag on a page whose job is being read — so the logged-out identity card starts at `opacity: 0` and fades in once the reader scrolls past ~200px (the cheapest "engaging with the post" signal; one-shot listener, sticks for the session). Escape hatches: `:hover`/`:focus-within` reveal it; reduced-motion skips the transition; a deep-link already past the threshold reveals immediately. The signed-in state is exempt — an ID badge, not a CTA. Starting at 0 (not a dim 0.35) is also what keeps it out of the `color-contrast` audit: axe composites opacity into measured contrast, and fully-transparent text drops out entirely (see `DESIGN.md` §2).

**The fixed rail.** The column is static (required for `anchor()`, above), so an in-flow identity card would scroll away before the reveal threshold ever fired. The permanent header surfaces — identity, version banner, history disclosure, unresolved badge — therefore live in a fixed `.cmt-rail` (`top: 64px`, matching the article's top margin so nothing swaps position across the threshold). Cards are *not* in the rail; they pass under it transiently while scrolling, and the stacking cascade's rail-bottom seed keeps a top-anchored card from *resting* under it.

**Reduced motion.** Pulses and the card `top` transition are silenced under `prefers-reduced-motion`. Programmatic scrolls need their own guard: an explicit `scrollIntoView({behavior})` overrides the page's `scroll-behavior: smooth` CSS (which already respects the preference), so every JS scroll call reads the preference at call time and passes `auto` when set. Sub-200 ms colour/opacity hover feedback is deliberately untouched — fades aren't the motion the preference silences.

**ARIA semantics — the deliberate non-changes matter most.** The version-history panel is a native `<details>`/`<summary>` disclosure and must not be "upgraded" to a hand-rolled `aria-expanded` button. The column stays `role="complementary"` (`aria-label="Comments"`): the `feed` role was **rejected** because ARIA defines it as an incrementally-loading scroll list — a contract this UI doesn't honour, so claiming it would degrade the screen-reader experience. Cards are semantic `<article>`s without `aria-posinset`/`aria-setsize` (ARIA scopes those to list/tree items and waives them when the whole set is in the DOM — exactly the case here). The action bar is a single labelled `<button>`, not a `toolbar` (a roving-tabindex contract for multi-control containers). An `aria-live` reply announcement and `aria-describedby` anchor context are deferred pending a manual assistive-technology pass — they hinge on announcement through wholesale re-renders that DOM-only tests can't observe, and shipping attributes that may silently do nothing helps no one.

#### WCAG, accessible-name, and landmark conformance — verified by tooling, not spec-reading

The ARIA review above is *structural*; the *rendered* conformance bars — colour contrast (WCAG SC 1.4.3), Label-in-Name (SC 2.5.3, visible text vs computed accessible name), one-main-landmark — cannot be derived from source (contrast needs the composited render; names need the resolved accessibility tree). So they're checked by tooling over the *built* pages, split by what each tier can see:

- **Render-independent checks are a hard publish gate** — `generate/audit-posts.ts`, the last step of every build, walks `dist/posts/*.html` and fails on: missing `<title>`/`<html lang>`/meta description, ≠1 main landmark, an `<img>` without `alt`; plus a curated **`html-validate`** sub-check (duplicate `id`, invalid nesting/content-model, skipped heading levels, non-unique landmarks, ARIA validity) — exactly the structural checks axe's default tags drop. The rule set is hand-picked and kept disjoint from the bespoke checks, so no invariant is double-reported. Honesty note: duplicate-`id`/well-formedness is **id-machinery hygiene** (it protects `aria-labelledby`, fragment links, and `position-anchor` targets), *not* a WCAG bar — SC 4.1.1 Parsing was obsoleted in WCAG 2.2.
- **Render-dependent checks are the axe e2e pass** — `e2e/axe.e2e.ts` runs axe-core over the landing page and every post (excluding the vendored Shikwasa player as third-party). `color-contrast` is a **hard gate**, with deliberate-dimming surfaces exempted per-node via a fixed `CONTRAST_EXEMPT_SELECTORS` roster — one entry today, the narrator's sub-chapter segments (the colour standard lives in `DESIGN.md`); `label-content-name-mismatch` is a w=0 ratchet — reported, not yet failed. Non-text and mid-animation figure contrast, which axe never sees, is the separate [figure contrast gate](#the-figurejourney-contract).

### Future direction: Web Push notifications

Not implemented. The comment system's whole point — the author follows up on real questions — currently ends at a polling viewer; nothing actively tells the author a comment landed. Outbound email needs a paid third-party sender (Cloudflare has no outbound mail API). **Web Push is the Cloudflare-native close**: the protocol (RFC 8030) is plain HTTP to browser-vendor push services (free, no signup), authenticated by a self-generated VAPID key pair, with the JWT signing and payload encryption doable in ~100 lines of `crypto.subtle` — no SDK, no new vendor.

Shape, when built: an author-only "Enable notifications" affordance subscribes via the existing SW registration and PUTs the per-device subscription envelope to R2; the comment-PUT handler, after a successful foreign write, fans out pushes via `ctx.waitUntil` (never blocking the commenter's response); the SW renders the notification and deep-links the post. A 404/410 from a push service **must delete that subscription** — browsers rotate endpoints silently, and without GC every comment fans out to an ever-growing dead list. Abuse posture is unchanged: push fires only as a side-effect of the already-rate-limited comment PUT. Commenter-direction notifications are symmetric, later.

Known constraints: permission is per-device opt-in; iOS Safari requires home-screen PWA install first; `userVisibleOnly` means no silent pushes (quiet sync stays the polling layer's job). SSE/websocket is not a substitute — it only fires while a tab is open, and the actual ask is "a comment landed at 2am, tell me in the morning"; the two can coexist. Implementation would land in `server/push/`, `client/pushSubscribe.ts`, and three SW listeners, additive to the existing `install`/`activate`/`fetch` (details pinned in proposal 21).

### Excluded from v1 (comments)

- Reply threading beyond a flat list per anchor.
- Resolve undo (resolutions are one-way until a delete-resolution endpoint exists).
- Tombstone GC (no server-side delete sweep — see [Lifecycle](#lifecycle-hide-vs-resolve)).
- Sub-region selection on graphics (drag-rectangle, SVG child clicks).
- Server-push (SSE/websocket) instead of polling — would slot in by replacing `CommentPolling`, nothing else moves.
- Server-side reply-length validation — the 8 KB per-change cap + rate limit bound the threat in the Worker; parsing reply text server-side would ship Automerge (~700 KB) into the bundle ([Hardening](#hardening)).
- Cross-document selections (one root per selection: article body or drawer).
- Web Push ([above](#future-direction-web-push-notifications)).

## Auth & login

Code: `server/auth/`.

Anonymous commenting isn't supported: the author follows up on real questions **by email**, and there's no path from "Anonymous" to a deliverable address. Commenting requires Google or Microsoft login; the reader's name + verified email + avatar attach to every reply. Logged out, the column shows a "Sign in to comment — so I can reply by email" pane.

### Why Google + Microsoft (not GitHub, not magic links)

The one requirement that picks providers: **the returned email must be deliverable.** That rules out **GitHub** — "Keep my email address private" yields `…@users.noreply.github.com`, verified but undeliverable, and a meaningful fraction of users have it on; the follow-up loop would quietly fail for exactly them. Google + Microsoft together cover personal accounts plus most corporate/university tenancy (Workspace + Entra ID; the Microsoft registration accepts all account types). **SAML is transparent to us**: an SSO org's users bounce through their corporate IdP and back — we only ever speak OAuth/OIDC to Google or Microsoft, never become a SAML SP. **Magic links** (covering the Shibboleth-only long tail) were rejected for v1 to avoid an email-sending dependency; addable later as a third button without touching the OAuth path.

### Why arctic

[`arctic`](https://arcticjs.dev/) is a small, zero-transitive-dep, provider-agnostic OAuth/OIDC helper that does exactly two things — build the authorization URL, verify the code — leaving sessions, storage, and CSRF binding to us. That "library does one thing" boundary fits.

### Userinfo from `/userinfo`, not from a decoded ID token

Both providers return an ID-token JWT in the code exchange; we deliberately don't verify it. Instead we call the provider's `GET /userinfo` with the access token. The trust model is identical either way — an HTTPS handshake against the real provider — but the round trip costs one request where JWT verification costs a JWKS fetch + cache + algorithm allowlist to maintain. Microsoft wrinkle: work accounts with non-mail UPNs sometimes leave `email` blank — `preferred_username` is the fallback; Microsoft omits `email_verified` because Entra owns the namespace (treated as verified).

**The `/userinfo` JSON is validated, never `as`-cast.** TLS authenticates the peer, not the payload shape — and `sub` is load-bearing: it becomes `userId = "<provider>:<sub>"`, the permanent R2 key and the value every authz check compares. A blank `sub` would silently mint a degenerate bucket keyed on the empty string. Each response parses against a small zod schema pinning `sub` to a non-empty string; the schemas stay deliberately conservative (only fields we read; `email` a bare non-empty string, not `.email()` — it's a join/contact key, not parsed) so an over-strict rule can't lock out a real login. Microsoft's email-or-UPN fallback folds into the schema as a transform, erroring when neither exists; failures map to the existing `502 auth/userinfo-unavailable`.

### Sessions: JWT cookie (HS256, `jose`)

Sessions are one `HttpOnly` cookie holding a standard **JWT**, HS256-signed via `jose` — real JWS compact serialization (any JWT debugger reads it), with `jose` owning constant-time verification and the hard algorithm allowlist (`["HS256"]`, the `alg:none`/confusion defense). TTL is **400 days — the practical max** (Chrome/Firefox/Safari clamp longer cookie `Max-Age` to 400 days); sliding-window refresh is a follow-up.

Claims are validated *after* signature verify: the payload runs through a `SessionClaims` zod schema, so a malformed-but-validly-signed payload (a future minting bug) degrades to logged-out exactly like a bad signature. This is **defense-in-depth, not a vulnerability fix** — the token is self-issued, so only our own bug could mint a misshapen one. The schema is deliberately **lenient** (unknown keys stripped, never `.strict()`) so an additive future claim doesn't log everyone out across a deploy skew; the `Session` type is `z.infer`-derived (validator and type can't drift) and `userId` reuses the same `<provider>:<sub>` primitive the comment store keys on.

**Revocation is by key rotation via the JWT `kid`.** `SESSION_SECRET=<secret>` (single key) or `SESSION_SECRETS=v1:…,v2:…` (rotation map): new tokens sign with `ACTIVE_KID`, old ones verify against their own `kid` until that key is dropped — zero-downtime rotation, and dropping a key force-logs-out exactly that cohort.

**Why JWT, not PASETO — and why no `iss`/`aud`.** PASETO removes the `alg` footgun at the format level, but JWT is what the whole OIDC neighbourhood speaks, has the debugger tooling, and `jose`'s pinned allowlist neutralizes the footgun anyway. `iss`/`aud` are omitted because the security boundary for an open-source engine with many independent deployments is the **per-deployment secret**: a foreign token fails the HMAC before `aud` would ever be consulted, so the signature *is* the cross-deployment audience check; a constant `iss` distinguishes nothing. Both are trivially added later (`kid` is already in place) if a key-sharing second service appears.

**Expiry UX.** Identity loads once at boot (`/auth/me`, cached for the page's lifetime); cookie `Max-Age` and JWT `exp` lapse together. Next-visit-after-expiry (the common path): the cookie is already evicted, the page renders logged-out, one click re-runs OAuth with `return_to` landing back in place. Mid-session expiry (vanishingly rare at 400 days): the UI keeps *looking* signed in; new comments still write to localStorage (no data loss) while background PUTs 401 until reload — the "mid-session identity refresh" gap below, the first thing to fix before shortening the TTL. Either way unsynced comments flush on the next authenticated load.

**Why not a server-side session store** (random id → KV/R2 lookup): the worst case of a stolen comment cookie is "someone posts as you" — no admin panel, no money, no DMs. Paying a storage read per authenticated request for individual-session revocation isn't worth it at that risk level. If it ever is: every handler resolves sessions through `verifySessionToken` exactly once — swap that one implementation and nothing else changes.

### OAuth flow plumbing

Per provider: `GET /auth/<provider>` generates `state` + a PKCE `S256` verifier into 10-minute `HttpOnly` cookies and 302s to the provider; the callback verifies state, exchanges the code, hits `/userinfo`, mints the session, 302s home. The state/verifier cookie names are **provider-bound**, so a stale callback from one provider can't replay against the other's in-flight flow.

`GET /auth/me` returns the public session subset (no `iat`/`exp`) or `null`. Both ends share one schema: the server builds against the inferred `IdentityResponse` type (a typo'd field is a compile error) and the client `safeParse`s against the same schema, degrading malformed bodies to logged-out — the same single-source + degrade-don't-trust posture as the comment wrappers. `POST /auth/logout` clears the cookie.

### Excluded from v1 (auth)

- **GitHub provider** — re-introduces the unreachable-noreply-email problem.
- **Magic-link fallback** for the Shibboleth-only long tail.
- **Server-side session revocation** — swap `verifySessionToken` for a lookup when needed.
- **Mid-session identity refresh** — the expiry gap above; low-impact at 400 days, a real footgun before any shorter TTL.
- **ID-token signature verification** — TLS + the `/userinfo` round trip is the chosen trust path.

## HTTP error responses (problem details)

Code: `shared/problemDetails.ts`.

Every non-2xx from a gated route (`/comments`, `/resolutions`, `/post-version`, `/auth/*`, the range-error path) is [RFC 9457][ProblemDetails] `application/problem+json`: `{ type, title, status, detail?, …extensions }`, e.g. a 429 carrying `type: …/probs/rate-limit/exceeded` plus a `retryAfter` extension.

One helper owns the format: `problem(status, slug, detail?, ext?)` resolves the slug to a stable type URI under the problem base, looks up the title, sets the content type, and (for `rate-limit/exceeded` only) pairs the body with a standard `Retry-After` header — both sourced from one `RATE_LIMIT_WINDOW_SECONDS` constant so header and body can't disagree. The slug union is a closed enum; a new error class is a one-file change.

- **Status codes are named, never magic numbers** — everything comes from the `http-status-codes` enum (`StatusCodes.TOO_MANY_REQUESTS`), and `about:blank` titles use `getReasonPhrase(status)`, so there's no hand-maintained phrase table. This holds across the gated API, the dev-only tooling, and the OpenAPI document's response keys.
- **The type-URI base resolves in three steps**: `PROBLEM_BASE_URL` if set → `${SITE_URL}/probs` (reusing the origin var everything else configures) → an RFC 2606 documentation domain *not under our control*, with a warn-once at first use so a deploy missing both vars is loud rather than silently spec-incompliant.

### The slug taxonomy

Twelve project slugs cover everything with more semantics than the bare status:

```
auth/unauthenticated         auth/forbidden
auth/misconfigured           auth/oauth-provider-error
auth/callback-invalid        auth/userinfo-unavailable
request/missing-parameter    request/invalid-parameter
request/empty-body           rate-limit/exceeded
comments/change-too-large    resolutions/resolution-too-large
```

The `request/*` slugs back the query-validation layer, which is one instance of a wider rule: **zod is the shape source of truth for every JSON boundary the comment data crosses**, composed from `shared/commentSchemas.ts`:

- Field primitives (non-empty `post`, the `provider:` `user` prefix, the 64-hex change hash, the `origin` enum) and wire shapes (listings, the resolution envelope, the post-version response) are declared once and validated at each edge — server query schemas compose the primitives; client fetch wrappers `safeParse` responses and **degrade** a malformed body into the call's existing failure path (an `ApiError` the sync loop already backs off on, or the `null` that already means missing) instead of trusting a blind `as`; the sync worker and CLI validate what they read; the CLI resolution writer builds its envelope through the same schema as the browser, so the two provably agree.
- **Zod validates shape, never authorization** — the semantic guards (PUT fence, byte caps, per-method authz) stay in handlers, and the binary Automerge blobs stay opaque end-to-end (content-addressed CRDT bytes have no JSON shape).
- **Wire objects are lenient** (`z.object` strips unknown keys): an additive field from a newer server never breaks an older client — which matters when content repos update on their own cadence.
- **localStorage edges split by blast radius**: the resolutions cache is server-synced, so it's `safeParse`d on read (a stale-shaped entry drops the cache and refetches); the draft store keeps a deliberate partial guard — a corrupt draft harms only its owner, and a faithful `Thread` schema would mirror the whole Web Annotation model in zod, reintroducing exactly the drift zod kills. Deliberately unvalidated (recorded so it isn't re-litigated): the annotation export and the wrangler-config read — generated/fail-loud shapes, not ingress.
- The same schemas feed an **OpenAPI 3.1 document** (`server/openapi.ts`, served at `GET /openapi.json`): components are imported from `commentSchemas.ts`, so document and runtime validators can't disagree. `/auth/me`'s response is `z.infer`-derived from the session-claims schema by `.omit(...)` — the wire shape is a *provable subset* of the claim shape. The redirect `/auth/*` routes stay out (their query parsing is semantic, not shape). The document exists for external integrators; the in-page JS carries TypeScript types already.

Truly generic responses (404/405/416) use **`about:blank`**, the spec's "nothing beyond the status code" sentinel — inventing `comments/change-not-found` for a 404 would be cargo-culting.

Two deliberate collapses on the auth path: the three CSRF-adjacent callback failures (missing code/state, state mismatch, exchange failure) share one `auth/callback-invalid` slug — telling an attacker *which* check rejected them is exactly the leakage RFC 9457 §5 warns against; server-side `console.warn` disambiguates for the operator. The provider-rejection case (`?error=` on the redirect) gets its own slug with the OAuth error code as an extension, **allow-listed against the RFC 6749 enumeration** before it reaches the wire — anything outside collapses to `"unknown"` (the raw value logs server-side only), since an unfiltered reflection would be attacker-controlled.

### Why this exists at all

- **Raw provider/config errors must never reach the client** (RFC 9457 §5's "no implementation details on the HTTP interface"): `auth/misconfigured` sends a static body, and the operator gets the original error via `console.warn` server-side.
- **Rate-limit backoff is wire-driven**: the push loop reads `Retry-After` (header or body extension) and defers `requestSync()` for the window — edits still land locally; only the network push pauses.
- **Client wrappers keep the body**: `ApiError` carries `status`, the parsed problem, and the parsed `Retry-After` ms, so debugging a 403 shows *which* check refused at a glance instead of a discarded `"403 Forbidden"` string.

### Helper and parser invariants

The wire format is a public surface (our client, curl, Cloudflare's edge), so the helper and its symmetric client parser commit to contracts a future call site can't accidentally violate:

- **Core members win over extensions** — the `ext` bag spreads *under* the `type`/`title`/`status`/`detail` literals, so an extension named `status: 999` can't desynchronize body from wire status (§3.1.2's MUST). `instance` is the one spec member left extension-controllable, matching its occurrence-identifier role.
- **The parser is bounded** — `parseProblem` rejects bodies over 64 KB (Content-Length pre-check + cancel-on-overflow streaming read); ours are <500 B, and the cap keeps a misbehaving intermediary from OOMing a tab.
- **Media type matches strictly** — split on `;`, lowercase, equality — never a substring check that `text/plain; note="application/problem+json"` would fool.
- **Shape is validated, not asserted — and extensions survive.** The body runs through a zod schema pinning the three REQUIRED members (`status` as a real integer, deliberately uncoerced so `${status}` math can't read a string); arrays and scalars that fooled a `typeof === "object"` guard return `null` (the caller's status-line fallback). The schema is **`.loose()`**, which is load-bearing: §3.2 extension members (ours camelCase, Cloudflare's snake_case) survive byte-for-byte where a default `z.object` would silently strip them.
- **Backoff is clamped to one hour** regardless of `Retry-After`: above 2³¹−1 ms, `setTimeout` silently clamps to ~1 ms and would busy-loop the push layer against a window that never elapses; one hour exceeds any real limiter window and shrugs off a hostile `Retry-After: 99999999999`.

### Coexistence with Cloudflare's edge

The clinching reason to adopt the spec rather than a bespoke shape: **the edge also speaks RFC 9457** — Cloudflare's proxy emits `application/problem+json` for its 1xxx-class errors (with snake_case extensions and a `cloudflare_error: true` discriminator our Worker never sets). Consequences: `parseProblem` handles both layers with no Cloudflare-aware fallback; any body without `cloudflare_error` is ours; and the naming divergence (`retry_after` vs `retryAfter`) costs nothing because the **`Retry-After` header** is the authoritative signal both layers set and the client reads.

### Out of scope

Deliberate omissions, each documented at its file so a future edit doesn't quietly close them:

- **`server/analyticsRoute.ts`** — always `204`, even for invalid payloads: a structured 400 would turn response codes into a post-slug existence oracle. Problem details has nothing to say about 2xx.
- **Dev-only tooling** (`regenerate.dev.ts`, `soundTest.dev.ts`) — error strings carry dynamic shape hints for an author reading curl output; a closed slug taxonomy fits badly and plain text is correct.
- **Dev static-asset 404/416/403** — no programmatic consumer; the JSON helper would buy nothing.

### Why not roll our own JSON shape

A private `{ error: "rate-limited" }` was tempting with one first-party client. RFC 9457 won because: the IANA media type makes the `Accept` advertisement a stable contract any problem-details-aware tool reads without bespoke parsing; §3.2 extensions are first-class (consumers MUST ignore unknown members, so adding fields later breaks nothing); and the wire symmetry with Cloudflare's edge means one parser, not two.

### Future direction

- **Surfacing rate-limit state in the UI** — today it's `console.warn` + silent backoff; a toast reading `ApiError` is small, but the interrupt-the-writer UX decision isn't. Deferred until rate limits show up in real usage.
- **Dev routes conforming** — if the dev tooling ever grows a non-author consumer (a browser admin UI), a small `dev/*` slug taxonomy becomes cheaper than string-parsing; until then plain text stands.

## Per-post author metadata

Code: `server/postMeta.ts`.

Authorship is **per-post**, not site-wide: each post declares `<meta name="author-email" content="…">` in its head, and the server compares the session's verified email to an in-memory map to answer "is this the author?"

### Why email and not userId

The Cloudflare-canonical key would be the stable `<provider>:<sub>` userId — it survives address changes and attracts no spam. Email won anyway because **the author already knows their email**; finding your `sub` means signing in and reading `/auth/me`. The spam concern is closed by the pipeline instead: the tag exists in **source** HTML only and is [stripped from served HTML](#build-time-html-strip) — the server-side lookup reads source at build (`.generated/postMeta.ts`) or dev startup, never the served response.

**Client-side author detection** can't read the stripped tag, so every author-only surface (aggregator, foreign-resolve button, version history, regen buttons) gates on the single server-computed `isAuthor` boolean from `GET /post-version` — fetched once at boot; fetch failure defaults to non-author.

### Email-verified check

The author check requires `session.emailVerified === true`: without it, an OAuth app with weak email verification could log in *as* the author's address and be treated as the author. Google sets `email_verified`; Microsoft doesn't emit it because Entra owns the address namespace — treated as verified.

### Dev + prod parity

Dev reads `posts/*.html` as the source of truth (fresh per startup); prod uses only the generated files, so `wrangler dev` works without a build step.

### Author profiles and bylines

Code: `shared/authorProfile.ts`, `client/byline.ts`.

Profile data (name, photo, social links) is author-level, keyed by the same email in the same `authors/` folder as the [voice clip](#per-author-voice-resolution): `<email>.json` (profile), `<email>.webp` (browser avatar; a `.png`/`.jpg` sibling feeds the share card), `<email>.wav` (build-only). Discoverable by listing, no central config, **no env fallback** — same reasoning and same path-guard as voice resolution. A post whose author has no profile gets no byline (degrade, don't fail); only the `.json`/avatar publish, so co-location never blurs served-vs-build-input.

**The load-bearing constraint: the served byline must never re-leak the email.** The email is only ever a disk/join key. Everything client-visible derives from the public **`handle`** (explicit `handle`, else the X link's last segment, else a name slug): avatars serve at `/assets/authors/<handle>.<ext>`, and the public per-post map carries no email. Unit tests pin the no-leak property on each producer (the author map, the feeds, the structured-data inject).

**Handle derivation is ASCII-deterministic or it fails the build — never a silent guess.** The slug folds Latin accents via NFKD (`José`→`jose`, the same fold as the heading slugger) but deliberately **does not transliterate non-Latin scripts**: a CJK/Cyrillic/Arabic name has no single correct romanization (an off-the-shelf transliterator would pick the *Chinese* pinyin of a Japanese name), so guessing would silently mislabel an author or collide two onto one avatar path. Such a name makes `buildAuthorMap` **throw** with an actionable message; the fix is the author's explicit ASCII `handle` in their profile — and an explicit non-ASCII handle is fatal too (no falling back behind the author's back). Auto-transliteration libraries were rejected as wrong-by-construction for multi-reading scripts: a loud fixable error beats a silent mislabel.

**The byline renders client-side**, like the player/comments/figures — not build-injected. Structural reason: posts are opaque static bundles in *both* runtimes (Bun `HTMLBundle` dev, `ASSETS` prod), and only `dist/` gets the post-build rewrite — a build-time body injection would appear in prod but not dev, exactly the drift client modules avoid. Crawler-facing author metadata isn't lost: it ships in `<head>` as JSON-LD/OG ([Structured data](#structured-data-schemaorg-open-graph-twitter-card)) — byline for humans, structured data for machines. One builder (`buildAuthorMap`) feeds both runtimes: prod writes `dist/assets/authors.json` + published avatars; dev serves the identical map fresh per request, so profiles update on reload and the two can't diverge.

**Avatar formats:** discovery prefers `.webp` (the byline `<img>` — ~2.5 KB vs a PNG's ~49 KB, and it's above the fold, `loading="eager"`); satori/resvg can't decode WebP, so the share card falls back to a same-name `.png`/`.jpg` sibling (none ⇒ name-only card). Two consumers, one resolved avatar — the split lives at the format layer, not two config fields.

**Byline CSS lives in `client/base.css`** (the [page-global rule](#opting-out-of-narration)): the byline appears on every post, including narration opt-outs that never load `narrator.css`. The article root is the shared `[data-narration-src]` selector; the block fills a build-time [reserved placeholder](#layout-stability-reserving-client-injected-chrome-cls) so mounting never shifts the page.

**Social-link icons are FontAwesome Free SVGs inlined as text** (`import … with { type: "text" }`): no webfont, no second stylesheet, nothing for `font-src` to govern, and `fill="currentColor"` inherits the anchor's colour/hover for free. A known brand key renders its icon; an unknown key still renders the link as text — adding a brand is one import + one map entry. (The webfont/CSS-class approach would relax `font-src` and ship a stylesheet whose `@font-face` URLs the bundler must rewrite.)

**"Last updated" lives in a `.post-meta` strip under the `<h1>`, separate from the byline** — author identity vs article metadata, placed where the standard blog pattern puts the date. Its negative top margin pairs with the engine-layout-owned `<h1>` margin (a shared baseline, not tuned to one post); a post wanting a different gap overrides from `@layer post`.

**Engine attribution.** Every post ends with a muted `Built with presidocs` link, appended in the same byline boot pass (independent of profile data, so it always renders). The URL is hardcoded, no config knob: a downstream blog hides it with one CSS rule — already the lowest-friction opt-out, where a flag would add a dev/prod sync point for nothing.

## Cascade-layer architecture

Code: `client/base.css`, `client/narrator.css`, `client/comments.css`.

Two coexistence problems shape the CSS architecture: **engine-owned UI lives inside the post's `<article>`** (byline, post-meta, follow-CTA, attribution, heading-link icons — placement that's load-bearing for comment anchoring, JSON-LD `mainEntityOfPage`, and the player mount, but which exposes engine UI to any generic selector in a per-post sheet), and **the engine's article defaults must apply to every post** (they once lived in `narrator.css`, which opt-out posts never load, so defaults drifted per narration mode). Both are solved structurally with **CSS cascade layers**: each concern gets a layer, and the cascade resolves by *ordering*, not by whatever selectors a post sheet happens to write.

```css
@layer engine-tokens, vendor, engine-layout, post, engine-components;
```

**Flat, distinct top-level names — deliberately not dotted sublayers (`engine.*`).** A dotted name pins every `engine.*` sublayer to the position of the parent `engine` layer's *first* mention — which is before `vendor`, so `engine-components` would be dragged below the vendor defaults and the player/comments overrides would lose to Shikwasa's stylesheet in every build. The interleaving this order depends on (vendor between tokens and layout; post between layout and components) cannot be expressed under one parent. Don't "tidy" the names into a namespace.

**Pinning the order: declared before any layer is created.** Layer precedence is fixed by first-mention during parsing, and an `@layer a, b;` statement is **append-only** — it can never reorder an existing name. The two build paths disagree on stylesheet order (Bun's dev HMR can inject `narrator.ts`'s CSS imports — which create `@layer vendor` — ahead of `base.css`; the prod bundle concatenates `base.css` first), so the canonical order is injected as an **inline `<style>` that is the first `<head>` child** — inline because a `<link>` or JS-imported CSS is re-injected by HMR in module order, not document order. Posts never author it: `generate/bunHtmlHeadPlugin.ts` injects it from one source (`generate/cssLayers.ts`) via `HTMLRewriter` `prepend` (structural, idempotent, immune to a stray `<head` in a comment — the failure the prior regex was open to). One plugin carries the layer order *and* the footer *and* the font preloads, because Bun `onLoad` is first-match-wins, so all engine `.html` transforms must share a single plugin. It runs in dev via `bunfig.toml` `[serve.static].plugins` (the one seam where Bun accepts an HTML loader; runtime `Bun.plugin()` rejects it) and in prod via `Bun.build`. Three guards: `build-html.ts` asserts the built HTML declares the order before its bundled stylesheet; `createDevServer` **throws at startup** if the content repo's bunfig doesn't register the plugin; `generate/cssLayers.test.ts` keeps injector, `base.css`, and registry in sync. Rejected: per-post authoring of the statement (couples the value to every content file); serving dev off the prod bundle (kills HMR).

The five layers, later wins:

- **`engine-tokens`** — `:root` design tokens + the `box-sizing` reset. Lowest, so a post can rebrand a token from `@layer post` without `!important`.
- **`vendor`** — third-party CSS routed through this layer (Shikwasa via `client/shikwasa-vendor.css` — inlined, not `@import`ed, because Bun's CSS bundler doesn't resolve bare npm specifiers). Vendors ship unlayered CSS that would otherwise beat every layer; wrapping demotes them so engine overrides win by ordering instead of specificity-chasing.
- **`engine-layout`** — what every post should look the same on: page-global typography, the article container (`max-width: 768px`), heading rhythm, lede, inline code. In `base.css`, so it applies with or without the player. Below `post`, so a post wanting a wider column wins from its own layer.
- **`post`** — per-post stylesheets opt in by wrapping rules in `@layer post { … }`. Non-opted-in sheets stay unlayered and keep old behavior — migration is incremental; a missed opt-in is a missed protection, not a regression.
- **`engine-components`** — the in-article engine components plus the player and comments UI. Declared last, so it doesn't matter whether a post sheet writes `a`, `article a`, or `.slug a` — engine chrome renders identically across posts.

**The escape hatch is unlayered**: unlayered rules beat every layer, so a post that *deliberately* restyles engine UI writes a plain rule (`.engine-attribution { display: none }`). What the layers remove is the *accidental* override, not the intentional one.

**Post-meta's calibrated negative margin** works only because `engine-layout` owns the default `<h1>` margin — the constant is paired with a shared baseline. A post overriding h1 margins from `@layer post` is expected to override the post-meta margin alongside.

**Rejected alternatives:** moving engine components outside `<article>` (breaks the JSON-LD and block-walker invariants and doesn't fix the layout question); Shadow DOM per component (bulletproof isolation, but kills cross-boundary text selection and the documented `display: none` opt-out — heavy for five components); `all: revert-layer` on component roots (a wrecking ball that resets inheritance wholesale and duplicates what `engine-components` already states). A build-time lint for unlayered engine-class selectors is deferred — the ordering prevents the bug; the lint would only be ergonomics.

Per-post sheets' authoring contract lives in `authoring/authoringRules.md`.

## Typography (self-hosted web fonts)

Two self-hosted faces — Red Hat Text (prose), Red Hat Mono (code) — declared once in `base.css` and exposed as `--font-sans`/`--font-mono`; every engine and figure stylesheet resolves to the tokens, so the blog's type is a single edit (the only literals are inline-SVG presentation attributes, which can't reference custom properties).

- **Why a web font, not a system stack:** a system stack resolves to different faces per OS with different metrics, so the same caption wraps differently per reader. Invisible for prose; fatal for **figures**, whose reserved heights overflow on a wider face the author can't see — and it would split the three surfaces that must agree (live page, video-capture browser, height-gate browser). One self-hosted face collapses all three onto identical wrapping — the only way a figure proven stable in CI is stable for an arbitrary reader.
- **Preloaded for swap-stability:** faces are `font-display: swap`, and a late swap re-wraps the article (CLS). The build preloads the above-the-fold weights (Text 400/500/700) as the first `<head>` children — **prod-only**, since dev inlines fonts as `data:` URIs and a preload there is a wasted fetch. Remaining faces stay unpreloaded (below the fold; preloading would contend with the critical bundle). A preload changes timing, not glyph metrics, so it needs no figure-capture cache bump. (A metric-matched `size-adjust` fallback face would harden the cold-load case further; not done.)
- **Openly licensed as a selection criterion:** self-hosting is *redistribution*, which proprietary faces forbid. Red Hat's faces are OFL 1.1; the woff2 name tables don't carry the full license text, so `client/fonts/OFL.txt` ships to `dist/fonts/` beside them — the license travelling with the files is what the OFL asks. A fork inherits a font it's allowed to ship.
- **Self-hosted, not a font CDN:** a third-party font request leaks the visit and forces `font-src` open. Latin-subset woff2 per actually-used weight, so nothing is browser-synthesized.
- **Inline in dev, external in prod — forced by CSP, not just performance.** `@font-face` uses a *relative* `url("./fonts/…")`. Dev inlines it as `data:` (fine — dev HTML routes never pass the CSP, and inlining keeps figure capture font-faithful). In prod that inline would be **blocked**: `font-src 'self'` doesn't cover `data:` — so `build-html.ts` passes `external: ["*.woff2"]`, `copy-static` ships `dist/fonts/`, and the bundled CSS resolves to same-origin URLs. The performance win rides along: Bun doesn't share CSS chunks across HTML entries, so inlined fonts would duplicate ~100 KB into every post's CSS. Rejected: absolute font URLs (Bun's bundler errors resolving them against the filesystem in both paths); a dev `/fonts/*` route (dev already inlines, and a silent 404 would drop the height gate onto a system font without failing anything).
- Landing/legal pages link `landing.css`, which carries its own copy of the `@font-face` block + tokens rather than depending on a stylesheet it never loads.

## Layout stability: reserving client-injected chrome (CLS)

Code: `generate/articleChromeReserve.ts`.

The in-article chrome renders client-side for dev/prod parity (back-link, byline + post-meta, the copy/subscribe control row, the narration dock), so each would push the article down as it mounts. The fix: **reserve each element's box at build time** so the client swap is layout-neutral. (The font preload above is the other half of the page's CLS story.) The reservations ride the same `bunHtmlHeadPlugin`, so dev and prod stay identical — deliberately *not* the served-HTML strip, which is prod-only and would leave dev shifting. Post-scoped, idempotent.

- **Replace-in-place** (back-link, byline, post-meta): the build emits a fixed-height empty `*-reserve` placeholder; `base.css` gives it the *same* box as the real element; the client `replaceWith`s it — identical boxes ⇒ zero-shift swap. One subtlety: `.back-link` is block-level `flex`, not `inline-flex` — an inline box sits in an anonymous line box whose strut makes it taller than the reserve, reintroducing a shift.
- **Append-into** (the control row): copy-markdown and subscribe share one slot, so the build emits a min-height `.subctl-zone` container the modules fill; the zone holds its reserved height throughout.
- **The dock is reveal-after-mount, not reserve** — it's `position: fixed`, so it never reflows the article, but its bottom-anchored box grew *upward* as Shikwasa filled it. The build ships it hidden (`data-hidden`, translated off-screen); `revealDock()` shows it once mounted via transform/opacity — neither triggers layout shift — with the error path revealing too, so the "run generate" nudge still shows.
- **Data-gated reserves read the same source the client does** — the byline reserve emits only when the post has a profile, post-meta only with a version, gated on the *same* build data the runtime fetches — so reserved space always matches what renders.

Pinned by the byline/backLink/copyMarkdown/articleChromeReserve tests. Known residual: a small dev-server-only early-layout settle of the first `<section>` — a pre-existing dev rendering artifact, absent in prod.

## Heading deep-links

Code: `client/headerLinks.ts`.

Every `h2`/`h3`/`h4` gets an icon-only copy-link affordance (hover-revealed, gutter-positioned) so readers can share `…#section` URLs. A progressive-enhancement module living in `base.css` (narration opt-out posts need it too).

- **A real `<a href="#id">`, not a `<button>`** — right-click → copy-address and Cmd-click → new-tab come free, and the heading stays self-linked for AT and crawlers. The click handler `preventDefault`s the native hash-scroll (the reader is already looking at the heading; jolting the viewport on a copy gesture is wrong), copies, and reflects the hash via `history.replaceState` — replace, not push, so repeated clicks don't pile up Back entries. Modifier clicks early-return to native handling.
- **Author-supplied ids are preserved; missing ones backfill with slug-of-text** (deduped with numeric suffixes). Preserving existing ids is load-bearing: the same ids anchor the narration `<mark name>`↔`id` pairing and comment threads — re-slugging an authored id would orphan every anchor pointing at it.
- **Hash-stability for comments:** appending the icon must not change any block's `textContent` (the comments layer hashes it for stale detection). The icon SVG contains only `<path>` (no text nodes), the wrappers carry only `aria-label`, and none of the tags are in the block walker's set — invisible to both the hash and the walker.
- **Left gutter on hover; inline-after-text on touch** — `@media (hover: none)` gets `position: static` + a faint always-visible icon, because the gutter position clips off-screen on a narrow viewport and there's no hover to reveal it. `h1` is skipped (the URL already points at it). The narrated-post `.heading-speaker` flanks the same headings on the right — an independent enhancement.
- **Scroll re-anchor on load, never on click:** an arriving `#hash` scrolls before the enhancement modules settle the DOM, so `boot()` ends with one `reanchorToHashIfNeeded()`. The click path never re-anchors (the heading hasn't moved). The page-global `scroll-behavior: smooth` (+ reduced-motion override) lives in `base.css` so every future in-page anchor gets it for free.

## Author-only block-id labels

Code: `client/figureCopyId.ts`.

Authoring leans on stable ids (staging marks, "rewrite paragraph `zswap-body`" prompts), but ids live in source, not on the rendered page. This module floats a small `#id` label in the left gutter beside every `<figure id>` and `<p id>` — click copies the bare id. **Author/localhost-only**: gated on localhost *and* the server-authoritative `isAuthor` flag (same gate as the regen tools — a DOM authorship check can't work in prod where the meta tag is stripped); readers short-circuit before any network call. Idempotent.

**Figures carry the id as a real text node; paragraphs must not.** A `<figure>` isn't a commentable block, so its label holds selectable text (and is a find-in-page target; the `#` is a separate non-selectable span so copies never include it). A `<p>` *is* commentable, and the comments layer hashes `textContent` — a text-node label would silently flag every thread on the paragraph as outdated. So the paragraph label is an empty `<button data-pid>` rendered via CSS `::before` content, which `textContent` never sees (`<button>` is phrasing content, valid inside `<p>`). Cost, same root cause: the paragraph id can't be drag-selected and find-in-page can't match it — a visual cue only.

## Citation deep-links

Code: `client/citationLink.ts`.

Heading links point at sections; CC-BY content should be citable at the *sentence*. The comments layer captures exact passages but is login-gated and private; this module turns any article-body selection into a **W3C Text Fragment** URL (`#:~:text=…`) for everyone. The consume side is free (rendering is Baseline; non-supporting browsers land at the page top), so only the *generator* ships — lazily, behind the gesture.

**One selection bar, not two.** Logged-in desktop: the comment action bar already floats above the selection, so "Copy link" renders as a **sibling button inside that bar** (the comment layer owns it and tells the standalone button to stand down) — two near-identical pills, one above and one below, would compete and confuse. Everyone else (logged-out — the common case): the standalone button appears below the selection. Both are real `<button>`s using `mousedown` + `preventDefault` to keep the selection alive. Generation runs **on click**, never on the continuous `selectionchange` path (the chunk is pre-warmed when the bar appears); the standalone button instead debounces on selection-settle and shows only once a link is ready. Scope is body prose only — figure/SVG selections are ignored (`:~:text=` can't anchor into graphics).

**A trap worth naming:** Firefox fires `selectionchange` with the anchor inside the audio player's **native-anonymous content** (seek-bar internals), whose nodes live in another security principal — reading *any* property, or passing one to `.contains()`, **throws**. Both selection handlers (citation and comments) first run the shared `isInspectableSelectionNode` guard (`document.contains` behind try/catch), treating a throw as "not ours."

**Generation: the spec algorithm via `fragment-generation-utils`, not a hand-rolled emitter.** The consumer is the *browser's* Text-Fragment matcher, which imposes two rules a naive builder gets wrong — and a wrong directive silently scrolls nowhere, the worst failure for a citation feature: fragments must start/end on **Unicode word boundaries** (a mid-word mouse-drag must be expanded first), and a repeated phrase must be **iteratively disambiguated** with prefix/suffix/range until provably unique (the directive has no metadata slot, and the `#id` part doesn't scope the search — the comments layer's content-hash anchoring can't port here because the browser ignores it). GoogleChromeLabs' `fragment-generation-utils` (Apache-2.0, zero deps, the generator half of the polyfill, tracking Chrome's shipping behaviour) implements both; on `AMBIGUOUS`/`TIMEOUT` we **degrade to the nearest section's `#id` link** and relabel the button "Copy section link" rather than emit a broken URL. (A home-grown emitter shipped first and failed both ways on real posts — that failure is what bought the library.)

The DOM-free surface (directive encoding, URL composition, degrade decision) is unit-tested; the generation itself needs real layout + `Intl.Segmenter` + a live `Selection`, so the two motivating behaviours — mid-word selections resolving, repeated phrases disambiguated — are proven in `e2e/citationLink.e2e.ts` (select mid-word, copy, reopen, assert the scroll), and `e2e/citationCommentBar.e2e.ts` covers the merged-bar case.

## Testing layout

Tests are colocated with the code they cover (`<module>.test.ts` beside `<module>.ts`, no separate `tests/` tree); `bun test` is the single entry point. The suite splits by what each test needs from the runtime:

- **Server / generate / shared** — the bulk: offline pipeline, Worker entry points, runtime-agnostic helpers. Plain Bun, no DOM.
- **Client (DOM)** — per-file opt-in happy-dom ([below](#dom-testing-harness)).
- **Tier-0 pure extractions** — math/string logic lifted *out* of DOM-coupled client modules into pure helpers (`client/narratorTiming.ts` is the canonical example; `commentsStale.ts`, `narratorDom.ts`, `commentsDom.ts` follow). The rule: anything testable as `(input) → output` lives outside the class with its own `.test.ts` and no DOM; the DOM wrappers call into it, so math regressions are caught below the DOM layer.

### happy-dom or e2e? (the decision rubric)

happy-dom is a JS reimplementation of the DOM, not a browser: it parses markup, matches selectors, dispatches events, and resolves *plain* computed style — but has no layout engine, no rendering, no a11y tree, no audio decoder, and an incomplete CSS model. **Default to happy-dom; escalate to e2e only when the thing under test is something happy-dom provably cannot model.** The fast check when unsure: write the one-line probe and read what `getComputedStyle`/`getBoundingClientRect`/`getByRole` actually returns — empty/zero/nothing for the asserted property is your answer.

happy-dom is enough when the assertion is **structural or logical**: DOM shape after a render/enhancement; state machines, parsers, guards, localStorage round-trips; event wiring (handlers fire, state mutates); selector matching and *unlayered* specificity.

Escalate to e2e (`e2e/*.e2e.ts`, real browser) when correctness lives in what happy-dom doesn't implement:

- **Cascade layers** — happy-dom ignores `@layer` entirely: `getComputedStyle` returns `""` for any property set inside one (verified), so a bug whose mechanism is layer *ordering* beating specificity passes a DOM test regardless. The only honest guard is a real-browser computed-style read.
- **Real layout/geometry** — anything reading `getBoundingClientRect()`, CSS anchor positioning, `position: sticky`, `:popover-open`, light-dismiss. happy-dom returns zeros unless you hand-mock rects, which only tests the mock.
- **The accessibility tree** — role/name assertions; happy-dom builds no a11y tree.
- **End-to-end stateful flows** — where the assertion depends on the whole pipeline running for real (selection → compose → submit → CRDT → anchoring → upload).
- **Real audio playback** — happy-dom's `<audio>` has no decoder; `play()` never advances time.
- **Touch/device emulation** — `pointer: coarse`/`hover: none` rules and tap flows: a *narrow viewport in a desktop context still reports a fine pointer with hover*, so genuine-touch behaviour needs device emulation; viewport-gated *logic* doesn't and runs faster in a plain narrow context.
- **Substrate the browser owns** — SW lifecycle, push, OAuth redirects, OS clipboard.

The asymmetry behind the default: happy-dom tests run Chrome-free in the unit pass; e2e boots system Chrome + a dev server, on demand (`bun run test:e2e`). Pin a bug at the lowest layer that can see it.

### DOM testing harness

Code: co-located with `client/*.ts`.

Client modules need `document`/`window`/`localStorage`, supplied by **happy-dom registered per-file**: each DOM test's *first* import is `"../happydom.ts"` (a register-once helper) — before the module under test, whose top-level code needs `document` to exist.

**Per-file, not the docs-recommended global `[test] preload` — tried, rejected.** A global registration breaks the non-DOM suite: happy-dom installs `globalThis.localStorage` as non-writable (so a test's plain shim assignment throws — the project pattern for replacing any happy-dom global is `Object.defineProperty(globalThis, …, { value, writable: true, configurable: true })`), and it mutates `process` in a way `Bun.spawn`'s stdio config rejects, which no test-side shim fixes. Per-file opt-in scopes the blast radius to exactly the files that ask.

Every DOM test starts with `beforeEach(() => { document.body.innerHTML = "" })` (fixture pollution otherwise leaks between tests); localStorage users add `clear()`, global-replacers restore in `afterEach`.

**Tested in this layer:** the pure-DOM construction and state-machine halves of `narratorDom.ts` (chapter resolver, speaker targets, key guards), `commentsDom.ts` (block walker, hash normalization, highlight-mute storage), `byline.ts` (placement rules; the property that the served avatar URL never embeds the author email), `headerLinks.ts` (slugify/dedupe, idempotent injection), `citationLink.ts` (Text Fragment emitter). The full `Narrator`/`CommentSystem` classes are deliberately not constructed here — their dependencies (Shikwasa + real audio; Automerge + identity + polling) are covered at other layers.

**Deliberately NOT tested in this layer** (a ledger, so nobody re-attempts these):

- **Real audio playback paths** — the pure math is tier-0; the integration is the manual release-check (`scripts/release-check.md`).
- **Real CSS layout** — anchor-positioned cards, spacer geometry, popover placement: e2e territory.
- **Browser-owned substrate** — SW install, push, OAuth redirects, clipboard: e2e or manual; never happy-dom.
- **Tier-2 fetch wrappers** (`identity.ts`, `commentsSync.ts`, aggregator/polling/api modules) — small single-flight controllers exercised end-to-end by their consumers. The rule: **the first concrete regression motivates the test, not speculation.**
- **Per-engine quirk matrices** — Chromium is the automated target; Safari/Firefox are manual-quarterly. A cross-engine matrix multiplies flake for divergences a single-author blog verifies by hand.
- **Live-DOM reader extraction** — the Markdown twin's Readability runs at build time, golden-tested; the browser's own reader view over the live DOM is best-effort until a real regression is observed.
- **The real Cloudflare deploy surface** — `getPlatformProxy()` already closes runtime parity in dev; the residue (real bucket/cache rules) is the manual `dev:edge` smoke.

**Real-browser tiers.** Playwright as a *library* inside `bun test` (one runner, two surfaces); `*.e2e.ts` files are skipped by the default glob and run via `bun run test:e2e` against the system Chrome (no browser download) and a fixture dev server. The heavy build+wrangler lanes are deliberately named *without* the `.e2e.ts` infix (like `prodAudioSmoke.ts`) so the default e2e loop skips them; each has its own script. The tiers and the invariant each enforces:

- **Layout + a11y-tree smoke** (harness) — real geometry is non-zero; the comments column is a `complementary` landmark named "Comments," never a `feed`.
- **Comment-card positioning** (`commentPositioning.e2e.ts`, Chromium + Firefox + WebKit) — drives the real selection → compose → submit → CRDT → upload flow and asserts cards track highlights, drafts don't scroll-jump, below-fold cards persist, overlaps cascade, the rail stays pinned. Its session-minting + UI-driven seeding is the reusable "comment fixture."
- **Per-post accessibility** (`axe.e2e.ts`) and the **per-card a11y snapshot** (`commentA11ySnapshot.e2e.ts`) — the rendered WCAG bars; details under [WCAG conformance](#wcag-accessible-name-and-landmark-conformance--verified-by-tooling-not-spec-reading).
- **Mobile tier** (`mobile.e2e.ts`) — Playwright *device emulation* (a genuine coarse pointer with no hover — the thing a narrow desktop viewport can't fake). Guards the mobile-only surfaces as a phone drives them: the single button + menu (both identity states), tap-to-popover placement under the button, the one-at-a-time/anti-stacking invariant, light-dismiss, and the menu-item highlight mute. It also asserts the media-emulation invariants: reduced-motion drops smooth scrolling and card transitions; `colorScheme: "dark"` proves the **light-only** design never flips. The viewport-gated *logic* half (select → menu → compose with retention across the collapsing button tap) runs faster in the plain narrow-viewport tier `commentsMenuFlow.e2e.ts`.
  - *Emulation gotchas for future mobile tests:* small `position: fixed` targets need `tap(…, { force: true })` (actionability hit-tests mis-resolve under a >1 `deviceScaleFactor` and report `<html> intercepts pointer events` — assert visibility + a11y presence first, then force); and a force-tap after `scrollIntoView` lands at the *pre-scroll* coordinate under `scroll-behavior: smooth`, so scroll with `behavior: "instant"`, settle, then tap.
- **Service-Worker / PWA tier** (`serviceWorker.ts`, `bun run test:e2e:sw`) — the SW never registers under fast dev, so this drives the **built** worker via the harness's `startWranglerServer()`. Invariants: the SW controls the page; the app shell precaches; a visited post re-serves offline (network-first fallback); hash-named assets resolve from cache offline (the page *runs*, not just renders); a redeploy's `activate` reaps the prior version's caches; and the served manifest is installable-shaped (plus `theme-color`/`apple-touch-icon` in the head — a dev:edge-only concern, since head injection is a post-build rewrite). Deferred to the manual smoke: the SW's own `cacheFirstRanged` 206 branch (awaits an audio fixture; the prod Worker's Range contract is covered by `prodAudioSmoke.ts`).
- **Prod-CSP violation gate** (`cspConsole.ts`, `bun run test:e2e:csp`) — the *enforced* document CSP exists only on the built worker (Bun serves HTML routes bare), so this registers a `securitypolicyviolation` listener and fails on any violation across landing + every post while exercising figures/comments. It exists for the class of interaction-only violations a static pass misses — canonically **Zod's JIT `new Function` probe**, which `script-src` blocks: `shared/zodJitless.ts` sets `z.config({ jitless: true })`, and this gate is what keeps that from regressing. It also guards the hash-allowed layer-order inline `<style>`.
- **Broken-link / dead-fragment gate** (`brokenLinks.ts`, `bun run test:e2e:links`) — the only href/anchor validation in the engine (audit-posts checks nothing href-shaped), so a renamed slug or heading id would otherwise ship a silent 404. Runs linkinator with fragment checking over **the running worker, deliberately not the `dist/` directory**: internal links are extensionless and resolve only through Workers `html_handling` — a static crawl 404s all of them, and rewriting extensionless→`.html` silently *defeats* fragment checking (verified). The Markdown twins were rejected as a crawl target: the HTML→Markdown transform strips element `id`s, so every authored `#fragment` would false-positive — a different artifact answering a different question. External links are skipped (a publish-blocking lane must stay deterministic and not leak third-party requests). Coverage boundary: the author-written id/href layer in served HTML — **not** the heading slugs `headerLinks.ts` backfills at runtime.

**The self-contained fixture.** `e2e/harness.ts` defaults to the engine's own `templates/content-repo`, bootstrapped on first use by `ensureFixtureBlog()` (symlink + `bun link`/`install` + a generated `SESSION_SECRET` written to both `.env` and `.dev.vars`, which must agree) — so the whole e2e suite runs from a bare engine checkout, no private content repo. `PRESIDOCS_E2E_BLOG` retargets it, and each content repo carries its own `test:e2e*` scripts, so the author's one-command flow still drives the real blog. Tests stay content-agnostic to serve both targets: single-post tiers drive the alphabetically-first deployable post; the figure gates drive every post whose *source markup* loads a figure module — detected from markup rather than the runtime registry, so a bundling/registration regression fails the gate loudly instead of vacuously skipping. The fixture's `hello.html` is a real post (commentable length, a conformant FigureJourney figure, the full client-script set, manifest + icons so the SW shell doesn't 404) but narration-free on disk — the suite carries no TTS/MOSS dependency; audio-gated tests skip on it. CI (`.github/workflows/ci.yml`) runs two jobs against the fixture: `test` (typecheck + unit + the Chromium e2e loop) and `worker-tiers` (SW + CSP + links sharing one build via `PRESIDOCS_E2E_SKIP_BUILD`, plus the private-blog tier `test:e2e:private`, which builds its own private fixture).

**No workerd test pool (today), but the door is open.** [`@cloudflare/vitest-pool-workers`][CFVitestPool] runs tests inside real workerd with binding emulation — the natural home for any future `worker.ts` logic where the workerd-vs-Bun difference is itself the thing under test. Not wired in because `worker.ts` is a thin route table over handlers already covered in plain Bun, and `dev:edge` smokes the workerd path. The first regression the plain-Bun harness can't catch motivates it.

[CFVitestPool]: https://developers.cloudflare.com/workers/testing/vitest-integration/

## AI-assisted authoring

Code: `authoring/` + the `process-comments` skill.

The comment system is the authoring interface itself: the author highlights text in their own post and leaves "rephrase this" / "add an example" comments through exactly the reader UI. The loop: publish → readers and the author leave comments → run the **`process-comments` skill** (`/process-comments <slug>`) in a Claude Code session, which pulls every unresolved thread, edits the post HTML in place, and resolves what it addresses under live review → regenerate audio and redeploy.

**Author-self and reader comments are treated identically** — one working set, one coherent editing pass. Separating "what the author wants changed" from "what readers want explained" would lose the case where one edit addresses both.

### How the loop works (the `process-comments` skill)

The skill (`.claude/skills/process-comments/SKILL.md`) runs inside an ordinary interactive session and drives:

1. **Sync down** — `bun run pull-comments <slug>` (production) plus `--local` (the running dev server). The two live stores are distinct (prod R2; the dev server's Miniflare R2), and neither is the on-disk store the offline tools read, so each needs its pull. An unpublished post's prod pull is a harmless no-op.
2. **Fetch** the open set — `bun authoring/exportAnnotations.ts <slug>` → a Web Annotation `AnnotationCollection`.
3. **Read the [editing rules](#the-editing-rules)** and the post; **edit `posts/<slug>.html` in place**.
4. **Report a per-thread verdict** (`APPLIED | PARTIAL | NOTE-ONLY`) and pause for the author (`git diff`, corrections, more passes).
5. On sign-off, **resolve the `APPLIED` threads** (`bun authoring/resolveThreads.ts`) and **push resolutions back** (`bun run push-resolutions <slug>`), so production hides them for the original commenters.

### Why local tooling, not in-Worker or the browser

- **Workers can't host it** — a pass takes minutes of interactive editing; Workers target second-scale requests.
- **The browser can't hold credentials** — any key shipped to the client lets whoever has the page open spend the author's quota.
- **Local already has the files** — the post is in the working tree, and the next step is `bun run build` against the same directory.

Author identity is intrinsic: only someone with the checkout and an authorized Claude Code session can run the skill — no new auth surface.

### Why an in-session skill (not a subprocess or the SDK)

- **The author's own session, plan, and auth** — no API key to provision, no separately-billed process.
- **Built-in Edit/Read/Grep** — no reimplemented tool loop, and Edit's `old_string`-must-be-unique invariant keeps every change a focused reviewable hunk; there is no full-file rewrite step where a narration block could silently vanish.
- **Iteration with shared context** — the session persists across passes ("reconsider just the narration comments", "revert that"), interleaving the author's direction with comment-driven edits. A one-shot invocation can do none of that.

### In-place editing; git is the review surface

The skill edits `posts/<slug>.html` directly — no draft sidecar. The author is present and steering; `git diff` is the review surface and git the undo. The safety model is **human-in-the-loop**, which is what lets the skill skip both a draft/accept indirection and a tool-permission sandbox: there is no memoryless process to fence, just an author watching.

### Inputs the skill sees

Each exported annotation carries: a **stable IRI** (`urn:blog:<slug>:thread:<id>` — the key for verdicts and write-back); the **`target` selector** with the exact quote (which Edit's unique-match requirement then locates); the **reply bodies** (the feedback itself); and **`x-blog:origin`** per annotation and body — which live store it was born in, so the skill can tell reader feedback (`production`) from the author's localhost scaffolding. `authorEmail` is stripped ([exporter](#exporting-to-the-web-annotation-wire-format)). `bun authoring/listUnresolved.ts <slug>` prints the same set human-readably.

### What gets filtered out

The loader walks the local store (`generated/.comments-dev/`) only, replaying each user's change-objects against the shared seed. It then **cross-merges replies across every reader's blob**: a thread lives only in its creator's blob, but replies to it can live in *any* blob — most importantly the author's replies on a reader's thread — so replies are bucketed by thread id globally, mirroring the browser aggregator's merged read. (Per-*blob* bucketing would silently drop every author-on-reader reply.) From the merged set it drops: self-resolved threads, author-resolved threads (the resolutions namespace), and threads with zero live replies (defensive). What's left is what Claude sees — never a thread already addressed.

### Syncing production comments

Code: `authoring/r2Sync.ts`.

The offline tools speak only to `.comments-dev/`; two thin pull/push pairs bridge it to the two live stores: `pull-comments <slug>` (down; `--local` for the dev server) and `push-resolutions <slug>` (up; `--local` lets the open browser tab hide resolved threads on its next poll — no restart, which keeps the localhost iterate loop live).

- **Why not `wrangler r2 object sync`:** no such command exists (single-key ops only, and the REST API can't list a bucket). The only path to R2 with the author's existing wrangler OAuth login — no separate S3 credential — is a Worker bound to the bucket: `r2Sync.ts` writes a throwaway config, runs a tiny worker under `wrangler dev --remote` (bound to the production bucket), talks to it over loopback for a few seconds, and kills it. Never deployed. This is exactly the localhost-exempt "smart tool" the dumb-edge rule allows — it merges nothing, just shuttles opaque bytes.
- **Direction fences:** pull is **additive and never deletes** (change-objects are immutable, resolutions only grow), scoped to one slug; push is **fenced to `resolutions/` keys** — reader-owned blobs can't be overwritten. Both hold identically in `--local` mode.
- **The pull is incremental**: content addressing means a mirrored blob can never have changed, so pulls LIST then GET only missing hashes (the same set-diff as browser sync), with bounded concurrency. Cost tracks the delta. Resolutions (mutable, few) always refetch.

**Per-blob origin stamps.** Each mirrored blob gets a `<hash>.bin.src` sidecar recording its birth store (`production` | `localhost`) — presence in a store proves nothing about birth (history travels, e.g. via localStorage), so provenance is recorded explicitly. The fences make it sound: blobs have no upward path, so anything ever observed in prod was *born* on prod — `production` wins, and a `localhost` stamp upgrades one-way. The offline loader converts blob stamps into per-thread/per-reply origins **by subset replay** (replay the production-stamped blobs alone, then all; an item first appearing when localhost blobs join was born there — the production subset is dependency-closed because a prod change can't depend on a localhost one). Resolutions are deliberately *not* stamped: they're pushed to every store whose pull found comments (a thread can span stores), and an orphan envelope in a store that doesn't know the thread is harmless.

**Seeding prod comments into the dev browser** (`bun run seed-comments <slug>`) restores the loop where the author opens a prod-born thread on localhost and replies with extra context for the LLM — scaffolding that never publishes (the upward fence stays resolutions-only). Seed PUTs the production-stamped blobs into the running dev server through the normal `/comments` API, **preserving the own-folder PUT fence** by minting a session per user folder — every minted session carries the author's email because it *is* the author acting (which also gets the trusted-owner rate-limit exemption). Each seeded blob carries `origin=production` metadata; resolutions seed too, so prod-resolved threads don't reappear. Idempotent (stamped blobs skip; unstamped ones re-PUT to upgrade metadata).

**The origin tag — one uniform rule, no environment branches.** The listing handler exposes origin metadata iff the stored object carries it; the client tags replies iff the view mixes origins. Per **reply**, not per thread (origin is a per-blob fact; a prod thread carrying localhost scaffolding replies is the whole point). Both classes get labels (`prod`/`local`) so an *untagged* reply unambiguously means "derivation didn't cover it," never silently "local." Attribution is **derived fresh each boot, never persisted** (`deriveOrigins`, the same subset-replay idea; change GETs are immutable-cached, so it's nearly free — and derived provenance can't drift or need migration). The render gate — tags appear only when a production-born reply exists in the view — is what keeps single-origin stores clean *without* an `if (prod)` branch.

**The `--local` mechanism: through the dev server's HTTP API, with a minted session.** The dev server holds its Miniflare R2 store open, so the bridge goes through the one process that owns it live — its own `/comments`/`/resolutions` endpoints — not a second `getPlatformProxy` (reads OK, but writes risk `SQLITE_BUSY` and wouldn't reliably surface to the server's open handle) and not Miniflare's internal blob layout (an implementation detail). Auth needs no server change: sessions are stateless HS256 JWTs and both CLI and server read `SESSION_SECRET` from `.env`, so the CLI mints a real author session — author power still comes from the email matching the post's `author-email` meta, the same check every author endpoint runs. It grants nothing the dev operator doesn't already have (they hold the secret), and the CLI **refuses any non-localhost URL**. Rejected: dual-writing dev to R2 + `.comments-dev` (re-splits the unified stores); reverting dev to the fsAdapter (loses parity outright).

### The editing rules

File: `authoring/authoringRules.md`.

A small (~4 KB) doc, deliberately not this whole methodology — the skill loads only what "how should this paragraph read" needs: the post's HTML structure, the mark↔id pairing, which tags are untouchable infrastructure, the per-post stylesheet (CSS authoring) contract, the decision tree (typo → apply; rewording → rewrite; substantive disagreement → `NOTE-ONLY`, never silently applied), and the required verdict format.

### Resolution write-back (resolve-iff-shipped)

`bun authoring/resolveThreads.ts <slug> <id…>` writes one author-resolution envelope per thread (accepting bare ids or the IRI verbatim), with `resolverId: "ai-applied"` — deliberately distinct from the OAuth `<provider>:<sub>` scheme so AI-driven resolutions stay greppable.

- **Only `APPLIED` resolves.** `PARTIAL` and `NOTE-ONLY` stay open — the verdict is the skill's self-assessment, not ground truth; the author closes those manually.
- **Resolve only after the edit shipped.** Because the skill edits in place and resolves only on sign-off, a thread is resolved iff its edit is actually in the file — no draft-rejected window where a thread closes without its content shipping.

Resolutions land in the local store; `push-resolutions` mirrors them up (or `--local` to the dev server). Resolving is deliberately not bundled with a version bump — the content hash is recorded on the next `bun run build`, which also arms the readers' "doc changed" banner.

### Decided against — surfacing per-iteration AI history in the browser

Fundamentally incompatible with in-place editing: intermediate passes exist only as uncommitted working-tree states, and making them durable would reintroduce exactly the per-pass snapshot machinery in-place editing was chosen to drop. Iteration history lives in **git** (commit between passes for checkpoints); only shipped revisions surface, via the [Document versions](#document-version) panel.

### Excluded from v1 (authoring)

- **Chained audio regeneration** — `bun run generate` exists; the author usually wants to verify prose before paying the multi-minute render.
- **Reply-back to commenters** — proposed responses sent by email; deferred until outbound email exists.
- **Multi-post sessions** — one post per invocation; cross-series consistency is a manual loop.
- **Unattended / CI runs** — the skill is interactive *by design*: resolution ties to live sign-off, so there is deliberately no headless path for a bot to apply-and-resolve on the author's behalf.

## Deploy architecture

Production runs on **Cloudflare Workers + R2**; **Bun** is dev-time and build-time only (`bun --hot index.ts`, `bun run generate`, the bundler). Bun never runs in production; Workers never runs in dev. Both runtimes share the same TypeScript handlers because the shared cross-runtime handlers are written against the standard `Request` (never `Bun.BunRequest` — dev-only routes in `createDevServer.ts` may use it) and cross-runtime primitives (`jose`, WebCrypto's `crypto.subtle`, `process.env` — the last is what `nodejs_compat` provides on Workers) — the same exported handlers mount under `Bun.serve` in dev and under the Worker `fetch` in prod.

### Why Workers (and not Bun on a VPS)

The backend is small, write-rare, and read-by-author-only — the profile Workers' stateless-function-plus-bindings model fits. The platform primitives are exactly what [hardening](#hardening) the comment surface needs, with nothing to operate:

- **R2 binding** — `env.COMMENTS.get/put` directly; no S3 SDK, no signed-URL plumbing.
- **Workers Rate Limiting API** — sliding-window per-key limits as a binding.
- **Turnstile** — a soft CAPTCHA escalation path if rate limits ever trip legit users.
- **Edge body-size limits + DDoS shielding** — applied before our code runs.

### Static vs dynamic content

Most artifacts ship as static assets in `dist/`, served by the Worker's `ASSETS` binding (edge-cached, no per-read cost): article HTML, bundled JS/CSS, narration manifests, transcripts, the Automerge WASM. R2 holds only what fails one of two questions:

- **Does it change per user request?** The per-user comment change-objects do → R2 (`env.COMMENTS`).
- **Does it fit Cloudflare's 25 MiB per-static-asset cap?** The full narration track can exceed it → R2 (`env.AUDIO`), served at the same content-hashed URL ([Serving generated audio](#serving-generated-audio-content-hashed-filenames--dev-range-support)). The track is static (fixed per commit); it's the size, not mutability, that moves it.

The two buckets are separate (`…-comments`, `…-audio`) with separate bindings, so comment and audio plumbing evolve independently. Of the platform's asset limits, the per-file cap is the only one a blog can realistically hit.

### Runtime split

| Concern | Dev (local) | Prod (Cloudflare) |
|---|---|---|
| HTTP server | `bun --hot index.ts` | Worker `fetch` (`worker.ts`) |
| Frontend bundle | Bun HTML import | `bun build` → `dist/`, served by `ASSETS` |
| Auth routes | mounted on `Bun.serve` | same handlers (`server/auth/routes.ts`) on the Worker `fetch` |
| Comments | same handler + same `r2Adapter`, over a local Miniflare R2 binding from `getPlatformProxy()` (state in `.wrangler/state/v3/`) | same handler, `r2Adapter(env.COMMENTS)`, enforcing [author-only visibility](#hardening) |
| Rate limiter | local sliding-window limiter from the same proxy — the 429 path runs in dev | Rate Limiting binding (`wrangler.toml`) |
| Narration manifest + transcript | served from `generated/` | copied into `dist/generated/` by `copy-static`, served by `ASSETS` |
| Full narration track | served from `generated/` | uploaded to R2 (`generate/upload-audio-r2.ts`), served from `env.AUDIO` |
| Automerge WASM | served from `node_modules` | copied to `dist/assets/automerge.wasm` |
| OAuth redirects | `http://localhost:3000/auth/<provider>/callback` | `https://<domain>/auth/<provider>/callback` — both registered at each provider |

### Dev server wrapper

Code: `scripts/dev.ts`.

`bun run dev` wraps `bun --hot index.ts` in a watcher, because `--hot` is blind to two change classes: it excludes `node_modules` from its watch registry (and the `link:presidocs` engine lives there from the runtime's perspective), and the dev route table is codegenned from `posts/` once at startup (a static `Bun.HTMLBundle` route only mounts when that codegen re-runs and is re-evaluated).

The wrapper watches `node_modules/presidocs/**`, `posts/**`, `authors/**`; on change it re-runs the route codegen, then **respawns only when it must** — a respawn tears the server down and drops the HMR socket, forcing a full browser reload:

- **Engine or author edit** → respawn (the child can't see either: `node_modules` is unwatched, and author/version chrome is injected at bundle time from outside the post's import graph).
- **Post add/remove/rename** → respawn, tested exactly and cheaply: the codegen is idempotent, so respawn iff its output file actually changed.
- **Content edit to an existing post** → no respawn; the child's own HMR re-bundles it in milliseconds. This is the common authoring case and must stay respawn-free.

Robustness rules: the regen runs *before* the child is stopped (a post that fails codegen leaves the running server up, not down), and an unexpected child exit respawns under a crash-loop cap that bails out loudly. Build outputs (`.generated/`, `.comments-dev/`) are excluded from the watch so codegen can't trigger restart loops.

**Bindings via `getPlatformProxy()`.** The dev factory (`server/createDevServer.ts`) gets its R2 and rate-limiter bindings from `wrangler`'s `getPlatformProxy()`, which boots a Miniflare-backed environment from the content repo's `wrangler.toml`. The same prod handlers then run unchanged over real binding semantics — this is what keeps the dev store byte-compatible with prod (same `r2Adapter`, same delimiter-based listing) and keeps the 429 path exercised locally instead of prod-only. `authoring/fsAdapter.ts` remains for the **offline authoring tools**, which read/write the on-disk `generated/.comments-dev/` shape; the sync CLI bridges disk ↔ dev-server R2 state ([Syncing production comments](#syncing-production-comments)).

The Miniflare persist dir is `.wrangler/state/v3` by default, overridable via `PRESIDOCS_DEV_STATE_DIR` — the e2e harness points it at a throwaway temp dir per run so seeded comments never enter the developer's interactive store. `bun run dev:reset-comments` wipes the local store; it never touches prod R2.

**Two secret sources in dev.** Bun autoloads `.env` (the canonical dev secret store, read via `process.env`); `getPlatformProxy()` reads Miniflare's `.dev.vars`, which only matters for `dev:edge`. Keep the values mirrored (`.env.example` + `.dev.vars.example` ship in the template).

**`dev:edge` — the workerd smoke check.** `bun run dev:edge` (`bun run build && bun engine/generate/upload-audio-r2.ts --local && wrangler dev --port 3000` — the middle step loads audio into the local R2 binding so workerd can serve it) runs the real `worker.ts` against the freshly built `dist/` under workerd, with real binding config. It exists because Bun's `HTMLBundle` routes can't be wrapped with response headers (see [HTTP security headers](#http-security-headers)), so the document CSP — plus `run_worker_first`, the feed MIME overrides, and the rest of the asset path — is only verifiable here before a deploy. Deliberately not the inner loop (no HMR, no `/dev/*` tooling); pinned to `:3000` so OAuth localhost callbacks keep working.

**Alternatives considered.**

- **`wrangler dev` as the inner loop** — rejected: workerd can't host the dev-only author surfaces that are the point of localhost (`/dev/regenerate` and `/dev/sound-test` spawn the MOSS Python pipeline — no subprocess in workerd), so the loop would need a two-process sidecar with OAuth routing between them. Instead we take Miniflare's *bindings* into the Bun loop via `getPlatformProxy()`.
- **Cloudflare Vite plugin** — would put the document CSP in dev, but the build is deeply Bun-native (`Bun.build`, `HTMLBundle`, the footer bundler plugin) and workerd still can't spawn MOSS. Revisit if the offline MOSS surface ever moves out of the dev server; until then `dev:edge` covers the gap.
- **`remote: true` bindings** — wrong defaults here (dev writes into prod R2, burns the prod rate-limit budget, pollutes analytics). An ad-hoc `wrangler dev --remote` is the per-incident escape hatch.

### Deploy unit

One Worker per blog — no Pages site. The Workers **Static Assets** binding serves `dist/` directly and falls through to the `fetch` handler for everything else; `wrangler.toml` lives in each content repo (see `templates/content-repo/`). Build: `bun run build`. Deploy: `bun run deploy`. Pages-with-Functions was rejected: a second deploy target and routing model with no benefit once one Worker does both.

### Dependency-CVE release gate

Code: `generate/audit-deps.ts`.

The dependency posture is otherwise *preventive* (tiny dep set, hand-rolled capabilities, vendoring, type-only packages instead of SDKs) — which lowers the odds of a bad dependency but says nothing when an advisory is published against an accepted one months later. And `jose`/`arctic`/`@automerge/automerge`/`turndown`/`linkedom` are crypto/OAuth/HTML-parsing libraries, the class where advisories land late. So the `deploy` script runs this gate as its **first** link (its fail-open behaviour, below, is what makes that safe), ahead of [`audit-dep-licenses`](#licensing-content-vs-code) and the [`verify-narration`](#interchangeable-to-run-not-equivalent-in-output--so-production-grade-is-a-publish-gate) provenance gate — the *detective* complement to the preventive posture, and the dependency-tree sibling of the [`audit-posts`](#wcag-accessible-name-and-landmark-conformance--verified-by-tooling-not-spec-reading) content gate.

It shells out to the native `bun audit --prod --json` (zero new dependency, zero client bytes; reads the existing `bun.lock`; `--prod` scopes to what ships). Coverage caveat: npm/GHSA advisories, not the full OSV corpus. The gate parses the JSON itself rather than trusting the exit code, which buys:

- **A severity floor** — only findings ≥ `GATE_SEVERITY` (default `high`) fail the deploy; lower severities print as informational.
- **A waiver roster** — a triaged advisory is waived in code (`WAIVED_ADVISORIES`, keyed by GHSA id, with a one-line unreachability reason and review date). The bar for entry is "we read the advisory and it can't reach us"; the default response to a real finding is a version bump, not a waiver.

**Fail-open on inability to run**: if the audit can't produce a parseable report (offline, npm down), it warns and passes — a deploy is online anyway and will fail later if the network is truly out. It blocks only on a finding it can see.

Ledger: `osv-scanner` (full OSV corpus) deferred — revisit if an OSV-only advisory ever hits a shipped dep, or when a CI lane exists to host it. Snyk/paid SaaS SCA rejected (account, telemetry, third-party data flow). Dependabot/Renovate rejected (CI machinery, clashes with the main-only working style). `audit-ci`/`better-npm-audit` can't read `bun.lock` — adopting one means maintaining a second lockfile resolved by a different resolver to do less.

### Supply-chain: install policy

Config: `package.json` (`trustedDependencies`) + `bunfig.toml` (`minimumReleaseAge`, `telemetry`).

The preventive posture is enforced at the package manager, in both repos (engine and content repo each run `bun install`):

- **All lifecycle scripts blocked: `trustedDependencies: []`** (a `package.json` manifest field, not bunfig). The empty array opts out of Bun's default allowlist too, so no dependency ever runs `preinstall`/`postinstall`. This is safe because the native-binary deps that look like they need scripts (`sharp`, `esbuild`, `workerd` — transitives of `wrangler`/`miniflare`) actually ship binaries as `optionalDependencies` platform packages. Blocking everything is *stricter* than trusting those three by name (their scripts do nothing useful here). If a future dep genuinely needs its script, the install prints `Blocked N postinstall` and `bun pm untrusted` names it — an explicit, reviewable trust decision instead of an implicit allowlist.
- **7-day release-age cooldown: `[install] minimumReleaseAge = 604800`.** A version published within the last week is filtered at resolution time — the window in which a maliciously published patch typically lives before takedown, which is the canonical npm supply-chain attack. Only newly-resolved versions are affected (restoring an unchanged `bun.lock` re-resolves nothing); `minimumReleaseAgeExcludes` is the per-package override. `telemetry = false` rides along.

Deferred: `frozenLockfile` (single author, no CI — it belongs in a future CI lane as `bun install --frozen-lockfile`); Bun's pluggable pre-install vulnerability scanner (adds a real dependency; a multi-author-scale decision).

### Licensing: content vs code

Code: `shared/licenseConfig.ts`.

The blog is **dual-licensed**: content (prose, figures, images, audio) under one license, code (the `<pre><code>` samples and exported figure source) under another — because the two are reused differently. Attribution-on-a-snippet (CC-BY's ask) is exactly the friction that stops a developer from dropping code into their project; a permissive code license isn't a meaningful loss for prose. Recommended pairing: **CC-BY-4.0** content, **MIT** code.

- **License as data.** `CONTENT_LICENSE`/`CODE_LICENSE` (+ optional `_URL`) are env knobs — SPDX identifiers resolved once at build time and baked into static artifacts, never read at request time (dumb-server rule). A known identifier resolves its own deed URL; an explicit `_URL` wins and is required for custom identifiers.
- **Opt-in, never imposed.** Unset → omitted from every surface. The engine must not declare a downstream blog's content freely reusable by default, and omission is legally safe (unlicensed = all-rights-reserved). The recommended values live in `.env.example`, not engine defaults. The "author meant CC-BY but forgot" failure is closed by the gate below, not by a default.
- **Where the declared license travels** (each surface only when set): JSON-LD `license`/`copyrightHolder`/`copyrightYear` (post + landing); Atom feed-level `<rights>` (deliberately the *content* license — Atom conveys the posts); Markdown-twin front-matter (`license` + `code_license` — a pasted doc bundles prose and snippets); an `llms.txt` line; a footer `rel="license"` link. `LICENSE.md` in the content repo is the canonical human text with the prose-vs-code split; the engine repo's own `LICENSE` (MIT) covers the engine software.
- **The podcast license inherits the content license.** `PODCAST_LICENSE` is an *override*, not a peer: it exists because the narration is the author's synthesized **voice**, and an author may license the words liberally (CC-BY) while restricting the voice (no redistribution/remix of the clone) — a differential one license can't express. Absent that, leave it unset; the `<podcast:license>` tag follows `CONTENT_LICENSE`.
- **Publish-time gate (`generate/audit-own-license.ts`).** A published build (`SITE_URL` set — the same going-live signal every discovery step keys on) with no `CONTENT_LICENSE` fails; missing `CODE_LICENSE` is a warning — except when the build advertises figure source ([figure source pointers](#copy-as-markdown)), which promotes it to a hard failure, since shipped source inviting reuse must carry terms. `SITE_URL`-less builds are exempt, so local exploration is frictionless; the choice is forced exactly once, at going-public. It runs as the fail-fast first step of the content repo's `build` script; `figure-source-export.ts` additionally enforces the figure-source case from inside the build.
- **Served notices (`/license`, `/licenses`).** Several bundled licenses require their notice to travel with the distribution (MIT "in all copies", Apache-2.0 §4, CC-BY's visible attribution for the Font Awesome icons) — a buried `@license` comment in a minified bundle satisfies none. `/license` serves the blog's `LICENSE.md` as `text/plain`; `/licenses` (+ `.txt` sidecar) is the grouped acknowledgements page (blog terms, fonts' OFL, every bundled dependency's notice), emitted under the same `SITE_URL` gate as `/help`.
- **The shipped-dependency set is derived, never hand-kept.** A static "deps we ship" list rots silently — one new client `import` and a required notice goes missing. `clientDeps.ts` builds the real client entrypoints with a metafile and collects packages from the **output** chunks that survived tree-shaking (not the input graph, where a fully tree-shaken import appears but ships nothing). Notice text comes from each package's own `LICENSE`/`NOTICE` file.
- **The gate (`generate/audit-dep-licenses.ts`)** fails when a client-bundled dep carries a non-permissive/unrecognized license or no reproducible notice; build/server-only deps are exempt (only distribution creates the duty). Standing waiver: **GSAP** (GreenSock's no-charge custom license, surfaced verbatim). Unlike the CVE gate, this one **fails closed** when it can't derive the client set: that derivation is a local bundle, so failure means the build is broken, and a compliance gate that can't see what ships must not wave a deploy through. It runs in the `deploy` chain beside the CVE gate.

Ledger (settled rejections): one `LICENSE.md` with a split section, not two files (every surface needs one canonical link). Blog-level, not per-post (a per-post override is a sync surface and a [private-blog](#private-blogs) enumeration vector). Build-time emission, not a Worker route (dumb-server). MIT over CC0 for code (recognizable on sight; `CODE_LICENSE` is overridable for public-domain preference). Blog-level `code_license` front-matter, not per-`<pre>` markers (a snippet isn't separately addressable). Figure-source files get an SPDX one-liner, not full license text. A hand-curated third-party-notice file rejected (rots on the next import — same reason the dep set is derived). Not yet built: the [video](#video-export) end-card attribution line.

### Copying static artifacts into `dist/`

Code: `generate/copy-static.ts`.

`bun build` only knows the HTML/JS/CSS module graph; the other served artifacts are copied into `dist/` by this step (between the build and the HTML strip): `generated/<slug>/manifest.<hash>.json` + `captions.vtt` → `dist/generated/<slug>/`, and the Automerge WASM → `dist/assets/`. The include rule is one pure, unit-tested predicate (`shouldShipGeneratedFile`), matching by exact name so a stray file is never swept in. Deliberately excluded: the full audio track (R2, not `dist/` — see [Static vs dynamic](#static-vs-dynamic-content)), build-internal files (`.tts-cache/`, `.comments-dev/`, `cache-keys.json`), and dotfiles.

- **A size guard backstops the 25 MiB cap**: after populating `dist/`, any oversized asset aborts the build with a file-named error — failing legibly at the step that produced it instead of deep inside wrangler.
- **It mirrors, it doesn't merge.** `dist/generated/` is wiped before repopulating, because a plain copy only ever adds: a superseded `manifest.<hash>.json` left behind stays live at its URL and caches keep serving it — content-addressing stops the page from *requesting* the old file, but only deletion stops the server from *answering* it. The R2 uploader reconciles in the same spirit (live track + one prior per post). Idempotent; safe to re-run.
- **The exported [video](#video-export) is deliberately not shipped** — it stays a local artifact the author uploads by hand; the Worker's video MIME/Range plumbing exists but is unreachable while nothing puts an `.mp4` in `dist/`.

### Build-time HTML strip

Code: `generate/strip-served-html.ts`.

Post HTML in `posts/` is the *authoring* artifact; much of it is dead weight (or a liability) at the reader's runtime. The last build step rewrites every `dist/` HTML in place, removing: `<meta name="author-email">` (spam mitigation — the server-side author check reads *source* HTML), `<script type="text/narration">` and the PLS lexicon (generation-only inputs; the player reads the manifest). Dev serves unstripped source — nothing a scraper sees, and stripping there would need an HTML-loader plugin for no gain.

The site footer is injected at bundle time (`generate/build-html.ts` wraps `Bun.build` with `htmlHeadPlugin()`, which runs the footer inject among its head rewrites), with the strip pass's own inject as an idempotent backstop (it short-circuits on the footer marker). In dev the same engine head-plugin injects it via the content repo's `bunfig.toml` `[serve.static].plugins` seam — the one place Bun's dev bundler accepts an HTML loader — so the footer renders identically under `bun run dev`.

### Code blocks

Code: `generate/highlightCode.ts`, `generate/shikiTransformers.ts`.

Authored `<pre><code class="language-…">` is highlighted at **build time** by Shiki — zero reader JS; the reader downloads coloured HTML. The pass rides the shared HTML seam that runs in both dev and prod (`generate/bunHtmlHeadPlugin.ts`), so the two render identically, and nothing Shiki-related reaches the Worker. It's a surgical `HTMLRewriter` transform (a whole-document re-serialize would perturb the post bytes), idempotent, and position-agnostic — which is why the three usage patterns need no special cases: a bare block in prose, a `<figure>`-wrapped block (commentable + narration-stageable), or a composite figure mixing a code block with SVG siblings.

**CSP is the load-bearing constraint.** Shiki's default per-token inline `style=` dies under `style-src 'self'`. A vendored `styleToClass` transformer rewrites every token style into a colour-keyed class; the token-colour rules ship as committed CSS in `base.css`, tuned to WCAG SC 1.4.3 against the code background (a unit test asserts the CSS covers every emitted class). Annotations follow the same principle — **explanatory labels are overlaid onto the code, never stuffed into it**: `// @note:`-style trailing comments are extracted before highlighting and re-injected as absolutely-positioned overlay spans; a small `elisionComment` transformer renders an authored `// ...` as a bare `...`. The stock Shiki transformers supply `[!code highlight/focus/++/--]`. The [Markdown twin](#copy-as-markdown) recovers clean source from the highlighted markup (joins `.line` blocks, drops injected overlays) and emits a labelled fence.

### Copy as Markdown

Code: `shared/htmlToMarkdown.ts`, `generate/markdown-export.ts`, `client/copyMarkdown.ts`.

Every post carries a "Copy as Markdown" split control (primary: copy a clean Markdown rendering for pasting into an LLM; menu: copy / view as Markdown). The Markdown is a **build artifact** — `generate/markdown-export.ts` emits `dist/posts/<slug>.md`; both actions point at that static file, so nothing heavy ships to the browser and what a reader copies is byte-identical to what the golden tests pinned. The dropdown is a plain JS menu, not the Popover API — a small action menu doesn't need the top layer.

- **Extract at build time, from the served HTML.** The pre-JS served HTML is already clean: no comment column, an empty narration dock, figures still in their static-SVG fallback. A live-DOM extraction (what browser reader modes do) would have to fight all of that off — and would sweep in the reader's own comment highlights and drafts, which are not the article. It runs after [the strip pass](#build-time-html-strip), over the same input the publish audits check, so the twin reflects exactly what's deployed.
- **The transform is pure** (HTML in, `{title, markdown}` out, no IO) and deliberately not a Worker route (dumb-server rule; a static file needs no request-time rendering). Extraction is Mozilla **Readability** (the Firefox reader engine — an importable, deterministic, golden-testable library; Chrome's DOM Distiller is unexportable C++ and being retired) over a **linkedom** server DOM (happy-dom's selector parser throws inside Readability under Bun). When Readability bails on a short post, the fallback serializes the post's own marked article root. Then Turndown, extended with the GFM plugin for exactly `tables`/`strikethrough`/`taskListItems` (without the table rule, a `<table>` flattens to a run-on line) plus two hand-written rules that re-emit `<details>`/`<summary>` asides as raw HTML (GitHub renders them collapsible; the blank line after `</summary>` is load-bearing). Each `<figure>` is pre-collapsed to its caption text — except a `<figure>`-wrapped `<table>` (tagged a figure only to be commentable), which is unwrapped so its data survives as a pipe table. Known limit: Readability strips `<input>`, so task-list checkboxes only survive the fallback path.
- **Front-matter is serialized by the `yaml` library, never hand-assembled** — a regex standing in for the YAML scalar grammar emits `title: true`/`2026` as a bare non-string, and an embedded newline breaks the block; `yaml.stringify` quotes exactly what needs quoting. Golden-tested with no browser.
- **The part divider earns a heading level in the twin.** In served HTML the [part](#two-level-chapters-parts--sub-chapters) divider is a presentational `<div>`, not a heading — the document outline must stay narration-independent. The twin's job is structural fidelity for ingestion, so `rebuildPartHeadings` promotes each divider to `<h2>` and demotes the sections it groups, yielding `#` title / `##` part / `###` section — the same nesting the outline drawer renders. The demotion is position-aware (an intro section before the first part stays top-level) and the whole rebuild is gated on the post having parts (a divider-free post converts byte-identically). Promotion also protects the divider from Readability, which can score a lone text `<div>` as boilerplate.
- **The `·`-prefixed "timeline" grouping in some divider labels is emitted verbatim, never reconstructed as structure.** No canonical surface (HTML, narration, outline) encodes that level, so synthesizing it would mean the twin *inventing* hierarchy by string-parsing label text — forbidden twice over (never invent structure a canonical surface lacks; never regex over structured content). If a real third level is ever wanted, build it once as explicit shared structure (a `data-part-parent` attribute) all surfaces derive from.
- **Figure source pointers.** An animated figure's caption note also links its real, unminified source: the figure declares `data-figure-src="<module>"` (explicit, because the DOM doesn't know which module animates it — ids don't match module names, and most figures are static SVG with no code), and `generate/figure-source-export.ts` copies `figures/<module>.{ts,css}` into `dist/posts/<slug>/figures/`. The link is **absolute** when `SITE_URL` is known — the twin is pasted into LLMs where a relative link is a dead string. The copy is single-file (figures import only `gsap` + the engine contract, never siblings) and **co-located under the post slug**, so on a [private blog](#private-blogs) it inherits the capability token with no extra branch — a flat `figures-src/` directory would be a post-enumerating leak. Each emitted file gets an SPDX header from the [code license](#licensing-content-vs-code), and advertising source with no `CODE_LICENSE` hard-fails the published build. Why not the sourcemaps the build already ships: a map is per-chunk (~30 modules + vendored gsap mixed), not a figure-scoped legible file. Why not a GitHub link: assumes the source is public — untrue for a private or unpublished blog.
- **Discovery + dev parity.** Each post's head carries `<link rel="alternate" type="text/markdown">`, and [`llms.txt`](#site-level-discovery) links the `.md` twins directly. Dev has no `dist/`, so the dev route generates the Markdown (and serves figure source) on the fly with the same transform — dev matches the deployed twin link for link.

### Subscribe controls

Code: `client/subscribe.ts`.

One or two subscribe split-controls sit next to Copy-as-Markdown in the byline slot — the reader-facing front door to the [feeds](#subscription-feeds-atom--podcast-rss): an **article feed** control on every post (copy `/feed.xml`; menu: open in feed reader via `feed://`, learn-more → `/help#subscribe-articles`), and a **podcast feed** control only on posts with narration audio (copy `/podcast.xml`; menu adds *Copy episode audio* — the [stable episode URL](#stable-shareable-episode-url), never the swept-on-rebuild hashed file).

- **A podcast subscription is whole-show** (RSS has no per-episode subscribe), so the feed link is identical on every post; the only per-post artifact is the episode audio. The control derives both its "is this an episode" gate and the audio path from the narration manifest the player already fetches — no new build-time signal, and the fetch is cache-shared with the narrator.
- **Copied links are canonical**: built from the page's `<link rel="canonical">` origin, falling back to the live origin only in dev — a reader on a preview host still copies the canonical URL.
- The two controls stay **separate**, not one merged "Subscribe" menu: podcast and article subscriptions are different acts with different destinations. This is the only place the article chrome surfaces raw feed URLs; the other entry points are `/help#subscribe` and the `<head>` autodiscovery links.

### "Edit" on GitHub

Code: `client/viewSource.ts`, `generate/sourceRepo.ts`.

An opt-in **"Edit"** pill links a post to its own source on the blog's public repo. `SOURCE_REPO_URL` (+ `SOURCE_REPO_BRANCH`, default `main`) resolve `<base>/blob/<branch>/posts/<slug>.html` — the repo path mirrors the site path. Unset → no control. The URL is computed at build and injected as `<link rel="vcs-github">` by the head plugin (dev and prod), so the client module just reads the href; the visible link points at GitHub's `/edit/` variant (auto-fork contribute flow) while the head link stays the canonical blob.

- **Short labels, full accessible names**: the four byline pills are one word each (Copy · Podcast · Feed · Edit) with full-action `aria-label`s (Label-in-Name-compliant: the name contains the visible word). The reserved `.subctl-zone` grows its `min-height` at measured wrap widths so the client-mounted row never shifts the article (the reserve is content-blind; making it content-aware is deferred — proposal 62).
- **Private blogs get nothing, unconditionally**: `resolveSourceRepo` returns null under `BLOG_PRIVATE` even when `SOURCE_REPO_URL` is set — a public source URL would both reveal a capability-gated post exists and hand out an off-capability path to it. `audit-private.ts` fails any private build page carrying the link.

### Back to all posts

Code: `client/backLink.ts`.

Every post opens with a muted "← All posts" link above the `<h1>`, pointing at `/` — the one-click path back for readers who landed directly from search/feeds/shares (whose browser history is empty). Client-mounted for dev/prod parity like the rest of the byline chrome; the footer's build-time Home link is the bottom-of-page counterpart.

### Offline / PWA

Code: `client/sw.js`, `client/swRegister.ts`, `generate/injectPwaHead.ts`.

The site is an installable PWA with offline reading of previously visited pages. The engine owns the Service Worker, registration boot, head-injection and build wiring; the content repo owns `manifest.webmanifest`, `icons/`, and the registration `<script>` in its HTML — cache strategy stays reusable, per-blog identity stays with the author.

**Cache strategy: three buckets, picked by URL shape.**

- **Network-only** for `/auth/*`, `/comments`, `/resolutions`, `/post-version`, `/_a` — caching even briefly creates races (logout-that-doesn't-take, comment-that-doesn't-show). The SW returns without `respondWith()`, so the browser fetches unobserved.
- **Cache-first** for `/generated/*`, `/assets/*`, and hash-named `*.{js,css}` — content-addressed URLs change when bytes change, so a hit is correctness-safe forever. This is the offline-listen story: a re-visited MP3 plays with no network.
- **Network-first with cache fallback** for navigations and post HTML — a re-publish shows immediately; the cache serves only when the network errors.

Traps and invariants:

- **`VERSION` is substituted at copy time, not bundle time.** The SW is served as top-level `/sw.js`, outside the module graph, so a bundler `define` can't reach it; `copy-static` string-replaces the placeholder with a per-deploy value, and `activate` reaps caches from other versions.
- **The Bun inner loop must stay SW-free.** `swRegister.ts` gates on a `__BUN_DEV__` define: under `dev:edge`/prod (through `Bun.build`) it registers; in the Bun loop (identifier undeclared) it not only skips registration but **actively unregisters any SW on the origin and purges its caches** — `dev:edge` and `bun run dev` share `localhost:3000`, and a leftover SW would cache-first-serve stale `/generated/*` snapshots the dev server never even sees. SW behaviour is therefore verified at `dev:edge`, the same posture as the document CSP.
- **`Cache-Control: no-cache` on `/sw.js` is load-bearing** — without it a stale SW sits in front of every deploy and visitors never see the rollout. Dev sets it on the route; prod appends a marker-guarded rule to `dist/_headers` (engine policy, not per-blog choice; blogs append their own rules to the same file).
- **Range requests are answered from cache with a synthesized `206`.** A cache-first `200 OK` to a `Range:` request is rejected by Safari mid-track. The SW slices the cached full body using the same `shared/httpRange.ts` resolver the dev server and Worker use; since the SW can't import TS, `copy-static` transpiles and splices the module between markers at copy time, and a parity test asserts the shipped block matches the shared module — one RFC 7233 implementation, three consumers, no drift.
- **Head injection is fail-silent and typed.** `injectPwaHead.ts` adds the manifest link, `theme-color`, and `apple-touch-icon` (read from the blog's own `manifest.webmanifest`, typed against the W3C manifest schema so a wrong field name is a `tsc` error); a blog with no manifest gets no broken link. iOS ignores manifest icons for the home screen — the `apple-touch-icon` is required separately, and iOS installs only via Share → Add to Home Screen.
- **Aggressive update lifecycle**: `skipWaiting()` + `clients.claim()` — the next navigation runs the new SW. Safe because HTML is network-first and assets are hash-named; a mid-session version swap can't show stale content.
- **Recovery posture**: a deploy that ships an `install`-time throw wedges returning visitors until they clear site data. Mitigations: the `/sw.js` no-cache rule above, and `dev:edge` as the pre-deploy verification surface (SW activates, vN→vN+1 hands over cleanly). A localStorage kill-switch in `swRegister.ts` is the designed post-incident lever, not yet built.

Limitations ledger (details tracked in [proposal 21](./proposals/21-pwa-offline-followups.md)): offline audio is cached only after first play (the player is `preload: "none"` so passive readers pay zero audio bytes; a "save for offline" affordance is the open decision); Background Sync for queued comment writes (Chromium-only, additive SW listener); Web Push rides the same SW when [it lands](#future-direction-web-push-notifications); the app icon is a placeholder; automated SW lifecycle tests — the dev:edge smoke is the verification today.

### Engagement analytics (Analytics Engine)

Code: `client/analytics.ts`, `server/analyticsRoute.ts`, `shared/analyticsSchema.ts`.

Anonymous engagement events go to one Cloudflare **Analytics Engine** dataset bound to the Worker. Two event families: `page_view` (slug + referrer hostname) and `narration_play`/`narration_quartile` (only after an explicit play; capped at one play + four quartiles per session). The load-bearing question they answer: does narration — the largest cost concentration in the codebase — earn its keep. Page views ride the same dataset because one write path beats two analytics products: no third-party beacon origin in the CSP, one privacy-policy paragraph. (Cloudflare Web Analytics answers only "how many page views"; Zaraz consolidates third-party tags, of which this blog ships zero.)

- **Anonymous by construction.** No cookies, no localStorage, no per-visitor identifier, no userId, no IP retention — the route reads only the JSON body, plus the bot filter and the rate-limit key (consumed by the limiter, never stored).
- **The positional slot map lives in one place** (`shared/analyticsSchema.ts`) and **slots are never repurposed** — Analytics Engine stores `{indexes, blobs, doubles}` positionally, so reusing slot N re-labels every historical row silently. New dimension = new slot, forever. Same discipline as the Automerge seed bytes.
- **The Worker route (`POST /_a`) always returns `204`**, valid or not — response codes must not become a post-slug existence oracle. It validates against the schema's event allowlist, the post index, a payload cap, and a bot check, and is rate-limited by a **separate** binding so beacon traffic and comment writes never share a budget.
- **Dev is a no-op sink** (`sink: null`): validates and 204s exactly like prod, writes nothing — developer clicks don't pollute the dataset, and the client beacon path is identical in both runtimes.
- **Query with `SUM(_sample_interval)`, not `count()`** — Analytics Engine samples at write time under sustained load; the former is identical under no sampling and stays correct if it kicks in, where `count()` silently under-reports.

Deliberately not tracked (the list is exhaustive of what was considered; re-adding one means engaging the recorded reason): per-chapter listen depth (quartiles suffice until the funnel shows a cliff); chapter-pill/highlight-toggle usage (wouldn't change what we build); comment-column engagement (the author aggregator is richer); figure interactivity (would lock a schema against a sample of one); reading-mode classification (needs per-session identity — the exact thing the cookieless posture forbids); opt-out-post views (already answerable by JOIN); OS-media-session usage (opaque to JS beyond the `trigger` field); scroll depth / time-on-page (confounds the listen question); A/B testing, heatmaps, session replay (all need a persistent identifier → consent banner).

### Structured data (Schema.org, Open Graph, Twitter Card)

Code: `generate/injectStructuredData.ts`.

A pasted post URL should unfurl (title/description/card); Google should be eligible for the Article rich result and "Listen to this article"; LLM indexers should get clean JSON-LD. The build injects three layers into every post: a Schema.org `BlogPosting` (nested `AudioObject`, `Person` author, `Organization` publisher), Open Graph, and a Twitter Card overlay. This is the machine-facing counterpart of the [client-rendered byline](#author-profiles-and-bylines): both read the same emailless profile map, so SEO never depends on the byline script and **no email ever appears**.

Field sources: extracted from the post HTML in one `HTMLRewriter` read (title, description, lang, publisher label, any authored `og:image`); passed in by the build for what the injector shouldn't gather itself (dates from `versions.json` — oldest entry = published, newest = modified; the `AudioObject` from the narration manifest; the author `Person`; the [share card](#share-cards) URL; `siteUrl` for absolutizing).

- **`SITE_URL` is the gate and is distinct from `OAUTH_REDIRECT_BASE`** — "where the site lives" vs "where auth redirects land", even though they coincide today. Unset → the whole inject is skipped, fail-silent.
- **`og:image` must always resolve** (it's required): a per-post authored override wins untouched (no duplicate tag emitted); otherwise the generated share card, with `og:image:alt`/width/height emitted since the card's size is known. Twitter card is `summary_large_image` when an image resolves. The author avatar is never the share image — it's only the JSON-LD `Person.image`.
- **`article:author` is a profile URL, not a name** (that's Open Graph's definition); the human-readable name rides JSON-LD `author.name` and `twitter:creator`.
- **Degrades field-by-field, never fails the build**: no manifest → no `AudioObject`; no profile → no `Person`; no `versions.json` → no dates. Idempotent (a pre-existing JSON-LD block short-circuits). Only files with a `versions.json` record are posts; the landing gets a parallel connected `WebSite`/`Blog` `@graph` (each post's `isPartOf` points at the Blog `@id`, so a consumer sees one blog with N posts). A `<link rel="canonical">` rides along so preview hosts don't index as duplicates.
- Extras on the `BlogPosting`: a two-level `BreadcrumbList` (landing → post, landing crumb named by the publisher — "Home" would be English-only), `wordCount`, a conservative `speakable` (`#lede` + `h1` only — apt for an audio-first blog), and the [license/copyright fields](#licensing-content-vs-code) when declared. Deliberately no `SearchAction` — there is no search endpoint; advertising one that points nowhere is worse than omitting it.
- **The graph is typed against `schema-dts`** (import-type-only, erased at build), so a `@type`/property typo fails `tsc` instead of Google's validator after deploy. One documented cast: the dimensioned `ImageObject` emits numeric width/height (the rich-result shape) against the stricter Schema.org types.

Dev doesn't inject — crawlers hit prod; dev serves source.

### Share cards

Code: `generate/share-card.ts`.

The default share image is a generated 1200×630 PNG per page — blog name, title, author avatar + name — so `og:image` is always satisfiable with a real card. Pipeline: **satori** (plain element tree — no JSX, no React) lays out to SVG with text as paths, **resvg-wasm** rasterizes to PNG. Deterministic, no native binary, no headless browser.

- One card per post (`dist/assets/og/<slug>.png`) plus the landing (`_site.png` — the `_` keeps it out of the slug namespace); the landing card uses the site tagline and the newest-post author (the same site-level-author rule the feed channel and landing JSON-LD use).
- **Fonts are static TTFs, vendored** (`generate/assets/fonts/`): satori rejects variable fonts and woff2, so two static weights of the blog's own reader-facing family are committed — the card renders in the blog's type identity, reproducibly on any machine. The same `loadFonts()` feeds every satori surface, including the video overlays.
- Runs after `bun build` (needs `dist/`), before the strip pass (which references the card URL). Gated on `SITE_URL`; skipped per-page when the page authors its own `og:image`; the landing card is skipped when there's no description to render — degrade, don't emit a brand-only card.

### Subscription feeds (Atom + Podcast RSS)

Code: `generate/feeds.ts`.

An audio-first blog with no feed is invisible to podcast clients and feed readers, and every field a feed needs already exists on disk after a build. `feeds.ts` runs after the strip (so the feed `<content>` splices the *stripped* body — no emails, no narration blobs reach subscribers) and emits three static artifacts, zero Worker code: `dist/feed.xml` (Atom, every post), `dist/podcast.xml` (RSS + `itunes:`/`podcast:` namespaces, only posts with audio; suppressed entirely when no post has audio — directories reject empty podcast feeds), and per-post `chapters.json` (Podlove Simple Chapters, referenced by `<podcast:chapters>`).

Config and identity:

- **Gated on the same `SITE_URL`** as everything else. A non-loopback `http://` `SITE_URL` is rejected at config time — published enclosure URLs must be `https:` (directories reject `http:`); loopback stays allowed for dev.
- **Engine stays content-agnostic**: site title/description read from the blog's landing HTML; authors from the same emailless profile map as the byline. Env knobs are parsed by zod schemas built from shared idiom helpers (`shared/envSchemas.ts` — `csvList`, `envFlag`, trim-or-default), keeping env parsing one convention across feeds, notify, and the Worker's block list. `SESSION_SECRET` parsing deliberately stays separate (security-sensitive).
- **Cover art is a dedicated asset (`PODCAST_COVER`), never the avatar** — Apple requires ≥1400² square; a too-small image gets the feed rejected, an absent one merely degrades, so unset → omitted. **Owner email is opt-in** (`PODCAST_OWNER_EMAIL`), never auto-pulled — a public feed is exactly the surface the email strip exists to protect; Apple only needs it for directory submission.

Identity and immutability invariants:

- **Atom entry ids are permanent** (RFC 4287): each entry's tag URI takes its date from *that entry's own* first-publish year, never a global minimum — a back-dated post must not rewrite every id and resurface the catalogue as unread. The feed's own `<id>` uses a fixed `SITE_LAUNCH_YEAR`. RSS `<guid>` is the stable post URL; episode identity never rides the enclosure URL.
- **`<podcast:episode>`/`<podcast:season>` are deliberately not emitted** — a dated blog has no author-assigned numbering, and synthesizing one from publish order is the same renumbering trap the id rule prevents. `<itunes:type>episodic</itunes:type>` already sorts by date. An explicitly numbered series would get an opt-in per-post `<meta>`; until then both tags stay off.
- **`<enclosure>` points at the [stable episode URL](#stable-shareable-episode-url)**, so a cached feed keeps a working link across regenerations; `length` is the real byte size from the manifest (MP3 framing isn't uniform — a computed `duration × bitrate` length makes some clients refuse the episode). A `<podcast:alternateEnclosure>` lists both the stable and content-hashed URLs with an SRI integrity digest from the manifest.
- **Channel metadata**: a stable `<podcast:guid>` (UUIDv5 over the feed URL, spec namespace), `<atom:link rel="self">`, `<podcast:medium>podcast</podcast:medium>`, and `<podcast:locked>` defaulting to **yes** (anti-hijack; flip `PODCAST_LOCKED=no` to migrate hosts). `<podcast:license>` inherits from the [licensing config](#licensing-content-vs-code). **Deliberately not emitted: `<podcast:txt purpose="ai-content">`** — the narration is the author's own reviewed words in their own cloned voice, the opposite of what that flag signals (synthetic script/persona); flagging it `true` would miscategorize the work. The honest voice-synthesis disclosure lives in human-readable prose, where nuance survives.
- **Two `<podcast:transcript>` tags per aligned episode**: `text/vtt` (the word-timed captions — the verbatim record of what's *heard*) and `text/html` (the post page — the parallel prose). The distinction is load-bearing because narration is a parallel narrative, not a read-aloud. The VTT tag is emitted only when the file exists, so a non-aligned episode never advertises a 404. The per-word JSON transcript format is deliberately skipped (redundant with VTT; unratified schema; Apple doesn't ingest it).
- **Chapters ship in both the JSON sidecar and the MP3 itself** (ID3v2 CHAP/CTOC for clients that only read in-file chapters), embedded at encode time from the same summed offsets the manifest uses, so the two can't disagree.

Push and delivery:

- **WebSub is opt-in** (`WEBSUB_HUB`): both feeds advertise the hub, and a post-deploy ping (`generate/websub-ping.ts`, after `wrangler deploy` so the hub re-fetches the *live* feed) notifies each topic. Defaultless on purpose — a hub is a third-party dependency the operator picks. Safe to ping every deploy: hubs dedup by diffing the feed; failures log, never fail the deploy. Serves feed readers; chat platforms don't speak WebSub.
- **Publish webhooks** (opt-in `DISCORD_WEBHOOK_URL`/`SLACK_WEBHOOK_URL`/`WEBHOOK_URL`) push an instant message to channels the author owns. The audience line is deliberate: instant push reaches only author-owned channels; a *reader* wanting posts in their own Slack/Discord uses that platform's RSS integration against the public feed (self-serve but polling). Instant reader-self-serve push would need a per-subscriber endpoint registry and publish-time fan-out — exactly the edge state the dumb-edge-server rule forbids. The new-post trigger diffs Atom entry ids in the built feed against the *live deployed* feed (snapshotted pre-deploy to an ephemeral gitignored file; deliberately no committed notified-set, which drifts because deploys don't commit) — id immutability makes edits and re-deploys a no-op delta, and only the Atom feed is diffed so an audio post isn't double-announced. Payloads are typed against the platforms' official type-only packages and truncated to their hard limits; no runtime SDK (`discord.js` drags a websocket tree, `@slack/webhook` pulls axios — for one POST). The generic endpoint can opt into CloudEvents framing and Standard-Webhooks signing, both hand-rolled (a few lines). Titles pass through verbatim per the [trusted-author model](#what-were-building). Live-channel acceptance is a manual smoke (`bun run notify:smoke`) — the local suite proves payload shape, only the real platform proves acceptance. Extra channels: proposal 33.

Correctness plumbing:

- **Entity handling: decode strictly, then escape.** `HTMLRewriter` hands back named entities intact, so plain-text fields are entity-decoded (`generate/htmlEntities.ts`, backed by the `entities` library) before XML-escaping — a naive re-escape double-encodes. The decoder **must stay the strict variant** (`decodeHTMLStrict`): the non-strict WHATWG legacy rule decodes prefixes (`&notareal;` → `¬areal;`) and would corrupt prose mid-word. The narrower non-XML escapers (WebVTT cues, ASS overlay grammar, YAML quoting) stay hand-rolled on purpose — `encodeXML` would be wrong for them.
- **Feed validity gate (`assertFeedWellFormed`).** The feeds are string-assembled over a deeply conditional tag tree — the exact shape where one mis-closed branch produces output a directory ingest rejects wholesale, and substring-based goldens structurally can't see it. Both feeds round-trip through `fast-xml-parser`'s `XMLValidator` (already a dependency on this path) before hitting disk; malformed → build fails. Scope: well-formedness + namespace survival, not directory acceptance (Apple/Podcast Index enforce cover dimensions and category enums beyond any local parser).
- **Autodiscovery + MIME + CORS**: every page head gets `<link rel="alternate">` feed links; the Worker overrides the feed paths' Content-Type to the strict Atom/RSS MIME types, and sets `Access-Control-Allow-Origin: *` on exactly the public feed sidecars (`/chapters.json`, `.vtt` — scoped by a pure, unit-tested predicate) so browser-based podcast players can fetch them; never on authenticated responses. Feeds are a build artifact; dev doesn't serve them.

### Site-level discovery

Code: `generate/site-discovery.ts`.

Per-post structured data covers each post; feeds cover subscription. Three site-root files cover the site as a whole — same `SITE_URL` gate, same disk gather, fail-silent, zero Worker code, one shared walk (no second source of "what's a post"):

- **`robots.txt`** — allow-everything + absolute `Sitemap:` pointer. The AI-crawler stance is **deliberate default-allow**: the blog *wants* LLM understanding of the posts, and the file says so in a comment so a future contributor doesn't reflexively lock it down. `ROBOTS_AI_CRAWLERS=deny` flips to explicit `Disallow:` blocks for the named training/answer bots.
- **`sitemap.xml`** — every real post + the landing, `<lastmod>` from `versions.json` (the same source as the feed `<updated>`, so freshness can't drift); `<changefreq>`/`<priority>` omitted (Google ignores both).
- **`llms.txt`** — the llmstxt.org curated Markdown index: site summary, post list with the same one-line descriptions the feeds carry, feeds section. Each post entry links the [Markdown twin](#copy-as-markdown) directly — the index exists for LLMs, so it hands them clean Markdown; the canonical HTML URL stays in the sitemap and each post's canonical link. `/llms-full.txt` is deliberately deferred: the article body is already the canonical crawlable text.

Dev doesn't emit these (dev serves source, not `dist/`); `bun run dev:edge` is the local preview that serves the real artifacts.

### Reader-facing help & feature discovery

Code: `generate/help-page.ts`.

The human analogue of site-level discovery: the engine ships a player, feeds, comment-driven revision, a PWA, and keyboard shortcuts, and a reader landing on the homepage can see none of it. The last build step emits, all `SITE_URL`-gated and fail-silent: **`/help`** (one anchored section per question a reader would phrase — listen, subscribe, comments, install, privacy — each section conditional on the feature actually existing in this build, detected from disk); **landing feature chips** (one per live feature, linking to its `/help#…` anchor); and a **`FAQPage` JSON-LD** block built from the same `(question, answer)` array as the prose, joined to the site `@graph` — so the structured data and the visible page can't disagree.

- **Engine-owned, unlike the [privacy page](#disclosure-surfaces)** — the asymmetry is load-bearing: privacy text makes *operator-specific legal* claims (stays content-side); help text makes *engine-behavioral* claims, so the engine is its authoritative narrator, which is also what keeps it from drifting as features change. An operator's own `help.html` in the content root wins; the emitter skips.
- **The keyboard table is generated from `KEY_BINDINGS`** — the same table the player dispatches on; one place updates behaviour and documentation together.
- **Plain anchored sections, no `<details>`+script** — the [CSP](#http-security-headers) forbids inline scripts, and always-present sections are strictly better for crawlers/agents/reader-mode anyway. (Inline `application/ld+json` is unaffected — CSP doesn't gate non-executable script types.)
- **The comments section gates on "has ≥1 post", not "auth configured"** — OAuth is a runtime secret the build can't read; post count is the honest build-time signal.
- `/help` renders in dev too, on the fly from source (feature-gating computed from source, so it can differ slightly from prod's artifact-based gating); `dev:edge` is the byte-faithful preview.

Deferred: a standalone `/subscribe` page (split out only if the help section bloats); a narrated landing intro (needs a player-without-a-post path); `<podcast:funding>`/`<podcast:value>` tags (cheap to add, not wanted); content i18n beyond `<html lang>`.

### Ask this blog — AI-search hand-off

Code: `generate/injectAiSearch.ts`, `client/aiSearch.ts`.

The landing carries an "Ask this blog" box that is deliberately **not a search index** — no crawler, no client index, no `/search` route. It wraps the reader's question in a prompt naming the blog origin and its [`llms.txt`](#site-level-discovery) index, and hands it to a chat model the reader picks (Ask Claude / Ask ChatGPT prefill URLs). The blog's own discovery surface is what grounds the answer.

- Injected during the HTML bundle in both dev and prod (unlike the feature chips, it has nothing to gate on built artifacts) — which is load-bearing: only the bundle-time path can add a **bundled, content-hashed** module script.
- **Navigation, never a cross-origin form**: the CSP pins `form-action 'self' …`, which would block a cross-origin `<form action>`; a top-level navigation isn't governed by it. No new CSP origin needed — nothing is fetched.
- **Progressive enhancement**: the markup ships real `<a>` links to each provider; JS only keeps the hrefs in sync with the input per keystroke. **Privacy holds**: nothing leaves the browser until the reader clicks through to a model they chose; no sub-processor is added.
- Not a Schema.org `SearchAction` (that describes an on-site endpoint that still doesn't exist), and not the deferred on-site full-text search (tracked in proposal 47/Pagefind) — the two are complementary.

### Private blogs

Code: `shared/blogPrivacy.ts`, `generate/audit-private.ts`; env: `BLOG_PRIVATE`.

Everything above makes posts findable; a private blog (`BLOG_PRIVATE=1`, `templates/private-content-repo/` starter) is the deliberate inversion: **the URL is the secret.** Every post filename carries an unguessable `--<token>` suffix (16 base64url chars ≈ 96 bits from `bun run new-post`; audit floor 64 bits), and everything derived from the slug — page, `.md` twin, audio, share card, `/post-version`, comment threads — inherits the secrecy because the slug is in the path. Entropy is calibrated to online guessing against the Worker, deliberately not to an offline adversary. **Renaming the file rotates the key** — leak recovery is rename, rebuild, redeploy.

**The threat model, honestly bounded.** Defended: enumeration, every engine-built index, search indexing of a leaked link, existence oracles (moot once holding a slug means holding the post). Not defended, by design: recipient resharing (that *is* the model), unfurler caches (per-post OG/share cards are deliberately kept — they render only for someone already holding the URL), browser/chat residue, domain-level visibility (CT logs name hosts, not paths). Out of scope: reader auth and encryption — different products. If a post can't tolerate "anyone who ever had the link can read it," it doesn't belong on this design.

**Blog-level, not per-post — the shape decision.** A per-post flag would (a) leave private source/figures/audio in a *public* repo, one gitignore slip from permanent history, and (b) turn every emitter into a filter that must exclude correctly — feeds, sitemap, llms.txt, landing, webhooks — where one filter bug silently ships a private post into a public feed and **every future emitter defaults to leaking**. Blog-level is binary and auditable ("these files don't exist"); mixed needs = a second, private satellite blog (the engine is multi-blog by design). Don't rebuild per-post privacy as filters.

**What flips under `BLOG_PRIVATE`.** Suppressed: sitemap, llms.txt, both feeds (which kills autodiscovery links, webhook diffing, and the WebSub ping for free — all key on the feeds), the landing JSON-LD graph, and Ask-this-blog (it hands an external model the blog URL + post index). Inverted: `X-Robots-Tag: noindex` on **every** response — baked into the build via `SITE_PRIVATE` in the generated post-meta so privacy can't drift between a build and its deploy config — plus a `<meta name="robots" content="noindex">` in every head. **The robots.txt subtlety that must not be "fixed" later: the wildcard user-agent stays `Allow` with no `Sitemap:` line — never a blanket `Disallow: /`** — a search crawler forbidden from fetching a leaked URL never sees the noindex and can index it URL-only; allow-and-noindex is what keeps it out entirely. (The named AI crawlers *do* get explicit `Disallow:` blocks — `ROBOTS_AI_CRAWLERS` defaults to `deny` on a private blog — safe because those bots feed models, not search indexes.) Kept deliberately: per-post structured data/OG/cards, `.md` twins, comments, narration, version history, offline reading, the post-link-free help page. The landing — the one guessable URL — carries no post links.

**Enforcement is an audit, not trust in the knob.** Suppression happens at each emitter via `isPrivateBlog()`; `generate/audit-private.ts` (the private-posture branch of the engine's build orchestrator, `generate/build.ts`) is the allowlist-shaped proof: no enumeration artifacts in `dist/`, no post links on non-post pages, noindex meta everywhere, the token suffix on every post filename, no announce env vars set, and **`BLOG_PRIVATE` itself set** — the private template invokes the build/deploy orchestrators with a structural `--private` flag (`bun engine/generate/build.ts --private`) that forces the private posture on, so `audit-private.ts` always runs; the audit then re-checks `BLOG_PRIVATE` and fails the build if the env var was lost, instead of silently shipping public. A post-build dist-scrub was rejected as blacklist-shaped: a new emitter would leak by default, and the externally-POSTing announce steps leave the machine where nothing can be scrubbed. The runtime half (unconditional noindex, referrer policy, 404s) is asserted by `e2e/privateBlog.ts` against the built worker; the audit's negative controls prove each rule fires.

#### Coverage: every served surface has a verdict

"Nothing leaks" is a negative property no single test captures, so every served surface was forced to an explicit verdict against one question — *does this reveal a post URL to someone not handed it, or transmit post content to a third party?* Recording both lists is the point: a leak hides in the surface no one thought to check, and the class this ledger exists for — global maps that enumerate every post path — was found **twice** (build output, then the dev server rebuilding the same maps per request) by adversarial passes after the first build looked clean.

*Needed handling, and got it:* the enumerators (discovery, feeds, Ask-this-blog, landing graph) — suppressed; security headers — the unconditional noindex; the **byline maps** (`authors.json`/`post-versions.json` enumerated every post, so one capability link handed over the whole set) — suppressed in both build *and* dev, replaced by per-post data injected into each post's own HTML; the help page — own noindex, no post links; subscribe controls — omitted in the private template (copying a 404 feed URL is a UX nit, not a leak).

*Can't leak, by reason:* everything keyed by the slug in its own URL inherits the capability (post HTML, twin, narration, cards, comments, `/post-version`); analytics is operator-owned, third-party-free, and not an existence oracle (always 204); reader-local residue (SW cache, media-session title, history) is accepted by the threat model; infrastructure surfaces carry no post data; within-page deep links only carry the *current* slug, which the copier already holds; existence oracles on post-scoped endpoints are accepted — probing needs the slug, and the slug is the post.

To re-run when built: **Web Push** — a notification naming a post must treat the post URL as the capability it is.

### Secrets

OAuth client secrets and `SESSION_SECRET`(`S`) live in Cloudflare's encrypted store (`wrangler secret put`), never in `wrangler.toml`. Names match the dev `.env`, so handlers read the same `process.env.*`/`env.*` in both runtimes.

**`.env` is dev-only and invisible to the Worker — the easy-to-miss step on a new blog.** Bun autoloads it locally, which gives the false impression the credentials exist everywhere; in prod only `[vars]` and pushed secrets populate the environment. Because OAuth providers are constructed lazily ([`server/auth/providers.ts`](#oauth-flow-plumbing) throws on first use, not boot), a secret-less deploy serves fine until the first login attempt fails with a named missing-var error — that deferred failure is the signature of a deploy that copied `.env` but never ran `secret put`. The secrets to push: `SESSION_SECRET`, the Google/Microsoft OAuth id+secret pairs, and `OAUTH_REDIRECT_BASE` (the public origin — provider redirect URIs derive from it); `BLOCKED_USERS`/`VAPID_PRIVATE_KEY` if used. Pipe values with `printf %s` (a trailing newline bakes into the secret). A `secret put` redeploys the Worker immediately. Analytics needs no secrets — only bindings. The matching provider-side step is registering both the localhost and prod redirect URIs; a `redirect_uri_mismatch` at login means that registration is missing (distinct from the missing-secret error).

**Backstop for the accidental paste: `secret-scan` (opt-in, per content repo).** The structure above keeps secrets in files meant for secrets; what it can't catch is a real credential pasted into a *tracked* file — plausible here because posts routinely discuss auth flows. `bun run secret-scan` runs secretlint (all-npm devDependency, zero shipped bytes) with the recommended preset plus a project rule pinning this engine's own credential shapes (`SESSION_SECRET`, `*_OAUTH_CLIENT_SECRET`, webhook URLs with embedded tokens); a `.secretlintignore` excludes the legitimate secret stores and the engine symlink, so only a *misplaced* secret trips it. Engine-recommended, not engine-forced (the template ships the config; it's a manual pre-push rung today, promotable to a hook once it catches a real near-miss).

### Why not KV

The Workers Rate Limiting binding replaces the whole KV rate-limiter design (key scheme, get/+1/put, window math, and the race where KV's eventual consistency lets two increments both read the pre-increment value) with one `limiter.limit({key})` call and a `wrangler.toml` block. And KV is the wrong store for the comment change-objects: content-addressed immutable objects need R2's read-after-write consistency — a client that just `PUT` a change must see it on `LIST`, where KV's up-to-60s propagation would look like lost writes. No remaining use case.

### Hardening

R2 is private; every access goes through the Worker (`server/comments/routes.ts`):

| Operation | URL | Allowed when |
|---|---|---|
| List users for a post | `GET /comments?post=X` | session is the post's author |
| List change hashes for (post, user) | `GET /comments?post=X&user=Y` | `session.userId === Y` OR post author |
| Fetch one change | `GET /comments?post=X&user=Y&change=Z` | same as above |
| Upload one change | `PUT /comments?post=X&user=Y&change=Z[&origin=…]` | `session.userId === Y` (and not blocked) |
| List resolved threadIds | `GET /resolutions?post=X` | any logged-in user |
| Fetch one resolution | `GET /resolutions?post=X&thread=T` | any logged-in user |
| Write a resolution | `PUT /resolutions?post=X&thread=T` | post author |
| Read post version (+ history) | `GET /post-version?post=X` | any session; `history` only for the author |

"Post author" = the session's verified email matches the post's `<meta name="author-email">` ([Per-post author metadata](#per-post-author-metadata)). Readers read/overwrite only their own change-objects (cross-device sync); the author reads everyone's but has **no special PUT power** — they only ever write their own folder. The PUT's `origin` param is **provenance metadata, never an authorization input**: enum-validated, stored, echoed, consumed only by author-mode debug UI — lying in it can at most mislabel a chip on the liar's own content.

Per-PUT validation:

| Check | Limit | What it bounds |
|---|---|---|
| Body size | `MAX_CHANGE_BYTES = 8 KB` | A legitimate Automerge change lands under ~1 KB; 8 KB is generous headroom. |
| Rate limit | 10 PUTs/60s per userId — **external commenters only** | Change-objects are immutable and content-addressed, so a key can't be reused to inject content; this bounds pile-up. The **post author is exempt** — trusted owner, writes only their own folder, and throttling them only blocks legitimate bulk work. `/resolutions` is author-only, so it carries no limiter. |
| Block list | `BLOCKED_USERS` (comma-separated `provider:sub`) | Listed users' PUTs return 200 but touch nothing — no R2 ops, no rate-limit budget burned. |
| Per-reply text length | none — the 8 KB change cap is the only length bound | Parsing reply text server-side would ship Automerge into the Worker (~700 KB); the 8 KB cap covers the same threat envelope at zero bundle cost. (A 5000-char client-side UX cap is referenced in a route comment but was never implemented.) |

Stacked: a max-rate attacker writes at most 80 KB/min into their own folder, touches no one else's content, and one `BLOCKED_USERS` entry silences them; worst-case blast radius is storage pennies.

### HTTP security headers

Code: `server/securityHeaders.ts`.

The auth layer above is who-can-write-what; the header layer is the orthogonal floor for an OAuth-gated UGC page: **XSS via comment content** (interpolation uses `textContent` today; CSP is the defense-in-depth against a future regression) and **clickjacking of the OAuth flow**.

**One shared module, two runtimes.** `withSecurityHeaders(res, {private})` wraps every response in both the Worker and the dev server. In the Worker, the `ASSETS.fetch` fall-through — which serves the article HTML — is wrapped too, and that only happens at all because of:

> **`run_worker_first = true` in `wrangler.toml [assets]` is mandatory.** The Static Assets default serves a matching asset directly and **never invokes the Worker** — so documents would ship with no security headers while API routes carry them, a silent split. With the flag, the Worker runs on every request and wraps the asset response. Verify after deploy: `curl -sD- -o/dev/null <url>/posts/<slug> | grep -i content-security-policy` — empty means the Worker is bypassed.

**The dev asymmetry worth knowing:** Bun serves the two HTML routes as `HTMLBundle` values with no response-header hook, so they cannot be wrapped — the document CSP is verified at `dev:edge`/prod, never the Bun loop. This is also why Bun's HMR-injected inline styles never trip the policy: the policy simply isn't on those routes in dev, and stays tight (`'self'`) everywhere it is.

**Preview hosts are noindexed** (`withNoindexOffCanonicalHost`): `X-Robots-Tag: noindex` on any response served off the canonical host (baked at build from `SITE_URL` — no second copy in wrangler vars to drift). Posts have canonicals, but the landing, feeds, and assets don't; the header keeps a whole preview host out of indexes.

The CSP (load-bearing directives; the full policy is commented in the source):

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'none'` | Deny-all base; each category opened explicitly. |
| `script-src` | `'self' 'wasm-unsafe-eval'` | **`'wasm-unsafe-eval'` is mandatory** — Automerge instantiates WASM from a fetched buffer, which `'self'` alone does not permit; omit it and the comment system dies. No `'unsafe-inline'`: there are zero inline scripts (narration/PLS are stripped at build; the analytics beacon is a bundled module). |
| `style-src` | `'self' 'sha256-…'` | **No `'unsafe-inline'`.** The one inline `<style>` — the cascade-layer-order pin — is allowed by **hash** of exactly that engine-controlled string (a drift test recomputes it from the constant). Client `.style.x=` writes are CSSOM, ungoverned by CSP. |
| `img-src` | `'self'` + Google/Microsoft avatar hosts | **Both the bare host and the `*.` wildcard are listed** — CSP's `*.host` does not match the bare host. Missing avatars degrade to initials. |
| `connect-src` | `'self'` | Same-origin XHRs and the analytics beacon (`/_a` — no cross-origin analytics endpoint exists). |
| `form-action` | `'self'` + IdP origins | Defensive only: login is an `<a>` → 302 navigation, which spec-compliant `form-action` doesn't govern (kept for Safari's broader reading and any future POST form). |
| `frame-ancestors` | `'none'` | Clickjacking (the modern `X-Frame-Options: DENY`). |
| `media-src` | `'self'` | Audio is same-origin (Worker proxies R2). |
| others | `base-uri 'self'`, `object-src 'none'`, `worker-src 'self'`, `font-src 'self'`, `manifest-src 'self'`, `upgrade-insecure-requests` | Cheap deny/scope rules. WASM is governed by `script-src`, not `worker-src`. Shikwasa's ID3 cover-art `createObjectURL` path would need `img-src blob:` — dormant while the MP3s carry no embedded artwork. |

The rest of the set: **HSTS** `max-age=63072000`, prod-only, deliberately bare — **`preload` is the one near-irreversible line in the stack** (baked into shipped browser binaries; de-listing takes months), so it waits for a final production hostname. **`X-Content-Type-Options: nosniff`** (comment bytes are `application/octet-stream`; a sniffer mis-reading user-controlled bytes as HTML would defeat same-origin). **`Referrer-Policy: strict-origin-when-cross-origin`** (also serves the private-blog model — outbound clicks don't carry the slug). **`Permissions-Policy`** deny-all except `autoplay`/`fullscreen`/`picture-in-picture` = `(self)` (the player). **COOP `same-origin`**; **`X-Frame-Options: DENY`** (free fallback for pre-CSP UAs); **CORP `same-origin` on private responses only** (assets should be loadable); **`Cache-Control: private, no-store` on the identity and comment-list responses** — CORP stops cross-origin loads but not cache retention, and these echo the user's email and private bytes (set per-handler; assets should cache). Individual content-addressed change fetches are instead `private, max-age=31536000, immutable` — the URL is the hash, so retention is safe.

**Cookie pairing:** the session cookie carries the **`__Host-` prefix in prod** (pins exact origin; forces Secure + Path=/ + no Domain), falling back to a bare name on plain-HTTP localhost; the logout clear must itself carry Secure + Path=/, or the browser rejects the delete and the cookie survives.

**Iterating:** a `CSP_REPORT_ONLY` env flag switches to `Content-Security-Policy-Report-Only`, so policy changes can be exercised against `wrangler dev` with violations logged before enforcing. `securityHeaders.test.ts` regression-guards the silent-breakage traps (the WASM keyword, no `'unsafe-inline'`, the style hash, HSTS/CORP gating).

**Where headers are NOT set:** not a `_headers` file (the Static Assets binding doesn't read it for Worker-served responses; that's a Pages convention), and not per-handler at each `new Response` (unreachable for the assets fall-through; easy to miss a call site). The single wrapper is the only attachment point.

### Excluded from v1 (deploy)

- **Pages + Worker split** — one Worker with the assets binding covers both.
- **Cloudflare KV** — [no use case](#why-not-kv).
- **Durable Objects** — the per-user R2 blob already serializes each user's writes; no actor model needed at this scale.
- **Turnstile/CAPTCHA** — wire in only when rate limits trip legitimate users; the 429-with-challenge path is a few lines then.
- **PUT audit log** — cheap insurance, not load-bearing until something goes wrong.
- **HSTS `includeSubDomains`+`preload`** — deferred until the hostname is final; `preload` is effectively irreversible.
- **CSP reporting endpoint** — Cloudflare has no off-the-shelf sink; stand one up only if the policy needs post-deploy tuning.
- **CSP nonce** — buys nothing while there are zero inline scripts; revisit only if authored posts grow them.
- **`Cross-Origin-Embedder-Policy`** — `require-corp` taxes every cross-origin load for the sole benefit of `SharedArrayBuffer`, which nothing uses (Automerge's WASM doesn't need it).

## Privacy & data protection

A blog with login-gated comments and page-view analytics is already a personal-data system under [GDPR][GDPR], [CCPA/CPRA][CCPA], and [APPI][APPI], however small the collection. Three layers: a small, mostly-zero **data inventory** kept accountable to ourselves; an always-on **disclosure surface** (footer link + just-in-time notice + full policy) sized to satisfy GDPR Art. 12–14, CalOPPA's "conspicuously post," and APPI notice-at-collection with one layered-notice pattern ([ISO 29184][ISO29184]); and a **forward-looking checklist** every new feature passes before it ships.

### Data inventory

**Keep this list authoritative**: every entry needs a matching paragraph in the per-blog `privacy.html`, updated in the same PR that changes the collection.

- **Engagement analytics** — Analytics Engine ([details](#engagement-analytics-analytics-engine)). Per page load: slug + referrer hostname; per narration session: slug, play trigger, duration, quartiles crossed — only after an explicit play. No cookies, no per-visitor identifier reaches the operator; Cloudflare sees the IP transiently and doesn't retain it in the dataset. **Basis:** legitimate interest (minimal, aggregate, no profiling). **Sub-processor:** Cloudflare.
- **Comments** — only on sign-in. From the IdP: `(provider, sub, name, email, picture URL)`; stored with comment body + anchor in per-user R2 blobs. The email is server-side only, never rendered to readers. **Basis:** consent (the sign-in click + submit); withdrawable by deletion. **Sub-processors:** Cloudflare (storage), Google + Microsoft (auth).
- **Session cookie** — `__Host-blog-session`, HS256 JWT, `HttpOnly; Secure; SameSite=Lax`, 400-day TTL. Set only after a login click → **strictly necessary**, no banner.
- **OAuth flow cookies** — state + PKCE verifier, 10-minute lifetime, cleared on callback. Strictly necessary.
- **Server logs** — Cloudflare's standard request logs (edge IP included) as a platform side effect; not extracted for analytics; Cloudflare's retention applies.

Not collected: ad cookies, tracking pixels, fingerprints, behavioral profiles, geolocation, passwords (OAuth's problem). **The CSP is the structural check** — a new tracking script can't load without relaxing `script-src` first.

### Disclosure surfaces

Three surfaces, one source of truth (the per-blog `privacy.html`):

- **The policy page** lives in the **content repo**, never the engine: it makes operator-specific claims (controller identity, contact, jurisdictions, sub-processors), and engine-shipped policy text would be a forged representation on the operator's behalf. No `privacy.html` → no footer link (env-gated), nothing breaks.
- **The footer** — every served page gets `Home · How this blog works · Privacy Policy · license badge · Acknowledgements`, each link independently env-gated (`PRIVACY_POLICY_URL`, `SITE_URL`, `CONTENT_LICENSE`); with nothing to link, no footer (a lone Home link is noise). Feeds are deliberately *not* footer links — raw XML is hostile to humans and a Podcast link would 404 on an audio-less blog; `/help#subscribe` is the human entry, `<head>` autodiscovery the machine one. The footer is **fully engine-owned** (content pages don't hand-author one); injection mechanics live in [Build-time HTML strip](#build-time-html-strip) and render identically in dev.
- **The just-in-time notice** — one `<p>` directly under the OAuth login buttons naming what's recorded and linking `/privacy`: GDPR Art. 13 wants the notice at exactly the moment of consent. Built with `textContent` + one anchor, matching the comments UI's no-`innerHTML` posture.

Dev routes: `generate/post-routes.ts` routes any root-level `*.html` (besides `index.html`) to `/<basename>`, so `/privacy` — and any future top-level legal page — works under `bun run dev` with no manual import.

### Considering privacy for new features

A new feature can quietly turn a no-data system into a data-handling one; fixing that after shipping is expensive. Before adding anything that touches reader-side state:

1. **Does it collect or process personal data** (anything identifying, directly or indirectly)? Then: pick and document exactly one **legal basis** (consent for explicit user actions; legitimate interest only when minimal/aggregate/non-profiling; if the choice isn't obvious, don't collect it). Name **where it's stored and who reads it** (a new sub-processor goes in the policy + this inventory). State a **retention bound** ("until the user deletes it" is fine for user content; "indefinitely" for anything else is a red flag). Add a **just-in-time notice** if collection is user-initiated (mandatory at the point of consent); passive collection needs at least the policy paragraph. Ensure a **deletion path** — if the operator can't see or delete it on request, don't ship it.
2. **Does it set or read a cookie?** Strictly-necessary cookies need no banner but are enumerated in the policy. Non-essential cookies would require a consent banner with a real reject path — the analytics path is cookieless *precisely so we don't have one*; prefer a cookieless alternative or skip the feature. **Even a would-be-necessary cookie must earn its keep** against the disclosure + coupling cost. Precedent: a `has_session=1` login-hint cookie (letting the comment loader branch before `/auth/me`) was built and **rejected** — the benefit was one off-critical-path GET. The generalized lesson: to branch on login state, let **the component that already resolves identity drive the behavior** instead of minting a client-readable signal (the drawer-body deferral is the worked example).
3. **Does it add a sub-processor?** Every external service touching reader data gets named in the policy *in the same PR*. If the policy update isn't worth doing, the integration isn't either. (New Cloudflare products under existing DP terms don't add one; new vendors do.)
4. **Does it expose data beyond service-provider use?** CCPA "sale/sharing" is broader than money — it covers most cross-context-advertising disclosure. **We do not sell or share**, and a feature that changes that drags in the "Your Privacy Choices" link, Global Privacy Control handling, and opt-out plumbing — a multi-week add; weigh it as such.
5. **Does it touch the operator's own data?** The operator is a person under these regimes too. The standing engine guarantee: **no public surface derives from the author email** (avatars hash it, bylines never render it, JSON-LD omits it). New surfaces maintain that property.
6. **A stricter regime?** The blog isn't directed at children; a feature that would attract under-16 users crosses into COPPA/Art. 8 (verifiable parental consent). GDPR Art. 9 special categories (health, biometric, precise location) are out of scope — don't store them.
7. **Operational defaults:** the CSP as the structural check on scripts; the comments `textContent` rule as the check on DOM reach; the R2-per-user blob shape (per-user deletion is one DELETE, export one GET — which is most of Art. 15/17/20); env-gated fail-silent for features that *disclose* (no URL → no link), never for features whose *privacy property itself* would silently no-op.
8. **Would it leak on a private blog?** The discoverability axis, orthogonal to the above ([Private blogs](#private-blogs)). If the feature emits, advertises, lists, or transmits a post URL/slug or content to anyone not handed the link — a `dist/` file naming multiple posts, a feed/index entry, a deploy-time POST, a runtime fetch of a global per-post map (the old byline maps were exactly this) — it must consult `isPrivateBlog()` **and** gain an assertion in `generate/audit-private.ts` (or `e2e/privateBlog.ts` for runtime properties). The default posture: **per-post data travels with the post — inline or under the slug's path — never in a global file or index.** Surfaces keyed by the slug in their own URL inherit the capability free, but say so; name which bucket (suppressed / inherits / operator-only / reader-local residue) a new surface lands in.

**When in doubt, don't collect it.** The cheapest data to keep compliant is data never collected; second cheapest is data deletable with one command. Optimize for that ordering before reaching for process (audit logs, DPIAs, data maps).

### Operator obligations (what the engine doesn't automate)

Per-operator duties the engine deliberately leaves manual:

- Keep `privacy.html` current (including "Last updated"); inventory changes are code-and-policy changes in one PR.
- Respond to data-subject requests within the window (30 days GDPR/APPI, 45 CCPA); the policy's contact email is the funnel.
- Maintain the sub-processor list as Cloudflare's product surface evolves.
- Notify affected users of a breach within 72 hours (GDPR Art. 33–34) — the R2 audit log we [declined](#excluded-from-v1-deploy) is a real gap here at scale; reconsider before any commercial deployment.

### Excluded from v1 (privacy)

- **Cookie banner / CMP** — nothing non-essential is set. If that ever changes, reject-all must be as prominent as accept-all (the EDPB is explicit).
- **"Your Privacy Choices" link + GPC** — required only if selling/sharing in the CCPA sense, which we don't.
- **Formal DPIA** — not required at this scale; this section + the policy are the proportionate substitute. Mandatory if comments are ever bulk-processed for analysis or readers profiled.
- **DSAR self-service portal** — manual via email at this volume; the per-user blob shape makes fulfillment one GET/DELETE. A `/me/data` route is a small add if volume ever justifies it.
- **R2 audit log** — deferred (see deploy exclusions), re-noted here because it would also harden Art. 33 breach response.
- **Consent for the analytics** — cookieless, identifier-free, aggregate → treated as legitimate interest, no banner. Some regulators read ePrivacy strictly enough to disagree; revisit if one points it out.
- **Engine-level policy boilerplate** — deliberately none (above). A scaffold helper would have to be extremely loud that the operator owns every claim.

## Terminology

Two units of spoken content come up throughout this doc

- **Chapter** — one `<script type="text/narration">` block in the post. Authored with `data-chapter-id` and `data-chapter-title` attributes. Maps 1:1 to a chapter in the audio player (chapter-skip lands here). Code type: `NarrationChapter`.
- **Segment** — the text between two `<mark>` boundaries inside a chapter. This is the unit that gets handed to the TTS provider, the unit that the audio cache keys on, and the unit the player highlights/scrolls to. Code type: `Segment`, produced by `splitChapter`. A chapter contains many segments.

The word **chunk** is deliberately *not* used as a user-facing concept (it's too generic to mean any one thing, and often already used in audio-processing contexts).

## Relation to other specifications

The specs the engine implements or leans on, with local mirrors under `specs/`. Each entry's details live in its owner section — this is the index, not a second explanation.

### In active use

| Spec | Used by | Role |
|---|---|---|
| [Web Annotation Data Model][AnnotationModel] | [Comments → Anchoring](#anchoring-the-web-annotation-target-model), [export](#exporting-to-the-web-annotation-wire-format) | Anchor targets/selectors; JSON-LD `AnnotationCollection` export. (Not used for the narration `<mark>`↔`id` pairing — too simple to need it.) |
| [JWT][JWT] / [JWS][JWS] / [JWA][JWA] + [JWT BCP][JWT-BCP] | [Sessions](#sessions-jwt-cookie-hs256-jose) | HS256 session cookies via `jose`, pinned algorithm allowlist, `kid` rotation. Provider ID tokens are deliberately *not* verified — see [Userinfo](#userinfo-from-userinfo-not-from-a-decoded-id-token). |
| [Media Session API][MediaSession] | [OS media controls](#os-media-controls-media-session-api) | Lock-screen/now-playing surface + hardware media keys. |
| [Service Workers + Cache API][ServiceWorkers] | [Offline / PWA](#offline--pwa) | The offline cache; synthesized `206`s for Range requests. |
| [HTTP Immutable Responses][ImmutableResponses] (RFC 8246) | [Serving generated audio](#serving-generated-audio-content-hashed-filenames--dev-range-support) | `Cache-Control: immutable` on content-addressed URLs **only** — never on a stable-named mutable file, which would reintroduce staleness. |
| [Web App Manifest][AppManifest] | [Offline / PWA](#offline--pwa) | Per-blog `manifest.webmanifest`; engine pins `id`/`start_url`/`scope`/`display`. |
| [Schema.org][SchemaOrg] + [Open Graph][OpenGraph] + [Twitter Cards][TwitterCards], as [JSON-LD 1.1][JSONLD] | [Structured data](#structured-data-schemaorg-open-graph-twitter-card) | `BlogPosting` (+`AudioObject`, `speakable`, two-level `BreadcrumbList`), landing `WebSite`/`Blog` graph, [help-page](#reader-facing-help--feature-discovery) [`FAQPage`][SchemaFAQPage]. |
| [Atom][Atom] (RFC 4287) + [RSS 2.0][RSS2] + [`itunes:`][ApplePodcast] + [Podcasting 2.0][PodcastNS] (+ [tag URIs][TagURI], [Podlove chapters][Podlove]) | [Subscription feeds](#subscription-feeds-atom--podcast-rss) | Article + podcast feeds; immutable entry ids; chapters sidecar. |
| [ID3v2 CHAP/CTOC][ID3Chapters] | [Subscription feeds](#subscription-feeds-atom--podcast-rss) | In-file MP3 chapters for clients that don't read the sidecar. |
| [Robots Exclusion][RobotsRFC] (RFC 9309) + [Sitemaps][Sitemaps] + [`llms.txt`][LlmsTxt] | [Site-level discovery](#site-level-discovery) | robots.txt (deliberate AI-crawler stance), sitemap, curated LLM index. |
| [CommonMark][CommonMark] + [`text/markdown`][MarkdownMediaType] (RFC 7763/[7764][MarkdownGuidance]) | [Copy as Markdown](#copy-as-markdown) | The `.md` twin: CommonMark + GFM tables/strikethrough/task-lists, advertised via `rel="alternate"`. |
| [WebVTT][WebVTT] | [Word-level timing](#word-level-timing-drawer-karaoke--subtitle-sidecar) | `captions.vtt` export sidecar (per-word intra-cue tags); the drawer reads the manifest inline instead. |
| [GDPR][GDPR] / [CCPA/CPRA][CCPA] + [CalOPPA][CalOPPA] / [APPI][APPI] / [ISO 29184][ISO29184] | [Privacy & data protection](#privacy--data-protection) | The regimes the policy maps rights/windows/disclosure structure against. |
| [WebSub][WebSub] | [Subscription feeds](#subscription-feeds-atom--podcast-rss) | Opt-in hub advertisement + post-deploy publish ping. |

### Possibly usable later

- **JSON Feed** — same data as Atom, JSON-shaped; every reader we care about consumes Atom. Trivial to mirror from the same feed walker if a subscriber asks.
- **`/llms-full.txt`** — whole-corpus dump; the article body is already the canonical crawlable text. Revisit if LLM indexers clearly start preferring it.
- **Background Sync** ([WICG][BackgroundSync]) — queue failed comment PUTs in IndexedDB, replay on reconnect; Chromium-only, additive SW listener (proposal 21).
- **Periodic Background Sync** ([WICG][PeriodicBackgroundSync]) — scheduled SW wake for pre-loading comments/post HTML; Chromium-only, engagement-gated (proposal 21).

### Considered, not used

- **EPUB Media Overlays + SMIL** ([EPUB], [SMIL3]) and **Sync Media Lite** ([SyncMedia]) — the canonical text-audio sync pairing, but their anchor model requires a stable `id` per highlighted unit: 10k+ minted `<span id>`s per post purely to fit the contract, with no EPUB consumer to benefit. The drawer slices strings on character offsets instead ([Word-level timing](#word-level-timing-drawer-karaoke--subtitle-sidecar)).
- **Media Fragments URI as a player/URL feature** ([MediaFragments]) — no `#t=` audio deep links. The `t=` syntax *does* appear inside comment targets (narration comments carry their segment's audio range), but as best-effort data, never authoritative — audio regenerates every revision ([Anchoring](#anchoring-the-web-annotation-target-model)).
- **Spoken HTML** ([SpokenHtml]) — inlines SSML into content attributes; our narration is a parallel narrative, not attribute-decorated content, so script blocks fit better.
- **PASETO** ([PASETO]) — removes JWT's `alg` footgun at the format level, but: smaller ecosystem, weaker Workers story, no debugger tooling, and our OIDC neighbours all speak JWT while `jose`'s pinned allowlist neutralizes the footgun anyway.
- **Schema.org `SearchAction`** — advertises a site-search endpoint that doesn't exist; pointing at nothing is worse than omitting. Revisit only with a real search route.
- **Schema.org `TechArticle`** — more precise than `BlogPosting` only if its extra fields (`proficiencyLevel`, `dependencies`) are populated, which needs a per-post metadata channel that doesn't exist (proposal 64). `BlogPosting` is not wrong.
- **Sitemap image/video/news extensions** — not applicable to a text-article blog; plain `<urlset>` carries everything.
- **Webmention** ([Webmention]) — rejected by design, not oversight. A Webmention carries only source+target URLs; any author identity in the source's h-card is self-asserted, so it delivers **no verified, deliverable email** — breaking the author-follows-up loop the whole comment system is built around ([Auth & login](#auth--login)). It also has no place in the per-`(post, userId)` store (no logged-in userId), and a receiver means owning an SSRF-shaped fetch of attacker-supplied URLs plus the spam filtering OAuth currently sidesteps. If a separate "public discussion" surface that doesn't promise follow-up is ever wanted, Webmention fits *that* — alongside, not replacing, OAuth.
- **Podcast Namespace JSON transcript** — redundant with the word-timed VTT; unratified schema; Apple doesn't ingest it ([Subscription feeds](#subscription-feeds-atom--podcast-rss)).

### Performance & Web Vitals (Lighthouse measurement)

Lighthouse is Google's auditing tool, not a spec; its Performance score blends five lab metrics (FCP/SI/LCP/TBT/CLS, with TBT 30% and LCP 25% the heavy weights). The field Core Web Vitals are LCP, INP, CLS. Every metric except Speed Index is defined by a W3C/WICG Web-Performance spec, mirrored under `specs/`: [Paint Timing][PaintTiming], [LCP][LCP], [Layout Instability][LayoutInstability], [Event Timing][EventTiming] (INP/FID), [Long Tasks][LongTasks] (→TBT), [Long Animation Frames][LoAF] (INP attribution), [Navigation Timing 2][NavTiming2] (TTFB), [Resource Timing][ResourceTiming], [Performance Timeline][PerfTimeline], [High Resolution Time][HRTime], [User Timing][UserTiming], [Server Timing][ServerTiming], [Element Timing][ElementTiming], and the [Timing Entry Names Registry][TimingRegistry]. Speed Index has no spec (computed from a filmstrip via [Speedline][SpeedIndex]). Cloudflare Observatory runs *actual Lighthouse* for lab scores and collects field vitals through Google's `web-vitals` library — so improving the Lighthouse score is improving the Observatory score, and that library (not the W3C prose) is the operative reference for how field metrics are bucketed.

**The score is a proxy; the reader's experience is the goal — and on a reading-centric page they diverge at TBT.** TBT measures main-thread input latency during load ("if you clicked right now…"), but a long-form reader's first act is to read and scroll — and scrolling runs on the compositor thread, unblocked by a busy main thread. So where deferring a subsystem trades higher lab TBT for faster text-on-screen, we take that trade deliberately: the [comments](#loading-comments-a-lazy-boot-off-the-critical-path) and [player](#loading-the-player-a-lazy-boot-off-the-critical-path) lazy boots can land their idle-time parse *inside* Lighthouse's TBT window as one concentrated task — a real cost to the number, near-invisible to the reader (field INP, a session-wide percentile, doesn't move on a one-time idle burst that yields to input). The corollary is a discipline, not a loophole: **defer work when deferring is right for the reader and accept the scored cost; never contort load timing purely to fall outside the synthetic trace.** When the score matters too, cut the real main-thread work — which helps the reader and the number together — never game the measurement.

---

[EPUB]: https://www.w3.org/TR/epub/
[SMIL3]: https://www.w3.org/TR/SMIL3/
[SyncMedia]: https://w3c.github.io/sync-media-pub/sync-media-lite
[WebVTT]: https://www.w3.org/TR/webvtt1/
[MediaFragments]: https://www.w3.org/TR/media-frags/
[SpokenHtml]: https://www.w3.org/TR/spoken-html/
[AnnotationModel]: https://www.w3.org/TR/annotation-model/
[AnnotationProtocol]: https://www.w3.org/TR/annotation-protocol/
[PLS]: https://www.w3.org/TR/pronunciation-lexicon/
[SSML]: https://www.w3.org/TR/speech-synthesis11/
[SSML-mark]: https://www.w3.org/TR/speech-synthesis11/#S3.3.2
[MediaSession]: https://www.w3.org/TR/mediasession/
[SchemaOrg]: https://schema.org/BlogPosting
[OpenGraph]: https://ogp.me/
[TwitterCards]: https://developer.x.com/en/docs/twitter-for-websites/cards/overview/abouts-cards
[Atom]: https://www.rfc-editor.org/rfc/rfc4287
[RSS2]: https://www.rssboard.org/rss-specification
[ApplePodcast]: https://podcasters.apple.com/support/823-podcast-requirements
[PodcastNS]: https://podcastindex.org/namespace/1.0
[TagURI]: https://www.rfc-editor.org/rfc/rfc4151
[Podlove]: https://podlove.org/simple-chapters/
[ID3Chapters]: https://id3.org/id3v2-chapters-1.0
[JSONFeed]: https://www.jsonfeed.org/version/1.1/
[WebSub]: https://www.w3.org/TR/websub/
[JWT]: https://datatracker.ietf.org/doc/html/rfc7519
[JWS]: https://datatracker.ietf.org/doc/html/rfc7515
[JWA]: https://datatracker.ietf.org/doc/html/rfc7518
[JWT-BCP]: https://datatracker.ietf.org/doc/html/rfc8725
[PASETO]: https://paseto.io/
[JSONLD]: https://www.w3.org/TR/json-ld11/
[SchemaSpeakable]: https://schema.org/SpeakableSpecification
[SchemaFAQPage]: https://schema.org/FAQPage
[SchemaSearchAction]: https://schema.org/SearchAction
[SchemaBreadcrumb]: https://schema.org/BreadcrumbList
[SchemaTechArticle]: https://schema.org/TechArticle
[RobotsRFC]: https://www.rfc-editor.org/rfc/rfc9309
[Sitemaps]: https://www.sitemaps.org/protocol.html
[SitemapExt]: https://www.sitemaps.org/protocol.html#extending
[LlmsTxt]: https://llmstxt.org/
[GDPR]: https://eur-lex.europa.eu/eli/reg/2016/679/oj
[CCPA]: https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?division=3.&part=4.&lawCode=CIV&title=1.81.5
[CalOPPA]: https://oag.ca.gov/privacy/online-privacy
[APPI]: https://www.ppc.go.jp/en/legal/
[ISO29184]: https://www.iso.org/standard/70331.html
[WebPushProto]: https://datatracker.ietf.org/doc/html/rfc8030
[Notifications]: https://notifications.spec.whatwg.org/
[PushAPI]: https://www.w3.org/TR/push-api/
[ServiceWorkers]: https://www.w3.org/TR/service-workers/
[AppManifest]: https://www.w3.org/TR/appmanifest/
[BackgroundSync]: https://wicg.github.io/background-sync/spec/
[PeriodicBackgroundSync]: https://wicg.github.io/background-sync/spec/PeriodicBackgroundSync-index.html
[CSSAnchorPos1]: https://www.w3.org/TR/css-anchor-position-1/
[CSSAnchorPos2]: https://drafts.csswg.org/css-anchor-position-2/
[Popover]: https://html.spec.whatwg.org/multipage/popover.html
[HTMLDialog]: https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element
[MediaQueries5]: https://www.w3.org/TR/mediaqueries-5/
[TextFragments]: https://wicg.github.io/scroll-to-text-fragment/
[ProblemDetails]: https://www.rfc-editor.org/rfc/rfc9457.html
[ImmutableResponses]: https://www.rfc-editor.org/rfc/rfc8246.html
[OpenAPI31]: https://spec.openapis.org/oas/v3.1.0
[JSONSchemaCore]: https://json-schema.org/draft/2020-12/json-schema-core
[JSONSchemaValidation]: https://json-schema.org/draft/2020-12/json-schema-validation
[WAIARIA]: https://www.w3.org/TR/wai-aria-1.2/
[APGFeed]: https://www.w3.org/WAI/ARIA/apg/patterns/feed/
[APGDisclosure]: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
[APGToolbar]: https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
[WCAG22]: https://www.w3.org/TR/WCAG22/
[AccName]: https://www.w3.org/TR/accname-1.2/
[APGLandmarks]: https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/
[BroadcastChannel]: https://html.spec.whatwg.org/multipage/web-messaging.html
[WebLocks]: https://www.w3.org/TR/web-locks/
[RFC1945]: https://www.rfc-editor.org/rfc/rfc1945.html
[RFC2616]: https://www.rfc-editor.org/rfc/rfc2616.html
[RFC2518]: https://www.rfc-editor.org/rfc/rfc2518.html
[RFC6585]: https://www.rfc-editor.org/rfc/rfc6585.html
[RFC7538]: https://www.rfc-editor.org/rfc/rfc7538.html
[CFRFC9457]: https://blog.cloudflare.com/rfc-9457-agent-error-pages/
[RFC2606]: https://www.rfc-editor.org/rfc/rfc2606.html
[RFC6749]: https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2.1
[Webmention]: https://www.w3.org/TR/webmention/
[PaintTiming]: https://www.w3.org/TR/paint-timing/
[LCP]: https://www.w3.org/TR/largest-contentful-paint/
[LayoutInstability]: https://wicg.github.io/layout-instability/
[EventTiming]: https://www.w3.org/TR/event-timing/
[LongTasks]: https://www.w3.org/TR/longtasks/
[LoAF]: https://www.w3.org/TR/long-animation-frames/
[NavTiming2]: https://www.w3.org/TR/navigation-timing-2/
[ResourceTiming]: https://www.w3.org/TR/resource-timing/
[PerfTimeline]: https://www.w3.org/TR/performance-timeline/
[HRTime]: https://www.w3.org/TR/hr-time-3/
[UserTiming]: https://www.w3.org/TR/user-timing/
[ServerTiming]: https://www.w3.org/TR/server-timing/
[ElementTiming]: https://w3c.github.io/element-timing/
[TimingRegistry]: https://www.w3.org/TR/timing-entrytypes-registry/
[LighthouseScoring]: https://developer.chrome.com/docs/lighthouse/performance/performance-scoring
[WebVitals]: https://web.dev/articles/vitals
[SpeedIndex]: https://developer.chrome.com/docs/lighthouse/performance/speed-index
[CFObservatory]: https://developers.cloudflare.com/speed/observatory/
[CFRumBeacon]: https://developers.cloudflare.com/speed/observatory/rum-beacon/
[CFWebVitals]: https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/
[WebVitalsJS]: https://github.com/GoogleChrome/web-vitals
[CommonMark]: https://spec.commonmark.org/0.31.2/
[MarkdownMediaType]: https://www.rfc-editor.org/rfc/rfc7763.html
[MarkdownGuidance]: https://www.rfc-editor.org/rfc/rfc7764.html
[Readability]: https://github.com/mozilla/readability
[Turndown]: https://github.com/mixmark-io/turndown
[linkedom]: https://github.com/WebReflection/linkedom
[DOMDistiller]: https://chromium.googlesource.com/chromium/dom-distiller
[ScreenAI]: https://chromium.googlesource.com/chromium/src/+/HEAD/services/screen_ai/README.md

<!-- Specs for the stable shareable audio URL (shipped — see "Stable shareable
episode URL" above) plus its deferred canonical-link follow-up (proposal 51 §3).
Most are now cited in the prose above; the canonical-link pair ([RFC8288] /
[RFC6596]) stays a deliberate orphan until that follow-up lands. Already-mirrored
specs that bear on the same design are reused, not duplicated: [ImmutableResponses] (RFC 8246,
the inverse policy — immutable belongs on the hashed URL, never the stable one),
[RSS2]/[ApplePodcast]/[PodcastNS] (enclosure, episode GUID, podcast:integrity),
[Atom], and [RFC7538] (308 — the redirect status to AVOID for a stable→hash
hop). -->
[RFC9110]: https://www.rfc-editor.org/rfc/rfc9110.html
[RFC9111]: https://www.rfc-editor.org/rfc/rfc9111.html
[RFC5861]: https://www.rfc-editor.org/rfc/rfc5861.html
[RFC 8288]: https://www.rfc-editor.org/rfc/rfc8288.html
[RFC 6596]: https://www.rfc-editor.org/rfc/rfc6596.html
[RFC9213]: https://www.rfc-editor.org/rfc/rfc9213.html
[RFC9530]: https://www.rfc-editor.org/rfc/rfc9530.html
[RFC3986]: https://www.rfc-editor.org/rfc/rfc3986.html
[RFC3003]: https://www.rfc-editor.org/rfc/rfc3003.html
[RFC8288]: https://www.rfc-editor.org/rfc/rfc8288.html
[RFC6596]: https://www.rfc-editor.org/rfc/rfc6596.html
[RFC6266]: https://www.rfc-editor.org/rfc/rfc6266.html
[RFC8615]: https://www.rfc-editor.org/rfc/rfc8615.html
[CoolURIs]: https://www.w3.org/Provider/Style/URI
[CoolURIsSW]: https://www.w3.org/TR/cooluris/
[HTMLMedia]: https://html.spec.whatwg.org/multipage/media.html
[MSEMpegAudio]: https://www.w3.org/TR/mse-byte-stream-format-mpeg-audio/
[SRI2]: https://www.w3.org/TR/sri-2/
[EdgeArch]: https://www.w3.org/TR/edge-arch
[KeyHeader]: https://www.ietf.org/archive/id/draft-ietf-httpbis-key-01.txt
[ClearSiteData]: https://www.w3.org/TR/clear-site-data/

<!-- For LLMs: local copies of the specs above. (No local copy of [TwitterCards]
— developer.x.com renders it client-side as a JS app, so there is no static
document to mirror; use the web link. The Twitter Card vocabulary we emit also
falls back to Open Graph, which IS mirrored. No local copies of the
Schema.org per-type pages [SchemaSpeakable]/[SchemaSearchAction]/
[SchemaBreadcrumb]/[SchemaTechArticle]/[SchemaFAQPage] — schema.org is
already represented in this mirror set via [SchemaOrg]/SchemaOrg-spec.html,
and each per-type page is just a vocabulary stub whose substance lives in
the types it cross-references (e.g. [SchemaFAQPage]'s mainEntity → Question →
acceptedAnswer), so mirroring one leaf without its referents only adds a
dangling partial. How we actually use each type is documented in prose above.)
[EPUB]: ./specs/EPUB3-spec.html
[SMIL3]: ./specs/SMIL3-spec.html
[SyncMedia]: ./specs/SyncMediaLite-spec.html
[WebVTT]: ./specs/WebVTT-spec.html
[MediaFragments]: ./specs/MediaFragmentUrl-spec.html
[SpokenHtml]: ./specs/spoken-html-spec.html
[AnnotationModel]: ./specs/WebAnnotationDataModel-spec.html
[PLS]: ./specs/PronunciationLexicon-spec.html
[SSML]: ./specs/SSML-spec.html
[SSML-mark]: ./specs/SSML-spec.html (section 3.3.2)
[MediaSession]: ./specs/MediaSession-spec.html
[SchemaOrg]: ./specs/SchemaOrg-spec.html
[OpenGraph]: ./specs/OpenGraph-spec.html
[Atom]: ./specs/Atom-spec.html
[RSS2]: ./specs/RSS2-spec.html
[ApplePodcast]: ./specs/ApplePodcast-spec.html
[PodcastNS]: ./specs/PodcastNamespace-spec.md
[TagURI]: ./specs/TagURI-spec.html
[Podlove]: ./specs/PodloveSimpleChapters-spec.html
[ID3Chapters]: ./specs/ID3Chapters-spec.html
[JSONFeed]: ./specs/JSONFeed-spec.html
[WebSub]: ./specs/WebSub-spec.html
[JWT]: ./specs/JWT-spec.html
[JWS]: ./specs/JWS-spec.html
[JWA]: ./specs/JWA-spec.html
[JWT-BCP]: ./specs/JWT-BCP-spec.html
[PASETO]: ./specs/PASETO-spec.html
[JSONLD]: ./specs/JSONLD-spec.html
[RobotsRFC]: ./specs/RobotsExclusionProtocol-spec.html
[Sitemaps]: ./specs/Sitemaps-spec.html
[SitemapExt]: ./specs/Sitemaps-spec.html (section: extending)
[LlmsTxt]: ./specs/LlmsTxt-spec.html
[WebPushProto]: ./specs/WebPushProtocol-spec.html
[Notifications]: ./specs/Notifications-spec.html
[PushAPI]: ./specs/PushAPI-spec.html
[ServiceWorkers]: ./specs/ServiceWorkers-spec.html
[AppManifest]: ./specs/AppManifest-spec.html
[BackgroundSync]: ./specs/BackgroundSync-spec.html
[PeriodicBackgroundSync]: ./specs/PeriodicBackgroundSync-spec.html
[CSSAnchorPos1]: ./specs/CSSAnchorPosition1-spec.html
[CSSAnchorPos2]: ./specs/CSSAnchorPosition2-spec.html
[Popover]: ./specs/Popover-spec.html
[HTMLDialog]: ./specs/HTMLDialog-spec.html
[MediaQueries5]: ./specs/MediaQueries5-spec.html
[TextFragments]: ./specs/ScrollToTextFragment-spec.html
[ProblemDetails]: ./specs/ProblemDetails-spec.html
[ImmutableResponses]: ./specs/ImmutableResponses-spec.html
[OpenAPI31]: ./specs/OpenAPI31-spec.html
[JSONSchemaCore]: ./specs/JSONSchemaCore-spec.html
[JSONSchemaValidation]: ./specs/JSONSchemaValidation-spec.html
[WAIARIA]: ./specs/WAIARIA-spec.html
[APGFeed]: ./specs/APG-feed-spec.html
[APGDisclosure]: ./specs/APG-disclosure-spec.html
[APGToolbar]: ./specs/APG-toolbar-spec.html
[WCAG22]: ./specs/WCAG22-spec.html
[AccName]: ./specs/AccName-spec.html
[APGLandmarks]: ./specs/APG-landmark-regions-spec.html
[BroadcastChannel]: ./specs/BroadcastChannel-spec.html
[WebLocks]: ./specs/WebLocks-spec.html
[RFC1945]: ./specs/HTTP10-spec.html
[RFC2616]: ./specs/HTTP11-spec.html
[RFC2518]: ./specs/WebDAV-spec.html
[RFC6585]: ./specs/AdditionalHTTPStatusCodes-spec.html
[RFC7538]: ./specs/PermanentRedirect-spec.html
[RFC2606]: ./specs/ReservedDomains-spec.html
[RFC6749]: ./specs/OAuth2-spec.html (section 4.1.2.1)
[Webmention]: ./specs/Webmention-spec.html
[PaintTiming]: ./specs/PaintTiming-spec.html
[LCP]: ./specs/LargestContentfulPaint-spec.html
[LayoutInstability]: ./specs/LayoutInstability-spec.html
[EventTiming]: ./specs/EventTiming-spec.html
[LongTasks]: ./specs/LongTasks-spec.html
[LoAF]: ./specs/LongAnimationFrames-spec.html
[NavTiming2]: ./specs/NavigationTiming2-spec.html
[ResourceTiming]: ./specs/ResourceTiming-spec.html
[PerfTimeline]: ./specs/PerformanceTimeline-spec.html
[HRTime]: ./specs/HRTime-spec.html
[UserTiming]: ./specs/UserTiming-spec.html
[ServerTiming]: ./specs/ServerTiming-spec.html
[ElementTiming]: ./specs/ElementTiming-spec.html
[TimingRegistry]: ./specs/TimingEntryTypesRegistry-spec.html
[CommonMark]: ./specs/CommonMark-spec.html
[MarkdownMediaType]: ./specs/MarkdownMediaType-spec.html
[MarkdownGuidance]: ./specs/MarkdownGuidance-spec.html
(No local copies of [Readability], [Turndown], [linkedom], [DOMDistiller], or
[ScreenAI] — these are the libraries/engines the Copy-as-Markdown pipeline
*uses* or names, not specs: Readability is Firefox's reader engine, Turndown the
HTML→Markdown serializer, linkedom the server DOM they run on, DOM Distiller is
Chrome's (being-retired) reader-mode extractor, and Screen AI is the Chromium
ML service replacing it — a code-repo README, not a standard. The format they
produce/consume IS a spec, mirrored above as [CommonMark] + [MarkdownMediaType].
Use the web links for the tools.)
(No local copies of [LighthouseScoring], [WebVitals], or [SpeedIndex] — these
are Google product docs, not standards-body specs: Lighthouse is a tool, Speed
Index is a metric it computes, and the pages are JS-rendered doc apps with no
static document to mirror. Use the web links; the metrics they describe are
each backed by a mirrored W3C/WICG spec above. Likewise no local copies of
[CFObservatory], [CFRumBeacon], [CFWebVitals], or [WebVitalsJS] — Cloudflare's
Observatory just runs Google Lighthouse and its RUM uses the `web-vitals`
library, so these are product docs / a code repo, not new specs; the metric
definitions they rely on are the same mirrored W3C/WICG specs above.)

Local copies of the stable-shareable-audio-URL specs (web links in the second-to-last block).
All have a static document, so all are mirrored — including the ones the
investigation judged NOT useful, flagged inline so they aren't mistaken for
load-bearing: [EdgeArch] (the pre-RFC-9213 vendor Surrogate-Control mechanism —
superseded by [RFC9213] for our CDN, kept for reference), [KeyHeader] (an
EXPIRED, never-standardized IETF draft for a richer secondary cache key — do not
design around it; mirrored as the original `.txt` Internet-Draft), [ClearSiteData]
(clears CLIENT state, can't target one URL's CDN-cached bytes — not an
invalidation tool here), and [RFC8615] (well-known URIs — irrelevant to serving
the media, only to discovery metadata). [SRI2] is mirrored but does NOT yet
cover `<audio>`/`<source>`; its relevance is purely as the hash format
[PodcastNS]'s `podcast:integrity` reuses.
[RFC9110]: ./specs/HTTPSemantics-spec.html
[RFC9111]: ./specs/HTTPCaching-spec.html
[RFC5861]: ./specs/StaleContentExtensions-spec.html
[RFC9213]: ./specs/TargetedCacheControl-spec.html
[RFC9530]: ./specs/DigestFields-spec.html
[RFC3986]: ./specs/URI-spec.html
[RFC3003]: ./specs/AudioMpegMediaType-spec.html
[RFC8288]: ./specs/WebLinking-spec.html
[RFC6596]: ./specs/CanonicalLinkRelation-spec.html
[RFC6266]: ./specs/ContentDisposition-spec.html
[RFC8615]: ./specs/WellKnownURIs-spec.html
[CoolURIs]: ./specs/CoolURIs-spec.html
[CoolURIsSW]: ./specs/CoolURIsSemanticWeb-spec.html
[HTMLMedia]: ./specs/HTMLMediaElements-spec.html
[MSEMpegAudio]: ./specs/MSEMpegAudioByteStream-spec.html
[SRI2]: ./specs/SRI2-spec.html
[EdgeArch]: ./specs/EdgeArchitecture-spec.html
[KeyHeader]: ./specs/KeyHeader-spec.txt
[ClearSiteData]: ./specs/ClearSiteData-spec.html
-->

