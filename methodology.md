# Methodology

This document summarizes the goal, methodology for reaching the goal esp. in relation to technical decisions, progress towards the goal of this project

## What we're building

A way to build explanatory technical blog posts that doubles as a talk via associated audio.

To ensure ease of AI authoring, each post is a self-contained HTML file that contains all relevant information inline (text, graphics — including animated, interactive figures — spoken script, etc.). Generator tools then parse this file to power things like a "Listen" button that plays a narration of the post.

The spoken track is deliberately **not** a read-aloud of the article - it's a parallel narrative that can paraphrase, reorder, skip over, or revisit visual elements the way a presenter does.

Key design decisions that shape the architecture:
- **The engine is a separate git repo from the content it renders.** This repo (`presidocs`) is the reusable *engine* — player, comments, build/TTS pipeline, server, authoring tools — and holds **no posts of its own**. Each actual blog is its own git repo containing only content (posts, figures, landing, per-blog config) and depends on the engine through a `bun link` symlink to the sibling engine checkout (`"presidocs": "link:presidocs"`); its `index.ts`/`worker.ts` are thin wrappers that call engine factories. One fast-moving engine is shared across blogs without copy-paste drift, while each blog's content and deploy config stay independently versioned. The hard rule that falls out of this: **engine code never names a specific post** — it discovers content by convention from a *content root*. See [Repository layout](#repository-layout) for the two folder structures and the wiring between them.
- **One file per post.** Article + spoken script live in the same HTML
  so authoring tools (humans or LLMs) edit one document, not a
  bundle. No other content input is allowed (note: multiple files are allowed to be served, but they have to be generated from the single input)
- **Audio is generated offline**, then served as static assets. A `bun run generate` step turns the inline spoken script into MP3-shaped artifacts plus a JSON timing manifest. The runtime player never calls a TTS API.
- **The narration is in the *author's own voice*.** The production audio is voice-cloned from a reference clip of the real author, so a listener feels the presentation is genuinely being given by the person who wrote it — not read by a generic synthetic narrator. This authenticity is the whole point of the spoken track. Crucially, auto-generating that voice is what makes it *sustainable*: the author can iterate on the document in response to feedback (see [AI-assisted iteration](#ai-assisted-authoring-authoring)) without re-recording a long presentation on every revision — the next build just re-synthesizes the changed segments in their voice. (This is also why the production TTS provider is a voice-cloning model; see [Providers](#providers-say-for-iteration-moss-for-production).)
- **Segment-level audio cache.** Edit one sentence and only that sentence is re-synthesized — the rest comes from cache. See [Audio caching](#audio-caching).
- **Non-linear narration is a first-class case.** Presenters reference earlier slides; our highlight/scroll logic has to handle going backwards as gracefully as forwards. This rests on one invariant: narration may skip *backward* (revisit an earlier figure) but never *forward*, so the page is covered by a monotonic frontier and every article position is "owned" by the first narration to reach it — which is what lets a prose marker map unambiguously to a point in the spoken track.
- **Chapters group into *parts*, and a part is one entity with three faces.** A long post's many chapters are grouped into a few navigable parts. A part's boundary exists on all three surfaces at once — a labeled prose **divider** (read), a spoken **section-intro** transition (heard), and a **script-drawer** entry (listed) — wired together by the intro's first `<mark>` targeting the divider's `id`. The part name is authored once (the section-intro's title, shown verbatim on the divider) and the spoken transition paraphrases it, exactly as every `<mark>` paraphrases its element. Crucially the part name is **decoupled from the member chapters' own headings**, so a part's first content section keeps its heading instead of being conscripted into naming the whole part. See [Two-level chapters](#two-level-chapters-parts--sub-chapters).
- **No light/dark toggle**: we will never support a dark-mode/light-mode switch, because we need to ensure generated visuals for charts, etc. appear correctly (too hard to do this for both modes)
- **Figures are live and interactive.** Diagrams aren't static images or pre-rendered video — the `<figure>`'s markup is authored in the post and progressively enhanced into an animated, interactive diagram by a referenced [GSAP](#animated-figures) module (kept external, like the player's code, because the prod CSP forbids inline scripts/styles). The figure stays [comment-anchorable as a graphic](#anchoring-graphics) and can sync to narration. See [Animated figures](#animated-figures).
- **Objects are CRDT-based; the *production* server is dumb storage.** Objects are managed via Automerge (CRDT library) and synced as content-addressed change objects in R2. Following this CRDT paradigm, the **production** server (the Cloudflare Worker) never runs Automerge or holds any other reconciliation logic — it just shuffles bytes. This is a *production deployment* constraint, not a universal one: it's what lets the comment data survive a malicious / buggy / different-version edge server, and it's why per-reader writes don't need server-side merge. **Localhost is exempt.** The dev Bun server and the offline build/authoring tools (`bun run generate`, `authoring/*`) run on the developer's machine, fully trusted, and freely run Automerge — merging every reader's blob, snapshotting, serializing to other formats. So "the server is dumb" should be read as "the *edge* server is dumb"; anything that only ever runs on localhost may be as smart as it likes.
- **Cloudflare ecosystem in prod, Bun in dev.** We focus on leveraging the Cloudflare ecosyhstem for production (Workers for the HTTP layer, R2 for any dynamic blob, the Static Assets binding for static content). Bun is dev-only (`bun --hot index.ts`) and build-time only (`bun run generate`)
- **Commenting as a core feature** Comments are done via OAuth login with the user's email. This allows us to not only apply recommended changes if relevant, but also follow-up with any commenter (via email or otherwise) to engage.
- **AI-assisted iteration: the comment system *is* the editing surface.** The author leaves their own comments on a post via the same UI a reader does, interleaved with readers' feedback ("rephrase this paragraph", "add an example for X"). An offline tool then hands every unresolved thread — both sources, undifferentiated — to Claude, which edits the source HTML in one reviewable diff. No separate editor view, no parallel workflow for human-driven vs. reader-driven edits. The same mechanism that gathers reader questions is the mechanism that drives the next revision. See [AI-assisted authoring](#ai-assisted-authoring-authoring).

## Repository layout

Because the engine and the content live in **separate repos** (see the design decision above), there are two distinct layouts. The split rule is simple: a folder lives in the engine if it's reusable code that never names a post; it lives in the content repo if it's this-blog-specific input or config.

### Engine repo (`presidocs`)

Each top-level folder is one concern, so finding code is "pick the folder that matches what you want to change":

- `generate/` — offline pipeline that turns a post into audio + manifest, plus the build-time codegens (`post-meta`, `post-versions`, `post-routes`) and the `copy-static`/`strip-served-html` build steps
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
- `authors/` — per-author assets, one set per author keyed by **`<author-email>`**: the profile (`<email>.json` — display name + social links), the avatar (`<email>.png`/`.jpg`/…), and the production-TTS voice-clone clip (`<email>.wav`). The `.json`/avatar power the reader-facing byline; the `.wav` is a build-only input (never served). One folder, one key. See [Author profiles and bylines](#author-profiles-and-bylines-sharedauthorprofilets-clientbylinets) and [Per-author voice resolution](#per-author-voice-resolution).
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

A static SVG diagram only carries so much. Since every post is already HTML running in a browser, we want figures that *move and respond*: a hash visibly scrambling under the avalanche effect, a value tracing a curve, a step-through the reader can scrub or drive. The long-term goal is an animated, interactive educational book for math topics — so "more than a fade-in" is the baseline, not a stretch.

The figure's **markup is authored in the post** — a `<figure id="…">` the author edits inline alongside the prose — and is progressively enhanced into the live diagram by a small **referenced module** (its animation code and styles), exactly the way the post already pulls in the player (`client/narrator.ts`) and comments (`client/comments.ts`). We'd have preferred the animation *code* inline in the post too, but the production CSP is `script-src 'self'` / `style-src 'self'` with no `'unsafe-inline'` (see [HTTP security headers](#http-security-headers-sharedsecurityheadersts)) — executable inline scripts and inline `<style>`/`style=` are blocked — and Bun's bundler doesn't cleanly externalize an inline `<script>` (it duplicates rather than strips it). So the behaviour lives in a bundled module under [`client/figures/`](#how-its-wired-clientfigures); the post owns the markup and the `<script src>`/`<link>` references. The figure still renders into a real `<figure id="…">`, which keeps it [comment-anchorable as a graphic](#anchoring-graphics) and live in the DOM — not a baked asset we can only point at as a flat box.

### Requirements

What we need from an animation approach, in priority order:

- **Text-only input.** The animation is specified entirely in text we can author and diff — no binary scene files, no GUI-only tool.
- **No React, in or out.** Neither the authoring format nor the runtime may depend on React (the rest of the site is React-free and stays that way).
- **Runs in the browser.** Output is HTML-compatible and executes client-side — not a pre-rendered video we can only embed.
- **More than basic animation.** Sequenced timelines, staggering, SVG path drawing, shape morphing, motion along a path — the vocabulary a math explainer needs, not just fades and slides.
- **No custom DSL of our own.** We'll happily write whatever text format an existing tool already uses (its JS/TS API, JSON, …); we just won't invent and maintain a bespoke animation language.
- **In-repo source, authored near the post.** The animation is plain source in our repo (the figure's markup in the post; its code in a bundled module), edited and diffed as text — not a separate external project rendered to an opaque asset. (Strict literal *inline-in-the-HTML* turned out to be blocked by the prod CSP; see below.)
- **Interactive (nice-to-have).** Readers can type, drag, hover, scrub. Lower priority than the above, but it's where the format pays off for an explorable book, and it's a natural fit for the project's existing interactivity (comments, the player).

### Library choice — GSAP

We prototyped the *same* figure (real in-browser SHA-256 with the avalanche effect) under multiple options before committing. What we considered:

- **Hand-written SVG / CSS / WAAPI.** Zero dependencies and fine for simple motion, but sequenced multi-step educational animations get verbose fast and there's no real timeline-scrubbing story. Kept as the **no-JS fallback** (the figure's initial frame), not the animation engine.
- **anime.js (v4).** Small, MIT, clean modern ESM API; we built a complete prototype in it. Great for simpler cases, but its timeline is less mature and it has no equivalent of the SVG-drawing / morph / motion-path toolkit a math book leans on.
- **Motion Canvas.** Best *authoring experience* for complex scripted animation (TypeScript generator functions, live-preview editor — "Manim-class in TS"). Rejected as the default on three structural mismatches: it's *playback*, not interactive; its scenes live in a **separate project rendered to a video/canvas asset**, breaking "one file per post"; and its tooling is **Vite-coupled**, against our Bun rule.
- **Manim.** The gold standard for cinematic math video, text-specified in Python — but it outputs *video* (no interactivity; comment-anchorable only as a flat box) and lives outside the post. Same back-pocket slot as Motion Canvas: a non-interactive **cinematic set-piece** could be rendered offline via `bun run generate` and served static like the audio, but it's not our default.
- **GSAP — picked.** Mature timeline control (`seek` / reverse / `timeScale` / labels / nesting) that suits step-throughs, and that lets a figure be slaved to the [narration player's existing rAF clock](#player--sync-clientnarratorts) for audio-synced animation; a free (since 2025, all plugins included) toolkit — `DrawSVG`, `MotionPath`, `MorphSVG` — that maps almost one-to-one onto math-explainer primitives; and ergonomic imperative re-animation (`gsap.quickTo`) for input-driven explorables. No React. In production the library is **vendored and bundled locally** (`bun add gsap`; Bun bundles the module import into the post's `'self'` asset), never loaded from a CDN, so it satisfies the document's Content-Security-Policy. GSAP only writes `element.style` (CSSOM), which CSP does not govern — so the animation needs no policy relaxation.

### How it's wired (`client/figures/`)

The first animated figure is the hash diagram in `posts/hash-functions.html`, implemented by `client/figures/hashAvalanche.{ts,css}`. The shape it establishes for future figures:

- **Progressive enhancement over a static fallback.** The post ships a static `<svg class="hash-static">` inside the `<figure>` as the no-JS / initial frame. On load the module hides it (adds `.hash-enhanced`) and injects the live stage. A reader with JS disabled, or a crawler, still sees a meaningful diagram.
- **Real computation, real interactivity.** The figure computes genuine SHA-256 via `crypto.subtle`, so typing any input — or the "flip one character" button — shows the *true* avalanche effect (≈ how many of the 64 hex digits change from a one-character edit), not a canned animation.
- **Narration-synced with no new player API.** The player already toggles a `narration-active` class on the element whose `<mark>` is playing (see [Player & sync](#player--sync-clientnarratorts)). The figure `MutationObserver`s that class on its own `<figure id="diagram">` and replays the intro when the "diagram" mark is reached, so a listener sees it move on cue. An `IntersectionObserver` covers the silent reader (play once when scrolled into view). This rides the [`<mark name>` ↔ `id` pairing](#connecting-spoken-text-to-blog-content) the narration already depends on, so the audio script needed no change.
- **Reduced-motion aware.** Under `prefers-reduced-motion: reduce` the module skips the scramble/pop-in and renders the final fingerprint directly.
- **CSP-clean by construction.** No inline `style=` (all classes, toggled in JS); dynamic visuals are GSAP CSSOM writes or class toggles, both ungoverned by `style-src`.

## SSML usage

Although [SSML] has historically been used to represent spoken text concepts, it has been losing traction given newer LLM-based models tend to focus on natural language hints over SSML-like DSLs.

While spoken text scripts often encode notes about delivery (ex: dramatic pauses, emotional cues), we generally do not need these for technical blogs. However, we *do* still often need two concepts from SSML

### Representing word pronunciation

Our use-case still requires pronunciation hints (which are not supported by every model) for technical words.

Therefore, to we allow specifying pronunciations using the [PLS] in two ways:
1. For commonly-used technical term, we allow a global `common-terms.pls` that is shared by all blog posts
2. For post-specific technical terms, we allow a `<script type="application/pls+xml">` to be inlined into the document

#### Honoring PLS without a PLS-aware engine (substitution)

None of our engines have a native PLS API: `say` ignores PLS outright, and MOSS is an autoregressive LLM that takes *text*, not a pronunciation dictionary. So for an engine that nonetheless reads whatever text we hand it (every LLM-TTS), we honor the lexicon by **substitution** — rewriting each matched grapheme to its pronunciation *in-band* before synthesis, so the engine never knows a lexicon existed. This lives in `generate/pronunciation.ts` (`parseLexicon` + `applyLexicon`) and is wired into the MOSS provider's `synthesize`. `say` still warns-and-ignores (it's the rough iteration tool; the cache keys on provider name, so a `say` draft and a MOSS render never collide).

**Respelling (`<alias>`) is the only viable tool — IPA (`<phoneme>`) is not, on the local MOSS model.** The author writes a respelling — plain words read through the normal voice ("SHA-256" → "shah two fifty six"). The rationale is specific to *probabilistic* engines: a term like "SHA-256" has several plausible readings, and each is a mode a high-temperature sampler can fall into — which is why MOSS will pronounce a term correctly ten times and then mangle it on the eleventh. Rewriting to one unambiguous English form is **entropy reduction at the input**: it collapses those competing modes, so the win isn't "it reads naturally," it's *lower variance*.

**But respelling has its own orthographic ambiguity — the bar is "one *obvious* reading," and we learned that the hard way.** The first attempt failed exactly here: MOSS read "sha" as "shay" (not "shah"), and "dee" (the letter D in "ripe em dee") as "dey". The fixes are *unambiguous* English: "sha" → **"shah"** (a real word, only ever /ʃɑː/ — confirmed: "shah two fifty six" renders perfectly). **Letter-names are the hardest case, and the fix that won was standalone CAPITAL letters**: "RIPEMD-160" → "ripe M D one sixty". Capitals get spelled correctly ("M"→"em", "D"→"dee") *and* resist blending into neighbours — lowercase "ripe em dee" was read "**rape** em **dey**", whereas the capital `M`/`D` break that merge. Two dead ends en route: a non-word respelling ("rype") came out *worse* (the model free-associates non-words), and punctuation isolation ("ripe, em" / "ripe. em") *did* fix the vowel but added an awkward pause. The workflow is: respell, verify *by ear* (the [per-segment re-roll](#per-segment-regeneration-dev-author-only) loop makes this cheap), tune until right.

**Why not IPA.** It looks like the obvious fix for letter-names — but the **local MOSS model does not usefully interpret IPA**, which we confirmed with a standalone 4-way test. There are *two distinct* failures: IPA **embedded** in a sentence (`the algorithm /ʃɑ.../ is common`) makes MOSS read the slashes *literally* ("slash"); IPA as the **entire** input (`/ʃɑ tu ˈfɪfti sɪks/`) consumes the slashes but renders *garbled noise*, not the phonemes. The likely cause: the model only accepts IPA in the exact token format its g2p (DeepPhonemizer / cmudict-IPA) emits, so hand-authored IPA comes out as garbage — and even if we matched it, it'd require phonemizing *whole segments* (the embedded form is dead), a heavy g2p detour we've rejected. IPA appears to be a flagship/larger-MOSS feature (same split as acoustic continuity). The parser still reads `<phoneme>` and `applyLexicon` *will* emit it to an engine that declares `ipaSupported` — but MOSS sets that **false**, so on MOSS every entry **must** carry a working `<alias>`. (Hand-authored IPA was also always *unverifiable* by an author who doesn't read it, whereas anyone can hear-check "shah two fifty six".)

**Substitution is defensive and unconditional, never detection-gated.** It's tempting to "only add a lexeme for terms MOSS actually gets wrong," but under sampling a clean take proves nothing — the synthesis you didn't audit can still betray you. So any term with an entry is substituted on *every* synthesis. Substitution lowers the bad-roll rate; it doesn't zero it (a multi-word respelling has its own smaller failure surface — odd stress, a stray pause). The residual is caught by the segment cache: a good take is frozen once accepted, and a bad roll costs a single-segment re-roll, not a re-render (see [per-segment regeneration](#per-segment-regeneration-dev-author-only)). The blunt last resort for stability is lowering MOSS's `audio_temperature`, but the per-term respelling is the surgical fix and keeps the prosodic variety.

**The matcher is the actual risk surface** — a PLS-aware engine would tokenize for us; here we do it ourselves, so it's deliberate:
- **Alphanumeric boundary**, not regex `\b` (which is defined against `\w` and misbehaves for graphemes that begin/end in punctuation, like `SHA-256`): a match is valid only when neither neighbor is `[A-Za-z0-9]`. So `SHA-256` matches inside `(SHA-256),` but not inside `SHA-2560`.
- **Longest-match-first**: a `RIPEMD-160` entry beats a bare `RIPEMD`.
- **Case-sensitive**: graphemes are matched exactly as listed. This is *why* a lexeme lists case variants (`SHA-256`, `sha256`, …) as separate graphemes — that list is the author's control, and it's also the **escape valve**: anything the matcher misses, the author fixes by adding another `<grapheme>`, exactly as before.

**Cache interaction.** The merged local lexicon XML is in the [TTS cache key](#audio-caching), so a substituted segment is correctly re-synthesized when the post's inline lexicon changes, but `common-terms.pls` is *excluded* from the key

#### Sound test (dev-only pronunciation audition)

Tuning a respelling is a *listening* loop — the bar is "one obvious reading," and the only way to know you've cleared it is to hear MOSS read the term. Doing that inside a post is awkward: the term is buried in a paragraph, and `common-terms.pls` is [excluded from the TTS cache key](#audio-caching), so editing a shared alias doesn't even re-synthesize the segments that use it. The **sound test** is the dedicated surface for this: a dev-only page at **`/dev/sound-test`** that lists every lexeme in `common-terms.pls`, plays the production-voice (MOSS) audio for each, and lets the author re-roll any that come out wrong — the audition counterpart to [per-segment regeneration](#per-segment-regeneration-dev-author-only), but for the cross-post lexicon rather than a post's segments.

Mechanically it mirrors the per-segment re-roll, with one deliberate inversion of the cache rule:
- **It synthesizes the already-substituted pronunciation text directly** (the `<alias>`, or `<phoneme>` wrapped in `/.../` on an IPA engine), not the grapheme + a lexicon. For a standalone term that's byte-identical to what `applyLexicon` would hand the engine, and it makes the audio's *identity* the respelling itself.
- **So its store keys on that text — the opposite of the post cache, on purpose.** The post pipeline excludes `common-terms.pls` from its key (so one shared edit doesn't invalidate every post). That's exactly wrong for an audition tool: editing a respelling *should* change its audio. So the sound test uses a **separate** store, `generated/.sound-test/<hash>.wav`, where the hash includes the voice identity *and* the synth text. Edit an alias → new hash → no file → the page shows it as "not generated" and offers a button; the stale file is swept on the next full run. (The `.`-prefix keeps it clear of `clean.ts`, which skips hidden dirs, and of `copy-static`'s prod glob.)
- **Heavy work stays offline, exactly like regenerate.** The page's buttons hit dev-only endpoints (`server/soundTest.dev.ts`) that shell out to the offline `generate/sound-test.ts` (loads the multi-GB MOSS model, writes the WAVs) and report progress via the same async start-then-poll job pattern as `/dev/regenerate`. `--all` loads the model once and renders every missing/stale lexeme in one pass; a per-row click re-rolls one. The endpoints are imported only by `createDevServer.ts` (never the Worker), and POST is gated behind a logged-in session.
- **Audio is cache-busted by file mtime.** A re-roll produces new bytes under the *same* content-hash filename (same synth text), so the page appends `?v=<mtime>` when loading a clip — sidestepping Chrome's sticky `<audio>` media cache, the same hazard the post track solves by [hashing the filename](#serving-generated-audio-content-hashed-filenames--dev-range-support).

Auditioning *every* word at once is also what surfaced the [leading-silence guard](#generation-pipeline): the page made it obvious that every term starting with "S" lost its onset, because the per-word trim ran the soft fricative straight into `silencedetect`'s amplitude threshold. The fix lives in the shared `leadingSilenceTrimMs`, not here — the sound test trims through the same guarded path the post pipeline does (for a one-word clip the lead is almost always within the guard, so nothing is trimmed).

**Closing the audit-to-fix loop: per-lexeme cross-post regeneration.** Once a respelling sounds right in the audition, the *post* audio for segments containing that term is still stale — `common-terms.pls` is excluded from the post cache key (see [Audio caching](#audio-caching)), so a shared edit doesn't invalidate anything on its own. The sound-test page closes this loop: each row shows which posts the lexeme occurs in (with the matching mark names and the post's last build time), plus one button that **re-rolls exactly those segments across every affected post** — and only those, leaving everything else as cache hits. Three properties make it safe:
- **The "occurs" check shares the substitution matcher**, not a looser one. Both the page's discovery (`matchesAnyGrapheme`) and the in-post substitution (`applyLexicon`) anchor on the same case-sensitive, alphanumeric-boundary rule, so the segments the page claims will change are exactly the segments the synthesis will substitute. Anything else would be a lie about audio identity.
- **The regen is surgical via `--force-mark`.** The endpoint shells out to `generate.ts` once per affected post with `--force-mark=<mark1,mark2,...>`: the listed marks bypass the cache *hit* and re-synthesize with the current (edited) lexicon, overwriting their bytes at the same key; every other segment hits cache. Per post you get one model load, then near-instant cache hits for the unaffected segments, and a fresh `full.<hash>.<ext>` rolled at the end. Across N affected posts that's N model loads sequentially — a known cost we accept because `generate.ts` is per-post; a future orchestrator that holds one provider open across posts would amortize this, but isn't worth the refactor today.
- **Author-gated per post, single-flight with the audition job.** The session must author *every* affected post (refuse-with-list on mismatch, not silent skip), and the sweep shares the same single-flight lock as the audition POSTs — MOSS loads one model at a time, so the two actions mutually exclude. Page state reports per-post progress (`pending` → `running` → `ok`/`error`) so a multi-minute sweep isn't a silent wait.
- **Voice is resolved per post, not blog-globally.** Each spawn passes an explicit `--voice=` chosen for the post's author (see [Per-author voice resolution](#per-author-voice-resolution)), so a multi-author blog re-rolls each post in *its own author's* voice. The page shows the resolved author per row (`alice@…'s voice`) before the click, and the POST refuses with a list naming any post whose `authors/<author-email>.wav` is missing.
- **The audition itself is keyed on the *session user's* own voice.** Clicking "Generate" / "Re-roll" for a row synthesizes the audition clip using `authors/<your-email>.wav` — so each author on a multi-author blog auditions the respelling in the voice they author posts with, and the per-voice keyed store keeps everyone's audition clips separate.

The page is an engine surface (it discovers the lexicon by convention at `posts/common-terms.pls`, never naming a post), so every blog built on the engine gets it for free; `bun run sound-test` renders the whole lexicon from the CLI for the same result without the page.

### Connecting spoken text to blog content

We want our spoken text to be able to highlight different parts of the HTML document that it is referring to. Essentially, listening to the audio should eventually take you down the entire blog (auto-scroll)

To facilitate this, blog content can be marked with `id`s in the HTML (ex: `<p id="foo">`), and spoken text can refer to these IDs using SSML `<mark>` tags (ex: `<mark name="foo"/>`. See [spec][SSML-mark] for more).

These `<mark>` tags in the audio also act as natural splitting boundaries — they delimit the **segments** that are individually synthesized and individually cached (see [Audio caching](#audio-caching)), and they're the unit of per-mark navigation in the player.

### Word-level timing (drawer karaoke + subtitle sidecar)

The script drawer surfaces the spoken text per `<mark>` segment; on top of that, an opt-in build flag (`--align=qwen3`) populates **per-word timing** so the drawer can highlight the exact word being spoken at any instant, and so a future social-media video pipeline can render subtitle-style karaoke captions. See [proposals/17](./proposals/17-word-level-narration-sync.md) for the decision rationale.

**Acquisition: forced alignment, build-time only.** None of our TTS providers emit word timestamps (MOSS is an autoregressive LLM, `say`/`espeak-ng` are opaque CLIs). The aligner runs in `generate/` per segment, gated by the same disk cache as TTS — words live at `generated/.tts-cache/<text-hash>/<full-hash>.words.json` *right next to* their `<full-hash>.wav`, so a segment re-roll invalidates both atomically and a backfill scenario (audio cached, words missing because alignment was added later) re-aligns the cached audio without re-synthesizing. The default backend is **Qwen3-ForcedAligner-0.6B** (Apache-2.0, local) configured via the **`QWEN3_ALIGNER_DIR`** env var (same pattern as `MOSS_TTS_DIR`); `QWEN3_ALIGNER_PYTHON` overrides the interpreter and `QWEN3_ALIGNER_DEVICE` the torch device (default **`cpu`** — see the worker note below). `bun engine/generate/align-check.ts <wav> "<transcript>"` is the smoke tool — the alignment counterpart to `sound-test` for MOSS.

**Long-lived worker, on CPU by default — and why both, with numbers.** Like MOSS, the aligner loads a model (~0.6B) that costs several seconds, and `generate.ts` interleaves synthesis and alignment in one per-segment loop. The first integration spawned a fresh `python align.py` *per segment*, which made the model reload the dominant cost. Measured on this hardware (RTX 2080 Ti, WSL2): aligning a 1.6s clip took **5.96s** and a 54s clip **6.93s** — i.e. **~5.9s of every call is pure model load** and only ~1s is the actual alignment compute even for a very long segment. Across a ~160-segment post that's ~16 minutes of nothing but reloading. So the aligner now drives a **long-lived worker** (`generate/align_worker.py`) on the exact MOSS pattern — model loads once, each segment is one request over a line-delimited JSON stdin/stdout protocol, structured tokens come back (no stdout text to parse), and `generate.ts`/`align-check.ts` call `close()` to tear it down so the process doesn't hang on the worker's never-ending stdout read. Warm per-segment cost drops to **~234ms** (measured), turning whole-post alignment from ~17 min into well under a minute. **CPU is the default device** because, with the reload amortized, that ~234ms compute is small enough that CPU costs us nothing we'd notice — while keeping the aligner off the GPU hands the entire card to MOSS, whose footprint already over-subscribes an 11 GB board ([Memory requirements and device placement](#memory-requirements-and-device-placement)). So on a discrete GPU CPU wins on both axes here: no VRAM contention *and*, because the old per-call GPU path also paid CUDA-init + host→device load every segment, no slower in practice. `QWEN3_ALIGNER_DEVICE=cuda:0`/`mps` overrides it for a machine with VRAM to spare or unified memory, where keeping a single long-lived model on-device is a clean win.

**The PLS-substitution wrinkle: align against spoken text, anchor against displayed text.** MOSS is fed text that has already been rewritten by [PLS substitution](#honoring-pls-without-a-pls-aware-engine-substitution) (`SHA-256` → `shah two fifty six`). Forced alignment must therefore run on the *substituted* string — the audio actually says "shah two fifty six" — but the drawer renders the *original* `SHA-256`. So `applyLexicon` returns both the substituted text *and* an index map (`originalStart`/`originalEnd`/`substitutedStart`/`substitutedEnd` per substitution), and the alignment cache projects each aligned token's substituted offsets back to original-text offsets via `projectSubstitutedPosToOriginal`. When one displayed term gets spoken as multiple words (`SHA-256` → 4 spoken words), the projection collapses to a *single* word entry spanning the full duration — the drawer highlights the displayed term continuously while MOSS takes its respelling excursion, which is what a reader following along expects.

**One alignment table, two emitters.** The same per-segment `words[]` data lands in two artifacts, mirroring the pattern the chapter pipeline already uses (in-MP3 ID3 CHAP frames + `<podcast:chapters>` JSON sidecar both generated from the same chapter table — see [Subscription feeds](#subscription-feeds-atom--podcast-rss-generatefeedsts)):
- **`manifest.json` `marks[].words`** — the runtime drawer reads this inline (no extra fetch, no parser). Each word is `{ s, e, t, d }`: `s`/`e` are character offsets into the mark's `text` (the displayed string the drawer renders), `t`/`d` are master-track absolute ms. The rAF tick that already finds the active mark does an inner linear scan over the segment's `words[]` (typically 30-80 entries) and toggles `.narration-active-word` on the right `<span>`. Backwards-compatible: a post without alignment simply has no `words` field and the drawer renders the text flat.
- **`generated/<slug>/captions.vtt`** — a [WebVTT][WebVTT] sidecar emitted by the build for the social-media video subtitle pipeline (out of scope for now — see [proposals/17 §10](./proposals/17-word-level-narration-sync.md)) and for general interop with caption tooling. One cue per `<mark>`; intra-cue `<HH:MM:SS.mmm>` timestamp tags per word. The drawer never fetches this file; it exists purely as an export. Skipped entirely on a post without alignment so pre-alignment builds keep their previous file set byte-for-byte.

**Why a custom JSON shape and not WebVTT for the runtime?** The drawer renders the segment's text as a *string*, slicing `text.slice(s, e)` for the active word's `<span>` — character-offset semantics. Standards whose anchor model is "highlight the element with id X" (EPUB Media Overlays, Sync Media Lite) would force a per-word `<span id>` DOM expansion at build time we'd have no consumer for. WebVTT was the strongest standards-aligned candidate but its only browser-native parsing surface (`<track>` + `cuechange`) exposes whole cues, never intra-cue tokens — so we'd parse the intra-cue tags ourselves anyway, *and* pay a second fetch round-trip. The hybrid (inline JSON + derived VTT) gets the runtime ergonomics of the project-native shape and the export-format ergonomics of WebVTT, without forcing either layer to compromise.

### Chapters

All SSML and spoken content in general lives inside `<script type="text/narration" data-chapter-id="unique-id" data-chapter-title="Visible Title">` blocks.

Usage of script blocks allows us to ensure that this text does not actually appear on the page (and instead, SSML/narration blocks are fed into generation tools to process)

We call this `text/narration` blocks instead of SSML blocks as we only allow the `<mark>` SSML notation, and so calling it a `SSML` block in general may confuse AI (it may write general SSML notation, which we don't support. For example, no `<speak>` tag)

These blocks each define a "chapter" for usage in audio narration (which allows skipping between chapters)

#### Two-level chapters (parts → sub-chapters)

Chapters have an **optional** second level of hierarchy. A chapter becomes a *member* of a part by adding **`data-chapter-parent="<part id>"`** to its `<script type="text/narration">` block. The parent is the part's **section-intro chapter**: a short spoken transition (*"So — where do these offers actually live?"*) that opens the part, whose **first `<mark>` targets the part's labeled divider** (`<mark name="<part id>"/>` ↔ `<div class="section-divider-labeled" id="<part id>">`), so the divider lights up while the intro plays. The hierarchy is a **flat attribute pointer**, not nested markup — `<script>` blocks can't nest in the DOM, so every chapter stays a top-level sibling and names its parent by id (rather than a dotted `parent.child` id, which would overload the id that `<mark>`s and deep-links also key on). Level is **derived** from the pointer's presence, never declared as its own attribute, so the two can't disagree: a chapter with no `data-chapter-parent` is top-level — either a part's section-intro or a flat standalone chapter; with one, it's a level-2 member. A post with zero `data-chapter-parent` attributes is a flat list of top-level chapters whose manifest carries no hierarchy annotation at all — the second level adds nothing until it's used.

We deliberately do **not** tie nesting to the prose's `<h2>`/`<h3>` *header levels*: narration can paraphrase, reorder, and skip around the document (it's a parallel narrative, not a read-aloud), so a chapter's spoken position doesn't track a heading's DOM position. The link is the explicit attribute instead. The **authoring convention** is nonetheless to *mirror* the outline you already wrote: a narration block whose prose corresponds to an `<h3>` under an `<h2>` sets `data-chapter-parent` to the chapter-id of the block corresponding to that `<h2>`. So you read the level straight off your own outline — one hierarchy to maintain, not two.

**A part is one entity with three renderings — divider, spoken intro, drawer.** The boundary between parts is a labeled divider in the prose — `<div class="section-divider-labeled" id="<part id>" role="separator">…</div>` placed before the part's first `<section>`, carrying the part name as text. It renders as a hairline rule with centered small-caps text — much thinner than a default `<hr>`, and unlike `<hr>` it can hold inline text (the plain `<hr class="section-divider" />` stays for unlabeled breaks; both render at the same hairline weight, since UA defaults are too thick for the article rhythm). That divider is the part's **prose face**. Its **audio face** is the section-intro chapter, whose first mark targets the divider's `id` — so the part exists on all three surfaces at once: read on the page (the divider), heard in the audio (the spoken transition), and listed in the script drawer (the intro's segment). The part name is authored once, as the section-intro's title; the divider shows it verbatim.

**The spoken text is a paraphrase of the displayed name, by design.** The divider shows the crisp slide-title label (*"Where do offers live?"*); the intro reads it the way a presenter would (*"So — where do these offers actually live?"*). That displayed-vs-spoken split is the same relationship every `<mark>` has with its element (narration paraphrases; it is never a read-aloud) and the same pairing [EPUB Media Overlays](#relation-to-other-specifications) use, so it's on-model. The payoff in the chapter strip: the section-intro is the part's clickable **group label** (clicking it plays the transition); the member chapters — *including the part's first content section* — are the segments beside it, each keeping its own `<h2>`/`<h3>` as its title. No heading is conscripted into doubling as the part name (a part named "Where do offers live?" needn't flatten into, or shadow, a heading like "P2P Offer Files"), and the first header shows in the strip like any other member.

**A labeled divider carries a "play from here" speaker.** Because a labeled divider *is* a part boundary in the prose, it doubles as a narration entry point: `narrator.ts` progressively enhances each `.section-divider-labeled` with a small speaker button (`.divider-speaker`) that seeks the audio to the start of the narration covering content below the divider, then plays. The button is injected only when narration is available (the player never boots on a [`data-narration="none"`](#opting-out-of-narration) post), and a divider with nothing narrated below it gets no button. **"First below" is defined by the highlighted element's DOM position, not by chapter membership** — and that distinction matters because narration is non-linear (a segment can reference a section earlier or later than where it sits). Concretely, the button seeks to the *earliest mark whose element is the divider itself or follows it in document order* (`firstMarkAfter`, a single forward pass over the time-ordered `marks`). Because a part's section-intro anchors its first mark **on** the divider, that intro is what's found — so the speaker plays the part from its spoken transition. (A silent divider with no intro falls through to the first mark below it — hence "at or after," not strictly after.) The target is recomputed on click (not cached at setup) so it stays correct if the article DOM changes after enhancement (e.g. a figure enhancing asynchronously), and the seek uses the same `+10ms` nudge as a chapter jump so a mark sitting exactly on a chapter boundary still lands inside the new chapter for the plugin's range check.

**Capped at two levels.** A good single-row strip UX doesn't survive deeper nesting, and the prose only ever narrates `<h2>`/`<h3>`. The cap is enforced at build time (`normalizeChapterParents` in `generate.ts`): a `data-chapter-parent` that points at a chapter which *itself* has a parent is flattened to its grandparent, and one that points at a missing or later-in-document chapter degrades to a flat top-level chapter — both with a **build-time warn, never a hard fail** (same "don't error a batch generate over one bad post" philosophy as the [opt-out path](#opting-out-of-narration)).

**Manifest + player.** The manifest stays a **flat, leaves-only** array; each level-2 chapter just carries an optional `parentId` annotation (absent on flat posts → byte-identical manifest; times stay absolute ms in the master track). A part's time range is *derived* (min/max over self + children), never stored. Shikwasa is fed the leaf chapters untouched, so every existing seek/boundary quirk still applies; the two-level grouping lives only in *our* `renderChapters`, which renders **one pill per top-level chapter** in the single horizontally-scrolling row — no second row, no scroll-snap, no height change. A part renders as a **segmented pill** — `[ N  «Part» Member A / Member B ]` — where `«Part»` is the part's **section-intro chapter title** as an emphasized group label and the member chapters are inert text spans divided by literal `/` characters, slightly de-emphasized (lower weight, lower opacity) so the group label anchors the part. The group label is the one chapter that *isn't* a segment: clicking it plays the section-intro — the spoken transition, which highlights the divider — i.e. the first thing in the part. Its active-state highlight rides the group label, so the strip lights up while the intro plays. A leaf top-level chapter renders as a numbered flat pill (the plain single-level shape, byte-identical on a flat post). One **collapse case**: a part with *exactly one* member renders as a flat pill carrying the section-intro's title — the member is still reachable by scrubbing and its active highlight routes to that pill, but the slash-segmented form is reserved for parts with multiple members.

**Click routing on a segmented pill is strict containment, not nearest-by-X.** The pill itself is a single `<button>` (one Tab stop, one MediaSession-friendly thing), but segments are inert spans; a click jumps only when it lands on a segment (`event.target.closest('.ch-seg')`) or the group label (`.ch-group`, which routes to the opener), so the slash and the padding around the number badge are *predictable no-ops*. Strict containment is the deliberate choice over routing a dead-zone click to the nearest segment by `clientX`: nearest-by-distance would let a click on the highlighted segment's tail land closer to its neighbor's center and silently jump away. It costs a tiny strip of "anywhere on the pill is clickable" surface in exchange for never moving when you didn't mean to — the right trade because the segment hit boxes are already large and the slash is narrow. Keyboard activation has no pointer target and jumps to the part's parent (a sensible default for the one-Tab-stop pill). Segment spans are `display: inline-block` so the clicked hit box matches the painted hover area; without that, `display: inline` lets click hit-testing leak past the painted background and the click can fire on a *different* span than the one your cursor was visibly highlighting.

**Navigation granularities are deliberately split** (and should not be "corrected" into uniformity):
- **Keyboard `1-9` → top-level chapters (parts).** The pill number labels the level-1 index, so the number you see is the key you press. Coarse "go to section N". (>9 parts still truncates at 9 — coarser but strictly more complete than the old flat-leaf indexing.)
- **MediaSession `previoustrack`/`nexttrack` → leaf chapters.** A single hardware/lock-screen skip is a fine "advance one spoken section", matching what a podcast listener expects.

The page-global key handler (`Space` play/pause, `←`/`→` seek ±10s, `1-9` chapter jump) dispatches off a single declarative table, **`KEY_BINDINGS` in `client/narratorDom.ts`** (a DOM-free module, so it's importable from a build step). That table is also what the [help page](#reader-facing-help--feature-discovery-generatehelp-pagets) renders its shortcut list from — one source of truth, so a binding added to the table updates both the behavior and its documentation, and neither can drift from the other.

**Drawer face.** The script drawer renders the same hierarchy in its own coordinate system. A top-level chapter heading renders as a labeled hairline divider (mirroring the article's `.section-divider-labeled`: centered label flanked by `::before`/`::after` hairlines); a sub-chapter heading drops the leading hairline and renders as a left-aligned title with a single trailing line — visibly distinct from "new chapter" *out of sticky context too*, so a sub-chapter never reads as a part boundary even when scrolled past. A muted vertical rule runs down each chapter's segment list and continues through sub-chapter headings via their own left border, grouping segments by chapter independent of the headings. Both heading levels are **sticky-scrolled**: the parent pins to the drawer body's top, the sub-chapter pins just below it via a shared `--sticky-chapter-h` offset, so the active chapter/sub-chapter stays on screen (the "sticky scroll" pattern modern editors use to keep nested function context visible). One DOM constraint this requires: **sub-chapter `<section>`s nest inside their parent's `<section>`**, not as flat siblings — `position: sticky` is scoped to the containing block, so a flat layout would unstick the parent heading the moment its own segments ended, dropping chapter context the instant a reader entered a sub-chapter. (This is the *only* place the rendered drawer DOM departs from the flat manifest; the manifest stays leaves-only.)

**Podcast feed.** The Podlove/Podcasting-2.0 chapters sidecar is flat with no nesting primitive, so the hierarchy degrades to a flat list with **part-prefixed child titles** (`"<part> — <chapter>"`); parts (and flat chapters) keep their bare title. The in-page player is the rich surface that shows true nesting; the feed is the lowest-common-denominator one — accepted graceful degradation, not flattened to match.

### Opting out of narration

Not every post wants a spoken track. A post opts out by setting **`data-narration="none"`** on its `<article>`, and the flag is honored in two places: `generate.ts` skips it cleanly (exit 0, "narration disabled" — so a batch generate over all posts doesn't choke on a post with zero `text/narration` chapters), and the client player's `boot()` hides the dock without fetching a manifest — so there's no empty player box and no "run `bun run generate`" message. That message is deliberately *kept* for the distinct case of a post that **does** want narration but hasn't been built yet (the manifest 404s); the opt-out gives us a real third state instead of conflating "intentionally silent" with "not generated yet".

**Why an explicit attribute, not "infer from the absence of `text/narration` blocks."** The narration blocks are [stripped from the served HTML](#build-time-html-strip-generatestrip-served-htmlts) (they're TTS-only and several KB), so at runtime — in production — the client genuinely *cannot* see whether a post has narration content. The opt-out signal therefore has to live in something that survives the strip: an attribute on the `<article>`. And because the same intent is needed by both the offline build (skip) and the runtime player (don't mount), it's read in both places off that one attribute.

**Keep `data-narration-src` even when opting out.** The comments layer uses `[data-narration-src]` as its [article-root selector](#comments-clientcommentsts), so removing it would silently disable commenting on the post. The opt-out attribute suppresses only the *player*; `data-narration-src` stays (now pointing at a manifest that is intentionally never built) so the post remains fully commentable. (A cleaner decoupling — a dedicated comments-root attribute — is possible but not yet worth it for three posts.)

**Consequence for CSS — a shared `client/base.css`.** A no-narration post drops the `client/narrator.css` `<link>` along with the player markup. But `narrator.css` had been doing triple duty: the player UI, the default-post typography, *and* the **page-global** layer (`* { box-sizing: border-box }`, the `--page-*` design tokens, the `html`/`body` theme). Dropping the file silently reverted the whole page to `content-box` (overflowing inputs, inflated widths) and lost the page background. So that global layer was extracted into **`client/base.css`**, linked *first* by **every** post regardless of narration; `narrator.css` is left with only the player UI and the generic-`article` typography that narration posts rely on. The rule this establishes: anything page-global lives in `base.css`, never in a feature stylesheet a post might legitimately not load.

### Generation pipeline

The pipeline for generating audio needs to take into account that different models have different requirements:
1. The input format (some models support [SSML], some [PLS], some custom systems and some have no pronunciation hint support at all)
2. The performance (some models are fast which are great for debugging, some are slow but higher quality. Additionally, some like `say` only work on Mac)
3. The output audio format produced (ex: `mp3`, `wav`)

Therefore, we split these concerns into two steps:
1. `TtsProvider`: synthesizes narrations into audio files (handles different models needing different inputs)
2. `AudioPipeline`: takes audio files, and does any processing on them (ex: concat, change encoding) to be ready to serve (note: handles different models having different output formats, yet wanting one consistent audio format to serve to users). It supports
- `silence`: insert silence as needed. A short `--segment-gap` (default 200ms) of silence is spliced between adjacent segments and between chapters at concat time, since TTS engines leave little/no pause of their own (especially under continuation prompting) and back-to-back sentences feel rushed. Mark/chapter times are computed against this gapped layout so highlighting stays in sync; `--segment-gap=0` disables it.
- `duration`: gets the duration of a working-format buffer, read straight from the WAV data-chunk size in the header. No subprocess: sample-accurate by construction.
- `concat`: combine audio buffers (note: ideally lossless to avoid re-encoding causing audio loss and no disk round-trip, but this is format-specific)
- `leadingSilenceMs`: how long the leading silence is in the audio (some audio-generating tools start with a lot of leading silence, making concatenation sound awkward). This is the raw `silencedetect` measurement — *where the engine thinks speech begins*.
- `leadingSilenceTrimMs`: how much leading silence it's actually *safe* to trim — and the value callers feed to `trim`, **not** the raw `leadingSilenceMs`. It's `max(0, leadingSilenceMs − guard)` for a guard (1s today, `LEADING_TRIM_GUARD_MS`). The guard exists because `silencedetect` is an *amplitude* detector: a quiet word-initial fricative (the "s" of "Swap", the "sh" of "shah") sits below the threshold, so the detected onset lands at the louder vowel *after* it. Trimming exactly to that onset clips the fricative — the bug that made every term starting with "S" lose its start. So we trim to a cushion *before* the onset instead, and trim nothing when the onset is already within the guard. The cost is up to `guard` ms of retained leading silence, accepted because a brief lead-in is harmless next to swallowing the first phoneme; the guard only needs to exceed the longest plausible soft onset (~250ms), so 1s is deliberately generous (tune it down if a leading beat on chapter seeks becomes noticeable). Both `generate.ts` (per chapter) and the [sound test](#sound-test-dev-only-pronunciation-audition) (per word) trim through this one guarded path, so neither special-cases the fix.
- `trim`: trim the start of an audio file (the duration comes from `leadingSilenceTrimMs`).
- `encode`: encode to the final audio format served to the user

Every operation except `concat` and `duration` is implemented as a shell-out to `ffmpeg` / `ffprobe`. `concat` stays as an in-memory byte-splice because ffmpeg's concat demuxer can't take multiple stdin pipes. `duration` stays in-memory because ffmpeg's `-stats time=HH:MM:SS.cc` is the timestamp of the last fully-encoded packet to the null muxer, **not** the total input duration — it lags by up to ~46ms (one PCM frame) on every buffer. That under-report is invisible per-segment but compounds when manifest chapter times are accumulated from per-segment durations: ~5s of drift over a 30-minute post, enough that a chapter-mark seek lands inside the previous chapter's audio. Reading the WAV header's data-chunk size sidesteps both the precision loss and the under-report (and is the same shape as why `concat` is a byte-splice: ffmpeg is the wrong tool for these PCM operations). `ffprobe`'s `format=duration` would also work for seekable files but returns N/A on a piped WAV because it refuses to trust the header without a seek — so the header read is the universal answer.

The final audio format we serve to users is `mp3` (64 kbps mono, benefiting from its small size, and the fact that audio quality loss is not meaningful on spoken audio).  We try to avoid re-encoding many times to avoid accumulated quality loss — concat operates on the working PCM and the final mp3 encode happens once at the end. The encoded track is written under a **content-hashed filename** (`full.<hash>.mp3`) so its URL changes whenever the bytes change; see [Serving generated audio](#serving-generated-audio-content-hashed-filenames--dev-range-support).

**The mp3 encode writes its output to a seekable temp file, not `pipe:1`** — the one ffmpeg op besides the WAV ops above that *must* round-trip through disk, for the same non-seekable-pipe reason. libmp3lame reserves a **Xing/Info** header in the first frame (it carries the total frame count, i.e. the exact duration) and backfills it once encoding finishes, which needs a seek back to the start of the output. On a pipe ffmpeg silently drops it, producing an mp3 with no duration tag — the browser then can't know the length until the whole file buffers, so `HTMLMediaElement.duration` is `Infinity`, and Shikwasa reads that as an unbounded stream and shows **"LIVE"** instead of the time remaining (its own getter prefers the live `<audio>` element's duration over the value we pass it, so handing Shikwasa the manifest duration isn't enough — the file itself has to carry the header). Writing to a real file lets the header land. A unit test asserts the header's presence so this can't silently regress.

### Providers: `say` for iteration, MOSS for production

Three providers are registered today (`--tts=NAME`, default `say`):

- **`say`** (macOS built-in) — fast and free, the iteration default. No pronunciation-hint support (it warns and ignores any PLS lexicon).
- **`espeak-ng`** (Linux / cross-platform) — the cheap, fast iteration engine where `say` isn't available; it fills the exact edit-loop role `say` plays on macOS, and likewise warns-and-ignores PLS. Unlike `say` it is **not preinstalled**, so the build's preflight prints the install command (Debian/Ubuntu: `sudo apt install espeak-ng`) when the binary is missing. Its native output is already the working format (mono 16-bit PCM @ 22050 Hz), so the common path is a lossless pass-through (only a non-22050 working rate triggers an ffmpeg resample). `--rate` maps onto its `-s` words/min knob.
- **`moss`** — production voice via the local [OpenMOSS MOSS-TTS](https://github.com/OpenMoss/MOSS-TTS) model, **voice-cloned** from a reference clip. Higher quality, much slower, and heavyweight to load — so it's reserved for production renders while `say`/`espeak-ng` carry the edit loop.

The three are deliberately interchangeable behind `TtsProvider`: the same post, cache, pipeline, and manifest code runs under either, so switching is just the flag. Because the cache key includes the provider name and voice, a `say` draft and a MOSS production render coexist in the cache rather than evicting each other — re-running with `--tts=say` after a MOSS render is still instant.

**MOSS integration shape.** MOSS is a separate Python project with its own (multi-GB) model and venv, living outside this repo. Three constraints drove the design:

- **Model load dominates.** Loading the ~1.7B transformer costs seconds; doing it per segment would swamp every build. So `moss` runs a **long-lived worker** (`generate/moss_worker.py`): the TS provider spawns it once, the model loads once, and thereafter each segment is one request over a line-delimited JSON protocol on stdin/stdout (the worker writes a WAV to a caller-chosen temp path; stdout carries only protocol JSON, all library/progress chatter goes to stderr). The worker is spawned **lazily on the first cache miss**, so a fully-cached rebuild — or any `--mock` run — never even starts Python. The flip side of a long-lived worker: it must be **explicitly torn down** when the run ends. `generate` calls `provider.close()` (which ends the worker's stdin and kills it) as its last step — without it the worker's stdout reader keeps Bun's event loop alive, so the process hangs *after* writing all its output instead of exiting (this also left the [regenerate endpoint's](#per-segment-regeneration-dev-author-only) job stuck `running` forever). `close()` is an optional part of the `TtsProvider` contract; stateless providers like `say` omit it.
- **Voice cloning is per-call, not a one-time step.** MOSS's API re-supplies the reference clip at generation time (`build_user_message(text=…, reference=[clip])`); there's no separate "train a speaker embedding once." The expensive thing we amortize by keeping the worker alive is the *model load*, not the cloning. The reference clip is passed as `--voice=<path.wav>`; for the cache key the provider hashes the clip's *contents* (`cacheVoiceId`) rather than its path, so two different clips cache separately while the same clip shares cache regardless of where it sits on disk (see [Audio caching](#audio-caching)). MOSS has no words/min rate (it clones cadence from the clip), so `--rate` is warned-and-ignored. PLS, however, MOSS *does* honor — not via a native API (it has none) but by [grapheme→pronunciation substitution](#honoring-pls-without-a-pls-aware-engine-substitution) on the segment text before synthesis.
- **Sample-rate matching is the provider's problem.** MOSS emits mono 16-bit PCM at a fixed 24 kHz; the working rate is configurable (22.05 kHz today). This isn't a quirk of MOSS — it's inherent to PCM: a WAV stores its sample rate *once, in the header*, and `concat` is a byte-splice under a single fresh header, so it physically can't carry two rates (the mismatched segment would play at the wrong speed/pitch). Every segment must therefore already be at the working rate. So `moss` resamples its output to the working rate with ffmpeg — but **only when the rates actually differ**: when MOSS's native rate equals the working rate, its WAV passes through untouched (lossless), and concat splices it directly. Setting the working rate to 24 kHz makes the whole production path resample-free; the resample exists purely to bridge the 24 kHz ↔ 22.05 kHz gap, not because concat needs it. (The resample round-trips through a temp file, not a pipe, because the WAV muxer can't fix up RIFF/data-chunk sizes on a non-seekable pipe and `concatWavs` reads those sizes.)
- **Trailing garbage-audio trim.** MOSS (like most autoregressive TTS) appends a brief burst of noise *after* the last word — preceded by a short silence gap — which reads as a click at every concat seam. The provider trims it per segment (`trailingArtifactTrimMs` + `truncateToMs` in `audio-pipeline.ts`): detect the last point where audio resumes after a silence, and if only a short tail (≤200ms) remains to EOF, cut there — dropping the blip while keeping the silence gap as a natural inter-sentence pause. It's a structural no-op for engines without the artifact (e.g. `say`, which ends in speech or plain silence). Note this is a *level/cleanup* fix, distinct from the *prosody* continuity below.

#### Cross-segment continuity (`SegmentContext`)

Synthesizing one segment per `<mark>` in isolation makes expressive engines restart each sentence at "top-of-paragraph" energy, so the seams are audible mid-chapter. We synthesize per-segment on purpose — it's what the [segment cache](#audio-caching) and per-mark highlight timing depend on. The obvious alternative, synthesizing a whole paragraph or chapter in one call, *would* flow naturally (it's what these models are tuned for) but was rejected: one blob has no internal `<mark>` alignment, so per-mark times would need forced alignment to recover, and the cache would collapse from per-sentence to per-paragraph. So we keep per-segment synthesis and instead give the engine **context about what came before**.

That context is a **provider-agnostic** addition to the `TtsProvider` contract: `synthesize(text, context?)` takes a `SegmentContext` (`{ continuesPrevious, previousText?, previousAudio? }`), and each provider uses whatever subset it supports (`say` ignores it — a flat synth voice has no seam to smooth). Continuity isn't a MOSS feature; any expressive engine has some version of it (ElevenLabs request-stitching, style/instruction strings, prior-audio conditioning), which is why it lives in the generic contract. `continuesPrevious` is derived from the narration's **paragraph structure** in `generate/narration.ts` — a blank line before a `<mark>` is a fresh start, soft single-newline wrapping is not — so a paragraph break is the author's lever to reset delivery. (An explicit per-mark flag was considered as an escape hatch; not needed yet.)

**`SegmentContext` never enters the TTS cache key** — it's best-effort conditioning, not identity. A segment is conditioned on its neighbor as it exists at synth time but is *not* re-synthesized when that neighbor later drifts, so "edit one sentence → re-synthesize one sentence" still holds. Production voice gen only runs on settled posts where edits are line-level tweaks, so a segment conditioned on a slightly-stale predecessor is "close enough." It's the same staleness tradeoff the cache already makes by [excluding `common-terms.pls`](#audio-caching); `rm -rf generated/.tts-cache` re-conditions everything cleanly.

**What shipped, and the listening lessons** — the strategy is selected by `MOSS_TTS_CONTINUATION` (`instruction` default | `acoustic` | `off`):

- **`instruction` (default, and the winner).** A continuing segment gets a free-text delivery hint (`build_user_message(..., instruction=...)`); fresh starts get none. Single-shot generation, so no audio feedback, trivially cache-safe, and the most portable layer (most engines take *some* style string). The hard-won lesson here: a blunt, *natural* hint beat an elaborate one. The production hint is essentially "talk like you're continuing from an existing paragraph"; an earlier wordier "even, conversational tone" backfired — the model rendered it as a too-soft, trailing-in first word. Combined with a short [`--segment-gap`](#generation-pipeline) of inter-segment silence, this path produces narration effectively indistinguishable from a human recording.
- **`acoustic` (opt-in; currently a net loss on the local model).** Feeds the previous segment's actual audio as multi-turn context (`[user(prevText), assistant(prevAudio), user(thisText)]`, generation mode) so the model continues from real measured energy instead of guessing. In theory the strongest fix; in practice on the **1.7B** model it made things markedly *worse* — tone drift, broken clips, duplicated/altered words, and **quality compounding downhill so the last segments of a chapter were the worst**. That downhill signature is the tell: each continuation conditions on the *previous generated* segment (already model output, resampled 24→22.05 kHz and trim-truncated), so re-tokenizing our own degraded audio accumulates artifacts. Two root causes — a design hazard (feeding back lossily-reprocessed model output is an accumulating feedback loop *regardless* of model) and model size (MOSS reserves multi-turn coherence for its larger/Realtime models). Kept behind the flag to retry on an 8B-class model; if so, it should feed the *pre-resample, pre-trim* native audio (or keep the raw `audio_codes` hot in the worker) to break the compounding.
- **`off`.** No continuity; every segment a fresh utterance (the pre-feature baseline).

The MOSS repo is located via the **`MOSS_TTS_DIR`** env var (no portable default path; `MOSS_TTS_PYTHON` overrides the interpreter, `MOSS_TTS_DEVICE` forces the torch device). The factory validates the interpreter and the reference clip up front, so a misconfiguration fails immediately rather than 30 segments into a run. The voice clip is resolved per post (not from any env var) — see [Per-author voice resolution](#per-author-voice-resolution) — so the **`generate:prod`** one-liner is just `bun run generate:prod <post.html>`: `generate.ts` parses the post's `<meta name="author-email">` and auto-loads `authors/<email>.wav`. `MOSS_TTS_DIR` and `MOSS_TTS_PYTHON` stay env vars because they're per-machine paths (your MOSS checkout); the voice clip is per-blog and committed, so it doesn't.

#### Per-author voice resolution

A blog can have multiple authors (`<meta name="author-email">` is per-post) — and each author's clone reference is a different clip. Re-rolling a post in someone else's voice is a *correctness* bug, not a cosmetic one: voice is part of the TTS cache key (via `cacheVoiceId`), but the *current* `full.<hash>.<ext>` would still be overwritten with the wrong-voice audio for readers. So everything that touches a post — the offline `generate.ts`, the per-segment `/dev/regenerate`, the sound-test in-posts sweep — resolves the clip **per post**, not blog-globally, and passes it as an explicit `--voice=` to the spawn.

The convention is **`<contentRoot>/authors/<author-email>.wav`** (e.g. `authors/alice@example.com.wav`) — the **same per-author folder** that holds the author's [profile and avatar](#author-profiles-and-bylines-sharedauthorprofilets-clientbylinets), keyed by the same email. Discoverable by file listing, no config artifact to keep in sync, one author adding their voice is one file commit. Mirrors how `postMeta` discovers authors by scanning `posts/*.html`. If a post's per-author file is missing, the resolver returns a structured failure and the caller **refuses** — naming the gap (which post, which file is missing) — rather than silently picking the wrong voice. Lives in `shared/voiceResolution.ts` so every per-post action shares one resolution. (The clip is a build-only input — only `generate.ts` and the dev tools read it — so co-locating it with the served avatar doesn't expose it.)

**No env-var fallback.** A single global default is the *exact* hazard the per-post lookup exists to prevent: the moment a second author shows up, "the default" becomes "the wrong voice" for half the posts, silently. Single-author blogs aren't disadvantaged — they just put their one clip at `authors/<their-email>.wav`, which is one file in the repo rather than an env var on every developer machine. `generate:prod` becomes correspondingly simple: it parses the post's author-email and auto-resolves, so the one-liner stays a one-liner and works correctly on a multi-author blog.

The matching rules are deliberately small: emails are lowercased and used verbatim as the filename (`alice@example.com.wav`), but anything that would let an authored email *escape* the dir — `/`, `\`, NUL, or a leading dot — is dropped before the lookup. Cache identity is unaffected by this convention: the MOSS provider still content-hashes the chosen clip into `cacheVoiceId`, so two authors' caches stay distinct wherever their clips live on disk.

**Deliberate non-requirement: one voice per post.** The unit of voice resolution is the **post**, not anything finer-grained. We do *not* plan to support multi-voice posts (e.g. a guest-author section read in a different voice from the rest of the post), and the whole engine bakes this in: per-segment `SegmentContext` carries no voice, `--force-mark` re-rolls inside one provider, the in-posts sweep spawns one `generate.ts` per post (one voice for the whole spawn), and the cache key has one `cacheVoiceId` per segment. A post that genuinely needs a different voice for some content should be its own post (with its own `author-email`). The audition surface (the sound-test page) keeps a *single* voice per audition clip for the same reason — the session user's own voice, see the audition section below.

**One environment gotcha worth recording.** MOSS decodes the reference clip through `torchcodec`, which `dlopen`s the system FFmpeg shared libraries at runtime — and a venv python's default loader path doesn't include them, so torchcodec fails to load even when a perfectly compatible FFmpeg is installed (the error misleadingly lists *every* FFmpeg version as unloadable, because the real failure is "couldn't find `libavcodec` to try against any of them"). The provider works around this by adding FFmpeg's lib dir to the worker subprocess's loader path (`DYLD_FALLBACK_LIBRARY_PATH` on macOS, `LD_LIBRARY_PATH` on Linux), derived from the `ffmpeg` CLI's location (`<prefix>/bin/ffmpeg` → `<prefix>/lib`) and overridable via `MOSS_TTS_FFMPEG_LIB`. This one fix covers torchcodec everywhere it's used — both decoding the reference clip and the `torchaudio.save` of the output — so the worker writes its WAV with `torchaudio.save` exactly like the upstream MOSS scripts.

#### Memory requirements and device placement

A production render with `--tts=moss --align=qwen3` loads **two** torch models, and `generate.ts` interleaves synthesis and alignment in a single per-segment loop ([Word-level timing](#word-level-timing-drawer-karaoke--subtitle-sidecar)). Their footprint is larger than the headline "~1.7B transformer" suggests, and a naïve "everything on the GPU" placement does not fit an 11 GB card. Two device-placement decisions — both **measured, not assumed** — make the production path fit and run fast on a discrete GPU while staying audio-neutral. Measured on an RTX 2080 Ti (11 GB) under WSL2; bf16 LM:

- **MOSS LM ≈ 6 GB** (bf16). The autoregressive generation loop — the expensive part — touches only this.
- **MOSS audio codec ≈ 7.2 GB** (float32; `processor.audio_tokenizer`). This is the *bigger* line item, but it's used only to encode the reference clip and decode the output codes, **not** inside the generation loop.
- **Qwen3-ForcedAligner-0.6B ≈ 1.85 GB** + per-segment KV.

Put all three on one GPU and you get ≈ 15 GB on an 11 GB card; even MOSS alone (≈ 13.4 GB) over-subscribes it. **On a unified-memory machine (Apple Silicon / MPS) that's a non-issue** — no separate VRAM ceiling, so ~15 GB is fine with enough total RAM (≈24 GB+), and everything stays on-device. **On a discrete GPU it's fatal:** native CUDA OOMs outright; WSL2 instead pages the overflow to host RAM over PCIe ("sysmem fallback"), which doesn't hard-fail but is the trap — under sustained generation it **thrashes catastrophically**. Measured on the codec's 151-word stress segment, everything-on-GPU ran at **4.55 s/token with 0 GB free** (peak 13.5 GB), i.e. ~38 min for a single segment before it wedged. (The failure is also **misleadingly located** — CUDA reports the over-allocation asynchronously, so it surfaces as `device not ready`/`out of memory` at an unrelated call like model load; `CUDA_LAUNCH_BLOCKING=1` pins it to the real site.)

**Fix 1 — the audio codec runs on CPU when the LM is on CUDA** (`moss_worker.py`, override `MOSS_TTS_CODEC_DEVICE`). This leaves the LM alone on the GPU — measured **6.3 GB peak, ~4.4 GB free, no spill** — and cuts per-token time **~10×, from 4.55 s to 0.43 s**, turning a wedging 38-min segment into ~3–4 min. The codec only encodes the reference and decodes the output codes (~0.6 s/segment on CPU), so it never touches the hot loop. Crucially it is **audio-neutral**, which we verified rather than hoped: decoding the *identical* generated tokens on CPU vs GPU differs only at float epsilon (RMS diff **−118 dBFS** below signal, Pearson correlation **1.0**), so CPU-decoded segments mix with already-cached GPU-decoded ones with **no re-render**. (bf16-ing the codec would also halve its footprint, but that *does* perturb the audio and would force a whole-post re-render — strictly worse than moving the device, so we don't.) On MPS there's no ceiling to spill against, so the codec stays with the LM.

**Fix 2 — the aligner defaults to CPU** ([Acquisition](#word-level-timing-drawer-karaoke--subtitle-sidecar)), keeping its 1.85 GB off the GPU entirely. Because its long-lived worker amortizes the model load, warm per-segment compute is ~234 ms, so CPU costs nothing we'd notice; and forced alignment is numerically a timing readout, so this too leaves the audio untouched. `MOSS_TTS_DEVICE` / `QWEN3_ALIGNER_DEVICE` can still split the models across separate GPUs or pin either back to `cuda:0`/`mps` on a box with VRAM to spare.

Net: on the 11 GB card the GPU holds only the MOSS LM (~6–8 GB with KV growth), both codecs/aligner sit on CPU, generation runs spill-free at ~0.43 s/token, and the audio is identical to the all-on-GPU output it replaces.

**An allocator trap we hit and backed out of.** The MOSS worker runs many `generate()` calls of varying KV-cache size, which can fragment the CUDA free pool into a slow-motion OOM on the *N*th, larger segment — the textbook fix is `PYTORCH_ALLOC_CONF=expandable_segments:True`. **Do not use it here.** `expandable_segments` allocates via CUDA's virtual-memory API (`cuMemCreate`/`cuMemMap`), which is **incompatible with WSL2's system-memory fallback** — the very spill mechanism MOSS relies on to fit 13.4 GB onto an 11 GB card. With it on, MOSS fails at model *load* with a misleading `CUDA driver error: device not ready`; with the default allocator it loads and spills normally. This was confirmed empirically: same ~10 GB free, the env var the *only* difference between load-fail and load-ok. So the worker leaves the allocator at its default and instead calls `torch.cuda.empty_cache()` between segments to return freed blocks each round — and the fragmentation it guards against is far less likely now that the aligner runs on CPU and leaves MOSS the whole card. (A non-WSL box with VRAM to spare can still opt into `expandable_segments` via the environment; we just don't force it.)

## Audio caching

Audio synthesis is slow (seconds to minutes per segment for LLM TTS models) and often paid per character. A typical authoring loop — tweak one sentence, regenerate — would otherwise re-synthesize the whole post on every iteration.

The cache operates per **segment** — the text between two `<mark>` boundaries — not per chapter.

**Cache key** is a `sha256` over every input that influences the synthesized bytes:
- TTS provider name (`say`, `piper`, …)
- Voice — but a **machine-independent** identifier, not the raw `--voice` value. `say`'s voice is a stable name ("Samantha"); MOSS's is a path to a reference clip *outside the repo*, so the provider exposes a `cacheVoiceId` that is a **content hash of the clip** instead. Keying on the absolute path would miss on every other machine (and re-cache the same clip if it moved); the content hash means the same clip shares cache wherever it lives, and genuinely different clips still cache apart.
- Rate
- Output audio format (sample rate, channels, bits/sample)
- Local PLS lexicon XML (the post's inline `<script type="application/pls+xml">` blocks merged together, or `null` if none). The merged XML labels each source by its path **relative to the repo root**, never an absolute/invocation path — so the key is identical whether `generate` is run with a relative path (CLI) or an absolute one (the regenerate endpoint), from any cwd, on any machine. Embedding the full path here once silently split the cache between those callers (and would split it across machines sharing a cache), making every button click a full cold re-render.
- Segment text

If any of these change, the corresponding entries miss and are re-synthesized. Note this means changing one inline `<lexeme>` invalidates every segment in *that post*, which is coarse but correct (we can't cheaply tell which segments used which grapheme) and the inline lexicon is small.

**The cross-post shared `common-terms.pls` is deliberately excluded from the cache key**, even though the merged lexicon (common + inline) is still what the TTS provider synthesizes against. Including it would mean editing one entry in `common-terms.pls` invalidates every cached segment across every post (which is unreasonably expensive). The tradeoff: after editing `common-terms.pls`, you need to wipe any relevant cache manually.

**Cache value** is the raw provider output bytes (working-format WAV), captured *before* trim / concat / encode. Those downstream ops are cheap and deterministic, so caching them would just bloat the cache without saving time.

**Cache location** is `generated/.tts-cache/<text-hash>/<full-hash>.wav`, shared across all posts. The layout is two-layer:
- `<text-hash>` is `sha256(segment text)` — one *bucket* per distinct sentence, independent of how it's synthesized.
- `<full-hash>` is the sha256 from the bullet list above — one file per distinct synthesized variant of that sentence (voice, rate, lexicon, …).

Cache lookups always use the full hash, so only an exact identity match is a hit. The text-hash layer exists purely for GC.

**Cache garbage collection.** Each generate run writes the set of *current* text-hashes for the post to `generated/<slug>/cache-keys.json` — **overwritten** every run, not unioned. `bun run clean <slug>` then deletes that post's directory AND sweeps the shared cache, removing any text-hash bucket no longer referenced by some other post's `cache-keys.json`.

The two-layer split lets GC distinguish the two cases that matter:
- **Sentence removed from the post**: its text-hash drops out of the index. On next clean, the bucket — and *every* voice/rate/lexicon variant inside it — is reaped.
- **Voice or rate changed (sentence unchanged)**: adds new files without deleting the old ones for different models/parameters.

To force re-synthesis without losing post artifacts, wipe `generated/.tts-cache/` by hand.

`--mock` runs bypass the cache entirely: the silent-audio shortcut is already trivially fast, and caching placeholder silence wastes disk.

**`--chapters=ID[,ID,...]` truncates the build to a subset of chapters** (matched by `data-chapter-id`, in document order). Sibling knob to [`--force-mark`](#per-segment-regeneration-dev-author-only) but at coarser granularity: where `--force-mark` re-rolls specific *segments* inside a full post build, `--chapters` skips synthesis entirely for everything outside the named chapters. The audio, manifest, and any [`captions.vtt`](#word-level-timing-drawer-karaoke--subtitle-sidecar) contain only the kept chapters — re-run without the flag to produce the full set. Built for the case where the first end-to-end run with `--tts=moss --align=qwen3` on an unbuilt long post would take hours (every segment loads MOSS + the aligner in fresh subprocesses, before any per-segment worker optimization lands): try one or two chapters first to confirm the pipeline works, *then* commit to the full render. A sub-chapter kept while its parent is filtered out is auto-reparented to top level so the truncated build stays well-formed; an unmatched ID warns but doesn't fail.

### Per-segment regeneration (dev, author-only)

MOSS is probabilistic (high `audio_temperature`), so a term can synthesize correctly nine times and mangle the tenth — a clean take never proves the next one is safe. The author therefore needs to **re-roll a single segment until it sounds right**, without re-rendering the post. That's a button on each segment in the [spoken-script drawer](#player--sync-clientnarratorts).

The mechanism reuses the cache rather than inventing an isolated render path — because there *can't* cleanly be one: segment durations cascade (change one segment's length and every later mark time in its chapter, and every later chapter's start, shift, and the `full.<hash>.mp3` track must be re-concatenated — and its hash, hence its URL, changes). So "regenerate this segment" is really *"force-resynthesize one segment, then rebuild the whole post"* — which is cheap, because every *other* segment is an instant cache hit and only the chosen one calls MOSS:

- **`generate --force-mark=<name>`** maps the mark to its segment text and passes a `forceResynthesize` predicate to the cache wrapper (`tts-cache.ts`). A matching segment bypasses the cache *hit*, re-synthesizes a fresh take, and **overwrites** the stored bytes — so the accepted re-roll becomes the cached one. Everything else hits. The manifest + `full.<hash>.mp3` are rebuilt normally (the new track gets a new hash; the prior one is swept).
- **`POST /dev/regenerate?post=<path>&mark=<name>`** (`server/regenerate.dev.ts`) shells out to that command with `--tts=moss`. It's **dev-only** (imported only by `index.ts`, absent from `worker.ts`) because it runs the build pipeline and loads the multi-GB model — a trusted-localhost operation, exactly what the [dumb-edge-server rule](#repository-layout) exempts — and **author-only** (the same server-authoritative `isPostAuthor` check the [version endpoint](#document-version-clientpostversionts-serverpostversionsroutets) uses). The endpoint resolves the voice clip [per the post's author](#per-author-voice-resolution) and passes it as an explicit `--voice=` to the spawn, so a multi-author blog re-rolls each post in its own author's voice. If the per-author clip is missing, the spawn never starts — the endpoint refuses with a 400 naming the gap. It's **async by design**: a full render is minutes — longer than `Bun.serve`'s idle timeout, and even a one-segment re-roll exceeds it because the MOSS model load alone does — so awaiting the subprocess inside the request would get the connection killed mid-run while the child kept going. Instead POST *starts* the job and returns `202`; **`GET /dev/regenerate`** reports `{ running, ok?, error? }`, and the client polls it. Single-flight (one model load at a time; concurrent POST → 409).
- **Cold-cache caveat.** The button is "one segment fast" only when the rest of the post is already cached for the *current* voice + lexicon. Because the voice is part of the [cache key](#audio-caching), clicking it after a voice change (or before any full render with this voice) silently becomes a *full* re-synthesis of every segment. So the intended workflow is: one `generate:prod` to settle the post at its final voice, *then* per-segment re-rolls.
- **The client button** (`client/narrator.ts`) is injected per segment only when `location.hostname` is localhost *and* `/post-version` reports `isAuthor` — ordinary readers short-circuit before any fetch and never see it. It POSTs to start, then **polls** until the job finishes, so the spinner tracks the actual render rather than a connection that times out (the earlier bug: the spinner cleared at the idle timeout while generation silently continued, so stopping the dev server then killed the run mid-write). On success it sets the URL hash to the segment and hard-reloads: the rebuilt manifest + audio (served `no-cache` in dev) are picked up cleanly, the drawer reopens on that segment, and the author presses play to judge the new take. A full reload (rather than surgically swapping Shikwasa's source) is deliberate — it's bulletproof, and the per-click model-load latency already dwarfs it.

This is the operational backstop named in [Representing word pronunciation](#representing-word-pronunciation): substitution lowers the bad-roll rate, the cache freezes good takes, and per-segment re-roll cleans up the residue.

## Audio Player

The audio player is managed by [shikwasa](https://shikwasa.js.org/), and exposes the following features:
- Shows chapters for the audio (skip to chapters with numpad)
- Pause/start with button (or by pressing spacebar anytime - even if the player is unselected/hidden). The spacebar/1-9/arrow shortcuts are armed from page load — they're how a reader who knows the convention starts the talk cold — and treated as one coherent group: no per-key gating on engagement, no asymmetry. (The trade against passive readers losing default Space-scroll is accepted: this is a player-bearing page, the player advertises itself, and any guard that fired Space conditionally wouldn't survive the same question applied to 1-9 or arrows.)
- Control speed (up to 2x)
- Skip/Rewind 10s (also doable with arrow keys)
- Hide/show highlighting in the article 
    - also turns off auto-scroll to facilitate taking screenshots, but snaps back when re-enabled
    - highlighting is hidden, but still logically processed (even if now shown) as this is much simlper and snappier than trying to recalculate what highlights should be shown at any given point the user re-enables highlighting
- Release / re-acquire the OS media-session surface (lock screen, hardware media keys, Bluetooth-headset taps) via a headset-glyph toggle in the controls row. ON (default, accent-colored) behaves as documented in [OS media controls](#os-media-controls-media-session-api); OFF tears down the metadata + every action handler + gates the rAF position-state push. The choice is persisted globally in `localStorage` under `narrate-capture-controls` — it's about the reader's relationship to their own music, not about any one talk, so a returning reader who released last session stays released across posts and across page loads. On-screen controls (dock buttons, chapter pills, drawer, keyboard shortcuts) are untouched in either state; only the OS surface is affected. **Partial-release caveat**: skip controls (`previoustrack` / `nexttrack`), the lock-screen "now playing" widget, and the position scrubber all release cleanly when toggled OFF — but hardware **play / pause / stop** still control the talk because of how the Media Session API is specified. See [OS media controls](#os-media-controls-media-session-api) for the explanation. The toggle is best understood as an escape hatch for an engaged reader, layered on top of the stronger property the [deferred first-play arming](#os-media-controls-media-session-api) already gives passive readers (those who never pressed play): nothing is captured for them in the first place.
- Show a progress bar & timer for position in the audio
- Toggle player entirely (to hide it and focus on just the article). One split-affordance pair, uniform across viewports:
    - The in-player close × (`.narrate-close-btn`) sits in the top-right corner of the player card and is the *close* affordance. Always visible while the dock is open.
    - The floating "Listen" pill (`.narrate-toggle`) sits in the viewport's bottom-right corner and is the *re-open* affordance. Hidden while the dock is open (so it never coexists with × on screen), revealed once × dismisses the dock.
    - Driving both affordances off the same `dock.dataset.hidden` flag means × and pill never appear together — which both resolves the narrow-viewport overlap (pill would otherwise sit on top of the dock) and stops two on-screen headphones glyphs from competing for meaning (the Listen pill's glyph and the in-dock `.narrate-capture-btn` glyph).
    - Shikwasa's own breakpoint switches the player to a vertically-stacked flex layout at ≤640px. Above that breakpoint the player is horizontal *and* the always-visible × is in the corner, so the highlight-toggle button (rightmost item in the controls row) would otherwise collide with ×; an extra `padding-right: 44px` is applied to `.shk-player` across the full horizontal-layout band (`@media (min-width: 641px)`) to push the controls inward and leave the corner clear. Not needed in the vertical layout (controls sit below the title, away from the corner).

### Chapter strip (`client/narrator.ts` + `client/narrator.css`)

Above the player sits a strip of chapter pills (one per [chapter](#chapters)), each jumping to that chapter. To avoid a post with many chapters wrapping this strip into a tall multi-row block that pushed the article down, it's instead a **single horizontally-scrolling row** with a fixed height. Scrolling is offered three ways so it's discoverable on every device:
- native swipe on touch
- mouse-wheel-over-strip (we translate vertical wheel to horizontal scroll ourselves, since browsers don't do it reliably)
- press-and-hold ‹ / › arrows that appear on fine-pointer (desktop) devices only when the strip actually overflows. The hold eases its scroll speed in rather than jumping to full speed, the active chapter's pill auto-scrolls into view as playback crosses chapters, and a fading mask on whichever edge has more pills hints there's more to scroll to.

Two non-obvious constraints shaped it, both worth recording so they aren't reintroduced:
- **The strip floats over the white article, not the dark player card** (only the card below it has the dark background). So the arrows — like the pills — need the dark fill; styled to match the dock's palette they'd be invisible white-on-white against the page.
- **No CSS scroll-snap.** Snapping pills to center looks tempting, but it reverts any sub-pill scroll increment back to the nearest pill, which silently swallows the hold-arrow's per-frame nudges and the wheel handler's small deltas. Smooth continuous scrolling is the requirement, so snap is left off.

*Note*:
- `Shikwasa`s `seek(time)` calls `parseInt(time)` internally (truncating fractions), so we bypass it with our own `seekToMs`
- `Shikwasa` has built-in chapter detection, but to avoid the edge-case of briefly showing the wrong chapter when seeking to exactly the chapter boundary, we add `+ 0.01` to the chapter start time when seeking so that it reliably considers us *inside* the new chapter range
- `Shikwasa` updates the progress-bar on the audio element's `timeupdate` event, which fires ~4×/sec; its CSS transition smooths each step but still leaves a visible ~150ms idle between them. We disable that transition and write the bar's width from our existing rAF tick (the same one driving mark highlighting), so the bar advances smoothly
- `theme: "dark"` is forced
- **CSS overrides win by cascade-layer ordering, not specificity arms races.** Shikwasa's stylesheet is routed through `@layer vendor` (via `client/shikwasa-vendor.css`); our `.shk-*` overrides in `narrator.css` live in `@layer engine-components`, declared later. Bare-class selectors like `.shk-player { padding-right: 44px }` win without `!important` or escalating selector specificity. See [Cascade-layer architecture](#cascade-layer-architecture-clientbasecss-clientnarratorcss-clientcommentscss).

## Player & sync (`client/narrator.ts`)

We need to keep the highlighted content in sync with the player controls (ex: skipping forward/backwards)

Key architectural things to make this work properly:
- Active-mark tracking uses **`requestAnimationFrame`** reading
  `player.currentTime`, and not the audio element's `timeupdate` event (`timeupdate` fires ~4x/sec, too coarse for sentence-level marks).
- Active mark = "latest mark whose `time` ≤ `currentTime`" (recomputed each tick so backward seeks are efficient).

### OS media controls (Media Session API)

The player also speaks the [Media Session API](https://www.w3.org/TR/mediasession/) (`navigator.mediaSession`), so a talk behaves like any other audio the OS knows about: the macOS Now Playing widget / Control Center, the iOS/Android lock screen, the Chrome notification tile, and Windows SMTC all show the post title + artist and drive play/pause/seek; Bluetooth-headset taps, hardware media keys, and OS skip buttons route into the player. It's `setupMediaSession()` in `client/narrator.ts`, **armed on the user's first explicit play** rather than at `init()` (gated on the `hasPlayed` one-way latch). The UA-level constraint already says the tab isn't routed media keys until audio has actually played (Chrome/Safari only make the tab the OS session target after a real `<audio>.play()`), so a passive reader's metadata/handlers were never reaching the lock screen anyway — deferring the *registration* aligns our behaviour with the platform's and stops polluting the OS "now playing" widget for a talk that never starts. It also means a reader who's listening to their own music doesn't have their headset-tap silently reassigned by visiting a blog post; the reassignment only happens once they've opted in by pressing play. Three pieces:

- **Metadata** — `navigator.mediaSession.metadata` from the same `data-narration-title` / `data-narration-artist` the dock uses. Artwork is left empty for now (no site cover asset yet; a single PNG is the obvious later add).
- **Action handlers route into the *existing* controls**, so there's one code path per gesture, not a parallel one:

  | MediaSession action | Player call (already used by) |
  | --- | --- |
  | `play` / `pause` / `stop` | `player.play()` / `player.pause()` (Space shortcut) — `stop` maps to pause (no real stop concept) |
  | `seekforward` / `seekbackward` | `skipBy(±seekOffset)` (the dock's 10 s buttons; OS-supplied offset honored, else 10 s) |
  | `seekto` | `seekToMs()` (the sample-accurate seek path) |
  | `previoustrack` / `nexttrack` | `jumpToChapterDelta(∓1)` — a chaptered talk's "track" *is* its chapter, mirroring the 1-9 shortcuts (no wraparound at the ends) |

  Each registration goes through a `safeSet` wrapper that swallows the throw for actions a given UA doesn't expose (e.g. `previoustrack`/`nexttrack` on Firefox/Linux without MPRIS), so one unsupported action can't block the rest.
- **Position + playback state.** `setPositionState` is pushed from the *same rAF tick* that drives the highlight (the canonical clock), with `position` clamped to `duration` (the spec throws otherwise, and the final frame can drift a hair past). `playbackState` is set explicitly in `onPlay`/`onPause`/`onEnded` rather than left to UA inference — the heuristic can disagree with reality right after a programmatic `currentTime` write (which `seekToMs` does), stranding the lock screen on the wrong icon.

The whole feature is gated on `"mediaSession" in navigator`, so pre-2021 Safari and the like get exactly today's behavior. It's pure runtime — no manifest or build change — and complements the in-page keyboard shortcuts rather than replacing them: MediaSession is the OS-surface input path, the `document` key listeners are the focused-window path, and both call the same player methods.

**Releasing the surface (`teardownMediaSession`).** A reader who's engaged the talk and later wants their headset back for their own music can flip the [capture toggle](#audio-player) to OFF; this calls `teardownMediaSession()`, the exact inverse of `setupMediaSession()`. It nulls every action handler (in a `try`/`catch` per action, mirroring `safeSet`), sets `metadata = null` (so the OS "now playing" widget no longer shows the blog title — leaving it there would be exactly the confusion a reader who released is escaping), and sets `playbackState = "none"`. The two `captureControls` guards — on the single `setPlaybackState` helper and on the rAF `setPositionState` push — are load-bearing: they're the chokepoints that stop the very next `onPlay` or rAF tick from re-acquiring the OS session a frame after teardown. Re-acquire on toggle-ON is symmetric: `setupMediaSession()` is idempotent enough to re-call, and the two state-write paths start passing again. Persistence is via one global `localStorage` key (`narrate-capture-controls`, value `"off"` to disable, absence ⇒ ON); the pref is read at `init()` before the first-play arming path can fire, so a returning reader who released last session stays released without having to re-toggle.

**What the release does NOT release — and why this is a platform constraint, not a bug.** The Media Session [spec defines *default actions*](https://w3c.github.io/mediasession/#default-actions) for some actions when no handler is registered: `play` → resume the active media element, `pause` → pause the active media element, `stop` → similar. `previoustrack` / `nexttrack` (and `seekbackward` / `seekforward` / `seekto`) have **no default action** — nulling their handlers genuinely releases them, which is why skip controls and lock-screen position visibly stop responding when capture is OFF. Play / pause / stop fall back to controlling our `<audio>` element directly, regardless of whether we registered handlers, because the browser still considers our tab the active media session as long as the `<audio>` element holds a loaded source. The only way to fully release play / pause back to the reader's music app would be to clear `audio.src` and `audio.load()` — releasing the OS session at the cost of stopping the talk and needing to re-buffer when re-armed. This is the same reason you can't keep a podcast app playing in one Chrome tab and have hardware keys control Spotify in another: at the OS level, only one media session owns the keys at a time. We considered the stop-and-release approach and rejected it (toggling capture shouldn't stop the talk; that would surprise the much more common "I want to keep listening, just give me my skip key back" case). So the toggle is a *partial* release by design, and the larger guarantee for the reported complaint is the deferred first-play arming itself: a reader who never pressed play has nothing captured to begin with, and the toggle is the escape hatch on top of that for readers who *did* engage.

## Manifest format (`generated/<slug>/manifest.json`)

- Times are **absolute milliseconds** in the master track (the player never needs to know that the audio was assembled from per-chapter files)
- `audio` is a path under `/generated/<slug>/`, pointing at the **content-hashed** final track (`full.<hash>.mp3`, see [Serving generated audio](#serving-generated-audio-content-hashed-filenames--dev-range-support)); Content-Type is inferred
- The time of different marks is calculated taking into account trimming out silent audio (to avoid slowly going out of sync)

## Serving generated audio (content-hashed filenames + dev range support)

The final per-post track is written as **`full.<hash>.mp3`** — a 16-hex-char content hash of the encoded bytes is baked into the filename, and the manifest's `audio` URL points at that hashed name. This is the **cache-busting contract for both dev and prod**: the URL changes whenever the audio changes, so a regenerated track is *always* fetched fresh, while an unchanged track can be cached indefinitely. The client is unaffected — it only ever reads `manifest.audio`, so the scheme is invisible to the player; `copy-static` ships the hashed file through its existing `*.mp3` glob, and `clean` removes it with the whole `generated/<slug>/` dir.

**The player ships with `preload="none"`, so a passive reader pays no audio bytes** — a 30-minute talk is ~14 MB at 64 kbps mono, and Chrome's default for `preload="auto"` is to pull most or all of that eagerly even if the reader never presses play. We hand Shikwasa the duration explicitly from `manifest.duration`, so the scrub bar still shows the correct length without any metadata fetch; the audio element only opens a connection when `play()` actually runs. The first press of play pays a one-shot ~200-500 ms latency to open the connection and buffer the first frames, and from there the Range support below takes over for any seek. This shares the same "first explicit play" signal that arms [OS media controls](#os-media-controls-media-session-api) and the global keyboard shortcuts — one mental model ("don't take anything from a reader who hasn't pressed play"), three behaviours fall out of it.

**Why hash the filename rather than tune cache headers.** The motivating bug: a regenerated `full.mp3` (stable name) wouldn't play even after a hard-refresh. Chrome keeps a **dedicated media cache** for `<audio>` that `Cmd+Shift+R` does *not* evict, and `Cache-Control: no-cache` *without* a validator (ETag/Last-Modified) doesn't reliably dislodge it either — so the browser kept replaying the stale bytes. A small track (a short post) happened to play from cache regardless, masking it; a 19 MB / 40-min track did not, which is why the bug looked post-specific. Content-hashing sidesteps the whole class: a fresh URL is in *no* cache (browser, media, or CDN), so correctness no longer depends on revalidation headers anyone can misconfigure. Each generate run also **sweeps** the superseded `full.*.mp3` (and any legacy unhashed `full.mp3`) so stale tracks don't pile up across dev iterations or get shipped to prod by `copy-static`'s glob.

**The manifest stays stable-named** (`manifest.json`) — it's the indirection that carries the current hash. It's fetched via `fetch()`, not a media element, so it isn't subject to the sticky media cache; the dev server serves it (and everything under `/generated/`) with **`Cache-Control: no-store`** so the player always sees the latest hash, and prod's CF Static Assets binding revalidates it by ETag. So `no-store` in dev now protects the *manifest*, not the audio — the audio's freshness comes from its hashed name.

**Dev server HTTP range support.** A browser media element won't *begin* playing a large audio resource it can't seek into — it needs `206 Partial Content` with `Accept-Ranges`. The dev file server (`serveFromDir` in `createDevServer.ts`) therefore honors `Range` requests (suffix `bytes=-N` and open-ended `bytes=N-` included), returning `206` with `Content-Range`/`Content-Length`, else a full `200` carrying `Content-Length` + `Accept-Ranges`. Without it a multi-MB track is served as one unbounded chunked stream with no length, which Chrome refuses to start (small files worked anyway because the browser buffers them whole). Prod (CF Static Assets) already supports ranges, so this keeps dev aligned with prod — the same reason a `--mock`/`say` draft and a MOSS render must both behave the same under the player.

## Comments (`client/comments.ts`)

Google-Docs-style threads anchored to selections in the article body, selections in the spoken-script drawer, *or* whole graphics. Every thread (and every in-progress draft) renders as its own card in a **right-side margin column** that scrolls with the article — same idea as Google Docs's comment pane.

### Why a column, not a single popover

One floating popover per span breaks as soon as you have **multiple threads on the same selection** — a real requirement for comments that sync across users, since two readers can independently comment on the same sentence.

The column sidesteps the disambiguation problem entirely: every thread is always visible, stacked next to its anchor. Clicking a highlight scrolls its card into view (and pulses it); clicking a card scrolls the article back to its anchor (and pulses that). Two threads on the same selection just appear as two cards at the same vertical position.

### Anchoring: the Web Annotation target model

Comment anchors are stored as **W3C [Web Annotation Data Model][AnnotationModel]** *targets* (REC 2017) — a `source` IRI plus one or more *selectors* that narrow it to a part of that source. The types live in `client/commentsStore.ts`; all knowledge of the selector shape is funneled through a small set of helpers (`makeTextTarget` / `makeGraphicTarget` to build, `textTargetParts` / `graphicTargetId` / `contextOf` / `isTextTarget` to read) so the UI and the offline tools read plain fields, never raw selector arrays.

**Why the spec shape.** Our pre-2026 anchor type (`{ kind, context, segments, startOffset, endOffset, quote }`) was, field-for-field, a worse-named reinvention of WA selectors. Adopting the spec is a vocabulary win (anyone who's touched annotation tooling knows "selector," "target," "TextQuoteSelector") and leaves the door open to interop with Hypothes.is / dokieli / EPUB readers — see [exporting](#exporting-to-the-web-annotation-wire-format). It cost almost nothing: the mapping is near 1:1, with exactly one concept the WA model doesn't have (our per-block content hash), parked in a project-namespaced extension.

A **text** target carries the standard selectors — a **`RangeSelector`** for the block span and a **`TextQuoteSelector`** for the verbatim text (plus a little surrounding context, stored cheaply against a possible future fuzzy re-anchor) — plus one project extension, **`x-blog:segmentHashes`**: a content hash of every block the selection touches. The WA model has selectors, not integrity checks, so the hashes — which drive stale-detection ([below](#stale-anchors-orphan--flag)) — have no native home and live in the extension. The `source` distinguishes the commentable surface (article body vs. the spoken-script drawer); the full post IRI is resolved only at the export boundary.

**Narration comments also carry an audio time range — derived, never entered.** A comment on the spoken-script drawer is implicitly about a slice of the narration *audio*. The author never types timestamps: `bun run generate` already computes each `<mark>`'s time (via the `AudioPipeline`), and a narration comment automatically picks up the audio range of the segment(s) it covers, stored as a W3C **Media Fragments** ([spec][MediaFragments]) selector alongside the text ones — so it survives [export](#exporting-to-the-web-annotation-wire-format) to standard annotation tooling. The range is segment-granular (bounded by `<mark>` times). The card has a speaker button that plays that segment; the stored range is otherwise for export/interop and future pacing-feedback features.

**The stored range is best-effort, not authoritative.** Audio is regenerated every revision, so a `t=` is only exactly valid for the build it was created against. In the normal loop that's a non-issue: a comment is typically resolved by the very AI edit that changes the content (and therefore the audio), so it's gone before its timestamps can drift. The range risks going stale whenever a comment *outlives* a regeneration — e.g. a `PARTIAL` / `NOTE-ONLY` thread the edit left open, or a comment on a segment re-synthesized for reasons unrelated to its text.

**[Per-segment regeneration](#per-segment-regeneration-dev-author-only) is exactly that "unrelated reason," and the sharpest case — because it drifts `t=` with *no text change at all*.** Re-rolling a segment's audio (unsatisfactory MOSS synthesis) changes that segment's duration, which **cascades**: every *later* segment in the post shifts in absolute time too. So a single re-roll can invalidate the stored `t=` of comments on the re-rolled segment *and on every segment after it* — while their text is untouched, so the [text-hash stale detection](#stale-anchors-orphan--flag) never fires and nothing visibly flags the drift. This is deliberate (the [orphan-and-flag](#stale-anchors-orphan--flag) machinery guards *text* anchors, which are the durable ones; an audio-time integrity check would be a parallel mechanism we've judged not worth building). The consequence is simply that the audio range is **silently** approximate after any re-roll, not just visibly-stale-after-edit.

So a consumer that needs an accurate time must re-derive it from the segment's current `<mark>` (reachable through the still-valid text anchor), treating the stored `t=` as a hint that may be one build old — or, after a re-roll, several segments' worth of drift downstream — never as ground truth.

**Narration comments are visually distinct** — a violet accent and the speaker button, versus the blue of article comments. The icon is the main "this is about the audio" cue; we skip a text label to keep the narrow card uncluttered.

**Narration cards are positioned by the *article* element they refer to, not by the drawer.** A narration comment's literal anchor lives in the spoken-script drawer (a fixed panel off to the side), so positioning cards there made them all cluster at the current scroll position and overflow — you could never see them all. Instead we place each narration card next to the article element its segment refers to, via the same `<mark name="X"/>` ↔ article `id="X"` pairing the player uses to highlight during playback, so narration and article comments interleave down the column. Clicking the card scrolls the article there; the speaker button drives the audio. Two edge cases the mark↔id model implies:
- **No paired article element.** An author can write a `<mark>` whose name matches no article `id`. Such a comment has no article position, so it falls back to stacking at the page bottom (and a click scrolls the drawer instead). Rare, and degrades gracefully rather than mispositioning.
- **Multiple article elements.** Not possible today — one mark name resolves to one id. If a segment ever maps to several, we'd anchor the card to the first; nothing else changes.

Every block needs an id so we can refer to it later. We try them in this order:

1. **Use the author's existing `id` attribute** if there is one. These are usually present because the block is also a `<mark>` target for the spoken track, so the comment system gets stable ids "for free" wherever the narration already anchored. An id like `definition-body` stays the same even if the author moves that paragraph around in the document.
2. **Otherwise, make one up** of the form `<context>:__b-<n>` — e.g. `article:__b-7` for the 8th block found while walking the article. This works fine when the document doesn't change, but the index shifts the moment a paragraph is inserted earlier in the file. That's okay: when that happens, the block's text content also shifts under the comment, the stored hash no longer matches, and the comment gets flagged as outdated rather than silently pointing at the wrong sentence.

The takeaway: blocks the author labelled stay rock-solid, and blocks they didn't label still work — they just become eligible for the "outdated" flow as soon as the surrounding document changes.

**Narration anchors cover only the spoken words.** A drawer segment's block also wraps the segment's play button (with its timestamp clock). The indexer and quote-capture deliberately exclude that, so a narration comment's stored quote and stale-detection hash track the spoken text, not the clock — including across multi-segment selections, where the clocks sit between segments.

### Stale anchors: orphan + flag

On every render, each block's current hash is recomputed and compared to the one stored in `x-blog:segmentHashes`. If *any* block in a thread mismatches, the thread is marked **outdated**:

- Its highlight is not drawn in the article (we don't want to point at the wrong sentence).
- Its card still renders in the column, with an "outdated" tag in the anchor preview and the original `quote` text intact so the reader can find what it used to point at. The card falls back to the first segment's element for vertical positioning; if even that segment is gone, it stacks at the bottom of the column.
- Stale text cards **bypass the hide list** and lose their Hide button. Hide's contract is "click the highlight to bring it back," but stale threads have no highlight — leaving the button there would orphan the card with no recovery affordance. Surfacing stale cards unconditionally keeps them visible until the user either updates the article or deletes the obsolete thread.

Note this means we reject these alternatives:
- silently dropping stale comments (dangerous loss of content)
- Fuzzy re-anchoring (too hard to get correct)

### Anchoring (graphics)

Whole-graphic only in v1, scoped to `<figure>` (the authoring convention from [SSML usage](#ssml-usage)). A graphic target is a `source` plus a single **`FragmentSelector`** naming the figure's id — no hash (the graphic's content isn't text and isn't comparable across edits). If a figure is replaced (same id, new contents) the comment intentionally follows; that's almost always the right behavior when an author iterates on a diagram. Multiple threads on the same figure simply stack as multiple cards in the column — there's no dedupe.

Standalone `<svg>`/`<img>`/`<canvas>` are deferred: `<img>` is a void element, `<svg>` is a different DOM namespace, both need a wrapper before we can drop an HTML trigger button inside. The figure-only restriction keeps the indexing code free of those edge cases.

### Exporting to the Web Annotation wire format

Storing anchors as WA targets is "Phase A": the *in-memory* shape is already the spec model, but the bytes on the wire (Automerge change-objects) are plain JS objects with no JSON-LD framing. "Phase B" closes that gap with a pure transform in `shared/annotationExport.ts` that turns a merged comment snapshot into spec-valid JSON-LD: each thread becomes an `Annotation` (`motivation: "commenting"`), each reply a `TextualBody` (`format: "text/markdown"`), wrapped in an `AnnotationCollection`. The non-WA bits become project extensions (`x-blog:resolvedAt`; the `x-blog:segmentHashes` already inside the target); `authorEmail` is **dropped** (author-eyes-only follow-up data has no place in a portable export). Annotation IRIs are `urn:blog:<slug>:thread:<id>` — a `urn:` scheme, *not* `urn:uuid:`, because our ids aren't RFC-4122 UUIDs and claiming otherwise is a lie a strict consumer could reject.

**Where it runs — and why not a Worker route.** The proposal's original sketch was a `GET /comments/export?post=X` endpoint on the Worker. That would force the edge server to run Automerge (merge every reader's per-user blob, then serialize), which **violates the production dumb-server rule** (see the key design decision up top). So the merge-and-serialize step lives only where running Automerge is already fine:

- **The offline authoring tool** `bun authoring/exportAnnotations.ts <slug> [--all] [--base <iri>] [--out <file>]`. It reuses the offline aggregation in `loadUnresolvedThreads` (which merges the dev fsAdapter blobs), then runs the serializer; it's also the input the [`process-comments` skill](#ai-assisted-authoring-authoring--the-process-comments-skill) consumes. Pure localhost Bun — the dumb-server rule doesn't reach it.
- **The author's browser**, which already holds the merged snapshot via the aggregator; a client-side "download annotations" affordance is a few lines on top of the same serializer (not yet wired to a button, but the function is ready).

Both respect dumb-server perfectly: the merge happens on a trusted, full-Automerge runtime; the edge server still only ever shuffles opaque change-bytes.

**On the Annotation Protocol / LDN inbox (the proposal's "Phase C").** Skipped, and the localhost exemption *doesn't* rescue it. The motivation for an inbound [Annotation Protocol][AnnotationProtocol] endpoint was "let federated annotation clients POST annotations into our system." But (a) it's an *inbound, networked* surface — that's a production endpoint, squarely under the dumb-server rule, not a localhost-only tool that the exemption covers; and (b) the one place we *did* wonder whether the protocol would help — the local AI comment-resolution pipeline — gains nothing from it: that tool reads the comment blobs straight off disk (`generated/.comments-dev/`) and merges them in-process, so a REST/LDN layer would be plumbing it routes *around*, not through. The standard *vocabulary* (which the authoring prompt now speaks for free, post-Phase-A) is the entire benefit there; the standard *protocol* adds nothing. If an LDN inbox is ever wanted, it's a genuine new networked feature with the same dumb-server tension the proposal flagged — not unlocked by this work.

**Migration / breaking change.** Phase A renamed the stored field `anchor` → `target` and reshaped its contents. The shared Automerge **seed is unchanged** (it only declares the top-level `threads` / `replies` maps; the anchor lives *inside* a thread, written by `addThread`), so this is *not* a seed-regen / schema-evolution event — old change-objects still apply cleanly to the doc. They just produce threads with the legacy `anchor` field and no `target`. Since the system has no production comments and breaking changes were acceptable, there is **no migration change**: such pre-migration threads are defensively *skipped* at both read boundaries (`commentsStore.snapshot()` and the offline loader) rather than crashing the renderer on a missing `target`. To clear the stale local test data entirely, wipe `generated/.comments-dev/` and the `blog-comments:*` localStorage keys.

### Storage layer (`client/commentsStore.ts`)

Comments live in an **Automerge document** (CRDT) rather than a plain JSON array. The store module owns the document; `comments.ts` is purely a UI layer reading snapshots and routing mutations through the store API.

**Why a CRDT given how little concurrency we have today.** Each `(post, reader)` pair gets their own folder of change-objects in R2, so two writers stepping on each other's content is rare — it happens only when one reader uses two devices. The CRDT keeps that case trivial: the sync loop is `LIST + GET + applyChanges` against content-addressed change hashes, and the author-side aggregating viewer is `for each reader: applyChanges(...)` — both fall out of Automerge's commutativity for free. Picking the CRDT mental model up front also forced the data shape to be merge-friendly (maps not lists, tombstones not deletions) — that's mostly what shaped the design decisions one section above.

**Why Automerge over Yjs / json-joy.** Automerge's plain-object mutation API (`change(doc, "op name", d => { d.threads[id].replies[rid] = {...} })`) maps almost 1:1 onto the v1 `Thread`/`Reply` types, so the refactor was a port not a rewrite. Yjs's `Y.Map`/`Y.Array` wrappers would have been imposed on every read path for a comments use case that doesn't need any of Yjs's rich-text power. The Automerge WASM core is <1MB and loads on first interaction only so it doesn't bloat the initial JS bundle. Standards-wise, neither Yjs nor Automerge is a "spec" in the IETF sense — there's no portable CRDT format, so we'd have picked one library no matter what. Automerge's [JSON-CRDT paper](https://arxiv.org/abs/1608.03960) is the closest thing to a published formal model.

**Doc shape — deliberately flat.** Threads and replies are *sibling* top-level maps, both keyed by globally-unique ids; each reply carries a `threadId` pointer back at its parent rather than living inside it:
```ts
type CommentDoc = {
  threads: {
    [id: string]: {
      target: Target,   // Web Annotation target (see Anchoring above)
      createdAt: number,
      resolvedAt?: number,
    }
  },
  replies: {
    [replyId: string]: Reply & { threadId: string }
  },
}
```
`snapshot()` does one bucketing pass over `replies` (grouping by `threadId`) and joins each bucket into its parent thread for display.

**Why flat — efficient sync.** The unit of human action and the unit of server change should match. The flat shape makes a reply the atomic change unit: adding one is `d.replies[newId] = {...}` — a write to a brand-new key in a top-level map. This lines up directly with how server sync wants to think about updates.

The server is — and must remain — **dumb storage**. It treats every uploaded byte sequence as opaque: clients `PUT` bytes, clients `GET` bytes, all CRDT logic (merging, change-graph reasoning, conflict resolution) happens client-side via `Automerge.applyChanges` / `Automerge.getAllChanges`. The Worker never runs Automerge. That's the architectural rule: it's what lets the comment system survive a malicious / buggy / different-version server without diverging the underlying data, and it's what makes "comment merging is correct" a *library guarantee* rather than something we'd have to re-verify whenever the server changed.

**One R2 object per Automerge change.** The wire protocol is per-change, not per-blob. Each change a client produces (the unit `Automerge.getAllChanges(doc)` returns) lives at `comments/<post>/<userId>/<changeHash>.bin`, where `<changeHash>` is the content hash Automerge already computes for every change. Content-addressed, globally unique, deduplicating by construction (the same change uploaded twice produces the same key and the same bytes; the server short-circuits with `already_present`).

This makes sync **pure set-diff over hashes** — no etag dance, no `If-Match`, no 412 retry loop. The complete sync logic:

```
hydrate:
  serverHashes = LIST  /comments?post=X&user=<self>
  for hash in serverHashes \ localHashes:
    bytes = GET  /comments?post=X&user=<self>&change=<hash>
    Automerge.applyChanges(myDoc, [bytes])
  push:
    for change in localChanges where change.hash ∉ serverHashes:
      PUT  /comments?post=X&user=<self>&change=<change.hash>  body=change.bytes

aggregate (author only):
  users = LIST  /comments?post=X
  for user in users where user != self:
    serverHashes = LIST  /comments?post=X&user=<user>
    for hash in serverHashes \ knownHashes[user]:
      bytes = GET  /comments?post=X&user=<user>&change=<hash>
      Automerge.applyChanges(otherDoc[user], [bytes])
```

Two devices uploading concurrently never collide: each writes to its own change-hash-keyed URL, both succeed, both objects exist. Zero-delta page loads cost a single LIST per user (returns the same hashes you already have → no GETs). A full-blob alternative (instead of having action be its own unit) would eat this complexity in the sync layer instead — `If-Match` / 412-refetch-merge-retry / etag bookkeeping / a promise chain for serialization, all there because the resource becomes mutable. Having each action be its own object means its change-objects are immutable, so the entire concurrency-control state machine just disappears.

**What we deliberately rule out — even as a future direction — is running Automerge on the server** (load → applyChanges → save). That would forfeit server-dumbness for marginal protocol elegance and is exactly the centralization the CRDT model was meant to avoid. If client A's saved doc has a structure the server's Automerge version doesn't understand, the server must remain able to shuffle the bytes around regardless.

**On GC.** Each change object lives forever — there's no per-change deletion. That's not waste in the CRDT model: tombstones are how "deletion" works at the data layer (a deleted reply is a `deletedAt` field, not an absence), so the change history needs to be retained to merge correctly across all readers. The R2-object multiplication is a *storage-layout* concern, not a semantic one. At our expected volume — single-digit comments per reader per post — accumulation is trivial. At much larger scale, a periodic **compactor** can replace many small change-objects with one canonical "base" object containing the same content (`Automerge.save` of the whole doc as one blob); this is a storage reshape, not deletion. Optional, future, not blocking.

**Why flat — fine-grained updates.** A nice secondary win: this is exactly the shape Automerge's modeling guide recommends. From the docs:

> "As a general principle with Automerge, you should make state updates at the most fine-grained level possible. Don't replace an entire object if you're only modifying one property of that object; just assign that one property instead."

Adding a "reply" now lands at a unique key in a top-level map that every device shares via the seed — concurrent adds to different keys merge for free without any conflict-resolution at all. Having a nested schema (`threads[T].replies[id]`) forces the worst possible shape for the merge: when two devices independently set `d.threads[T] = {...}` (e.g. an author "materializing" a foreign thread before adding a reply), Automerge has to pick one assignment as the visible value via its multi-value-register policy. The losing value isn't *deleted* per se (Automerge keeps track of conflicts for youj to resolve them), but designing around assuming everything conflicts is usually not the right approach. The flat schema sidesteps the whole register-with-conflicts dance by ensuring every add is to a brand-new unique key, where nothing needs resolving in the first place.

**Shared seed.** All `CommentDoc`s start from an identical 127-byte Automerge blob hardcoded as `SEED_BYTES_B64` in `commentsStore.ts`. The seed exists to give every device the same root change history for both the `threads` and `replies` fields — without it, each device would call `Automerge.from({threads:{}, replies:{}}, ...)` independently, producing different timestamps in the genesis change and therefore separate "create threads" / "create replies" ops with different op IDs. On merge, Automerge resolves the resulting same-key conflict by surfacing one assignment as the visible value (the other lives on in `Automerge.getConflicts`). The hardcoded seed sidesteps the whole thing by making every device genuinely share the same genesis ops — there's nothing to resolve. This is the workaround the Automerge docs themselves recommend (§"Setting up an initial document structure"), almost verbatim. **Regenerating the seed bytes breaks compatibility with every existing blob** — the regen one-liner is in the source comment, but it's never to be run casually.

**Schema evolution gotcha.** Changing the shape of `CommentDoc` (adding a new top-level map, renaming a field) requires regenerating the seed, which produces a new `SEED_CHANGE_HASH`. Every existing R2 change-object was authored against the *old* seed as its parent, so the new doc's change graph has no path to those parents. `Automerge.applyChanges` does not raise an error in this case — it **silently skips** changes whose dependencies aren't present. Operationally that means old comments disappear from the app's view, with no log line, no exception, nothing to debug from. If we ever need to evolve `CommentDoc`, the recovery path is the migration-change pattern from the Automerge docs (§"Schema migration"): produce a pinned migration change that depends on the old seed's tip and asserts the new schema's shape, ship it as a second hardcoded blob, and have every reader apply it once on first load before any per-(post, user) changes are touched. Until then: don't change `CommentDoc`'s shape.

**Reader identity.** Provided by the [auth backend](#auth--login-serverauth): each logged-in user has a stable `<provider>:<sub>` userId (e.g. `google:1234567890`). The CommentStore is keyed on that id, so the same user's writes from different devices land in the same logical doc and merge cleanly via Automerge. The R2 blob key is `comments/<post>/<userId>.amrg`. There is no per-device identity layer and no anonymous fallback — login is required to comment, full stop.

**Persistence.** `Automerge.save(doc)` produces a `Uint8Array`; we base64-encode it into `localStorage` under `blog-comments:<path>:user:<userId>.amrg`. localStorage is string-only and snapshots are small (a hundred bytes per op), so the base64 inefficiency doesn't register; if comments ever grow huge we'd switch to IndexedDB (which stores binary natively).

**Author identity.** Each `Reply` carries the author's `authorId` (`<provider>:<sub>`), `authorName`, `authorEmail`, and an optional `authorPicture` URL — populated at submit time from the logged-in identity. The UI renders avatar + display name on every reply; `authorEmail` is deliberately *not* rendered to other readers (only the blog author needs it, for follow-up by mail).

### Draft persistence (`client/draftsStorage.ts`)

Drafts — unsubmitted threads + their in-progress textarea contents — are kept *out* of the CRDT (no cross-device sync, no aggregating-viewer leakage of half-typed thoughts) but persisted to **localStorage** under `blog-drafts:<path>:user:<userId>` so a page reload or accidental tab close doesn't blow away an in-progress comment. Two pieces of state pair with each draft:

- The `Thread` object itself (id, anchor, empty `replies`, `createdAt`) — same shape as a saved thread, just never handed to the CRDT.
- A separate `draftBodies: Map<threadId, string>` of the current textarea contents, updated on every `input` event from the composer.

`persistDrafts()` runs after each draft-touching mutation (create / cancel / promote / keystroke) and serializes both pieces as one JSON array of `{ thread, body }` entries. localStorage is synchronous and the payload is small (hundreds of bytes per draft), so debouncing the per-keystroke write isn't worth the complexity.

**Why localStorage, not the CRDT.** The whole point of "draft" is that it's *the user's private uncommitted thinking*. Putting it in the CRDT would (a) sync it to the user's other devices the moment they start typing, which is surprising when they intended to compose on this device; (b) bloat the comment blob with content the user might cancel anyway; (c) become visible to the author via the aggregating viewer the moment they polled, which is a real privacy regression. localStorage is exactly the scope we want: this browser, this user, this post — no further.

**Why a separate file (not the CRDT's localStorage blob).** Re-using `commentsStore`'s `Automerge.save` blob for drafts would mean drafts get applied as Automerge ops, which is exactly the cross-device behavior we're trying to avoid. A standalone key keeps the two persistence stories cleanly separable: erasing one doesn't touch the other; a future migration on either format leaves the other alone.

**Restoration.** On boot — after identity is loaded but before the first `renderAll` — `DraftsStorage.load()` reads back the JSON array and pushes each `Thread` into `this.drafts` and each body into `this.draftBodies`. The first render then builds composer cards for them just as if they'd been created mid-session; the textarea's initial value comes from the body map. No flicker, no "drafts pop in late."

**Surviving a re-render is separate from surviving a reload, and covers replies too.** `renderAll` tears down and rebuilds *every* card, and the [visibility-gated poll](#sync-clientcommentssyncts-clientcommentsaggregatorts) re-renders unconditionally every 60s (and on tab re-focus) — wholly independent of any keystroke. That rebuild destroys the textarea the user is typing in: focus jumps out and the in-progress text is dropped. Draft bodies survive because they're mirrored into `draftBodies` and re-applied on build, but **replies have no such buffer** (only unsubmitted *threads* persist; an open thread's reply box always builds empty), so a re-render mid-reply silently lost the whole reply. The fix is a single mechanism in `renderAll`: before the teardown, snapshot the focused composer (`threadId` + value + caret); after the rebuild, re-apply value, selection, and `focus({ preventScroll: true })` onto the new card for that thread (no-op if the thread vanished, e.g. resolved out from under the render). This restores focus for drafts *and* carries the typed text across the render for replies — the one path that wasn't otherwise persisted. `preventScroll` matters because the trigger is usually a background poll, not a user action, so refocusing must not yank the viewport. Note this is re-render survival only — reply text is deliberately *not* persisted to localStorage across a hard reload the way draft bodies are (an open thread's reply is less "work in progress" than a whole unsubmitted comment); revisit if that proves to be a papercut.

**Anchor validity isn't re-checked on load.** A draft authored against an earlier version of the post still renders even if the underlying segments have changed — the card stacks at its anchor's last-known position (or at page bottom if the block is gone), with the original `quote` preserved in the anchor preview. This matches the orphan-and-flag philosophy used for saved threads: better to surface the user's work and let them decide than to silently drop it. The simpler fallback (drop stale drafts at load time) was rejected for the same reason.

### Sync (`client/commentsSync.ts`, `client/commentsAggregator.ts`)

Sync to R2 is per-change set-diff over content-addressed Automerge change hashes. The store handles local-only concerns (mutate, persist to localStorage, snapshot); the sync layer wraps it with network round-trips that are simple enough to fit on one screen.

**Boot** — `sync.hydrate()`:
1. `LIST /comments?post=X&user=<self>` → array of change hashes the server has for us
2. Set-diff against the hashes of changes already in our local doc → list of hashes to fetch
3. Parallel `GET` for each, `store.applyOwnChanges(bytes[])` to apply
4. Record everything the server has (union of remote + local) as `serverKnownHashes`
5. Trigger one `requestSync()` to push any local changes the server doesn't have (catches the case where a previous session crashed mid-push, or where the user wrote before `onChange` was wired)

**Write** — every store mutation fires `store.onChange`, which the sync layer points at `requestSync()`. The push:
1. `store.getAllLocalChanges()` → all (hash, bytes) pairs in our doc
2. Filter to those whose hash isn't in `serverKnownHashes` (initialized with `SEED_CHANGE_HASH` — the shared seed never needs to be uploaded)
3. Parallel `PUT` for each new change; on success, add its hash to `serverKnownHashes`

Concurrency is handled by content addressing: each change object lives at its own hash-keyed URL, so two devices uploading at the same moment write to two different URLs — both succeed, no conflict at the protocol layer, no `If-Match` / 412 retry / etag bookkeeping. A single in-flight `pushing` flag with a `dirty` rerun is the only state machine in the sync layer; it exists to coalesce a burst of writes into one batched push, not to handle conflicts.

**Author aggregating viewer** — when `isAuthorOfCurrentPost(identity)` returns true, `aggregateOtherReaders` runs after hydrate. For each non-self user it does the same set-diff dance: `LIST /comments?post=X&user=<u>`, fetch any change hashes we haven't already pulled for that user, `store.applyOtherChanges(u, bytes[])`. The store keeps each user's loaded doc in a separate `others` map (NOT merged into `this.doc`), so:
- `snapshot()` reads from `merge(doc, ...others)` — the author sees everyone's comments.
- `getAllLocalChanges()` returns only changes from `doc` — the author's R2 folder doesn't bloat with other readers' content.

Per-user per-page-load cost: 1 LIST, plus 1 GET per new change for that user. **Zero-delta loads cost just the LISTs** — if a reader hasn't added anything since last visit, no GETs at all. Per-user-pull failures are logged and skipped rather than aborting the whole aggregation.

**Visibility-gated polling.** A `CommentPolling` controller wraps the boot-time hydrate/aggregate path and re-runs it on a 60-second cadence while the tab is `document.visibilityState === "visible"`. When the tab goes hidden the timer is cancelled outright — there's no point pulling fresh comments the user isn't looking at — and on becoming visible again we trigger an immediate poll if more than the interval has elapsed since the last one (so a user returning after a long absence doesn't have to wait for the next 60-second mark). The single-flight guard inside the controller coalesces overlapping requests, so a slow network can't stack concurrent hydrate sweeps.

### Author-resolution (`client/resolutionsStore.ts`, `server/comments/resolutionsRoutes.ts`)

The blog author can mark *any* thread as resolved — including foreign threads written by other readers. This is structurally different from a commenter resolving their own thread:

- Commenters write `thread.resolvedAt` into their own `CommentDoc` via the existing flat-map path.
- The author can't write into a foreign commenter's doc (each per-user blob is owned by that user; the auth layer rejects cross-user PUTs).
- We also can't have the author "materialize" the foreign thread into their own `CommentDoc` and set `resolvedAt` there — that hits the multi-value-register conflict the [storage layer notes](#why-flat--fine-grained-updates) warn about (two devices assigning to the same `threads[T]` key produces a register with two visible values; nested ops only attach to one).

The way out is a separate per-post namespace that's *not* a CRDT at all:

```
resolutions/<post>/<threadId>.json
```

One mutable JSON blob per resolved thread. The body is opaque to the server (`{ threadId, resolvedAt, resolverId, resolverName }` — a few hundred bytes). Single-writer per post (only the post author has PUT permission), so there's no merge problem — last-write-wins is harmless when the only writer is one identity across one or two devices producing near-identical bytes.

**Visibility model:**

| Operation | URL | Allowed when |
|---|---|---|
| List resolved threadIds for a post | `GET /resolutions?post=X` | any logged-in user |
| Fetch one resolution body | `GET /resolutions?post=X&thread=T` | any logged-in user |
| Write a resolution | `PUT /resolutions?post=X&thread=T` | session present AND session is the post's author |

Reads are open to all logged-in users so the original commenter can pull the resolution that hides *their own* thread. Other readers technically receive the LIST/GET too, but the `threadId`s are opaque random strings; without the corresponding CRDT thread (which lives only in its commenter's private blob), the resolution is meaningless to a third party. This is what lets us avoid making the author's full personal comments blob public — a much larger information surface.

**Client integration:**
- `ResolutionStore` keeps a `Map<threadId, ResolutionEnvelope>` in sync with the server, persisted to localStorage so reloads don't refetch every entry.
- `hydrate()` is pure pull (LIST → diff-fetch by upload timestamp) and runs on boot and on every polling tick alongside the per-user `sync.hydrate()` and the author aggregator.
- `resolve()` PUTs the envelope, updates the local cache, fires `onChange` → re-render. Failures are logged, not surfaced — same pattern as comment sync.
- The render-path predicate `threadIsResolved(thread)` unifies the two sources: `thread.resolvedAt !== undefined` (self-resolve) OR `resolutions.isResolved(thread.id)` (author-resolve). Either hides the card and unwraps the highlight.

**Resolve-button routing.** The Resolve button only shows when there's somewhere meaningful for the click to go:
- Own thread (commenter): routes to `CommentStore.resolveThread()` — the existing self-resolve path.
- Foreign thread + user is the post author: routes to `ResolutionStore.resolve()`.
- Foreign thread + user is *not* the post author: button is suppressed (would otherwise be a no-op).

`CommentStore.ownsThread(threadId)` lets the UI tell which case applies — it returns true iff `threadId` exists in *our own* `doc.threads`, false for threads we only see via the author aggregator's `others` map.

**Why not Automerge for the resolutions blob.** Resolutions don't need CRDT merge: the writer set is one logical actor (the post author across their devices), the data per thread is one short envelope, and we don't track per-field history. A plain JSON blob with last-write-wins is the right shape; using Automerge would mean shipping a second seed, a second `applyChanges` sync loop, and per-change content addressing for nothing.

### Document version (`client/postVersion.ts`, `server/postVersionsRoute.ts`)

Each post has a content hash — SHA-256 of the source HTML bytes — that the build script bumps every time the source changes. The hash powers two distinct surfaces:

1. **Commenter "doc changed" banner.** On boot, the client fetches the post's `currentHash` and compares it to `localStorage["blog-doc-version:<post>"]`. If the user has been here before AND the hash differs, a banner appears in the comments column: "The post has been updated since your last visit. Some comments may no longer apply." This is the explanation for two things that would otherwise be confusing: stale anchors on a thread the reader posted weeks ago, and threads that vanished because the author resolved them. We bump the last-seen value immediately on first render so a reload clears the banner.
2. **Author-only version history.** When the same endpoint sees a request from the post's author, it also returns the chronological list of past hashes (most recent first, with `builtAt` ISO timestamps). The author sees an expandable "Document versions (N)" panel in the comments column.

**Hash + history storage:**
- Source: `posts/<slug>.html` raw bytes.
- Hash: `SHA-256` (browser-native; same `crypto.subtle.digest` available in Workers and Node, identical bytes).
- History: `posts/versions.json` (committed to git). The build script `generate/post-versions.ts` reads each post, computes its current hash, and *prepends* a new entry to `versions.json` for any post whose hash differs from its most-recent recorded one. Idempotent — running `bun run build` twice without editing a post is a no-op.
- Same script also writes the content repo's `.generated/postVersions.ts` (an importable static map) for the Worker bundle.

**Dev parity:** `server/postVersions.dev.ts` recomputes the current hash from the source files at startup (so a fresh edit shows up without rerunning `bun run build`), and reads history from `posts/versions.json`. If the dev-computed current hash doesn't match the most-recent entry in `versions.json` (the author edited but hasn't built), we synthesize an in-memory "now" entry at the head of the history so the panel reflects the actual on-disk state. Not persisted — the build script remains the only writer.

**Visibility — two surfaces, different audiences.** `GET /post-version?post=X` returns `{ currentHash, history? }` and requires login: the hash + per-build cadence is comment-adjacent and would double as a version-tracking pixel for drive-bys, so it stays behind the same session gate the comment system already enforces. `history` is only included when the session is the post's author — every other logged-in user gets `currentHash` alone. **A separate public file, `/assets/post-versions.json`, exposes only the most recent `builtAt` per post** — no hash, no per-build history. That's the byline's "Last updated" data source (see [Author profiles and bylines](#author-profiles-and-bylines-sharedauthorprofilets-clientbylinets)), and it's the same field we already publish to crawlers as JSON-LD `dateModified` (see [Structured data](#structured-data-schemaorg-open-graph-twitter-card-sharedinjectstructureddatats)), so there's nothing new to gate. Splitting the two keeps the public surface narrow (one human-readable date) and the gated endpoint gated. Both files are built from the same `posts/versions.json` source: prod via `copy-static.ts → buildPublicPostVersionsMap`, dev fresh per request from the same helper.

### UI

- **Selection → floating action bar.** A "Comment" pill appears above any selection inside a commentable root. Clicking it creates a draft card in the column, scrolls to it, and focuses its textarea.
- **Cards column** spans the document height. Each card is within it, so cards scroll with the page naturally. `repositionCards()` aligns each card's top with its anchor, then pushes later cards down so they don't overlap. It runs on scroll, resize, and after every render.
- **Bottom clearance.** Comments near the end of the page are kept scrollable clear of the fixed player dock (an invisible spacer adds just enough scroll room), so a comment on the very last paragraph isn't trapped behind the player.
- **Drafts vs threads.** A *draft* is an unsubmitted thread held in `this.drafts`. Drafts deliberately don't go into the CRDT, so they never sync to a server or to the user's other devices — but they DO persist to localStorage via `draftsStorage.ts` so closing the tab mid-compose doesn't lose the work (see [Draft persistence](#draft-persistence-clientdraftsstoragets)). The card looks the same as a saved one but is framed with a blue border; the composer's "Cancel" discards the entire draft, "Comment" promotes it (registering the thread and the reply). After the first reply lands the thread lives in the CRDT and subsequent typing in the same card just appends replies. Each card owns its own textarea, so drafts never collide with each other and the old "you have unsaved work" draft-protection logic isn't needed.
- **Cross-linking** between card and anchor: clicking a highlight scrolls its card into view and pulses it; clicking a card (anywhere outside its buttons / textarea) scrolls the article to the anchor and pulses the highlight.
- **Highlight color** is soft blue (`rgba(88, 166, 255, 0.22)`), deliberately not yellow — narration already paints the active sentence yellow/orange, and a sentence that's both being read and commented needs to be visually unambiguous. Nested highlight spans (overlapping threads) naturally compose to a darker blue, which reads as "denser commentary here."
- **Layout reservation.** When the column is visible (≥1100px viewport) `body { padding-right: 360px }` shifts the centered article left so the column has a clean gutter to live in. The narration dock stays viewport-centered and so no longer sits dead-center under the article when the column is showing; that visual mismatch is mild enough to ignore for v1.
- **Author-only thread-id tag.** Each saved card shows its `threadId` as a small monospace chip pinned to the left of the action row (`margin-right: auto`, so the Hide / Resolve / Reply buttons stay grouped on the right) — but only for the post author, gated on the same server-authoritative `isAuthor` flag the [version endpoint](#document-version-clientpostversionts-serverpostversionsroutets) reports; readers never render it, and drafts skip it since they aren't exported yet. It exists to close the loop with [`process-comments`](#ai-assisted-authoring-authoring): the skill reports verdicts keyed by that id (`Thread #N (id=<threadId>)` — the same id baked into the `urn:blog:<slug>:thread:<id>` IRI and accepted by `resolve-threads`), but the id appeared nowhere on the page, so the author couldn't match a printed id back to the visual card it belongs to. Clicking the chip copies the id to the clipboard.

### Lifecycle: Hide vs Resolve

Three ways a thread can leave the UI, with very different semantics:

| | Trigger | UI effect | Storage effect | How to undo |
|---|---|---|---|---|
| **Hide** | "Hide" button on a non-stale saved card | Card removed; highlight stays | None (session-only `hiddenCardIds` Set) | Click the highlight, or reload |
| **Self-resolve** | "Resolve" button on a saved card the user owns | Card removed; highlight removed | `resolvedAt` timestamp set on the thread; record stays in localStorage | Not in v1 — permanent |
| **Author-resolve** | "Resolve" button on a foreign saved card, when the user is the post author | Card removed everywhere (also vanishes for the original commenter on their next poll) | Per-post resolution blob written to `resolutions/<post>/<threadId>.json`; the commenter's snapshot honors it via the combined `threadIsResolved()` check | Not in v1 — permanent |
| **Delete reply** | "x" on each reply | Reply removed; thread auto-resolves when last visible reply is gone | `deletedAt` timestamp set on the reply (and `resolvedAt` on the thread if it's the last one); both stay in localStorage | Not in v1 — permanent |

**Why three?** Hide is a casual "I'm done looking at this for now." Resolve is the decisive "this is addressed, get rid of it." Reply-delete is for fixing typos / removing individual replies. Conflating them would force every dismissal to feel either too cavalier (one-click delete-everything) or too cautious (confirm-every-time).

**Localstorage as the deletion queue.** Resolved threads and deleted replies aren't removed from localStorage — they sit there as **tombstones** (`resolvedAt` on the thread, `deletedAt` on the reply), filtered out of every render path. When a server sync lands, the client will iterate tombstones, send a DELETE for each, and only then remove them locally. Using the existing store as the queue (instead of a separate `pendingDeletions` array) means there's no second data structure to keep in sync and no migration once networking arrives.

The same logic applies symmetrically to threads (Resolve) and replies (Delete) — different user-facing actions, same architectural pattern. Deleting the *last* visible reply on a thread additionally sets `thread.resolvedAt`, so the server sync issues both reply-level DELETEs and a thread-level DELETE; a zero-reply thread is a dead record server-side anyway, so the extra request is harmless.

Two notes on what's deferred:
- **"Never synced → remove immediately."** Replies don't yet carry a `syncedAt` field set after a successful server write. With one, Delete/Resolve on an item that's never reached R2 could skip the tombstone and remove outright. Today everything tombstones uniformly — slightly more work than necessary but the doc shape is already merge-friendly so adding `syncedAt` later won't need a migration.
- **Tombstone GC.** Tombstones accumulate in localStorage indefinitely — and they're each their own R2 change-object once uploaded. That's correct in CRDT terms (the tombstone IS the deletion; dropping it would un-delete the reply on next merge from a peer who still has the original). A future compactor (see the GC paragraph in the Storage layer) can replace many small change-objects with one canonical `Automerge.save` blob, which preserves the same logical state while shrinking the object count. Not implemented yet; the kilobyte accumulation at our scale doesn't justify the effort.

### Responsive

- **≥1100px (column mode):** column visible alongside the article. Highlight clicks navigate to the matching card (scroll + pulse). A *second* consecutive click on the same highlight (or graphic indicator) hides that card — equivalent to clicking the card's Hide button, but driven from the article side. The state is tracked in `lastFocusedThreadId`, which is reset whenever a click brings a previously-hidden card back (so an unhide-then-rehide doesn't happen in one click), whenever a different anchor is clicked, and whenever the focused card disappears between renders. This makes the highlight a single primitive for "show me / hide me again" rather than a one-way navigation gesture.
- **<1100px (popover mode):** the column's permanent surfaces (identity header, version banner, history panel, stacked cards) are hidden. Threads render into the DOM as before, but only the one tagged `data-mobile-active="true"` is visible — as a fixed-position overlay (`left/right: 12px`). The popover is **anchored to the tapped element**: at the moment the user taps, `computeMobilePopoverPosition` measures the anchor's `getBoundingClientRect()` and writes inline `top`/`bottom`/`max-height` so the popover appears immediately below the anchor (or above it if there's more room there). The reserved bottom region tracks `--narrate-dock-height` so the popover stays above the player dock no matter how tall it is. The computed position is stashed in `activeMobilePosition` and re-applied after every `renderAll` — a poll-driven re-render rebuilds the card element, so without re-applying the popover would snap to the CSS default. Always writing inline `top` *and* `bottom` (one explicit, one `auto`) is deliberate: a stale `top` left over from a previous desktop `repositionCards` would otherwise win over CSS specificity and force the card to stretch into a tall, mostly-empty box. Tapping a highlight or graphic indicator promotes that thread to active; tapping the *same* anchor a second time toggles it closed; tapping a *different* highlight switches the popover to its thread. Tap-outside still works as a backup dismiss. Drafts created via the action-bar Comment pill are immediately surfaced as the active popover. Multi-thread anchors still resolve to a single popover (the first thread); a stacked-popover or swipe-between flow can land later without further architectural changes.
- **Hide-all-comments button** (`.cmt-hide-all-fab`): a small circular button pinned to the top-right of the viewport (mobile-only — desktop hides it via media query, since the column itself is the affordance). Top placement is deliberate — the bottom is dense on mobile, with the narrator's "Listen" pill and the player dock competing for the same space. Pressing flattens every highlight, suppresses graphic indicators, hides the column, and dismisses the active popover. The toggle is persisted to localStorage so the choice survives reloads — useful both as a mobile distraction-free reading mode and as a desktop screenshot-clean mode. The underlying state (drafts, hidden cards, snapshot) is untouched - it just suppresses visual surfaces.

**Mobile sign-in surface.** The identity header (`.cmt-identity`) is pinned to the top-right of the viewport on mobile via `position: fixed`, stacked just below the hide-all-comments button (which keeps its top-right corner). Width is capped at `min(220px, calc(100vw - 24px))` — the desktop column is 320px wide, so the mobile pill is deliberately ~30% narrower so it reads as a compact floating widget instead of a shrunken column. Both states render: logged-out shows the pitch + Google / Microsoft provider buttons, logged-in shows the avatar + name + Sign out. Three ways the bar leaves the screen:

- A dedicated × inside the bar (`.cmt-identity-dismiss`) flips `body.cmt-identity-dismissed` and hides it for the session. *Deliberately not persisted across reloads*, so a returning reader who's never signed in still sees the affordance on the next page load.
- While a comment popover is open (`body.cmt-mobile-popover-active`, toggled by `setActiveCard`), the bar is hidden — the popover's auto-placement near the tapped anchor can land in the upper viewport, so overlapping the bar would be visual clutter. The bar re-appears as soon as the popover dismisses.
- The hide-all-comments button still suppresses the bar along with everything else in the comment system (the identity sits inside the column DOM, which `body.cmt-highlights-hidden` already collapses).

**Sign-in CTA: dim until the reader engages.** Most readers won't ever comment, so a full-strength "Sign in" card at first paint reads as nag — it's the brightest, most chrome-heavy element on a page whose job is to be read, not to convert. The logged-out identity card (`.cmt-identity-loggedout`) therefore starts at `opacity: 0.35` and only transitions to full once the reader has scrolled past ~200px. Scrolling is the cheapest available "this reader is engaging with the post" signal, and crossing that threshold is what earns the CTA the right to lean in: a one-shot scroll listener in `comments.ts` `init()` flips `body.cmt-identity-revealed` and unbinds itself, so the brightened state then sticks for the session (scrolling back to the top doesn't re-dim it — once you've committed to reading, the affordance stays full strength). Two escape hatches keep the dim state from being a usability trap: `:hover` and `:focus-within` both bring it to full opacity, so a curious mouse user or a keyboard user tabbing into the provider buttons gets a normal-contrast card; and `prefers-reduced-motion: reduce` skips the opacity transition entirely. The signed-in state is exempt — for a returning reader the card is an ID badge ("you're signed in as X / Sign out"), not a CTA, and dimming it would be confusing rather than calming. A deep-link that loads the page already scrolled past the threshold reveals immediately (checked in `init()` against `window.scrollY`) so the card isn't stuck dim with no further scroll incoming.

The dim → bright transition only pays off if the card is **still in view** when the threshold fires. On desktop the `.cmt-column` is `position: absolute` with no defined height (cards inside are themselves absolutely-positioned, so they don't contribute to its intrinsic height), which means a child sitting at the top of the column scrolls away with the document — by `scrollY=200` the identity card is already ~136px off the top of the viewport and brightening it lights up nothing. The fix is to pin the desktop identity card from the start with `position: fixed; top: 64px; right: 24px; width: 320px` (inside the `min-width: 1100px` block), where `top: 64px` matches the column's original top so the card occupies the same on-screen slot at `scrollY=0` and there is *no position swap* across the threshold — only the opacity changes. An earlier iteration only swapped to `position: fixed` *on* the threshold (gated on `body.cmt-identity-revealed`); that produced a visible teleport, since at the moment of swap the card jumped from its document position (off-screen above) to its viewport position (`top: 16px`). Mirroring mobile's pre-existing always-fixed rule sidesteps that. The trade-off it introduces: a comment card anchored very near the top of the article scrolls *under* the pinned identity card and is occluded by it — the standard cost of any pinned UI, and one we're accepting because the identity card is small (one short flex column), starts dim, and is easy to mouse over to its dismiss × if it really is in the way.

### Future direction: Web Push notifications

The core motivation of the whole auth-gated comment system — "the author wants to follow up on real questions" — currently terminates in the author's verified email and a polling viewer. There is no active notification to the author that a comment landed; they have to revisit posts or check the aggregator manually. Outbound email would close that loop but introduces a paid third-party dependency (Resend / Postmark / SES — Cloudflare has Email Routing for *receiving* mail but no outbound send API). **Web Push** is the Cloudflare-native alternative: the entire flow stays inside the Workers + R2 model already in use.

**What it solves:** when a reader submits a comment, the author's browser (or installed PWA) gets an OS-level notification with the post title and a snippet, even if they're not currently on the site. Same architecture can later notify a commenter when the author replies to their thread; same plumbing, different sender/recipient direction.

**Why Web Push fits the Cloudflare-only constraint.** The Web Push protocol ([RFC 8030][WebPushProto]) is just HTTP. The "push services" are run by browser vendors (FCM for Chrome / Edge, Mozilla autopush for Firefox, Apple Push for Safari) — they're free, no signup, no API keys, and the only credentials we need are a self-generated **VAPID** key pair to authenticate the *sender* (us) to those services. Workers can speak this protocol directly via `crypto.subtle` (ECDSA P-256 for the VAPID JWT, AES-128-GCM + HKDF for the payload encryption). No SDK with transitive deps, no separate hosted service.

**End-to-end shape:**

1. **Setup (one-time, build-time).** Generate a VAPID key pair (`crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" })`). Public key → embedded as a build-time constant in `client/`; private key → `wrangler secret put VAPID_PRIVATE_KEY`. The `sub` claim of every VAPID JWT is a `mailto:` URI for the operator (browser push services require it for abuse contact).

2. **Subscription (client, author-only).** When a logged-in user who is the author of *any* post lands on a page where they haven't yet granted notification permission, the comments column surfaces an "Enable notifications" button (gated identically to the existing aggregator surface — same `isAuthor` signal). On click:
   - The service worker is already registered (see [Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts)) — `navigator.serviceWorker.ready` returns the existing registration, no double-register footgun.
   - `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })` → yields a `PushSubscription` (an endpoint URL + two encryption keys, all JSON-serializable).
   - `PUT /push-subscriptions?user=<self>` with the subscription envelope. Stored under `push-subscriptions/<userId>/<subscriptionId>.json` in R2. Multiple subscriptions per user is normal (one per device / browser); we keep them all.

3. **Trigger (server, on comment write).** The existing `PUT /comments?post=X&user=Y&change=Z` handler doesn't change its accept/reject logic. After a successful write, it does a fire-and-forget lookup: `if postMeta.authorOf(X) !== Y, fan-out a push to every subscription under the author's userId`. The fan-out uses `ctx.waitUntil(...)` so the response to the commenter isn't blocked on the (potentially slow) push services. A failed push (HTTP 404 / 410 from the push service = subscription gone) deletes that subscription object so we don't keep retrying it.
   - The payload is intentionally tiny: `{ post, threadId, snippet, commenterName }` — enough for the SW to render a useful notification, nothing the author couldn't already see in the column. Crucially we *don't* try to ship the Automerge change here; the SW just hits the page to load it on click.

4. **Render (service worker).** `self.addEventListener("push", (e) => e.waitUntil(self.registration.showNotification(title, options)))` — `title` is the post title, `body` is `${commenterName}: ${snippet}`, `data.url` deep-links to the post (and ideally to the specific thread via a URL fragment). `notificationclick` opens that URL in a focused tab.

**What about the commenter side?** Symmetric: a commenter who's enabled notifications subscribes the same way; the trigger on author-side writes (`session.userId === postAuthor`) fans out to commenters whose `Reply.authorId` appears in any visible thread on the post. The fan-out target set is computed by reading the per-user R2 blobs the author already has access to via the aggregator. Worth its own follow-up — the v1 of Web Push would just be author-direction.

**Rate limiting and abuse.** A subscription endpoint is opaque (long random URL the browser issued — not user-controllable), so there's no spoofing surface. The only abuse vector is one logged-in commenter spamming `PUT /comments` and force-firing pushes to the author; the existing 10-PUT-per-60s rate limit already covers this. We do NOT want to start sending pushes from anywhere except a successful comment write — making push a side-effect of an already-rate-limited endpoint keeps the threat envelope unchanged.

**Limitations to call out before building this.**
- **Author has to opt in once per device.** Notification permission is browser-scoped and can't be granted server-side.
- **Safari iOS** requires the site be installed to the home screen as a PWA before Web Push works at all. Desktop Safari does work without PWA install.
- **Subscriptions expire.** Browsers can rotate the push endpoint silently (e.g., on a long absence, or a major version upgrade). The 404/410 GC step is mandatory — without it, the R2 folder slowly fills with dead subscriptions and every comment fans out to all of them.
- **No silent pushes.** `userVisibleOnly: true` is mandatory in Chromium; the SW MUST show a notification on every push. We can't use this channel for "quiet sync" — that's still the polling layer's job.
- **One Worker, one bundle.** The VAPID JWT signing and the AES-GCM payload encryption are ~100 lines of code (no library required), but they DO use `crypto.subtle` in ways that take some care to get right. A standalone `server/push/` module mirrors `server/comments/` and is testable in isolation.

**Why not just replace polling with SSE/websocket and re-render on push.** Two different surfaces with two different SLAs. SSE/websocket only fires while the tab is open — it doesn't surface "a comment landed at 2am" the next morning, which is the actual ask. Web Push is OS-level and works while the browser is closed. The polling layer also stays useful for "the page is open, show me new replies as they arrive without me reloading" — both can coexist (a Web Push handler could even broadcast to open tabs to skip the next poll, but that's a bonus, not the point).

**Status: not implemented.** The SW substrate is in place (see [Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts)) — push handlers are additive on top, no change to the existing `install`/`activate`/`fetch`. If we go ahead, the implementation lands in `server/push/`, `client/pushSubscribe.ts`, and three new event listeners (`push`, `notificationclick`, `pushsubscriptionchange`) in `client/sw.js`, with the trigger plumbed into the existing comment-PUT path. The `showNotification()` option shape (`tag` for thread collapse, `actions`, `badge`, `data`, the permission-state model) and the client-side composition (`pushManager.subscribe`, reusing the existing SW registration) are pinned down in [proposal 21 §1](./proposals/21-pwa-offline-followups.md).

### Excluded from v1

- Reply threading beyond a flat list per anchor.
- Resolve undo (resolutions are one-way until a delete-resolution endpoint is added).
- Garbage-collecting accumulated `resolvedAt` / `deletedAt` tombstones (no server-side delete sweep yet — see the [tombstone-GC note above](#lifecycle-hide-vs-resolve)).
- Sub-region selection on graphics (drag-rectangle, SVG child clicks).
- **Server-push (SSE / websocket) instead of polling.** The current polling cadence is good enough at single-author scale; SSE would slot in by replacing `CommentPolling` without touching the stores.
- **Server-side per-reply length validation.** The 32 KB blob cap + 8 KB per-PUT delta + 10/min rate limit are enforced in the Worker; per-reply 5000-char limits are client-side UX only. Strict server enforcement would require shipping Automerge into the Worker bundle (~700 KB) to parse the doc; the byte budgets above cover the same threat envelope at zero bundle cost.
- Cross-document selections (selection must stay within one of: article body OR drawer).
- **Web Push notifications** to the author on new comments. Design captured in [Future direction: Web Push notifications](#future-direction-web-push-notifications); not built.

## Auth & login (`server/auth/`)

Anonymous commenting isn't supported: the author wants to follow up on real questions by email, and there's no useful path from "Anonymous" to a deliverable address. Posting a comment or reply therefore requires logging in with Google or Microsoft first, and the reader's identity (name + verified email + avatar) attaches to every reply they write. Until the reader signs in, the comments column shows a "Sign in to comment — so I can reply by email." pane in place of the composer, with one button per provider.

### Why Google + Microsoft (not GitHub, not magic links)

The single requirement that picks the providers is: *the email we get back has to be deliverable.* That immediately rules out **GitHub** — users with "Keep my email address private" turned on report a primary email like `12345+username@users.noreply.github.com`, which is verified and unique to the user but cannot receive mail. A meaningful fraction of GitHub users have this set, and the follow-up requirement quietly fails for them.

**Google + Microsoft** together cover the vast majority of corporate and university accounts:
- Personal Gmail + any Google Workspace org (most universities + many companies).
- Personal Outlook + any Entra ID tenant from any organization (M365 companies + many universities + the long tail that's increasingly hosted in M365).

Note: The Microsoft client is registered against all possible Microsoft logins (not just personal emails)

**SAML is transparent to us.** When a user at a SAML-SSO Workspace or Entra org clicks "Sign in," Google / Microsoft silently bounces them through their corporate IdP (Okta, Azure AD, whatever) and back. We only ever speak OAuth 2.0 / OIDC to Google or Microsoft — we never see a SAML assertion, never become a SAML SP, never join a federation.

**Magic links** (enter email → click link in inbox) were considered as a third option that would cover the literal long tail including Shibboleth-only universities. Rejected for v1 to avoid the email-sending dependency (Resend / Postmark / SES). Can be added later as a third button without disturbing the OAuth code path.

### Why arctic

[`arctic`](https://arcticjs.dev/) is a small (no transitive deps), provider-agnostic OAuth 2.0 + OIDC helper. It handles just creating the authorization URL and verifiying the authorization code, leaving everything else (sessions, storage, UI, CSRF binding) to us. That asymmetric "library does one thing" boundary fits this project better than the alternatives

### Userinfo from `/userinfo`, not from a decoded ID token

Both providers return an ID token (a JWT) in the code-exchange response. A pedantic OIDC client would verify the JWT signature against the provider's JWKS, then trust the claims inline. We don't. Instead we take the access token from the same response, call the provider's standard `GET /userinfo` endpoint over TLS, and use the JSON body.

The trust model is the same either way: in both flows we trust that we're talking to the real provider because we just completed an HTTPS handshake against `accounts.google.com` / `login.microsoftonline.com`. Doing the userinfo call costs one extra round trip; doing JWT verification costs a JWKS fetch + caching layer + algorithm allowlist. The round trip is much cheaper to maintain.

One Microsoft-specific wrinkle: the OIDC `email` claim is sometimes blank for work accounts whose admin configured a non-mail UPN; in those cases `preferred_username` is the address. We fall back to it. Microsoft doesn't emit `email_verified` because Entra owns the address namespace — anything it returns is verified by definition.

### Sessions: JWT cookie (HS256, `jose`)

Sessions are stored entirely in a single `HttpOnly` cookie holding a standard **JWT** (RFC 7519), HS256-signed via [`jose`](https://github.com/panva/jose) — a real `<header>.<payload>.<signature>` JWS compact serialization, so jwt.io / the `jose` CLI / any JWT debugger reads it, and `jose` owns the constant-time verify plus the algorithm allowlist (`{ algorithms: ["HS256"] }`, the standard `alg:none`/confusion defense). `iat`/`exp` are seconds since epoch per the spec. TTL is 400 days, which is the practical max — Chrome (since v104), Firefox, and Safari all clamp any cookie `Max-Age` beyond that to 400 days. Sliding-window refresh (re-mint on each authenticated request to keep active users logged in indefinitely) is a follow-up. `jose` runs on Web Crypto (`globalThis.crypto.subtle`), so `verifySessionToken` — and the `getSessionFromRequest` → `whoami` callers it feeds — became `async`; the migration also drops the `node:crypto` HMAC the bespoke format relied on.

**Revocation is by key rotation, via the JWT `kid`.** Every token's header carries a `kid` (`v1` today); the verifier resolves the signing key from a small in-memory map built from env. Two accepted shapes: `SESSION_SECRET=<secret>` (single key, becomes `v1`) or `SESSION_SECRETS=v1:<secret>,v2:<secret>` (explicit `kid`→secret map for rotation). To rotate: add a new key, bump `ACTIVE_KID` so new tokens sign with it, and old tokens keep verifying against their `kid`'s key until you drop it — zero-downtime, and dropping a key force-logs-out *exactly* that cohort. This closes the gap the previous bespoke format had, where the only revocation was rotating the one secret and invalidating **every** active session at once.

**Why [JWT] and not [PASETO], and why no `iss`/`aud`.** PASETO removes the `alg`-confusion footgun at the *format* level (the algorithm is implied by the version — `v4.local`, `v4.public` — so there's no `alg` field to lie about and no `none`). We use JWT anyway: it's what the OAuth/OIDC stack we already speak talks (arctic, Google, and Microsoft all issue JWTs), it has the debugger tooling (jwt.io, the `jose` CLI) PASETO lacks, and `jose`'s hard-pinned allowlist neutralizes the `alg` footgun for us without changing formats. PASETO would only win for a greenfield system with no OIDC neighbors — not us. We also deliberately omit `iss`/`aud`: for an open-source tool with many *independent* deployments, the security boundary is the **per-deployment `SESSION_SECRET`**, not the shared codebase — a token minted at one site fails the HMAC check at another *before* `aud` is ever consulted, so the signature already **is** the cross-deployment audience check. `aud` adds protection only when two verifiers *share* a key (and even then "use a distinct secret per site" closes it for free); a constant `iss="presidocs"` is identical across deployments, distinguishing nothing the signature doesn't. Both are ~30 harmless bytes, trivially added later if a key-sharing second service ever appears (`kid` would already be in place).

**What the user experiences at expiry (after 400 days, or any invalid cookie).** Identity is loaded once at boot from `/auth/me` and cached for the page's lifetime (`client/identity.ts`); the cookie's `Max-Age` and the JWT `exp` are both 400 days, so they lapse together. Two cases:
- **Next visit after expiry** (the common path): the browser has already evicted the expired cookie, so `/auth/me` returns `null` and the page renders the logged-out state with provider login buttons. Clicking one runs the normal OAuth flow with `return_to` set to the current path, landing the user right back where they were — usually a single redirect, since the IdP session typically persists. No error screen, no data prompt; just a "signed out" UI until they click.
- **Mid-session expiry** (sitting on an already-loaded page as it crosses the boundary — vanishingly rare at a 400-day TTL): identity isn't re-fetched, so the UI keeps *looking* signed-in. New comments still write to `localStorage` immediately (no data loss), but each background sync `PUT` now 401s and is logged to the console — the comment stays local and un-synced until the user reloads and re-authenticates. This is the *"mid-session identity refresh"* gap listed under **Excluded from v1** below: low-impact at 400 days, but the first thing to fix before shortening the TTL.

Either way nothing is silently lost: unsynced comments persist in `localStorage` and flush to R2 on the next authenticated load.

**Why not a server-side session store** (R2 blob keyed by random session id, KV with a TTL, etc.). For comments specifically, the worst case of a stolen cookie is "someone posts as you for up to 400 days." That's not access to anything destructive — no admin panel to walk into, no money to move, no DMs to read. Paying one storage read per authenticated request to gain individual-session revocation isn't worth it at this risk level. If revocation ever does matter, every route handler in `server/auth/routes.ts` goes through `verifySessionToken(token)` exactly once — swap that implementation for a KV / R2 lookup and nothing else changes.

### OAuth flow plumbing

Per provider, the flow is:
1. `GET /auth/<provider>` — generate `state` and a PKCE `code_verifier`, store both in short-lived (10 minute) `HttpOnly` cookies named `blog-oauth-state-<provider>` and `blog-oauth-verifier-<provider>`, then 302 to the provider's authorization endpoint.
2. (user authenticates, possibly through their org's SAML IdP)
3. `GET /auth/<provider>/callback` — verify the returned `state` matches the cookie's, exchange the code for tokens, hit `/userinfo`, mint the session cookie, 302 home.

The state / verifier cookies are deliberately **bound to the provider** in their cookie names, so a stale callback from one provider can't be replayed against the other's in-flight flow. PKCE (`S256`) is on by default — arctic generates the verifier and challenge for us.

`GET /auth/me` returns the public subset of the session (no `iat`/`exp`) as JSON, or `null` if not logged in. `POST /auth/logout` clears the cookie.

### Excluded from v1

- **GitHub provider** (re-introduces the unreachable-noreply-email problem).
- **Magic-link fallback** for the Shibboleth-only long tail.
- **Server-side session revocation** (would require switching `verifySessionToken` to a KV / R2 lookup).
- **Mid-session identity refresh.** `/auth/me` is read once at boot; an expired cookie mid-session leaves the UI looking signed-in until reload. Writes still hit localStorage immediately (so no data loss), but the per-write PUT to R2 silently 401s until the user reloads and re-auths. Low-impact at the current 400-day TTL but a real footgun to clean up before any meaningfully shorter session expiry.
- **ID token signature verification** (we trust TLS to the provider + the `/userinfo` round trip instead, see above).

## Per-post author metadata (`server/postMeta.ts`)

Authorship is **per-post**, not site-wide. Each post HTML declares its author in a head meta tag:

```html
<meta name="author-email" content="you@example.com">
```

The server resolves "who is the author of this post?" by looking up the request's `?post=` path in an in-memory map and comparing the result to the session's verified email.

### Why email and not userId

The Cloudflare-canonical move would be to store the author's stable `<provider>:<sub>` userId (e.g. `google:1234567890`) rather than an email — userIds don't change when the user updates their primary address at the provider, and they're never used as a contact channel so they don't attract spam.

We picked email anyway, because:
- **The author already knows their email.** Looking up your `sub` requires signing in once and reading `/auth/me`; pasting your email in a meta tag doesn't.

The spam concern is mitigated by the build pipeline: the meta tag exists in **source** HTML (the author edits it there; the generator reads it there) but is **stripped from the served HTML** during the build process (crawlers hitting prod see no `author-email` tag). The server-side author lookup doesn't depend on the tag being in the served response — it reads the source HTML at build time (via the content repo's `.generated/postMeta.ts`) or dev startup (via `server/postMeta.dev.ts`), so dropping it from the response is purely cosmetic.

**Client-side author detection** can't read the stripped tag in prod, so it instead reads the server-computed `isAuthor` boolean returned by `GET /post-version?post=X`. Every author-only client surface (the aggregator, the resolve-foreign-thread button, the version history panel) gates on this single signal. The post-version endpoint is fetched once at boot before any author-only decisions are made; failure to fetch defaults to non-author, matching the safe-degrade behavior elsewhere.

The same strip step also removes other source-only tags from served HTML — see [Build-time HTML strip](#build-time-html-strip-generatestrip-served-htmlts).

### Email-verified check

The author check requires `session.emailVerified === true`. Without that gate, an attacker who controls an OAuth app with weak email verification (or one that accepts user-supplied emails without verification) could log in with the author's email and be treated as author.
- Google sets `email_verified` based on its own verification
- Microsoft doesn't emit the field (we treat that as verified)

### Dev + prod parity

- In dev builds, `posts/*.html` is the source of truth
- In prod builds, we use only the generated files (`wrangler dev` works without a build step)

### Author profiles and bylines (`shared/authorProfile.ts`, `client/byline.ts`)

A reader should see *who wrote a post* — name, photo, and social links (X first, but the convention generalizes). The author-email is the only per-post author signal, and it's the join key here too: author **profile** data is author-level, not post-level, so it lives in the per-author `authors/` folder keyed by email — the **same folder** (and same email key) the [voice clip](#per-author-voice-resolution) uses:

```
authors/<author-email>.json    { name, handle?, links?, avatar? }
authors/<author-email>.png     avatar (or .jpg/.jpeg/.webp)
authors/<author-email>.wav     voice-clone clip (build-only input, never served)
```

Discoverable by file listing, no central config to keep in sync, one author onboarding is a few file commits, **no env-var fallback** — the same reasoning (and the same `safeEmailComponent` path guard, shared from `voiceResolution.ts`) as the voice clip. `resolveAuthorProfile` returns a structured failure naming the gap; a post whose author has no resolvable profile is logged and simply gets **no byline** (degrade, don't fail the build). One folder per author keeps the runtime-boundary honest in a different way: only the `.json`/avatar are published (the avatar copied under a public handle, §below), while the `.wav` is read only by the offline build — so co-location doesn't blur "served" vs "build input".

**The load-bearing constraint: the served byline must never re-leak the email.** The whole reason `<meta name="author-email">` is [stripped from served HTML](#why-email-and-not-userid) is to keep the address away from crawlers. So the email is *only ever a disk/join key* — every value that reaches the client is derived from the public **`handle`** (a sanitized, lowercased slug from the explicit `handle`, else the X link's last segment, else a name-slug), never the email. The served avatar lives at `/assets/authors/<handle>.<ext>`, not `/.../<email>.<ext>`, and the public map the client fetches (`/assets/authors.json`, keyed by post path) carries no email at all. A build-time check confirms `dist/` contains no address.

**The byline is rendered client-side** (`client/byline.ts`), a progressive-enhancement module like the player, comments, and figures — *not* injected into the HTML at build time. The reason is structural: a post is served as an **opaque static bundle in both dev and prod** — Bun's `HTMLBundle` in dev (which can't be rewritten the way the player/comments references are; see `createDevServer.ts`) and Cloudflare's `ASSETS` binding in prod. Only `dist/` gets the [post-build HTML rewrite](#build-time-html-strip-generatestrip-served-htmlts), so a build-time *body* injection would appear in prod but not dev — exactly the drift the rest of the architecture avoids by making in-page features client modules. Client rendering is the one path identical in both. (Crawler/no-JS author metadata is not lost: it's emitted into `<head>` as JSON-LD/Open Graph at build time — see [Structured data](#structured-data-schemaorg-open-graph-twitter-card-sharedinjectstructureddatats). The visible byline is for humans; the structured data is for machines.)

**One builder for dev and prod** (`buildAuthorMap`): the prod build (`copy-static.ts`) writes `dist/assets/authors.json` and publishes each avatar under its public handle; the dev server serves the identical map and avatars fresh per request from the same function — so a new post or edited profile shows on reload without a restart, and dev/prod bylines can't diverge.

**Byline CSS lives in `client/base.css`, not `narrator.css`** — for the same reason the page-global layer was extracted there (see [Opting out of narration](#opting-out-of-narration)): the byline must appear on **every** post, including narration opt-out posts that never link `narrator.css`. The article root is found via the shared `[data-narration-src]` selector (present even on opt-out posts), and the block is inserted after the lede (or the title).

**Social-link icons (FontAwesome Free v7 SVGs, inlined as text).** Each entry in the profile's `links` map (`{ x, github, bluesky, mastodon, … }`) renders as an icon-only anchor: the brand mark is inlined as `<svg fill="currentColor">` and `aria-label`/`title` carry the human label so it stays readable to screen readers and hover-discoverable to sighted users. We import the SVGs as text (`import faGithub from "@fortawesome/fontawesome-free/svgs/brands/github.svg" with { type: "text" }`) — so they end up in the JS bundle directly: no webfont, no extra `<link>`, no second-asset fetch, and nothing for the CSP's `font-src 'self'` to govern. `fill="currentColor"` means the icon inherits the anchor's text color and hover state without any new CSS plumbing. The chosen-vs-fallback split mirrors the `links` map itself: a known brand key resolves to `{ label, svg }` and renders the icon; an unknown key still renders the link, just with its key as plain text — adding a new brand is one SVG import + one map entry. (We considered the `fa-github` CSS-class approach with the FontAwesome webfont, but it would require both relaxing `font-src` for the woff2 and shipping a second stylesheet whose `@font-face url()` references Bun's bundler would have to rewrite; inline-SVG dodges both.)

**"Last updated" lives in a `.post-meta` strip directly under the `<h1>` title — separate from the byline.** The byline is *author identity* (avatar + name + social links); the meta strip is *article metadata* — currently `Last updated <date>`. The placement under the title (rather than under the lede or next to the byline) is the standard blog pattern — NYT/Guardian/Substack put the date here. The strip rides a `-24px` negative top margin to read as a subtitle line rather than a separate paragraph block. The calibration holds across every post because engine-layout (not any per-post sheet) owns the default `<h1>` margin — so the constant is paired with a shared baseline, not tuned to one specific post's title sizing. A post that genuinely wants a different gap can override `.post-meta { margin-top: <x> }` from [`@layer post`](#cascade-layer-architecture-clientbasecss-clientnarratorcss-clientcommentscss).

**Engine attribution (`buildEngineAttribution`).** Every post ends with a subtle `Built with presidocs` line linking to the engine's GitHub repo — appended in the same `client/byline.ts` boot pass as the follow-CTA, sharing its `[data-narration-src]` anchor so it appears on narration opt-out posts too. Independent of the author profile (no data dependency), so it always renders; muted `--page-fg-muted` styling and no card framing so it never competes visually with the follow-CTA above it. The URL is hardcoded — a downstream blog that wants the attribution gone overrides one CSS rule (`.engine-attribution { display: none }`); the engine doesn't add a config knob for it because hiding an `display: none`-able element is already the lowest-friction opt-out the platform offers, and a config flag would be one more dev/prod synchronization point for negligible gain.

## Cascade-layer architecture (`client/base.css`, `client/narrator.css`, `client/comments.css`)

Two coexistence problems shape the engine's CSS architecture:

1. **Engine-owned UI lives inside the post's `<article>`.** The `.post-meta` strip, the `.byline`, the `.author-cta` follow-CTA, the `.engine-attribution` line, and the per-heading `.heading-link` icon are all engine-injected children of the article. That placement is load-bearing — the comment-anchor model, the JSON-LD `mainEntityOfPage` semantics, and the player's `[data-narration-src]` mount all assume the byline and its peers are part of the article entity. The cost is cascade exposure: a per-post stylesheet that scopes its rules to an article-level class shares an ancestor with these components, so a generic selector in the post sheet (an `a` rule, a typography reset) can reach into engine UI it never intended to touch.
2. **The engine's article-level defaults must apply to every post.** Article column width, heading rhythm, lede sizing, inline code — these used to live in `narrator.css`, which only loads on narration posts. Opt-out posts had to redefine the same defaults in their own per-post sheets, and the two sets drifted. "Shared across all posts" should be owned at the page-global layer, not duplicated per narration mode.

Both are solved by the same structural mechanism: **CSS [cascade layers](https://www.w3.org/TR/css-cascade-5/#layering) (`@layer`)** declare an explicit precedence between groups of rules, so each concern lives in its own layer and the cascade resolves them by *ordering*, not by what selectors the post sheet ends up writing. The layer order is declared once, at the top of `client/base.css` (the first stylesheet every post links):

```css
@layer engine-tokens, vendor, engine-layout, post, engine-components;
```

**These are flat, distinct top-level layer names — deliberately not dotted sublayers (`engine.tokens`, …).** A dotted name nests every `engine.*` under a single `engine` layer whose position is pinned at its *first* mention. Because `engine-tokens` is mentioned before `vendor`, that `engine` layer would sit before `vendor`, dragging `engine-components` (a sublayer) down *with* it — so the player and comments overrides would lose to Shikwasa's `@layer vendor` defaults. And the interleaving this order depends on — `vendor` between tokens and layout, `post` between layout and components — simply can't be expressed when those names share a parent. The trap is silent in `bun run dev` (Bun's HMR serves each CSS file as its own sheet and the override happens to win on selector specificity), and only surfaces in the bundled prod CSS (`bun run build` / `dev:edge`), where the single merged stylesheet honors the nested-layer ordering and the player reverts to Shikwasa's default 120px chrome. Keep the names flat; don't "tidy" them into an `engine.*` namespace.

Five named layers, in cascade-precedence order (later wins):

- **`engine-tokens`** — `:root` design tokens (`--page-fg`, `--page-fg-muted`, `--page-bg`) and the `box-sizing: border-box` reset. Lowest precedence so a post can rebrand a token from `@layer post` without `!important`.
- **`vendor`** — third-party stylesheets routed through this layer (today: the Shikwasa audio-player CSS, via `client/shikwasa-vendor.css`). Vendors ship their CSS unlayered, which would otherwise beat every layer — wrapping them in `vendor` demotes them to the lowest-precedence layer that touches their selectors, so the engine's overrides in `engine-components` win by ordering rather than by chasing the vendor's selector specificity. Inlined rather than `@import`ed because Bun's CSS bundler doesn't resolve bare npm specifiers from inside CSS — see `client/shikwasa-vendor.css` for the refresh-on-upgrade procedure.
- **`engine-layout`** — everything every post should look the same on: page-global `html`/`body` typography, `scroll-behavior`, the `.site-footer` block, the **article container** (`max-width: 768px` — matching the column width major reading apps converged on, top margin, side padding), the default heading rhythm (`article h1`/`h2`/`h3`), `.lede` sizing, inline `code` styling. Lives in `base.css`, not `narrator.css`, so it applies whether or not the post loads the player. Declared below `post` so a post that wants a wider column or a bigger title still wins from its own `@layer post`.
- **`post`** — every per-post stylesheet (`figures/*.css`) opts in by wrapping its rules in `@layer post { … }`. Article-body styling — titles, paragraphs, prose anchors, figures, tables, callouts — lives here. Stylesheets that don't opt in stay unlayered and keep today's behavior, so the migration is incremental: no opt-in is a regression, only a missed protection.
- **`engine-components`** — the five article-children components above, plus the rest of `narrator.css` (the floating player dock, chapter strip, `.narration-active` highlight, the player-reservation `padding-bottom`) and `comments.css` (the action bar, cards column, highlight spans). Declared last so it doesn't matter whether a post sheet writes `a`, `article a`, or `.<slug> a`: the engine rule wins by layer ordering, the byline icons stay `--page-fg-muted`, the follow-CTA stays neutral, the "Last updated" line stays in its calibrated slot, the heading-link affordance keeps its hover behavior, and the comments / narration UI render the same way across posts.

**The escape hatch is unlayered.** A post that *deliberately* wants to restyle an engine component writes an unlayered rule — no `@layer` wrapper — because **unlayered rules beat every layer**, regardless of specificity. So the override surface is preserved: a downstream blog that wants the engine attribution gone still writes `.engine-attribution { display: none }` (and `display: none` collapses the element across the cascade-layer fence regardless of property resolution); a blog that wants pink byline icons writes an unlayered `.byline-link { color: hotpink }`. The change is that *accidental* overrides — a post-scoped `a` rule reaching into the byline — no longer happen.

**Post-meta sits on a calibrated negative top margin, paired with a shared baseline.** Inside `engine-components`, `.post-meta { margin: -24px .25rem 0 }` pulls the strip up against the title so it reads as a subtitle line. The constant only works because `engine-layout` owns the default `<h1>` margin — every post inherits the same h1 rhythm by default, so the -24px is calibrated against a fixed baseline rather than a moving target. A post that overrides h1 margins from `@layer post` is making a deliberate departure and is expected to override the post-meta margin alongside it; the inverse problem (engine guessing what arbitrary h1 sizing each post might choose) is exactly what owning the default at the engine layer avoids.

**Why this over the alternatives.** Three approaches were considered and rejected. (1) **Move engine components outside `<article>`** — would fix the cascade leak but breaks the article-as-`mainEntityOfPage` JSON-LD invariant, breaks the comments-layer block walker assumptions, and doesn't address the meta-strip positioning bug (which is layout, not cascade). (2) **Shadow DOM per engine component** — bulletproof style isolation, but loses text selection across the boundary, loses the documented `display: none` opt-out, and is architecturally heavy for a five-component surface. (3) **`all: revert-layer` on engine-component roots** — works in principle but is a wrecking ball: resets `box-sizing`, `font-family`, every inherited property, every animation, requiring a long piecemeal re-application list that duplicates what `engine-components` already says. The layer ordering gets the same "engine wins" outcome without any of those costs.

**Authoring contract.** Per-post stylesheets opt into `@layer post`; the rule is spelled out in [`authoring/authoringRules.md`](./authoring/authoringRules.md). A future build-time lint that flags unlayered selectors matching engine-component classes (or unscoped `a`/`h1`/`p` rules inside the article) is **deferred** — the layer ordering prevents the bug, so the lint is at most a quality-of-life check on top, worth revisiting only after we see whether authors still trip on the surface.

## Heading deep-links (`client/headerLinks.ts`)

A long-form post is read in pieces — a reader (or the author, sharing context with someone) should be able to copy `…/posts/foo#problem-heading` to a section, not just the post. The minimum we want: an icon-only "copy link" affordance on every heading, discoverable on hover, that copies the absolute URL with brief feedback. Like the player, comments, byline, and figures, it's a progressive-enhancement client module — and lives in [`base.css`](#opting-out-of-narration), not a feature stylesheet, because every post needs it including [narration opt-out posts](#opting-out-of-narration) that never link `narrator.css`.

**A real `<a href="#id">`, not a `<button>`.** Plain click is the primary path, but right-click → "Copy link address" and Cmd/Ctrl-click → "Open in new tab" come along for free, and the heading stays semantically self-linked for screen readers and crawlers. The click handler then `preventDefault`s the native hash-scroll — the reader is already *looking* at the heading, so jolting the viewport on a "copy" gesture is the wrong default — copies the URL, and reflects the section in the address bar via `history.replaceState`. Replace, not push: repeated clicks shouldn't pile up history entries the user would have to press Back through. Modifier-key clicks (Cmd/Ctrl/Shift/Alt, and any non-primary button) early-return so the browser's native handling stays untouched.

**Author-supplied ids are preserved; missing ones are backfilled with slug-of-text.** A heading with no `id` gets `slugify(textContent)` (lowercased ASCII, hyphen-collapsed, deduped against every existing id in the document with a `-2`/`-3` suffix). Existing ids are left alone — this is load-bearing because the same heading ids anchor both [the `<mark name>` ↔ `id` pairing](#connecting-spoken-text-to-blog-content) the narration depends on and [comment threads keyed `id:<heading-id>`](#anchoring-the-web-annotation-target-model). Silently re-slugging an author-written id would orphan every anchor that points at it.

**Hash-stability for comments.** The comments layer hashes each block's `textContent` and flags a mismatch as [outdated](#stale-anchors-orphan--flag), so appending the link icon must not change `textContent`. The icon is built from FontAwesome SVGs whose markup contains only `<path>` (no text nodes — the FontAwesome attribution lives in a `<!-- -->` comment, which isn't part of `textContent`), wrapped in `<span>`/`<a>` elements that carry only `aria-label`. None of those tags are in the comments walker's [`BLOCK_TAGS`](#comments-clientcommentsts) set either, so the icon is invisible to the block walker too — no new commentable block, no hash drift on existing ones.

**Position and visibility — left gutter on hover, inline-after-text on touch.** On hover-capable devices the icon sits in the left gutter (`position: absolute; right: 100%`) — the GitHub/Docusaurus convention readers already know — and is hidden via `opacity: 0` until any of `h2/h3/h4:hover`, the icon's own `:hover`, or `:focus-visible` fires (so Tab-users can reach it via keyboard). On `@media (hover: none)` the gutter trick fails — a narrow mobile viewport hugs the left edge, so an absolute icon at `right: 100%` clips off-screen — so the touch fallback switches to `position: static` (inline after the heading text) and `opacity: 0.55` (always faintly visible, since there's no hover to trigger the reveal). Scope is `h2`/`h3`/`h4`: `h1` is the page title (the URL already points at it), `h5`/`h6` rare enough in long-form prose to skip until a need shows up.

**Scroll re-anchor on *load*, never on click.** When someone arrives with `#problem-heading` already in the URL, the browser's initial hash-scroll fires *before* progressive-enhancement modules (byline injection, this module's id-backfill) finish settling the DOM. The targeted heading may have moved by the time JS is done, so `reanchorToHashIfNeeded()` runs once at the end of `boot()` and re-`scrollIntoView`s the target. The click-copy path doesn't re-anchor (the heading hasn't moved) and explicitly suppresses the scroll — different cases, opposite handling. The `html { scroll-behavior: smooth }` rule (with a `prefers-reduced-motion` override) lives in `base.css` so any future in-page anchor (TOC, drawer link, anything) gets smooth-scroll for free without each feature wiring its own.

## Testing layout

Tests are colocated with the code they cover — `<module>.test.ts` sits next to `<module>.ts` rather than in a separate `tests/` tree, matching how `types/` and `proposals/` are absent in favor of "the code owns its own surface." `bun test` is the single entry point; the `presidocs/package.json` `test` script runs nothing more elaborate than that.

The suite splits into three layers by what each test needs from the runtime:

- **Server / generate / shared** — the bulk of the tests, exercising offline pipeline code (`generate/`), the Worker entry points (`server/`), and runtime-agnostic helpers (`shared/`). These run in plain Bun: no DOM, no preload, no fetch stubs at the file boundary. Anything that runs only on the offline build or the edge belongs here.
- **Client (DOM) — per-file opt-in happy-dom** — see [DOM testing harness](#dom-testing-harness-clientts) below.
- **Tier-0 pure extractions** — math/string functions lifted *out* of DOM-coupled client modules into `shared/` so they can be tested without happy-dom. `shared/narratorTiming.ts` (mark + word bisect) is the canonical example; `client/commentsStale.ts` (segment-hash drift check), `client/narratorDom.ts` (hash parsing, capture-controls localStorage, keyboard-shortcut guard, top-level chapter resolver), and `client/commentsDom.ts` (block walker, popover-placement math, hide-all storage) follow the same pattern. The rule: anything testable as `(input) → output` lives outside the class, gets a dedicated `.test.ts`, and runs without any DOM. The DOM-coupled wrappers in `narrator.ts` / `comments.ts` then call into these helpers, so a regression in the math is caught at the pure-test layer before it can reach a DOM test.

### DOM testing harness (`client/*.ts`)

Client modules target the browser, not the Bun runtime, so testing them needs `document` / `window` / `localStorage`-as-Storage. We use **happy-dom**, registered per-file rather than via a global Bun preload.

**Registration is per-file via `import "../happydom.ts";`**. The helper at `presidocs/happydom.ts` calls `GlobalRegistrator.register()` exactly once (a `globalThis.__HAPPY_DOM_REGISTERED__` flag short-circuits subsequent imports). Each DOM test file's first import is `"../happydom.ts"`, before any import of the module under test — happy-dom must install `document` before the module's top-level code runs.

**Why per-file, not the docs-recommended global `[test] preload`.** The happy-dom docs recommend a `bunfig.toml` entry like `preload = ["./happydom.ts"]` that registers the browser environment for *every* test file. Tried, rejected. Two concrete breakages in the existing server / generate suite:

1. **`commentsStore.test.ts`'s `localStorage` shim** — the file installs an in-memory `localStorage` for testing the CRDT store outside a browser. happy-dom registers `globalThis.localStorage` as a *non-writable* property (`Object.defineProperty` with `writable: false`), so a plain `globalThis.localStorage = shim` assignment throws once happy-dom has run. Defensible fix: rewrite the shim install as `Object.defineProperty(globalThis, "localStorage", { value: shim, writable: true, configurable: true })`. That's now the project pattern for ANY test that wants to replace a happy-dom-installed global (the same shape is used in `client/postVersion.test.ts`'s `fetch` stub).
2. **`audio-pipeline.test.ts`'s `Bun.spawn` calls** — happy-dom mutates fields on `process` (its own browser shim for `process.stdio` triplet semantics differs from Bun's), and `Bun.spawn`'s stdio config rejects the mutated shape with `TypeError: stdio must be an array of 'inherit', 'ignore', or null`. There's no clean shim for this on the test side; the fix is to keep happy-dom out of those tests entirely, which per-file opt-in does for free.

Per-file opt-in keeps happy-dom's blast radius scoped to exactly the files that ask for it. The docs' advice still applies for projects that are 100% browser-side; in this mixed engine, per-file is the right tradeoff.

**One `beforeEach` reset.** Every DOM test starts with `beforeEach(() => { document.body.innerHTML = ""; })`. Without it, fixture markup from one test pollutes the next within the same file. Tests that also touch `localStorage` follow with `localStorage.clear()`, and tests that replace globals (the fetch stub pattern) restore them in `afterEach` via `Object.defineProperty`.

**What's tested in this layer.** Pure-DOM construction and pure-state-machine logic in the four DOM-coupled client modules:

- `client/narratorDom.ts` — chapter-number resolver, divider-speaker "first below" element, capture-controls localStorage round-trip, keyboard-shortcut focus / modifier guard, deep-link hash parser. The full Narrator class isn't tested directly — its constructor needs Shikwasa Player, which needs real `<audio>` decoding (see "deliberately not tested" below).
- `client/commentsDom.ts` — block walker, hash-stability `normalizeText`, mobile popover placement math, hide-all FAB localStorage. The full CommentSystem class isn't tested directly — it needs Automerge boot, identity fetch, polling controllers, and a CRDT store, all of which the same-file `commentsStore.test.ts` already exercises at the data layer without a DOM.
- `client/byline.ts` — placement rules (under `#lede` if present, else under `#title`, else prepended), profile rendering, the privacy property that the served avatar URL never embeds the author email, post-meta date formatting.
- `client/headerLinks.ts` — slugify rules + dedupe, idempotent id backfill, anchor injection.

**What's deliberately NOT tested in this layer.**

- **Anything that needs real audio playback** — the rAF tick reading `player.currentTime`, the active-mark application path (`updateActive` → `setActive`), Shikwasa's chapter-strip rendering, OS lock-screen widgets. happy-dom has a JS-visible `<audio>` element but no decoder, so `play()` doesn't advance time and `timeupdate` doesn't fire. The pure math (`computeActiveMark`, `findActiveWord` in `shared/narratorTiming.ts`) is covered server-style; the integration is covered by the manual release-check at `scripts/release-check.md`.
- **Real CSS layout** — `repositionCards` (Google-Docs-style overlap avoidance), the desktop comment column's pinned identity card, the dim-on-load → reveal-on-scroll threshold for the sign-in CTA. happy-dom returns zeros for `getBoundingClientRect()` unless a test hand-mocks each element's rect, which produces tests that pass only against their own fake. The integration is real-browser territory; the manual checklist covers it.
- **Service Worker installation, push delivery, OAuth redirects, OS clipboard** — substrate behaviour the browser owns. No automated test in any tier here can verify these meaningfully; manual is the only honest layer.
- **Tier-2 modules where the bug-cost hasn't yet justified the test** — `identity.ts`, `commentsSync.ts`, `commentsAggregator.ts`, `resolutionsStore.ts`, `commentsPolling.ts`, `commentsApi.ts`, `resolutionsApi.ts`. Each is a small fetch wrapper or single-flight controller; the contract surface is exercised end-to-end by the integration of the modules that consume them. The rule is "first concrete regression motivates the test, not speculation."

**No real-browser harness (today).** No Playwright, no WebdriverIO, no Puppeteer. The case-by-case analysis is in `scripts/release-check.md`; the short version is that real Chromium tests would either re-verify what happy-dom already covers (the JS-visible API surface) or test substrate behaviour that no Chromium-from-a-test can actually reach (the OS surface). The PWA + Service Worker foundation has shipped ([Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts)), so the SW lifecycle is now the first feature where the marginal value of real-browser testing is real. Today it's covered by a manual `dev:edge` smoke (DevTools → Application → Service Workers shows "activated and is running"; a code change cleanly transitions vN → vN+1 with `clients.claim()` taking over the next navigation — recipe in [Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts)). A Playwright/Puppeteer-driven SW lifecycle test would be the natural place to formalize this if the substrate grows beyond the four current handlers.

**No workerd test pool (today), but the door is open.** Cloudflare's [`@cloudflare/vitest-pool-workers`][CFVitestPool] runs tests inside the same workerd runtime the prod Worker uses, with real binding emulation. It would be a natural fit for any future `worker.ts` logic that's hard to prove against a plain-Bun handler test — Service-Worker version-rollout fallback ([Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts)), Rate-Limiter edge cases, or any path where the workerd-vs-Bun runtime difference is itself the thing under test. We don't run it now because `worker.ts` is a thin route table over runtime-agnostic handlers that already get covered in plain-Bun tests, and the `dev:edge` smoke check exercises the workerd path end-to-end before deploy. First concrete regression that the plain-Bun harness can't catch motivates wiring it in.

[CFVitestPool]: https://developers.cloudflare.com/workers/testing/vitest-integration/

## AI-assisted authoring (`authoring/` + the `process-comments` skill)

The comment system isn't just a feedback channel — it's the authoring interface itself. The author opens their own post, highlights text, leaves comments like "rephrase this", "add a paragraph about edge cases", etc. — through exactly the same UI a reader uses. The loop:

1. Publish the post.
2. Readers (and the author, on a re-read) leave comments through the in-page column.
3. In a Claude Code session, run the **`process-comments` skill** (`/process-comments <slug>`). It pulls every unresolved thread — readers' + the author's own — edits the post HTML in place to address them, and resolves the ones it addresses, with the author reviewing each change live and steering across passes.
4. Author regenerates audio (`bun run generate`) and redeploys (`bun run build && wrangler deploy`).

**Author-self comments and reader comments are treated identically.** "Rephrase the avalanche-effect paragraph to mention SHA-256 explicitly" (left by the author) sits in the same working set as "is this really deterministic for streaming inputs?" (left by a reader). The skill makes one coherent set of edits across both. That synthesis is the point: separating "what the author wants to change" from "what readers want explained" loses the case where one edit addresses both.

### How the loop works (the `process-comments` skill)

The skill (`.claude/skills/process-comments/SKILL.md`) runs inside an ordinary interactive Claude Code session and drives:

1. **Sync down** the production comments — `bun run pull-comments <slug>` — so the local store mirrors what readers actually left (see [Syncing production comments](#syncing-production-comments-authoringr2syncts)). On a not-yet-published / localhost-only post there's nothing in R2 and this is a harmless no-op.
2. **Fetch** the open comments — `bun authoring/exportAnnotations.ts <slug>` — as a Web Annotation `AnnotationCollection` (see [Inputs the skill sees](#inputs-the-skill-sees)).
3. **Read the editing rules** (`authoring/authoringRules.md`) and the post, then **edit `posts/<slug>.html` in place**.
4. **Report a verdict per thread** (`APPLIED | PARTIAL | NOTE-ONLY`) and **pause for the author** to review (`git diff`), request changes, or ask for another pass.
5. On the author's sign-off, **resolve the `APPLIED` threads** — `bun authoring/resolveThreads.ts <slug> <id…>` — and **push the resolutions back** — `bun run push-resolutions <slug>` — so production hides them for the original commenters (see [Resolution write-back](#resolution-write-back-resolve-iff-shipped)).

### Why local tooling, not in-Worker or the browser

The same three-runtime split that shapes the rest of the project (see [Deploy architecture](#deploy-architecture)) applies: Bun + the author's local Claude Code for dev/build-time, Workers for prod request handling, browser for reader UI. AI authoring lives in the local bucket:

- **Workers can't host it.** A pass over a long post can take minutes; Workers target second-scale request handling, not multi-minute interactive editing the author watches.
- **The browser can't hold credentials.** Whether an API key or an OAuth token, shipping it to the client lets anyone with the page open spend the author's quota.
- **Local already has the files.** The post HTML is right there in the working tree; the very next step is `bun run build` against the same directory.

Author identity is intrinsic: only someone with the project checked out and an authorized local Claude Code session can run the skill. No new auth surface to secure.

### Why an in-session skill (not a subprocess or the SDK)

Running comment-processing *inside the author's interactive Claude Code session* — rather than spawning a separate non-interactive process or calling `api.anthropic.com/v1/messages` directly — buys three things:

- **The author's own session, plan, and auth.** No `ANTHROPIC_API_KEY` to provision, no separately-billed subprocess; it runs on the Claude Code the author is already signed into.
- **Built-in Edit / Read / Grep / Glob.** No reimplementing exact-text replacement or a tool-use loop against the raw API. Edit's `old_string`-must-be-unique invariant keeps every change a focused, reviewable diff hunk — there's no full-file rewrite step where a `<script type="text/narration">` block could silently disappear.
- **Iteration with shared context.** The session persists across passes, so the author can do many rounds — "reconsider just the narration comments", "revert that last edit", "also restructure §3 while you're in there" — and interleave their own direction with the comment-driven edits. A one-shot, memoryless invocation can do none of that.

### In-place editing; git is the review surface

The skill edits `posts/<slug>.html` directly — no draft sidecar. The author is present and steering: watching each Edit as it happens, with `git diff` against the working tree as the review surface and git itself as the undo. So the safety model is **human-in-the-loop** — the author's live review approves (or stops, or corrects) each change. That's what lets the skill skip both a separate draft/review-accept indirection and any tool-permission sandbox: there's no memoryless process to fence in, just an author watching.

### Inputs the skill sees

`bun authoring/exportAnnotations.ts <slug> [--all]` emits the open comments as a [Web Annotation](#anchoring-the-web-annotation-target-model) `AnnotationCollection` (JSON-LD). Each comment carries:
- a **stable IRI** (`urn:blog:<slug>:thread:<id>`) — the key for the verdicts and the resolution write-back;
- a **`target` selector** pinpointing the block + exact quoted text, so the skill locates text via Edit's unique-match requirement;
- the **reply bodies** — the actual feedback to act on.

`authorEmail` is stripped from the export — it's author-eyes-only follow-up data with no place in a portable annotation (see the [exporter](#exporting-to-the-web-annotation-wire-format)).

A dry-run diagnostic, `bun authoring/listUnresolved.ts <slug>`, prints the same set in human-readable form — a quick sanity check of which threads survived the resolved-filter.

### What gets filtered out

The loader walks the local dev store (`generated/.comments-dev/`) directly — it never talks to R2. For a published post, `bun run pull-comments <slug>` mirrors the live comments into that store first (see [Syncing production comments](#syncing-production-comments-authoringr2syncts)). For each user it replays every `.bin` change-object against the shared seed (see [Storage layer](#storage-layer-clientcommentsstorets)). It then **cross-merges replies across every reader's blob**: a thread object lives only in its *creator's* blob, but replies to it can live in any blob — most importantly the author's own replies left on a *reader's* thread — so replies are bucketed by thread id globally before assembly, mirroring the browser aggregator's `merge(doc, …others)` read ([Sync](#sync-clientcommentssyncts-clientcommentsaggregatorts)). (Per-*blob* bucketing instead would silently drop every author-on-reader reply — exactly the divergence this guards against; the loader's job is to mirror the aggregator, not re-derive a narrower view.) From that merged set it drops:

- Threads with `resolvedAt !== undefined` (self-resolve).
- Threads whose id appears in the per-post resolutions namespace (author-resolve — see [Author-resolution](#author-resolution-clientresolutionsstorets-servercommentsresolutionsroutests)).
- Threads with zero live (non-tombstoned) replies — defensive against malformed blobs; the auto-resolve in `deleteReply` should already cover this.

What's left is what Claude sees — never a thread already addressed.

### Syncing production comments (`authoring/r2Sync.ts`)

The loader and the resolution write-back both speak only to the local `.comments-dev/` store — by design ([Why local tooling](#why-local-tooling-not-in-worker-or-the-browser)). For a published post, two thin sync steps bridge that store to the production R2 bucket:

- `bun run pull-comments <slug>` — mirror the live comment change-objects (and any existing resolutions) **down** into `.comments-dev/`, run before exporting.
- `bun run push-resolutions <slug>` — mirror this post's resolution envelopes **up** to R2, run after the author signs off.

**Why it isn't `wrangler r2 object sync`.** There is no such command — `wrangler r2 object` only does single-key `get`/`put`/`delete`, and the v4 REST API can't list a bucket's objects. The only way to reach R2 with the author's *existing* `wrangler deploy` OAuth login — no separate S3 credential to mint and store — is a Worker bound to the bucket. So `r2Sync.ts` writes a throwaway wrangler config that points a `COMMENTS` binding at the bucket named in the content repo's own `wrangler.toml`, runs the tiny `authoring/r2SyncWorker.ts` under `wrangler dev --remote` (which binds to the *production* bucket), talks to it over `127.0.0.1` for a few seconds — `LIST` + `GET` to pull, `PUT` to push — then kills it. The worker is never deployed.

This is exactly the localhost-exempt "smart" tool the dumb-edge-server rule allows ([Why local tooling](#why-local-tooling-not-in-worker-or-the-browser)): it merges nothing, it just shuttles opaque content-addressed bytes. Two safety properties fall out of the data model: **pull is additive and never deletes** (comment change-objects are immutable and resolutions only grow) and is scoped to the one slug, so other posts' local data is untouched; **push is fenced to `resolutions/` keys**, so the only thing ever written back is the author's own resolution envelopes — reader-owned comment blobs can't be overwritten.

### The editing rules (`authoring/authoringRules.md`)

The rules the skill follows live in `authoring/authoringRules.md` — a small (~2KB) doc, deliberately *not* all of this ~90KB methodology. It covers only what's needed to edit a post without breaking it:

- HTML structure (article + narration scripts + PLS lexicon).
- The mark↔id pairing between narration `<mark name="X"/>` and article `id="X"`.
- Which tags are infrastructure (`<meta name="author-email">`, `<link>` / `<script type="module">` for client wiring) and must not be touched.
- The decision tree: typo-fix → apply; rewording request → rewrite; substantive disagreement / out of scope → flag as `NOTE-ONLY` rather than silently apply.
- The required structured verdict format (`Thread #N (id=…): APPLIED | PARTIAL | NOTE-ONLY`).

Keeping the rules small and separate means the skill loads only what's relevant to "how should this paragraph read," not Automerge merge semantics or the OAuth flow.

### Resolution write-back (resolve-iff-shipped)

`bun authoring/resolveThreads.ts <slug> <id…>` writes one author-resolution envelope per thread, through the same `fsAdapter.putResolution` the dev server uses. It accepts either a bare thread id or the annotation IRI verbatim (it strips the `urn:blog:<slug>:thread:` prefix). The envelope uses `resolverId: "ai-applied"` — distinct from the OAuth `<provider>:<sub>` scheme so AI-driven resolutions stay greppable in audits — and `resolverName: "AI (process-comments skill)"`.

Two rules keep it honest:

- **Only `APPLIED` resolves.** `PARTIAL` (addressed *some* of the thread) and `NOTE-ONLY` (flagged for the author rather than edited) stay open — the verdict is the skill's own self-assessment, not ground truth, so the author resolves those manually after follow-up.
- **Resolve only after the edit shipped.** Resolution means "this feedback landed in `posts/<slug>.html`." Because the skill edits in place and resolves only on the author's sign-off, a thread is resolved *if and only if* the edit it triggered is actually in the file — there's no draft-rejected window where a thread could look closed without its content shipping.

Resolutions land in the local dev store (`generated/.comments-dev/resolutions/`); `bun run push-resolutions <slug>` mirrors them up to R2 (see [Syncing production comments](#syncing-production-comments-authoringr2syncts)), symmetric with the pull that fetched the comments. Resolving is *not* bundled with a version bump — the post content-hash is recorded by `generate/post-versions.ts` on the next `bun run build`, which also arms readers' "doc changed" banner ([Document version](#document-version-clientpostversionts-serverpostversionsroutets)).

### Decided against — surfacing per-iteration AI history in the browser

We considered capturing each intermediate AI pass as a browsable version (a "show me what the AI tried across iterations" view in the UI). It's fundamentally incompatible with in-place editing: in-place means every pass overwrites `posts/<slug>.html`, so intermediate passes only ever exist as uncommitted working-tree states — there's nothing durable to surface unless we re-introduce per-pass snapshots, which is exactly the draft machinery in-place was chosen to drop. So iteration history lives in **git** (the author commits between passes if they want checkpoints), and only *shipped* revisions become browsable entries in the author's [Document versions](#document-version-clientpostversionts-serverpostversionsroutets) panel (via the post-version hash on the next build).

### Excluded from v1

- **Chained audio regeneration.** `bun run generate` does this already; folding it into the comment-processing loop would be a convenience but has its own (multi-minute) latency story, and the author often wants to verify the prose before paying that cost.
- **Reply-back to commenters.** A future flow could have the skill propose responses for the author to send via email; deferred until outbound email is wired up (see [Future direction: Web Push notifications](#future-direction-web-push-notifications)).
- **Multi-post sessions.** One post per skill invocation. Cross-post consistency (e.g. updating a shared intro across a series) is a manual loop today.
- **Unattended / CI runs.** The skill is interactive by design — the author reviews live and resolution ties to that sign-off — so there's deliberately no headless path for a bot to apply and resolve comments on the author's behalf.

## Deploy architecture

Production runs on **Cloudflare Workers + R2**. **Bun** is restricted to dev-time (the iterative server in `index.ts`, the bundler) and the offline tools (`bun run generate`). Bun never runs in production; Workers never runs in dev. The two runtimes share the same TypeScript handlers because the auth code in `server/auth/` was deliberately written against `Request` (not `Bun.BunRequest`) and uses `node:crypto` (works on Workers under the `nodejs_compat` flag) — so the same exported handlers mount under `Bun.serve` in dev and under a Worker `fetch` entrypoint in prod.

### Why Workers (and not Bun on a VPS)

The blog backend is small, write-rare, and read-by-author-only — a profile that fits Workers' "stateless function + bindings" model cleanly. The Cloudflare primitives that fall out for free are precisely the ones we want for [hardening](#hardening) the comment surface:
- **R2 binding** — `env.COMMENTS.get(key)` / `put(key, body)` directly, no S3 SDK or signed-URL plumbing.
- **Workers Rate Limiting API** — sliding-window per-key limits as a binding; no KV counters or in-process LRU to maintain.
- **Cloudflare Turnstile** — soft-escalation to a CAPTCHA when a user trips the rate limit, better UX than a hard 429.
- **Edge body-size limits + DDoS shielding** — applied before our code runs.

### Static vs dynamic content

**R2 is reserved for truly dynamic content — content that's written at runtime in response to user actions.** Today that's exactly one thing: per-user comment Automerge blobs. Everything else — the article HTML, the bundled JS/CSS, the pre-rendered MP3s + their narration manifests, the Automerge WASM core the client lazy-loads — ships as a **static asset bundled into `dist/`** and served by the Worker's `ASSETS` binding (edge-cached, no Worker invocation per request, no per-read cost).

The split-line is "does this change in response to a user request?", not "did some build step produce it." Audio is generated by `bun run generate`, but for any given commit the bytes are fixed — that's static. Comments change every time a reader submits one — that's dynamic.

This works until per-deploy total assets approach Cloudflare's Static Assets limits (per-file ≤ 25 MB, ≤ 20k files / ~20 GB per deployment). For a single-author blog at 64 kbps mono mp3 (~480 KB/minute), that's hundreds of hours of audio before we'd need to revisit. If the limit is ever in sight, move the audio to R2 *and only the audio*; the comment R2 plumbing is unaffected.

### Runtime split

| Concern | Dev (local) | Prod (Cloudflare) |
|---|---|---|
| HTTP server | `bun --hot index.ts` | Worker `fetch` handler (`worker.ts`) |
| Frontend bundle | Bun's HTML import (`import index from "./index.html"`) | `bun build` → `dist/`, served by the `ASSETS` binding |
| Auth routes | mounted in the `Bun.serve` routes object | same exported handlers from `server/auth/routes.ts`, mounted in the Worker `fetch` |
| Comments | same `handleCommentsRequest` handler from `server/comments/routes.ts`, mounted on `Bun.serve` and backed by the **same `r2Adapter`** prod uses, over a local Miniflare R2 binding resolved from the content repo's `wrangler.toml` via `wrangler`'s `getPlatformProxy()`. State persists under `.wrangler/state/v3/r2/` | same handler, mounted on the Worker `fetch` and backed by `r2Adapter(env.COMMENTS)`, enforcing the [author-only visibility rules](#hardening) |
| Rate limiter | `env.RATE_LIMITER` from the same `getPlatformProxy()` proxy — local sliding-window limiter; the 429 path executes in dev | Workers Rate Limiting binding declared in `wrangler.toml` |
| Generated audio + manifest | served from `generated/` via `serveFromDir` | copied into `dist/generated/` by `generate/copy-static.ts`, served by the `ASSETS` binding |
| Automerge WASM | served from `node_modules` via `/assets/automerge.wasm` route | copied into `dist/assets/automerge.wasm`, served by the `ASSETS` binding |
| OAuth redirects | `http://localhost:3000/auth/<provider>/callback` | `https://<your-domain>/auth/<provider>/callback` — both URIs registered at each provider |

### Dev server wrapper

`bun run dev` doesn't call `bun --hot index.ts` directly — it goes through `presidocs/scripts/dev.ts`, a thin wrapper that spawns the `--hot` child and hard-restarts it on the changes `--hot` can't see. Two classes of change motivate it:

- **Engine edits.** Bun's `--hot` explicitly excludes `node_modules` from its watch registry. With the `link:presidocs` dep the engine's source lives under `node_modules/presidocs/` from the runtime's perspective, so saving a file in the sibling engine checkout never triggered a reload.
- **New / renamed posts.** The dev route table is codegenned from `posts/` into `.generated/postRoutes.ts` once at startup. Dropping a post in didn't get mounted until you restarted *and* re-ran the codegen by hand.

The wrapper folds both into one rule: watch `node_modules/presidocs/**`, `posts/**`, and `authors/**`; on any change, debounce 100 ms, re-run `engine/generate/post-routes.ts`, and respawn the server. In-project edits to `index.ts`/`worker.ts`/etc. still go through the child's fast HMR — the wrapper only handles the cross-boundary cases. Outputs like `.generated/` and `.comments-dev/` are excluded from the watch list so the codegen and the dev comment store don't trigger restart loops.

**Bindings via `getPlatformProxy()`.** The dev factory (`createDevServer.ts`) doesn't reinvent the R2 / rate-limiter bindings — at boot it calls `wrangler`'s `getPlatformProxy()`, which spins up a Miniflare-backed local environment from the content repo's `wrangler.toml` (the engine discovers it by convention from the content root — *engine never names a post or reads a blog-specific value into its own code*; `wrangler.toml` is content-repo config like `posts/` or `authors/`). The same prod handlers run unchanged: `r2Adapter(proxy.env.COMMENTS)` over local R2, `proxy.env.RATE_LIMITER` instead of `null`. That closes two long-standing dev/prod gaps — the fs-vs-R2 store divergence (`listUsers` was `readdir` vs. delimiter-based `list`, etc.) and the never-exercised 429 path. The proxy's `dispose()` is wired to `SIGINT`/`SIGTERM` so the Miniflare child stops cleanly when dev shuts down. `server/comments/fsAdapter.ts` stays in the tree because the **offline author tooling** (`authoring/resolveThreads.ts`, `loadUnresolvedThreads.ts`, `exportAnnotations.ts`, `r2Sync.ts`) still reads/writes the on-disk `generated/.comments-dev/` shape — dev-server writes now land in Miniflare R2 under `.wrangler/state/`, so author flows that want a local replay run `bun run pull-comments` against prod R2 as before.

**Two secret sources during dev.** `.env` is the canonical Bun-loop secret store (Bun autoloads it; `process.env` works in the auth handlers exactly as in prod). `getPlatformProxy()` reads `.dev.vars` (Miniflare's convention) — for the Bun loop that doesn't matter because the auth code uses `process.env`, not the proxy's vars; `.dev.vars` only becomes load-bearing for the `dev:edge` surface below. Keep the same values in both files (an `.env.example` + `.dev.vars.example` pair ships in each content repo).

**`dev:edge` — the workerd smoke check.** Bun's `HTMLBundle` routes can't be wrapped with response headers (see [HTTP security headers](#http-security-headers-sharedsecurityheadersts)), so the document CSP is impossible to verify against the Bun inner loop. `bun run dev:edge` (`bun run build && wrangler dev --port 3000`) runs the prod Worker (`worker.ts`) against the freshly-built `dist/` under workerd, with the same R2 + rate-limiter bindings the deploy will use. It's deliberately **not** the inner loop (no HMR, no `/dev/*` subprocess tooling — those can't run on workerd) — it's the one local surface that exercises the document CSP, `run_worker_first`, the feed MIME override, and the rest of the asset-binding path before a deploy. Pinned to `:3000` so the OAuth localhost callbacks (`OAUTH_REDIRECT_BASE`) keep working.

**Alternatives considered.** Cloudflare's canonical local-dev path is to run `wrangler dev` (or the [Cloudflare Vite plugin][CFViteAnnouncement]) as the *primary* loop, with bindings auto-simulated by Miniflare ([CF docs][CFLocalDev]). We deliberately don't:

- **`wrangler dev` as the inner loop** — workerd cannot host the dev-only author surfaces that are the whole point of running on localhost: `/dev/regenerate` and `/dev/sound-test` shell out to the MOSS Python pipeline (no subprocess spawn in workerd), `/dev/sound-test` is itself a Bun-bundled `HTMLBundle`, and `/assets/authors.json` rebuilds per request from arbitrary `posts/` reads. These match what the runtime-split rule above calls "smart, fully-trusted localhost" tools — moving them to workerd would either lose them or force a two-process sidecar (one workerd, one Bun, with OAuth-callback routing between them), which is real operational complexity for what `dev:edge` already covers occasionally. So we use Miniflare's *bindings* inside Bun (via `getPlatformProxy()`) without moving the whole loop to workerd.
- **Cloudflare Vite plugin** ([announcement][CFViteAnnouncement]) — closes the document-CSP-in-dev gap by running `worker.ts` in workerd alongside Vite-HMR'd frontend code, which would be a real win. But the build pipeline is deeply Bun-native (`Bun.build`, `Bun.serve`, `Bun.HTMLBundle`, the bundler plugin in [`bunFooterPlugin.ts`](#build-time-html-strip-generatestrip-served-htmlts)), so adopting it is a substantial migration; and it doesn't solve the `/dev/*` subprocess block — workerd still can't spawn MOSS, so a Vite-plugin world remains a hybrid with the same sidecar question. The right-sized move would be: if the project ever drops the offline MOSS surface (or externalises it behind a separate dev process the operator accepts running), the Vite plugin becomes the natural consolidation. Until then the `dev:edge` smoke + Bun inner loop is the cheaper cut.
- **`remote: true` per binding** ([CF docs][CFLocalDev]) — lets a specific binding hit real Cloudflare resources during local dev. None of ours benefit: a dev-server write hitting prod R2 is the wrong default, the rate limiter would burn the prod 10/60s budget, and the analytics dataset would pollute by edit-and-refresh. If a Miniflare quirk ever needs verification against the real bucket, an ad-hoc `wrangler dev --remote` is the per-incident escape hatch rather than a permanent binding flag.

[CFLocalDev]: https://developers.cloudflare.com/workers/local-development/
[CFViteAnnouncement]: https://blog.cloudflare.com/introducing-the-cloudflare-vite-plugin/

### Deploy unit

One Worker per project — no separate Pages site. Cloudflare's **Static Assets** feature (GA 2024) lets a Worker bind to a built artifact directory and serve static files transparently, falling back to the `fetch` handler for everything else. Sketch of `wrangler.toml`:
```toml
main = "worker.ts"
compatibility_flags = ["nodejs_compat"]
assets = { directory = "./dist", binding = "ASSETS" }
[[r2_buckets]]
binding = "COMMENTS"
bucket_name = "blog-comments"
```
Build: `bun run build`. Deploy: `wrangler deploy`. Two commands.

The Pages-with-Functions alternative was considered and rejected: it's a second deploy target and a second routing model for no benefit when one Worker can do both. Pages is preferable only when you want git-push-to-deploy from GitHub without a Worker config.

### Copying static artifacts into `dist/` (`generate/copy-static.ts`)

`bun build` only knows about the HTML/JS/CSS module graph. The other static artifacts that need to be served — per-post audio + narration manifests under `generated/`, and the Automerge WASM the comments client lazy-loads — have to be copied into `dist/` separately. `generate/copy-static.ts` does this as the step between `bun build` and the HTML strip:

- `generated/<slug>/manifest.json` + `generated/<slug>/*.mp3` → `dist/generated/<slug>/`
- `node_modules/@automerge/automerge/dist/automerge.wasm` → `dist/assets/automerge.wasm`

Build-internal files under `generated/` are deliberately excluded: the `.tts-cache/` buckets, the dev-only `.comments-dev/` fs-adapter blobs, and the per-slug `cache-keys.json` GC index. Idempotent; safe to re-run.

### Build-time HTML strip (`generate/strip-served-html.ts`)

The post HTML in `posts/` is the *authoring* artifact — it carries everything a human or LLM needs to edit one document end-to-end: visible article content, the offline-generator inputs (PLS lexicons, narration scripts), and the per-post author email. Most of that is dead weight at the reader's runtime: the player loads pre-rendered audio from the manifest (not from inline narration), the TTS lexicon is only used by `bun run generate`, and the author email is only used by the server-side author check (which reads source HTML, not served HTML).

The last step of `bun run build` rewrites every HTML file under `dist/` in place, removing:
- `<meta name="author-email" ...>` — spam mitigation.
- `<script type="text/narration" ...>...</script>` — generation-only.
- `<script type="application/pls+xml">...</script>` — generation-only.

**Dev doesn't strip.** `bun --hot index.ts` serves the full source HTML on localhost. Stripping in dev would require a Bun HTML-loader plugin; not worth the friction for content that no scraper sees.

**Footer inject runs in the bundler now, with the strip pass as backstop.** `shared/injectFooter.ts` is wired through `engine/generate/build-html.ts`, a small `Bun.build({plugins:[siteFooterPlugin()]})` wrapper that the per-blog `bun run build` invokes in place of the bare `bun build ./index.html ...` CLI step. That way every entry HTML the bundler reads goes through `injectSiteFooter` with the same env-gates the post-build pass uses (`PRIVACY_POLICY_URL` for the privacy link, `SITE_URL` for the [help link](#reader-facing-help--feature-discovery-generatehelp-pagets)). `strip-served-html.ts`'s own `injectSiteFooter` call stays in place but short-circuits on the `class="site-footer"` marker the plugin already wrote — a belt-and-suspenders backstop that keeps prod HTML correct if anyone runs the post-build pass without the plugin. The Bun *runtime* plugin system (i.e. registering via `Bun.plugin(siteFooterPlugin())` at the dev server's entry) rejects `loader: "html"` as of Bun 1.3.14, so dev `HTMLBundle` routes can't run the plugin yet; the footer is fully engine-owned (content pages no longer hand-author one), so it's simply absent under `bun run dev` — the same prod-only posture as the feeds, sitemap, and `/help`. When Bun's runtime plugin system gains html-loader support, registering the plugin from the content-repo `index.ts` closes the dev footer gap with no other code changes.

### Offline / PWA (`client/sw.js`, `client/swRegister.ts`, `shared/injectPwaHead.ts`)

The site is an installable PWA with offline reading of any page a reader has already visited. Three coordinated pieces, split clean across the engine/content boundary:

- **Engine** owns the Service Worker (`client/sw.js`), the registration boot (`client/swRegister.ts`), the `<head>`-injection helper (`shared/injectPwaHead.ts`), and the build-time wiring (`generate/copy-static.ts`, `generate/build-html.ts`, `generate/strip-served-html.ts`).
- **Content** (each blog repo) owns its own `manifest.webmanifest`, the `icons/` set, and the `<script type="module" src=".../engine/client/swRegister.ts">` import in source HTML.

This split keeps the SW + cache strategy reusable across blogs while every per-blog value (app name, theme color, icon set) stays in the content repo where the author edits it. Proposal 06 has the full per-decision rationale; this section captures the parts that affect day-to-day operation.

**Cache strategy: three buckets, picked by URL shape.**
- **Network-only** for `/auth/*`, `/comments`, `/resolutions`, `/post-version`, `/_a` — caching even briefly creates races (logout-that-doesn't-take, comment-that-doesn't-show, stale doc-version banner). The SW returns *without* calling `e.respondWith()`, so the browser does the fetch unobserved.
- **Cache-first** for `/generated/*`, `/assets/*`, and hash-suffixed `*-XXXXXXXX.{js,css}` — these are content-addressed or hash-named, so the URL changes when the bytes change and a cache hit is correctness-safe forever. This is the whole offline-listen story: a re-visited MP3 plays without a network call.
- **Network-first with cache fallback** for navigations and post HTML — the author wants a re-publish to show up immediately; cache only kicks in when the network errors, giving an offline reader the last copy they saw.

**`VERSION` is substituted at copy time, not bundle time.** `client/sw.js` carries the literal placeholder `"__SW_VERSION__"`; `generate/copy-static.ts` swaps it for `Date.now()` when copying into `dist/sw.js`. Bun's bundler doesn't process the SW (it's served as top-level `/sw.js`, not part of the module graph), so a build-time `define` wouldn't reach it — the string-replace at copy time is the right layer. Every deploy gets a fresh `VERSION`, and `activate`'s reap step deletes any cache whose key doesn't end with the current value.

**`__BUN_DEV__` define and the "Bun loop doesn't register the SW" rule.** `swRegister.ts` gates registration on `typeof __BUN_DEV__ === "undefined" ? true : __BUN_DEV__`:
- **Bun inner loop** (no `Bun.build` step): identifier stays undeclared at runtime, gate evaluates to "this is dev," registration is skipped. HMR runs clean and a stale SW can't accidentally wedge a localhost session.
- **`dev:edge` + prod** (through `Bun.build`): `define: { __BUN_DEV__: "false" }` in `generate/build-html.ts` substitutes the identifier; the bundler constant-folds `var isBunDev = false;` and the registration runs.

Net effect: SW work is verified at `dev:edge`, not in the inner loop. Same posture as the document CSP — Bun can't host it, workerd does.

**`Service-Worker-Allowed: /` and `Cache-Control: no-cache` on `/sw.js`.** The SW is served from origin root so its default scope is already `/`; the `Service-Worker-Allowed` header is documentary (it would matter only if we ever relocated `sw.js`). The `Cache-Control: no-cache` is load-bearing — without it, a stale SW would sit in front of a deployed new one and visitors would never see the rollout. In dev, `createDevServer.ts` sets it inline on the route. In prod, `copy-static.ts` appends a `/sw.js  Cache-Control: no-cache` rule to `dist/_headers` (the Cloudflare-native static rule), with the `# presidocs: sw.js no-cache` marker so re-running the build doesn't pile up duplicates. The rule is **engine policy, not a per-blog choice** — about the SW the engine ships, not the blog's preference — so the engine emits it. Blogs that want their own `_headers` rules append to the same file; the marker keeps the engine's rule from being clobbered or duplicated.

**Range handling inside the SW.** The narrator player issues `Range: bytes=N-M` requests while seeking. A naive cache-first that returns the full body to a Range request yields a `200 OK`; Chromium tolerates it, Safari has been observed to reject mid-track. The SW's `cacheFirstRanged` path therefore slices the cached full response and synthesizes a `206 Partial Content` with `Content-Range`. The parse semantics mirror [`shared/httpRange.ts`](#dev-server-wrapper) (the single source of truth used by the dev server and the Worker); the SW can't import TS from `shared/`, so it carries the same logic in plain JS at a tighter scope — only the cases the media element actually sends (`bytes=N-M`, `bytes=N-`, `bytes=-N`), plus the suffix-clamp and 416 branch.

**`<head>` metadata injection.** `shared/injectPwaHead.ts` adds three entries — `<link rel="manifest">`, `<meta name="theme-color">`, `<link rel="apple-touch-icon">` — via the same `HTMLRewriter` post-build pattern as the privacy footer and structured data. The manifest URL is engine-fixed at `/manifest.webmanifest`; the `theme-color` and `apple-touch-icon` values come from the per-blog `manifest.webmanifest` (`theme_color` and `icons[0].src`) read once at the start of `strip-served-html.ts`. The `class="pwa-manifest"` marker on the manifest link makes the helper idempotent. Fail-silent: if a blog ships no manifest, the inject is skipped entirely — no broken `/manifest.webmanifest` link in served HTML.

**iOS specifics.** Safari iOS doesn't fire `beforeinstallprompt` and requires the user to manually Share → Add to Home Screen; only after that does Web Push (when it ships) work. The `<link rel="apple-touch-icon">` is required separately from the manifest icons because iOS ignores the manifest icons array for the home-screen icon.

**Aggressive update lifecycle.** `install` calls `self.skipWaiting()`, `activate` calls `self.clients.claim()`. The next navigation runs the new SW; no two-tab hang. With network-first HTML and cache-first hash-named assets, the version-skew window is harmless — a mid-session vN → vN+1 swap can't show stale content.

**Recovery posture for a broken-SW deploy.** If a deploy ships an `install`-time throw, every returning visitor is wedged on the old SW until they clear site data — a real production incident. Mitigations: the `Cache-Control: no-cache` on `/sw.js` is non-negotiable (above); `dev:edge` is the verification surface before any deploy (see below); and a `swRegister.ts` kill-switch (one localStorage flag → `unregister()`) is the post-incident lever — adding it pre-emptively is on the open list, not in v1.

**Verification surface: `dev:edge`.** Before a SW-touching deploy: run `bun run dev:edge` and confirm `curl -sI http://localhost:3000/sw.js | grep -i cache-control` returns `no-cache`, DevTools → Application → Service Workers shows "activated and is running," and a code change cleanly transitions vN → vN+1 with `clients.claim()` taking over the next navigation. This is the one local surface that exercises the SW + `_headers` + `ASSETS` path end-to-end before prod — `dev:edge` exists precisely for risks at this level. **Deferred fast-follow:** automating this as a pre-deploy/CI gate (a `wrangler dev` boot + `curl -sI localhost:3000/ | grep -i content-security-policy` and security-header assertion) would catch a dropped CSP or header regression before deploy without relying on the manual step — today the check is manual.

**Limitations / not in v1** (forward-looking work tracked in [proposal 21](./proposals/21-pwa-offline-followups.md)).
- **Offline audio is cached only after first play.** The narrator sets `preload: "none"` (`client/narrator.ts`) so a passive reader pays zero audio bytes, and the SW caches only what's actually fetched — so a post's MP3 lands in the cache the moment you press play, not when you merely open the post. A reader who opened a post online but never played it, then goes offline, gets the article text from cache but a failed audio fetch. The [help page](#reader-facing-help--feature-discovery-generatehelp-pagets) is worded to match (narration replays offline "once you've started playing it"). Whether to add a "Save for offline listening" affordance or auto-fetch inside an installed PWA is the open decision in [proposal 21 §4](./proposals/21-pwa-offline-followups.md#4-offline-audio-with-lazy-preload).
- **Background Sync** ([WICG draft][BackgroundSync]) — would queue failed comment `PUT`s in IndexedDB and replay them on connectivity return. Chromium-only; future direction ([proposal 21 §2](./proposals/21-pwa-offline-followups.md)).
- **Web Push** — the same SW will carry the `push`/`notificationclick` handlers when [Future direction: Web Push notifications](#future-direction-web-push-notifications) lands. No change to the `install`/`activate`/`fetch` handlers documented above.
- **Real app icon** — the current set is an "SG" placeholder on `#0d1117`. The install prompt fires; the icon is just ugly.
- **Real-browser SW lifecycle tests** — see [Tests](#tests). The dev:edge manual smoke above is the verification surface today; an automated Playwright test would be the natural place to formalize it.

### Engagement analytics (Analytics Engine)

The blog writes a small set of anonymous engagement events to a single **Cloudflare Analytics Engine** dataset (`blog_engagement`) bound to the Worker as `env.ANALYTICS`. Two event types today: `page_view` (one per page load, with the post slug and the referrer hostname) and the narration pair `narration_play` + `narration_quartile` (only fired after the listener has explicitly pressed play, capped at one play + four quartiles per session). Schema: `client/analytics.ts` builds the beacon, `server/analyticsRoute.ts` validates and writes, the positional slot map lives in `shared/analyticsSchema.ts` and is the single source of truth.

**Why Analytics Engine, not Web Analytics.** Analytics Engine is the Workers-side write-arbitrary-events product. We started on Web Analytics (the client-side `<script defer>` beacon to `static.cloudflareinsights.com`) for page views, but it answers exactly one question — "how many page views" — and the load-bearing analytics question for this engine is *engagement*: does the narration feature, which is the single largest cost concentration in the codebase, justify its investment? That can't ride on Web Analytics. So once we needed a Worker-side event surface for narration anyway, the cheaper move was to fold page views into the same dataset and delete the second analytics path — fewer moving parts, tighter CSP (no `static.cloudflareinsights.com` origin), one privacy-policy paragraph instead of two.

**Why not Zaraz.** Cloudflare's server-side tag manager — the canonical "send events to N third-party analytics destinations without each shipping a tracker into the browser" surface. Right shape when you're consolidating GA4 + Meta Pixel + Mixpanel + Hotjar off the page; wrong shape for us because we ship zero third-party tags (the privacy posture forbids them) and zero is what Zaraz is consolidating. Adopting it would mean an extra cross-origin client script (`zaraz/i.js`) + an extra hop between client and Analytics Engine, for no win over `sendBeacon` → Worker → `writeDataPoint`. So: same Cloudflare vendor, no Zaraz layer.

**Anonymous by construction.** No cookies, no `localStorage`, no per-visitor identifier on the client; no userId, no IP retention on the server. The Worker route reads only what the client puts in the JSON body and writes only positional blobs/doubles — there is no code path in `analyticsRoute.ts` that touches request headers other than the bot filter (`request.cf.botManagement.verifiedBot` + a UA pattern) and the rate-limit key (the edge IP, consumed by the limiter and never stored). The same privacy-and-disclosure paragraph in `privacy.html` covers both event families — see [Data inventory](#data-inventory).

**Client beacon.** `client/analytics.ts` exports `emitNarrationPlay` / `emitNarrationQuartile`, called from `client/narrator.ts` at the first-play latch and from the rAF tick that already drives highlighting. It also has a top-level side-effect: on module load it fires one `page_view` via `navigator.sendBeacon('/_a', ...)`. Posts pick this up transitively because `narrator.ts` imports the module; the **landing page** (and any non-post HTML like `privacy.html`) carries its own `<script type="module" src="./engine/client/analytics.ts">` so the side-effect fires there too. The page-view emit is window-guarded against double-fire (a post may have multiple `<script type="module">` graphs, each instantiating its own copy of the module — only one of them wins).

**Worker route.** `POST /_a`, mounted from both `createWorker.ts` (prod) and `createDevServer.ts` (dev). Validates the event against a strict allowlist (`shared/analyticsSchema.ts:EVENT_NAME_SET`), the post against `postMetaIndex` (with `/` allowed for the landing), payload size against `MAX_PAYLOAD_BYTES`, and bot status against `request.cf` + a UA pattern. Always returns `204 No Content` — even on a rejected payload — so a probe can't discover valid post slugs by response code. Rate-limited via a **separate** Workers Rate Limiting binding (`ANALYTICS_RATE_LIMITER`, `namespace_id = 2002`, 100/60s, keyed on edge IP) so anonymous beacon traffic and authenticated comment writes never share a budget.

**Slot stability is forever.** Analytics Engine stores `{indexes, blobs, doubles}` positionally — if you ever *repurpose* slot N from "trigger" to "chapter" you silently mis-label every historical row that used slot N for "trigger." The slot map lives in one place (`shared/analyticsSchema.ts`); the file header documents the never-edit rule; the route is the only writer that depends on the positions. Adding a new dimension means allocating a *new* slot, never editing one in place. Same discipline as the [Automerge seed bytes](#storage-layer-clientcommentsstorets) — easy to break, painful to debug.

**Dev is a no-op sink.** The dev server passes `sink: null` so the route validates and 204s exactly like prod but never writes anything — a developer's clicks don't pollute the prod dataset, and the dev build doesn't need an Analytics Engine binding configured. The other half of the dev/prod parity is that the client beacon path is identical in both runtimes: `sendBeacon('/_a')` works the same against Bun and against the Worker.

**Pricing tier.** Analytics Engine is positioned by Cloudflare alongside Workers Paid. The free tier permits 100,000 data points per day, which is well above a personal blog's traffic — a viral post would still fit comfortably — but if the blog ever expects sustained higher volume, the Worker has to be on Workers Paid for the writes to keep landing. The cost on Workers Paid is per-million-rows, not per-binding, so adding the binding to a new content repo carries no fixed cost beyond what Workers Paid already adds.

**Querying.** Two SQL queries on the Cloudflare Workers Analytics dashboard answer the load-bearing question. They use `SUM(_sample_interval)` rather than `count()` because Analytics Engine applies *write-time* sampling once a single index value (here, an event-type) sustains very high write rates — `SUM(_sample_interval)` is identical to `count()` while we're under the threshold (the field is `1` per row) and stays correct if sampling ever kicks in, where `count()` would silently under-report. At this blog's scale we'll never trigger sampling; using the sampling-correct form anyway keeps the queries reusable as-is.

```sql
-- Per-post play rate alongside page views (same dataset, one JOIN-equivalent)
SELECT blob1 AS post, SUM(_sample_interval) AS plays
FROM blog_engagement
WHERE index1 = 'narration_play'
GROUP BY post

-- Per-post quartile funnel
SELECT blob1 AS post, double1 AS quartile, SUM(_sample_interval) AS reached
FROM blog_engagement
WHERE index1 = 'narration_quartile'
GROUP BY post, quartile
ORDER BY post, quartile
```

**No build-time injection.** The previous Web Analytics path injected a `<script>` tag into every HTML file at build time (`shared/injectAnalytics.ts`, since deleted). The new path doesn't need it: the client beacon module is imported as a normal ES module — by `narrator.ts` for posts, by an explicit `<script type="module">` for the landing — and the slot writes happen entirely server-side via the binding. The dist HTML carries no analytics origin, and the CSP `connect-src`/`script-src` stay tight to `'self'`.

**Deliberately not tracked.** Adding any of the below would re-relax the privacy posture or the schema; re-adding one means engaging with the recorded reason, not slipping it in. The list is exhaustive of what's been considered — anything not here is genuinely "we haven't thought about it yet," not "we considered it and decided to add."

- **Per-chapter listen depth** — quartiles are coarse enough today; revisit only if the quartile funnel ever shows a cliff worth investigating.
- **Chapter-pill / chapter-jump events; highlight-toggle usage** — knowing the click-through rate wouldn't change what we'd build; the strip and the toggle are cheap to keep either way.
- **Comment-column engagement** — the [author aggregator](#author-aggregating-viewer) already exposes richer per-thread data; an event surface would parallel a better one.
- **Figure interactivity** — wants per-figure schema; the blog has one interactive figure today, so v1 would lock the shape against a sample of one. Revisit once there's a second.
- **Reading-mode classification (listen-only / read-only / both)** — needs sustained per-session identity, which is the exact thing the cookieless posture forbids. The play-rate × quartile-funnel split is the coarser-but-honest version of the same question.
- **Opt-out-post views** — already answerable from `page_view` JOINed against the (statically known) [`data-narration="none"`](#opting-out-of-narration) set; no new event needed.
- **OS-media-session usage (lock screen, hardware keys)** — opaque to JS; `trigger=media-key` on `narration_play` is the one observable proxy.
- **Scroll depth / time on page** — confounder for the load-bearing question (did the listener *finish listening*, not *finish scrolling*); its own proposal if it ever becomes load-bearing.
- **A/B testing, heatmaps, session replay** — each needs a stable per-visitor identifier (cookie or fingerprint) which immediately requires a consent banner. Off the table while the privacy posture is cookieless.

### Structured data (Schema.org, Open Graph, Twitter Card) (`shared/injectStructuredData.ts`)

A post URL pasted into Slack/Discord/iMessage/LinkedIn/X should unfurl with a title, description, and share card; Google should be eligible for the **Article rich result** and its **"Listen to this article"** audio surface; and LLM search indexers (which special-case JSON-LD) should get clean structured metadata. None of that exists without `<head>` metadata, so the build emits three layers into every post: a **Schema.org JSON-LD** `BlogPosting` (with a nested `AudioObject`, `Person` author, and `Organization` publisher), **Open Graph** tags, and a **Twitter Card** overlay.

This is the **crawler/unfurl-facing counterpart to the [client-rendered byline](#author-profiles-and-bylines-sharedauthorprofilets-clientbylinets)**, and the two split the work cleanly: the byline is the *visible* author block (JS, identical dev/prod); the structured data is for *machines* (static HTML, no JS), so SEO never depends on the byline script running. They share one data source — `buildAuthorMap` — so the JSON-LD `author` is the same public `Person` (name + `sameAs` X link + avatar as `image`), and **the email never appears here either** (the profile map is emailless by construction).

It rides the same post-build pass as the strip and analytics, via `shared/injectStructuredData.ts`. The split of where each field comes from:

- **Extracted from the post HTML** (a single `HTMLRewriter` read): `headline`/`og:title` from `<title>`; `description` from `<meta name="description">` if present else the `#lede` text; `inLanguage` from `<html lang>`; the publisher/`og:site_name` from the article's existing `data-narration-artist` (already the publisher label — no new knob); and any pre-existing `og:image`.
- **Passed in by the build** (disk/env context the injector shouldn't gather itself): `datePublished`/`dateModified` from `posts/versions.json` (newest-first, so **oldest entry = published, newest = modified**); the `AudioObject` from the post's `generated/<slug>/manifest.json` (absolute `contentUrl`, `audio/mpeg`, ISO-8601 `duration` from the manifest's ms); the author `Person` from the public profile map; the post's [generated share card](#share-cards-generateshare-cardts) URL (the default `og:image`); and `siteUrl` for making every URL absolute.

Design decisions worth keeping:

- **`SITE_URL`, separate from `OAUTH_REDIRECT_BASE`.** Absolute HTTPS URLs are mandatory for `og:`/JSON-LD (relative and `http://` are rejected by validators), so the canonical origin must be configured. It's a *distinct* env var from the OAuth callback base even though they coincide today — one is "where the site lives," the other is "where auth redirects land." **Unset → the whole structured-data inject is skipped** (fail-silent); the blog still works, it just doesn't get rich cards in that deploy.
- **`og:image`: per-post override wins, else the generated share card.** `og:image` is a *required* Open Graph property, so it must always resolve. A post may declare its own `<meta property="og:image">` (a wide hero); the injector then leaves that tag exactly as authored and **does not emit its own** (no duplicate `og:image`), though JSON-LD `image`/`twitter:image` still resolve it to absolute. With no override, the default is the post's [generated 1200x630 share card](#share-cards-generateshare-cardts) (`/assets/og/<slug>.png`), passed in by the build and gated on the card file actually existing. Because the card's size is known, we also emit `og:image:alt` (the post title) and `og:image:width`/`:height`, and the JSON-LD `image` is an `ImageObject` with those dimensions (an override stays a bare URL — its size is unknown). The Twitter card is `summary_large_image` whenever a share image resolves (the card and any override are both large-format), falling back to `summary` only when there's none. The small author avatar is **never** the share image — it's only the JSON-LD `Person.image`. `twitter:creator` is derived from the X handle.
- **`article:author` is a profile URL, not a name.** The Open Graph Article type defines `article:author` as a profile reference (a URL), so the injector emits the author's `links.x` (falling back to `links.website`, omitted if neither exists) — never the display name. The human-readable name is still carried correctly by JSON-LD `author.name` and `twitter:creator`.
- **Degrades field-by-field, never fails the build.** No manifest (a [narration opt-out](#opting-out-of-narration) post) → no `AudioObject`/`og:audio`, the rest still emits. No resolvable author profile → no `Person`/`article:author`. Missing `versions.json` → no dates. Idempotent: a pre-existing JSON-LD block short-circuits the whole inject (same trick as the analytics beacon).
- **Only real posts get the `BlogPosting`.** A file is treated as a post only if it has a `versions.json` record; the landing page goes through a parallel `injectSiteStructuredData` path (see below), and any other `dist/` HTML short-circuits. A `<link rel="canonical">` is emitted alongside, so localhost/preview-deploy variants of a URL don't get indexed as duplicates.
- **`wordCount` + `speakable`.** Two free, content-agnostic fields on the `BlogPosting`. `wordCount` is whitespace-token count over the stripped article body (approximate but stable across re-builds — a minor SEO + LLM length signal). `speakable` is a `SpeakableSpecification` pointing at `#lede` and `h1` only (conservative — never the full article); apt for an audio-first blog and how Google Assistant et al. decide what to read aloud. Both omitted if the source has no `<article>` (impossible for a real post).
- **Landing page gets a parallel `WebSite`/`Blog` @graph** via `injectSiteStructuredData` (same file, same gate, idempotent). The two nodes share the same emailless `Person` author and `Organization` publisher the posts already use — one source of truth, no second blog name to keep in sync. The `@graph` is *connected*, not just two parallel nodes: each `BlogPosting` carries `isPartOf` → the landing's Blog `@id`, and the WebSite carries the inverse `mainEntity` → same Blog `@id`. A consumer that fetches both pages sees one Blog with N posts, not two unrelated documents. A meta description is also added (extracted from the first `<main> p`, the same source `readSiteMeta` uses for the feed `<subtitle>`) when the source doesn't already declare one. Deliberately **no `SearchAction`** — the engine has no site-search endpoint to advertise; a `SearchAction` pointing nowhere is worse than omitting it. Revisit only if a search route is ever added.

**Dev doesn't inject** — same posture as the strip/analytics steps; crawlers and unfurl bots hit prod, and dev serves un-rewritten source.

### Share cards (`generate/share-card.ts`)

The default `og:image`/`twitter:image` is a **generated 1200x630 PNG per page** — blog name, page title, and author (avatar + name) — so every page has a real share card (not a tiny avatar) and the required `og:image` is always satisfiable. Pipeline: **satori** lays the card out from a plain element tree (no JSX/React — the engine is React-free) into an SVG with the text already converted to vector **paths**, then **@resvg/resvg-wasm** rasterizes that SVG to PNG. Deterministic, no native binary, no headless browser.

- **Per-post and landing-page.** One card per real post (`dist/assets/og/<slug>.png`) PLUS one for the landing page (`dist/assets/og/_site.png` — the leading `_` keeps it out of the post-slug namespace). Both use the same renderer; the landing card puts the site **description** (tagline) in the middle band and the newest-post author at the bottom (the same "site-level author" rule the feed channel and landing-page JSON-LD use — one convention, three call sites). The landing card is the load-bearing fix that lets the landing page satisfy OG's `og:image` required property.
- **Static font, vendored.** satori's font parser rejects *variable* fonts (it chokes on the `fvar` table), so two **static** weights are committed under `generate/assets/fonts/` (DejaVu Sans Regular + Bold — freely redistributable; see the `LICENSE` there). Vendored, not read from the system, so the build is reproducible on any machine/CI. Swap typefaces by dropping in different static Regular/Bold TTFs and updating `loadFonts()`.
- **Where it runs.** A build step after `bun build` (it needs `dist/`) and before [strip-served-html](#structured-data-schemaorg-open-graph-twitter-card-sharedinjectstructureddatats) (which references the card URL when injecting `og:image`). Gated on `SITE_URL` like the other discovery features, and **skipped per-page** when the page declares its own `<meta property="og:image">` (that page takes the override path, so no card is wasted). The landing card is also skipped when the landing has no `<main> <p>` description to put in the middle band — degrades cleanly rather than emitting a brand-only card.
- **The avatar feeds the card, not the meta tag.** The author avatar is read from the per-author folder and drawn *into* the card; the small square avatar is never itself the share image.

### Subscription feeds (Atom + Podcast RSS) (`generate/feeds.ts`)

An audio-first blog with no feed is invisible to every podcast client and feed reader — yet every field a feed needs already exists on disk after a build. `generate/feeds.ts` is the final build step (after the strip, so it can splice the *stripped* post body into the feed `<content>` — no email, no narration blobs reach subscribers) and emits three static artifacts, **zero Worker code**:

- **`dist/feed.xml`** — Atom 1.0, one `<entry>` per post. Article-side; doesn't require audio.
- **`dist/podcast.xml`** — Podcast RSS 2.0 with the `itunes:` and Podcasting-2.0 `podcast:` namespaces, one `<item>` per post that **has narration audio**. Suppressed entirely if no post has audio (an empty podcast feed gets rejected from directory submission).
- **`dist/generated/<slug>/chapters.json`** — a [Podlove Simple Chapters](https://podlove.org/simple-chapters/) sidecar (referenced by `<podcast:chapters>`), one per audio post.

Decisions:

- **Gated on the same `SITE_URL`** the structured-data inject uses (one canonical-origin var, not a second one) — feeds need absolute URLs for every link/enclosure, so no `SITE_URL` → feeds are skipped (fail-silent, like the other build injects).
- **Engine stays content-agnostic.** The site title + description are read from the blog's own landing `index.html` at build time (never hardcoded in the engine); the per-post and channel author come from the same public profile map as the [byline](#author-profiles-and-bylines-sharedauthorprofilets-clientbylinets) (so **no email** in the feed by default). The deploy-level knobs are env-driven with defaults (`shared/feedConfig.ts`: `FEED_LANGUAGE`, `PODCAST_CATEGORY`, `PODCAST_EXPLICIT`, plus `PODCAST_OWNER_EMAIL`, `PODCAST_COVER`, `SITE_LAUNCH_YEAR`).
- **Podcast cover art is a dedicated asset, never the avatar.** Apple requires `<itunes:image>` to be ≥1400² square, so the channel image comes from `PODCAST_COVER`; when unset it's **omitted** (a too-small image gets the feed rejected, whereas an absent one merely degrades). The small author avatar is used only for the Atom `<logo>`.
- **Podcast owner email is opt-in** (`PODCAST_OWNER_EMAIL`), never auto-pulled from `<meta name="author-email">`. A public feed is exactly the surface the [email strip](#why-email-and-not-userid) exists to keep the address off; Apple *directory submission* needs an owner email, so an author who wants it sets the var, and the feed omits it otherwise.
- **Dates from `versions.json`.** Newest-first, so oldest entry = `<published>`/`<pubDate>`, newest = `<updated>`.
- **Atom ids are permanent (RFC 4287 §4.2.6).** Each entry's tagURI takes its date from *that entry's own first-publish year*, so adding a later post with an *earlier* date never changes another entry's `<id>` (a global minimum year would rewrite every id and resurface the whole back catalogue as unread). The feed's own `<id>` uses a fixed `SITE_LAUNCH_YEAR`, never a min-across-posts. RSS `<guid isPermaLink="false">` is the (stable) post URL.
- **Atom `<content type="html">` is entity-escaped** (the spec's normative form), not CDATA; the RSS `<content:encoded>` stays CDATA (RSS's own convention).
- **Channel `<podcast:guid>` + `<atom:link rel="self">`.** The RSS channel carries a stable Podcasting-2.0 GUID — a dependency-free UUIDv5 over the feed URL with the spec's fixed namespace (verified against the spec's published example in a test) — plus an Atom self-link, both expected by podcast directories/validators.
- **`<enclosure length>` is the real byte size** (`stat` of the built MP3), not `duration × bitrate` — MP3 framing isn't uniform and a wrong length makes some clients refuse the episode. The audio URL is the content-hashed `full.<hash>.mp3` read straight from the manifest, so the feed always points at the current track.
- **Chapters in both the JSON sidecar *and* the MP3 itself.** `chapters.json` (ms → seconds) gives every modern podcast client chapter markers through `<podcast:chapters>` — the rich surface. The MP3 also carries [ID3v2 CHAP+CTOC frames](#relation-to-other-specifications) for the (older / minimalist) clients that only read in-file chapters, embedded at encode time via an ffmetadata sidecar (`-id3v2_version 3`) so the same chapter offsets the manifest uses land verbatim in the MP3. The encode therefore happens *after* the per-chapter offsets are summed from artifact durations, so the in-file times match the manifest byte-for-byte without a second pass. Hierarchy degrades to a flat list with part-prefixed child titles, same shape as the `<podcast:chapters>` sidecar — true nesting lives only on the in-page player.
- **Plain-text fields are entity-decoded** (`shared/htmlEntities.ts`) before XML-escaping, since `HTMLRewriter` hands back `&mdash;` etc. intact and a naive re-escape would double-encode them; body HTML rides in `type="html"` CDATA untouched.
- **Autodiscovery + MIME.** The strip pass injects `<link rel="alternate" type="application/atom+xml"/rss+xml">` into every page's `<head>` (gated on `SITE_URL`), and `createWorker.ts` overrides the `.xml` Content-Type to `application/atom+xml` / `application/rss+xml` for the two feed paths (strict validators sniff for these). Feeds are a prod/build artifact — dev serves source, not `dist/`, so it doesn't serve them.

### Site-level discovery (`generate/site-discovery.ts`)

The per-post structured data tells crawlers and LLMs about *each post*; the feeds tell them how to subscribe. The site-as-a-whole needs three more files crawlers expect at the site root — none of them exists by default, and all three are cheap. `generate/site-discovery.ts` is the site-level analogue of `feeds.ts`: same `SITE_URL` gate, same disk gather (`posts/*.html` + `versions.json` + landing `index.html`), same fail-silent posture, **zero Worker code**. Runs after `feeds.ts` so it can advertise `/podcast.xml` in `llms.txt` only when feeds.ts actually emitted it.

- **`dist/robots.txt`.** Allow-everything signal + an absolute `Sitemap:` pointer. AI-crawler stance is **deliberate and default-allow** (the blog explicitly *wants* LLM understanding of the posts; blocking training/answer crawlers is counter to that goal); the file calls the stance out so a future contributor doesn't "lock it down" reflexively. Flip with `ROBOTS_AI_CRAWLERS=deny` and the file emits explicit `Disallow: /` for the known training/answer bots (`GPTBot`, `ChatGPT-User`, `OAI-SearchBot`, `ClaudeBot`, `Claude-Web`, `anthropic-ai`, `Google-Extended`, `PerplexityBot`, `CCBot`, `Applebot-Extended`, `Amazonbot`, `Bytespider`, `Meta-ExternalAgent`).
- **`dist/sitemap.xml`.** One `<url>` per real post (the same `posts/*.html` + author-email + `versions.json` convention `feeds.ts` uses) plus the landing page. `<lastmod>` comes from `versions.json`' newest `builtAt` (the same source as the feed `<updated>`); the landing's `<lastmod>` is the max across posts — a monotonic, no-extra-state proxy that updates when the post list does. Deliberately **omits `<changefreq>`/`<priority>`** — Google documents that it ignores both.
- **`dist/llms.txt`.** [llmstxt.org](https://llmstxt.org/) convention: a curated Markdown index an LLM indexer can read instead of crawling every page. Title heading + one-line site summary (the landing's first `<main> p`) + a linked post list with one-line descriptions (each post's `<meta name="description">` or `#lede` — the same source `feeds.ts:extractPostMeta` uses, so feed `<summary>`/RSS `<description>`/llms.txt all carry the *same* text) + a Feeds section pointing at `/feed.xml` (and `/podcast.xml` only when it exists). The companion `/llms-full.txt` (whole corpus inlined) is **deliberately deferred** — the article body is already the canonical crawlable text, so a full dump would duplicate what a crawler reads anyway.
- **One driver, shared gather.** All three files come out of one disk-walk reusing `feeds.ts`' pure helpers (`escapeXml`, `readSiteMeta`, `extractPostMeta`) — there is no second source of "what's a post" or "what's the site title." Served by `env.ASSETS.fetch` as `text/plain` / `application/xml`; no Worker route changes, no MIME overrides (sitemap consumers accept generic `application/xml`, unlike strict Atom/RSS validators).

**Dev doesn't emit** — same posture as feeds. `bun run dev` is the fast HMR loop and serves *source*, not `dist/`. To see these artifacts locally without deploying, use **`bun run dev:edge`** (`bun run build && wrangler dev`): it runs the full production build and serves the real `dist/` through the local Workers runtime at `localhost:3000`, so `robots.txt` / `sitemap.xml` / `llms.txt` (and the help page + feeds) resolve exactly as they will in prod.

### Reader-facing help & feature discovery (`generate/help-page.ts`)

Site-level discovery points *crawlers and LLM indexers* at the blog. This is its **human** analogue: every presidocs blog ships an audio-first player, Atom + Podcast feeds, a comment-as-revision workflow, a PWA, and keyboard shortcuts — but a reader landing on the homepage sees only a title and a post list, signposting none of it. `generate/help-page.ts` (the last build step, after `feeds.ts` + `site-discovery.ts`) closes that gap with three artifacts, all `SITE_URL`-gated, fail-silent, **zero Worker code**:

- **`dist/help.html`** — a "How this blog works" page, structured as one anchored `<section id="…">` per question a reader (or their LLM) would actually phrase: *listen*, *subscribe*, *comments*, *install*, *privacy*. Each section is conditional on the feature actually shipping (detected from disk exactly as the other steps do — any `generated/<slug>/manifest.json` with audio → the listen section; `dist/feed.xml`/`dist/podcast.xml` → the subscribe section + per-app recipes; a real post exists → comments; `dist/manifest.webmanifest` → install). So the page never documents a feature this build didn't produce.
- **Landing feature chips** — a `<nav class="presidocs-features">` auto-injected into `dist/index.html` immediately before the `<ul class="posts">` (idempotent on the `presidocs-features` marker; falls back to end-of-`<main>` if there's no post list). One chip per live feature, each linking to its `/help#…` anchor — so the landing finally signposts what the blog can do.
- **`FAQPage` JSON-LD** on `/help`, built from the *same* `(question, answer)` array as the prose (one source — the structured data and the visible page can't disagree about which questions exist). Each `Question` carries its section-anchor `@id` and the page is joined to the landing's `WebSite` `@graph` via `isPartOf`, so a search engine or LLM agent answering *"how do I add this to my podcast app"* can cite a specific URL (`/help#subscribe`) rather than infer from the posts.

Decisions worth keeping:

- **Engine-owned, unlike the [privacy page](#disclosure-surfaces).** The asymmetry is deliberate and load-bearing: privacy text makes *operator-specific* legal claims (controller, jurisdictions, sub-processors) so it stays content-side; help text makes *engine-behavioral* claims (how the player works, what the feeds emit, which keys are bound) so the engine is its authoritative narrator and emits it — which is also what keeps it from drifting as features change. An operator who wants their own copy drops a `help.html` in the content root; the emitter then **skips** (logged), and the normal build/serve path picks their file up.
- **Keyboard table is generated from `KEY_BINDINGS`** (`client/narratorDom.ts`), the same table the player's keydown handler dispatches off (see [Navigation granularities](#two-level-chapters-parts--sub-chapters)). Adding a shortcut in one place updates both the behavior and its documentation — no second hand-maintained list to drift.
- **Plain anchored sections, not `<details>` + script.** The page collapses nothing behind interaction: every per-app recipe is an always-present `<h3 id="…">` (e.g. `#subscribe-apple-podcasts`), in the DOM for crawlers/agents/reader-mode, each deep-linkable with a CSS `:target` highlight. The original design used collapsible `<details>` opened by a fragment-matching script, but the [CSP](#http-security-headers-sharedsecurityheadersts) forbids inline scripts — and plain sections turned out strictly better for SEO/LLM reach. (Inline `application/ld+json` is unaffected — CSP doesn't gate it, which is why the FAQPage block and the existing [structured data](#structured-data-schemaorg-open-graph-twitter-card-sharedinjectstructureddatats) both ship inline.)
- **Comments gate is "has ≥1 post," not "auth configured."** OAuth is a runtime secret the build can't read, and the comment UI ships on every post regardless, so a non-zero post count is the honest build-time signal for the comments section/chip.
- **Reuses one source of truth throughout.** Site title/description from `readSiteMeta` (the landing's own HTML), site author from the newest post's profile (the same rule the feed channel + landing JSON-LD use), the bundled stylesheet lifted verbatim from `dist/index.html` so `help.html` is styled by the same hashed chunk — the engine never hardcodes a blog name or a second stylesheet. The footer and `<head>` chrome come from the same [`injectSiteFooter`](#disclosure-surfaces) / [`injectPwaHead`](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts) the other pages use, so `/help` isn't an outlier.

**Previewing locally — use `dev:edge`, not `dev`.** `/help` is a prod build artifact like the feeds and sitemap (`post-routes.ts` scans the content root, so a `dist/`-only `help.html` has no route in the HMR `bun run dev` server). It's fully previewable locally without deploying: **`bun run dev:edge`** (`bun run build && wrangler dev`) serves the real `dist/` through the local Workers runtime at `localhost:3000`, where `/help` resolves at the extensionless path via Workers Static Assets `html_handling` (exactly as `/privacy` does from `dist/privacy.html`), with the landing chips, footer, feeds, and CSP all live. For a tight iteration loop on the page content itself, re-running just `bun engine/generate/help-page.ts` after an initial build rewrites `dist/help.html` in place (the chip inject is idempotent, so it no-ops on the already-chipped landing — rebuild `index.html` if you're changing the chip set), and a running `wrangler dev` serves the new file on the next request — no full rebuild. `llms.txt` lists `/help` in its `## Optional` section (same gate), so an LLM gets the curated page too.

**Deferred follow-ups (not built).** Four were considered and parked: (1) a standalone `/subscribe` page — for now subscribing is a section of `/help`, split it out only if that section bloats or traffic concentrates there; (2) an engine-narrated "what this blog is" intro Listen control on the landing — needs an audio asset and a player-without-a-post code path, its own proposal when revisited; (3) `<podcast:funding>` / `<podcast:value>` tip-jar / value4value tags in the podcast feed — not wanted now, but the Podcasting 2.0 feed already speaks the namespace, so a future operator can add them cheaply; (4) full content i18n — the page is `en`-only today (it does set `<html lang>` from `FEED_LANGUAGE`), deferred until a non-English deploy asks.

### Secrets

All OAuth client secrets and `SESSION_SECRET` (or `SESSION_SECRETS=v1:…,v2:…` for [key rotation](#sessions-jwt-cookie-hs256-jose)) live in Cloudflare's encrypted secret store (`wrangler secret put ...`), *not* in `wrangler.toml`. Names line up with the dev `.env`, so the route handlers read the same `process.env.*` / `env.*` regardless of runtime.

**`.env` is dev-only and is never uploaded to Cloudflare — this is the easy-to-miss step when standing up a new blog.** Bun auto-loads `.env` on localhost, so dev "just works" and gives the false impression the credentials are configured everywhere. In production `process.env` is populated *only* from `[vars]` in `wrangler.toml` plus whatever has been pushed with `wrangler secret put` — the file on disk is invisible to the Worker. Because the OAuth providers are constructed lazily ([`server/auth/providers.ts`](#commenting-as-a-core-feature) — `required()` throws on first use, not at boot), a blog with no secrets set deploys cleanly and serves fine until the *first login attempt*, which fails with `auth misconfigured: GOOGLE_OAUTH_CLIENT_ID env var is required for OAuth`. That deferred failure is the symptom of a fresh deploy that copied the dev `.env` but never ran `secret put`.

So **a new blog's deploy checklist is two commands plus pushing every secret once**:
```sh
bun run build && wrangler deploy                  # the two-command deploy (see Deploy unit)
for k in SESSION_SECRET \
         GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET \
         MICROSOFT_OAUTH_CLIENT_ID MICROSOFT_OAUTH_CLIENT_SECRET \
         OAUTH_REDIRECT_BASE; do
  printf %s "$(grep -m1 "^$k=" .env | cut -d= -f2-)" | wrangler secret put "$k"
done
wrangler secret list                              # verify all are present
```
(`printf %s` avoids baking a trailing newline into the secret value.) `OAUTH_REDIRECT_BASE` must be the public origin, e.g. `https://blog.example.com`, since the provider redirect URIs are derived from it ([`redirectUri()`](#commenting-as-a-core-feature)); `BLOCKED_USERS` and `VAPID_PRIVATE_KEY` are set the same way if/when those features are used. Engagement analytics live entirely behind Cloudflare bindings (Analytics Engine + a separate rate limiter — see [Engagement analytics](#engagement-analytics-analytics-engine)), so they need no env vars or secrets at all — just the binding declarations in `wrangler.toml`. **Setting a secret redeploys the running Worker immediately**, so no separate `wrangler deploy` is needed after a `secret put`.

The matching **provider-side** step is registering each redirect URI (`<OAUTH_REDIRECT_BASE>/auth/<provider>/callback`) in the Google Cloud OAuth console and the Microsoft Entra app registration — a `redirect_uri_mismatch` at login means that registration is missing, distinct from the missing-secret error above (both the localhost and prod URIs must be registered; see the [runtime-split table](#runtime-split)).

### Why not KV

Cloudflare's **Workers Rate Limiting API** does the same job with substantially less code we have to own:

| | With KV | With Workers Rate Limiting API |
|---|---|---|
| Storage | We design a key scheme (e.g. `rl:<userId>:<minute-bucket>`) | Cloudflare-managed, no keys |
| Increment + check | We `get`, `+1`, `put`, compare to threshold | One call: `await limiter.limit({ key })` returns `{success}` |
| Window math | We pick fixed buckets or implement a sliding window ourselves | Sliding window built in |
| Concurrent increments | KV's eventual consistency means two simultaneous increments can both read the pre-increment value and race | Handled by Cloudflare's distributed counter |
| Declaration | none | one block in `wrangler.toml` |

There's no real win KV offers back. KV would also be a poor fit for the comment change-objects themselves — content-addressed immutable objects benefit from R2's strong read-after-write consistency (a client that just `PUT`'d a change should immediately see it on `LIST`); KV's up-to-60-second propagation would create the appearance of lost writes whenever a client pulled right after pushing.

So KV ends up with no use case that something else doesn't do better.

### Hardening

R2 access is gated by the Worker (the bucket itself is private). Every request goes through `server/comments/routes.ts`:

| Operation | URL | Allowed when |
|---|---|---|
| List users for a post | `GET /comments?post=X` | session present AND session is the post's author |
| List change hashes for a (post, user) | `GET /comments?post=X&user=Y` | session present AND (`session.userId === Y` OR session is the post's author) |
| Fetch one change | `GET /comments?post=X&user=Y&change=Z` | same as above |
| Upload one change | `PUT /comments?post=X&user=Y&change=Z` | session present AND `session.userId === Y` (and not in `BLOCKED_USERS`) |
| List resolved threadIds for a post | `GET /resolutions?post=X` | session present (any logged-in user) |
| Fetch one resolution body | `GET /resolutions?post=X&thread=T` | session present (any logged-in user) |
| Write a resolution | `PUT /resolutions?post=X&thread=T` | session present AND session is the post's author |
| Read post version + (author-only) history | `GET /post-version?post=X` | session present; `history` field only populated for the post's author |

"Session is the post's author" means the session's verified email matches the post's `<meta name="author-email">` tag — see [Per-post author metadata](#per-post-author-metadata-serverpostmetats). Readers can read and overwrite only their own change-objects (needed for cross-device sync); the author of a post can read everyone's change-objects; nobody else sees anything. The author has no special PUT power — they only ever write to their own folder.

Validation runs on every PUT:

| Check | Limit | What it bounds |
|---|---|---|
| Body size | `MAX_CHANGE_BYTES = 8 KB` | One Automerge change typically lands under 1 KB after compression, even with the 5000-char reply max; 8 KB is well above any single legitimate change. |
| Rate limit | 10 PUTs / 60s per `userId` (`wrangler.toml`) | Throttles sustained writes — change-objects are immutable and content-addressed, so an attacker can't reuse a key to inject content, but they can still pile up new ones without this. |
| Block list | `BLOCKED_USERS` env var (comma-separated `<provider>:<sub>`) | Listed users' PUTs return a 200 but never touch the store. No R2 ops, no rate-limit budget burned. Update via `wrangler secret put BLOCKED_USERS`. |
| Per-reply text length | 5000 chars | **Client-side UX only** — strict server-side enforcement would require shipping Automerge into the Worker bundle (~700 KB) to parse the change. The 8 KB per-change cap covers the same threat envelope at zero bundle cost. |

Stacked together: a max-rate attacker on a fresh account can write at most 10 changes/min × 8 KB = 80 KB/min into their own folder, can't touch anyone else's content (auth check), and once you add them to `BLOCKED_USERS` their next PUT silently goes nowhere. The bucket-wide blast radius per attacker is bounded by storage cost — pennies per month in the absolute worst case.

### HTTP security headers (`shared/securityHeaders.ts`)

The request-auth + validation layer above is about *who can write what*. The response-header layer is the orthogonal floor for an OAuth-gated UGC system that renders reader comments into the article page: the threats it addresses are **XSS via comment content** (every interpolation point uses `textContent` today, but a CSP is the defense-in-depth against a future regression) and **clickjacking of the OAuth flow**. The session cookie flags are already correct (`HttpOnly; Secure` (prod); `SameSite=Lax` — see [Sessions](#sessions-jwt-cookie-hs256-jose)); this is purely additive at the response layer.

**One shared module, two runtimes.** `shared/securityHeaders.ts` exports `withSecurityHeaders(res, { private })`, imported by both the content repo's `worker.ts` (via `createWorker.ts`) and dev server (via `createDevServer.ts`) — the same dev/prod-parity pattern the handlers use. In the **Worker** it wraps *every* response: API routes are wrapped `{ private: true }`, and the `ASSETS.fetch` fall-through (which serves the **article HTML** — see [Static vs dynamic content](#static-vs-dynamic-content)) is wrapped public, so the document CSP genuinely takes effect in prod.

> **`run_worker_first = true` is mandatory for the above to hold (`wrangler.toml` → `[assets]`).** This bit us on the first real deploy. With the modern Workers Static Assets binding, the **default is that Cloudflare serves a matching static asset directly and never invokes the Worker** — so the article HTML/JS/CSS would go out with *no* security headers (the API routes, which always run the Worker, would carry the CSP; the documents would not — a silent, easy-to-miss split). Setting `run_worker_first = true` makes the Worker run on every request; it then fetches the asset via `env.ASSETS.fetch` and wraps it, which is the only way the `ASSETS.fetch` fall-through above is actually reached. Verify after any deploy with `curl -sD- -o/dev/null <url>/posts/<slug> | grep -i content-security-policy` — an empty result means the Worker is being bypassed. This lives in each *content* repo's `wrangler.toml` (and the `templates/content-repo/` starter), since that's where the deploy config lives.

**The dev asymmetry worth knowing.** `Bun.serve`'s `routes` serves the two HTML pages (`/` and the post) as `HTMLBundle` values, not functions, and there's no response-header hook for them — so they **cannot be wrapped**. The Bun dev server therefore applies headers only to the *function*-style routes (auth, comments, `/post-version`, the generated-asset + WASM routes); the two HTML routes go out bare. Consequence: **the document CSP is verified against `wrangler dev` / a deploy, not the Bun dev server.** This is convenient, not just tolerable — it also means Bun's HMR injecting its own inline `<style>`/`<script>` into those HTML routes never trips the policy, so `style-src`/`script-src` stay tight (`'self'`) in both runtimes with no dev-only carve-out.

The Content-Security-Policy (the load-bearing directives are commented in the source):

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'none'` | Deny-all base; every used category is opened explicitly below. |
| `script-src` | `'self' 'wasm-unsafe-eval'` | **`'wasm-unsafe-eval'` is mandatory** — Automerge instantiates its WASM core from a *fetched buffer* (`client/commentsStore.ts`), which `'self'` alone does **not** permit; omit it and the entire comment system dies under enforcement. No `'unsafe-inline'`: there are zero inline JS `<script>` blocks (narration/PLS scripts are stripped at build time; the engagement-analytics beacon is `navigator.sendBeacon` from our own bundled module, not an inline `<script>`). |
| `style-src` | `'self'` | **No `'unsafe-inline'`.** `index.html`'s former inline `<style>` was externalized to `client/landing.css`; every other stylesheet is `<link>`ed. The ~21 client-side `.style.x =` writes are CSSOM, which CSP does not govern. |
| `img-src` | `'self' https://lh3.googleusercontent.com https://graph.microsoft.com https://*.graph.microsoft.com` | Google + Microsoft Graph avatars. **Both the bare host and the wildcard** are listed because a CSP `*.host` matches subdomains but *not* the bare host. Missing avatars degrade to the colored-initial fallback, so this is low-risk. |
| `connect-src` | `'self'` | Same-origin XHRs (`/comments`, `/auth/me`, manifests) **and** the engagement-analytics beacon (`/_a`, written server-side to Analytics Engine — no cross-origin analytics endpoint runs in the browser). |
| `form-action` | `'self' https://accounts.google.com https://login.microsoftonline.com` | **Defensive only, not load-bearing.** Login is an `<a href="/auth/google">` → 302 *navigation*, which spec-compliant `form-action` does not govern (the IdP origins are kept for Safari's broader interpretation and a future POST form). |
| `frame-ancestors` | `'none'` | Clickjacking protection (the modern `X-Frame-Options: DENY`), for both the article and the OAuth flow. |
| `media-src` | `'self'` | Audio MP3s served same-origin via the `ASSETS` binding. |
| others | `base-uri 'self'`, `object-src 'none'`, `worker-src 'self'` (no `blob:` — nothing constructs a `Worker`; the lone Shikwasa `createObjectURL(blob)` is ID3 cover-art governed by `img-src`, and dormant since our mp3s carry no embedded artwork), `font-src 'self'`, `manifest-src 'self'`, `upgrade-insecure-requests` | Cheap deny/scope rules. WASM execution is governed by `script-src` (above), **not** `worker-src`. |

The rest of the set:

- **`Strict-Transport-Security: max-age=63072000`** — **prod only** (gated on `isProd()`, exactly like the `Secure` cookie flag; HSTS over plain-HTTP localhost is meaningless). Deliberately **bare `max-age`**: no `includeSubDomains`/`preload` until the production hostname is confirmed. `preload` is the one near-irreversible line in the whole stack — it's baked into shipped browser binaries globally and de-listing takes months, so "we can make any breaking change pre-launch" does *not* cover it.
- **`X-Content-Type-Options: nosniff`** — comments are stored/served as `application/octet-stream` (Automerge change bytes); a sniffer mis-identifying user-controlled bytes as HTML would defeat the same-origin protection.
- **`Referrer-Policy: strict-origin-when-cross-origin`** — pins the modern default explicitly; avoids leaking comment-bearing paths to outbound links / the IdP.
- **`Permissions-Policy`** — deny every feature except `autoplay`, `fullscreen`, `picture-in-picture` = `(self)` (the narrator/Shikwasa player needs these from same-origin code).
- **`Cross-Origin-Opener-Policy: same-origin`** — isolates the browsing-context group (cheap; relevant if OAuth ever moves to a popup).
- **`X-Frame-Options: DENY`** — redundant with `frame-ancestors 'none'` on modern browsers, kept as a free fallback for any ancient UA that ignores CSP (clickjacking the OAuth flow is a named threat).
- **`Cross-Origin-Resource-Policy: same-origin`** — set **only on private (non-asset) responses** (comments, `/auth/me`, `/post-version`), so a third-party page can't load them as a cross-origin subresource. Not set on the article HTML/JS/CSS/audio.
- **`Cache-Control: private, no-store`** on the identity/comment responses (`/auth/me`, the comment endpoints) — these echo the logged-in user's email/name/picture or their private comment bytes; CORP stops cross-origin *loads* but not browser/shared-cache *retention*, so these are set per-handler in `server/auth/routes.ts` / `server/comments/routes.ts` (not in the shared wrapper, since assets *should* cache).

**Cookie hardening, paired.** The session cookie carries the **`__Host-` prefix in prod** (`__Host-blog-session`), pinning it to the exact origin (forces Secure + Path=/ + no Domain). The prefix requires `Secure`, which is only set in prod, so dev (`http://localhost`) falls back to the bare `blog-session` name — resolved consistently for set/read/clear within each environment. The logout clear must itself carry Secure + Path=/, or the browser rejects the delete and the cookie survives.

**Verifying / iterating.** `securityHeaders()` reads a `CSP_REPORT_ONLY` env flag: when set, it emits `Content-Security-Policy-Report-Only` instead of the enforcing header, so the policy can be exercised against `wrangler dev` with violations logged (not blocked) before enforcing — the step that catches a forgotten origin or a dropped `'wasm-unsafe-eval'`. `shared/securityHeaders.test.ts` regression-guards the two silent-breakage traps (the WASM keyword; no `'unsafe-inline'` in `style-src`) plus the HSTS/CORP gating and the report-only toggle. Because the site is pre-launch (no traffic to protect, breaking changes acceptable), the multi-phase report-only-then-enforce *rollout* collapsed into shipping the tight end-state in one change, verified locally.
One remaining behavior to double-check at runtime:
- **the audio player** — Shikwasa's ID3 cover-art path (`createObjectURL(blob)`) would need `img-src blob:`, dormant only as long as our mp3s carry no embedded artwork

**Where they are NOT set.** Not via a Cloudflare Pages `_headers` file — the Workers Static Assets binding doesn't read it (a Pages convention; we run [one Worker, not Pages](#deploy-unit)). Not per-handler at each `new Response(...)` — easy to miss a call site and unreachable for the assets fall-through. The single `withSecurityHeaders` wrapper is the only attachment point.

### Excluded from v1

- **Separate API and asset deployments** (Pages + Worker). One Worker with the assets binding covers both.
- **Cloudflare KV** — see above.
- **Durable Objects** — overkill at this scale. The per-user R2 blob already serializes that user's writes; we don't need an actor model on top.
- **Turnstile / CAPTCHA** — wired in only when rate limits actually start tripping for legit users. The hooks (a 429-with-challenge path) can be added in a few lines later.
- **Audit log** of every PUT. Cheap insurance, but not load-bearing until something goes wrong.
- **HSTS `includeSubDomains` + `preload`** — see [HTTP security headers](#http-security-headers-sharedsecurityheadersts); deferred until the production hostname is final (`preload` is effectively irreversible). Today we ship bare `max-age`.
- **A CSP reporting endpoint** (`Report-To` / a `/csp-report` route) — Cloudflare has no off-the-shelf sink for CSP reports, so violations live in users' DevTools only. Stand one up (a few lines, `console.log` → `wrangler tail`, or pipe into the `blog_engagement` Analytics Engine dataset alongside the rest of the analytics) if the policy ever needs post-deploy tuning.
- **A CSP nonce** — buys nothing while there are no inline `<script>` blocks (the analytics beacon is external-`src`). Revisit only if authored post HTML grows inline scripts.
- **`Cross-Origin-Embedder-Policy`** — `require-corp` would force every cross-origin response we load (avatars, the beacon) to ship CORP headers of their own, for the sole benefit of `SharedArrayBuffer` / high-res timers, which we don't use (Automerge's WASM works without them).

## Privacy & data protection

A reader-facing blog with login-gated comments and page-view analytics is **already a personal-data system** under [GDPR][GDPR], [CCPA/CPRA][CCPA], and Japan's [APPI][APPI] — even when the data collection is deliberately small. The engine treats privacy as a first-class concern with three layers: a small, mostly-zero **data inventory** that we keep accountable to ourselves; an **always-on disclosure surface** (footer link + just-in-time notice + full policy page) sized to satisfy GDPR Art. 12–14, CalOPPA's "conspicuously post," and APPI's notice-at-collection rule with one pattern; and a **forward-looking checklist** that any new feature has to pass before it ships.

The disclosure pattern follows [ISO/IEC 29184:2020][ISO29184] (the international standard for online privacy notices and consent) and the UK ICO's "concise, transparent, intelligible, easily accessible" reading of GDPR Art. 12 — *layered notices*: a one-click footer link on every page (full policy), plus just-in-time disclosure at the point of collection (the OAuth login button). No single web standard mandates an exact location, so we follow the industry pattern that satisfies every named regime at once.

### Data inventory

What gets collected, where it lives, who acts as processor, what the legal basis is. **Keep this list authoritative** — every entry needs a matching paragraph in the per-blog `privacy.html`, and adding to this list always means updating that page in the same PR.

- **Engagement analytics** — Cloudflare Analytics Engine (see [Engagement analytics](#engagement-analytics-analytics-engine)). Per page load: post slug + referrer hostname (no full URL). Per narration session: post slug, what triggered playback (button / Space / OS media key / chapter pill / seek), the audio's master-track duration, and which 25 / 50 / 75 / 100 % quartiles the listener crossed. No cookies, no per-visitor identifier reaches the operator. Cloudflare receives the IP transiently to handle the request, drops it through the edge bot filter, and does not retain it in the analytics dataset. Narration events fire only after the listener has explicitly pressed play. **Legal basis:** legitimate interest (GDPR Art. 6(1)(f)) — minimal, aggregate, no profiling. **Sub-processor:** Cloudflare.

- **Comments** — only collected if a reader chooses to sign in. From the OAuth provider we receive `(provider, sub, name, email, picture URL)`; we store the comment body, anchor, and that identity in per-user R2 blobs (see [Storage layer](#storage-layer-clientcommentsstorets) and [Comments R2 layout](#why-not-kv)). The blob path embeds `<provider>:<sub>`, the byline shows name + avatar, the email is held server-side only (used for reply notification, never rendered — same property the [byline privacy invariant](#author-profiles-and-bylines-sharedauthorprofilets-clientbylinets) enforces for authors). **Legal basis:** consent (GDPR Art. 6(1)(a)), recorded by the act of clicking "Sign in with X" and submitting a comment; withdrawable by deleting the comment or requesting deletion. **Sub-processors:** Cloudflare (storage), Google + Microsoft (authentication).

- **Session cookie** — `__Host-blog-session` (prod) / `blog-session` (dev), HS256 JWT, `HttpOnly; Secure; SameSite=Lax`, 400-day TTL (see [Sessions](#sessions-jwt-cookie-hs256-jose)). Set *only* after a user clicks a login button, so it's **strictly necessary** under GDPR/ePrivacy — no banner required. The cookie value is opaque to the operator beyond the JWT payload (`userId`, `name`, `email`, `picture`).

- **OAuth flow cookies** — `blog-oauth-state-<provider>` and `blog-oauth-verifier-<provider>`, 10-minute lifetime, cleared on callback (see [OAuth flow plumbing](#oauth-flow-plumbing)). CSRF + PKCE plumbing only; never read after the flow completes. Strictly necessary.

- **Server logs** — the Worker emits standard request logs (timestamp, method, path, status, edge IP) as a side effect of running on Cloudflare's platform. Not extracted for analytics; Cloudflare's standard retention applies.

What we do **not** collect: third-party advertising cookies, tracking pixels, persistent client fingerprints, behavioral profiles, geolocation, account passwords (OAuth handles that at the provider). The CSP (`shared/securityHeaders.ts`) is the structural check on this — adding a new tracking script would require relaxing `script-src` first.

### Disclosure surfaces

Three surfaces, one source of truth (the per-blog `privacy.html`):

- **The policy page** — `<content-repo>/privacy.html`. Lives in the **content repo**, not the engine, because it makes operator-specific claims (controller identity, contact email, jurisdictions named, sub-processor list as of today). The engine ships no policy text — that would be a forged representation on behalf of the operator. A fresh content repo without `privacy.html` simply gets no footer link (the injector is env-gated, see below).

- **The footer** — every served page carries a `<footer class="site-footer">` with a small link set (`Home` · `How this blog works` · `Privacy Policy`), produced by `shared/injectFooter.ts`. Each link is independently gated: the privacy link on `PRIVACY_POLICY_URL`, the [help link](#reader-facing-help--feature-discovery-generatehelp-pagets) on `SITE_URL` (the gate under which `/help` is emitted), and `Home` whenever a footer shows at all; with neither help nor privacy available the footer is a no-op (a lone `Home` link is noise). Feeds are deliberately **not** linked here — a visible "Podcast" link would 404 on an audio-less blog, and raw feed XML is unfriendly to a human, so `/help#subscribe` is the human entry point and the `<head>` autodiscovery `<link>`s are the machine one. It runs at build time through two paths: the Bun bundler plugin `shared/bunFooterPlugin.ts`, wired into the bundle step in `engine/generate/build-html.ts`, and the post-build `strip-served-html.ts` sweep as a backstop (idempotent on the `class="site-footer"` marker). Both paths derive the *same* two hrefs from the *same* env, or they'd render different footers depending on which won the idempotency race. See [Build-time HTML strip](#build-time-html-strip-generatestrip-served-htmlts). **The footer is fully engine-owned** — content pages do not hand-author one (removing a hardcoded `<footer>` is what lets the injected set, including the help link, reach the landing and policy pages).

- **The just-in-time notice** — a single `<p class="cmt-identity-privacy">` rendered by `client/comments.ts` directly under the OAuth login buttons, naming what's recorded and linking to `/privacy`. This is the *point of collection* — GDPR Art. 13 wants the legal basis (consent) and a pointer to the full notice surfaced at exactly the moment the user is about to give it. Built with `textContent` + a single anchor — no `innerHTML` splicing — matching the rest of the comments UI's XSS posture (every interpolation point is `textContent`; the CSP is the structural backstop, see [HTTP security headers](#http-security-headers-sharedsecurityheadersts)).

**Why build-time injection, not a static `<footer>` in each post.** Hand-rolling the same footer into every post HTML would duplicate the markup, and a content repo author would have to remember to paste it into every new post they wrote. A client-side DOM injection would either flash the page without a footer before the script ran, or require adding script-driven content (breaking the "no extra runtime JS" posture). Build-time injection treats the footer as a deploy-time decoration, exactly like the analytics beacon and the structured-data block, with the same fail-silent posture if the env var is unset.

**Dev visibility.** The build-time injector runs through a Bun bundler plugin (`shared/bunFooterPlugin.ts`), which `Bun.build` accepts but Bun's *runtime* plugin system (1.3.14) rejects — registering it from the dev server's entry crashes on `loader: "html"`. So `bun run dev` doesn't get the inject on `HTMLBundle` routes, and since the footer is now [fully engine-owned](#disclosure-surfaces) (no hand-authored fallback in source), **no page shows a footer under `bun run dev`** — the same prod-only posture the feeds, sitemap, and `/help` already have. It's author-visible at `dev:edge` and on the deployed site. When Bun's runtime plugin system gains html-loader support, registering `siteFooterPlugin()` in each content-repo's `index.ts` will close the dev gap with no other code changes.

**Dev routes for non-post pages.** `generate/post-routes.ts` (the dev-server route-table codegen) picks up any root-level `*.html` besides `index.html` and routes it to `/<basename>`, so `/privacy` works under `bun run dev` without a manual import. This is the general path for any future top-level legal/marketing page (`terms.html`, `accessibility.html`) — drop the file in the content repo, restart dev, the route is there.

### Considering privacy for new features

Privacy isn't only "what we collect today." A new feature can quietly turn a no-data system into a data-handling one, and the cost of fixing that *after* it ships is high. Before adding anything that touches reader-side state, walk the checklist:

**1. Does this feature collect or process personal data?** Personal data is anything that could identify a specific person, directly (name, email, login ID) or indirectly (IP-pinned analytics, persistent client fingerprints, comment text mentioning identity). If yes:

- **What's the legal basis under GDPR?** Pick exactly one and document it. The realistic options here are *consent* (Art. 6(1)(a) — explicit user action like "Sign in with X" or a notification opt-in), *legitimate interest* (Art. 6(1)(f) — only safe when data is minimal, aggregate, and not used for profiling; see analytics), and *contract* (Art. 6(1)(b) — almost never applies on a personal blog). If the choice isn't obvious, the answer is probably "we shouldn't be collecting it."

- **Where will it be stored, and who can read it?** Sub-processor or first-party? If new sub-processor, add to the policy and the data inventory in this section.

- **What's the retention policy?** "Until the user deletes it" is fine for user-authored content; "indefinitely" for anything else is a red flag. Anything operational (logs, debug traces) should have a stated upper bound.

- **Does the user need a just-in-time notice at the point of collection?** Sub-rule: if the action that records the data is *user-initiated* (click a button), JIT is mandatory — it's where GDPR Art. 13 wants the notice. If the data is collected passively in the background, the footer link plus a paragraph in the policy is the floor.

- **Is there a deletion path?** Every personal-data store has to be removable on request; if the feature stores something the operator can't see or delete on the user's behalf (e.g. a third-party widget's cookie), don't ship it.

**2. Does it set or read a cookie?**

- *Strictly necessary* cookies (session auth, CSRF state, language preference set by user action) need **no** banner and no consent, but they go in the policy with their purpose, lifetime, flags.
- *Non-essential* cookies (analytics, advertising, A/B testing, persistence beyond the session) would require a **consent banner with a real reject path** before being set. We have none today and the bar to add one is high — the engagement-analytics path (Analytics Engine, see [Engagement analytics](#engagement-analytics-analytics-engine)) is cookieless and identifier-free precisely so we don't have to. If a feature would set a non-essential cookie, the right move is almost always to use a cookieless alternative or skip the feature.

**3. Does it add a sub-processor?**

Every external service that touches reader data is a sub-processor under GDPR and a "service provider" under CCPA. **Name it in the policy.** Today the list is short (Cloudflare; Google and Microsoft as OAuth IdPs). Adding e.g. a third-party comment system, a hosted search service, an email-newsletter platform, or an embed that fetches data, means amending the policy *in the same PR* that wires up the integration. If the policy update isn't worth doing, the integration probably isn't worth shipping.

Within Cloudflare itself, R2 and Workers KV are already covered by Cloudflare's data-processing terms — moving comments to KV (we've [explicitly declined to](#why-not-kv)) wouldn't add a new sub-processor, but adding e.g. Cloudflare Email Routing or Stream would.

**4. Does it expose data to third parties beyond service-provider use?**

- "Sale" or "sharing" under CCPA/CPRA is broader than "for money" — it includes most forms of disclosure for cross-context behavioral advertising. **We do not sell or share**, full stop, and the policy says so. A new feature that would change this (e.g. an embed that ships visitor data to an ad network) would also require: a "Do Not Sell or Share My Personal Information" or "Your Privacy Choices" link in the footer (CCPA §1798.135), a Global Privacy Control handler, and explicit consent-or-opt-out plumbing. That's a multi-week add, not an afternoon — treat the choice with that weight.

- *Disclosures to authorities* (legal-process compliance) are not "sale" but they're worth keeping in mind; the policy already covers them with a single sentence.

**5. Is the feature reader-visible only, or does it touch the operator's own data?**

If the feature collects data *about the operator* (e.g. surface authoring analytics, expose draft history publicly), the analysis is the same — the operator is also a person under these regulations. But the [author-email privacy invariant](#why-email-and-not-userid) and the [byline-email-doesn't-leak invariant](#author-profiles-and-bylines-sharedauthorprofilets-clientbylinets) are already engine-level guarantees; respect them. Specifically, *no public surface should derive from the author email* (avatar URLs hash it, byline never renders it, JSON-LD omits it). New surfaces that would expose author data have to maintain that property.

**6. Is the feature subject to a stricter regime than GDPR/CCPA/APPI?**

The blog is not directed at children (under 16, per the policy); a feature that *would* attract under-16 users (e.g. content for schools) crosses into COPPA / Article 8 territory and needs verifiable parental consent. Health, financial, biometric, location-pinpoint data are all special categories under GDPR Art. 9 and out of scope for this engine — do not store them.

**7. Operational defaults.**

- Use the existing CSP as a structural check (a new tracking script can't load without relaxing `script-src`).
- Use the existing comment-system "everything goes through `textContent`" rule as a structural check on what reaches the DOM.
- Use the existing R2-per-user blob shape: it makes per-user deletion a single `DELETE` and per-user export a single `GET`, which is what Art. 15 / 17 / 20 rights mostly come down to.
- Keep the `.env` env var pattern (fail-silent if unset). A privacy feature that *requires* a build-time secret to function should not silently no-op the privacy property — but a feature that *additionally* discloses something can fail-silent (no analytics token → no analytics, no policy URL → no footer link, both fine for a personal-build).

**When in doubt, the answer is "don't collect it."** The cheapest data to keep compliant is the data that was never collected; the second cheapest is data the operator can delete with a single command. Optimize for that ordering before reaching for processes (audit logs, DPIA, data-mapping doc).

### Operator obligations (what the engine doesn't automate)

A handful of compliance duties are inherent to running a blog and the engine deliberately doesn't try to solve them — they're per-operator and not technical:

- **Keep `<content-repo>/privacy.html` current**, including the "Last updated" date. Any change to the data inventory in this section is a code-and-content change in the same PR.
- **Respond to data-subject requests** (access, rectification, deletion, portability) within the regulatory window (30 days GDPR / APPI, 45 days CCPA). The contact email on the policy is the funnel.
- **Maintain the sub-processor list** as Cloudflare's own product surface evolves (new bindings, new regions). The list in this section is a snapshot.
- **Notify affected users of a personal-data breach** within 72 hours of becoming aware (GDPR Art. 33–34). The R2 audit log we [chose not to ship](#excluded-from-v1-3) is a real gap here at scale; reconsider it before any commercial deployment.

### Excluded from v1

- **Cookie banner / consent management platform** — not required under the current shape (cookieless analytics, strictly-necessary session cookie set only on user-initiated login). Adding one would mean adding a *non-essential* cookie or tracker — see the checklist above. If that ever happens, the banner has to offer a reject-all path as prominent as accept-all (the EDPB has been explicit on this).
- **"Do Not Sell or Share / Your Privacy Choices" link** — required only if the operator sells or shares personal information in the CCPA sense, which we don't. Surface and Global Privacy Control wiring would come together.
- **Formal DPIA** (Data Protection Impact Assessment under GDPR Art. 35) — not required at this scale or risk level; this section + the policy file are the proportionate substitute. A DPIA becomes mandatory if e.g. comments are processed in bulk for sentiment analysis, or features start systematically profiling readers.
- **DSAR (Data Subject Access Request) self-service portal** — manual via email is fine at this volume. The R2-per-user blob shape means a fulfillment is `GET blobs/<userId>` for export, `DELETE blobs/<userId>` for erasure; if request volume ever justifies it, a `/me/data` route would be a small add.
- **R2 audit log** of every write — same note as in the deploy-architecture [Excluded from v1](#excluded-from-v1-3), reconsidered through the privacy lens: it would also harden Art. 33 breach response. Still deferred; flagged for any commercial deployment.
- **Cookie consent for engagement analytics** — the Analytics Engine path is cookieless, identifier-free, bot-filtered, and aggregate, so we treat it as legitimate-interest with no banner. The EDPB has not blessed cookieless analytics in general, and some regulators read ePrivacy strictly enough that a banner might still be required in some jurisdictions; revisit if a regulator points one out.
- **Engine-level policy boilerplate.** We deliberately ship no `privacy.html` template — see "Disclosure surfaces" above. A future helper that scaffolded a placeholder policy (`bun run init:privacy`) is reasonable, but it would have to make extremely loud that the operator owns every claim it makes.

## Terminology

Two units of spoken content come up throughout this doc

- **Chapter** — one `<script type="text/narration">` block in the post. Authored with `data-chapter-id` and `data-chapter-title` attributes. Maps 1:1 to a chapter in the audio player (chapter-skip lands here). Code type: `NarrationChapter`.
- **Segment** — the text between two `<mark>` boundaries inside a chapter. This is the unit that gets handed to the TTS provider, the unit that the audio cache keys on, and the unit the player highlights/scrolls to. Code type: `Segment`, produced by `splitChapter`. A chapter contains many segments.

The word **chunk** is deliberately *not* used as a user-facing concept (it's too generic to mean any one thing, and often already used in audio-processing contexts).

## Relation to other specifications

### In active use

- **Web Annotation Data Model** ([spec][AnnotationModel]): the comments system stores every anchor as a Web Annotation *target* (selectors over the post — `RangeSelector` + `TextQuoteSelector`, or a `FragmentSelector` for graphics), and exports threads as a JSON-LD `AnnotationCollection`. See [Comments → Anchoring](#anchoring-the-web-annotation-target-model) and [Exporting to the Web Annotation wire format](#exporting-to-the-web-annotation-wire-format). (Still *not* used for the narration `<mark>` ↔ `id` pairing — that relation is simple enough to need no annotation vocabulary.)
- **JWT / JWS / JWA** ([RFC 7519][JWT], [RFC 7515][JWS], [RFC 7518][JWA]): session cookies are HS256-signed JWTs — a compact JWS serialization, `HS256` from the JWA algorithm registry — verified by `jose` with a hard-pinned algorithm allowlist (the [JWT BCP][JWT-BCP], RFC 8725) and a `kid` header for key rotation. See [Sessions](#sessions-jwt-cookie-hs256-jose). Provider ID tokens are *also* JWTs, but we deliberately *don't* verify them — see [Userinfo from `/userinfo`](#userinfo-from-userinfo-not-from-a-decoded-id-token).
- **Media Session API** ([spec][MediaSession]): the narration player wires the OS-level "now playing" surface (lock screen, macOS Now Playing, notification tile) and routes hardware/Bluetooth/media-key controls into the player. See [OS media controls](#os-media-controls-media-session-api).
- **Service Workers + Cache API** ([spec][ServiceWorkers]): `client/sw.js` is the offline cache — cache-first for hash-named JS/CSS, content-addressed audio, the narration manifest, and the Automerge WASM; network-first-with-fallback for navigations and post HTML; network-only for auth/comments/post-version/analytics. Range requests are sliced from the cached full body to a synthesized `206` (Safari rejects a `200` reply to a `Range:` mid-track). Registration boots from `client/swRegister.ts`, gated to `dev:edge` and prod via a `__BUN_DEV__` define — the Bun inner loop deliberately doesn't register. See [Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts).
- **Web App Manifest** ([spec][AppManifest]): every served page advertises `dist/manifest.webmanifest` via `<link rel="manifest">` injected by `shared/injectPwaHead.ts`. The per-blog manifest carries `name`/`short_name`/`description`/`theme_color`/`icons`; the engine pins `id: "/"` for stable app identity across future `start_url` changes, `start_url`/`scope: "/"` for the post-list entry point, and `display: "standalone"` for a no-browser-chrome reading surface. See [Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts).
- **Schema.org + Open Graph + Twitter Card** ([Schema.org][SchemaOrg], [Open Graph][OpenGraph], [Twitter Cards][TwitterCards]), serialized as **JSON-LD 1.1** ([spec][JSONLD]): the post-build pass injects a Schema.org `BlogPosting` (with a nested `AudioObject`, `Person` author, `Organization` publisher, plus `wordCount` and a [`SpeakableSpecification`][SchemaSpeakable] pointing at `#lede`/`h1` — apt for an audio-first blog and how voice surfaces decide what to read aloud) as JSON-LD, plus Open Graph and Twitter Card `<meta>` tags — so a shared link unfurls with title/description/image/audio and Google's Article rich result + "Listen to this article" audio surface become eligible. The landing page gets a parallel `WebSite` + `Blog` `@graph` (same Person/Organization, one source of truth) so the homepage isn't semantically empty either, and the [help page](#reader-facing-help--feature-discovery-generatehelp-pagets) carries a [`FAQPage`][SchemaFAQPage] (one `Question` per how-do-I section, joined to the same `WebSite` `@graph` via `isPartOf`) so a search engine or LLM agent can surface a specific answer. The author `Person` (name, `sameAs` social link, avatar `image`) is the same public profile the byline uses, so no email is emitted. See [Structured data](#structured-data-schemaorg-open-graph-twitter-card-sharedinjectstructureddatats).
- **Atom 1.0 + Podcast RSS 2.0 + Podcasting 2.0** ([Atom / RFC 4287][Atom], [RSS 2.0][RSS2], Apple's [`itunes:` podcast namespace][ApplePodcast], [Podcasting 2.0 namespace][PodcastNS]): the build emits an Atom feed for article subscriptions (entry `<id>`s are [tag URIs, RFC 4151][TagURI], immutable across edits), a Podcast RSS feed for audio posts (`<enclosure>` + `itunes:`/`podcast:` tags, `<pubDate>` in RFC 822 form), and a [Podlove Simple Chapters][Podlove] JSON sidecar referenced by `<podcast:chapters>`. See [Subscription feeds](#subscription-feeds-atom--podcast-rss-generatefeedsts).
- **ID3v2 Chapter Frames (CHAP / CTOC)** ([spec][ID3Chapters]): the final MP3 carries in-file chapter markers (ID3v2.3 CHAP frames + a top-level ordered CTOC, each CHAP carrying a TIT2 sub-frame title) for the podcast clients that read chapters from the file rather than the `<podcast:chapters>` sidecar. Embedded at encode time via an ffmetadata sidecar (`-id3v2_version 3`); chapter offsets are computed from per-artifact durations *before* the encode/content-hash, so the in-file times match the manifest and the Podlove sidecar byte-for-byte. See [Subscription feeds](#subscription-feeds-atom--podcast-rss-generatefeedsts).
- **Robots Exclusion Protocol** ([RFC 9309][RobotsRFC]): `dist/robots.txt` carries an allow-everything signal, an absolute `Sitemap:` pointer, and a deliberate AI-crawler stance (default-allow; `ROBOTS_AI_CRAWLERS=deny` emits explicit `Disallow:` blocks for the named training/answer bots). See [Site-level discovery](#site-level-discovery-generatesite-discoveryts).
- **Sitemaps 0.9** ([sitemaps.org protocol][Sitemaps]): `dist/sitemap.xml` lists the canonical URL set (landing + every real post) with `<lastmod>` from `versions.json` — the same source the feed `<updated>` uses, so feed freshness and sitemap freshness can't drift. `<changefreq>`/`<priority>` deliberately omitted (Google documents that it ignores both). See [Site-level discovery](#site-level-discovery-generatesite-discoveryts).
- **`llms.txt`** ([llmstxt.org convention][LlmsTxt]): `dist/llms.txt` is a curated Markdown map an LLM indexer can read instead of crawling every page — H1 title + blockquote summary + `## Posts` (the curated post index, the same per-post descriptions the feed `<summary>` carries) + `## Optional` (subscription endpoints — the convention reserves `## Optional` for "URLs that can be skipped if a shorter context is needed," and Atom/podcast feeds are exactly that). The companion `/llms-full.txt` is deferred (article body is already the canonical crawlable text — see [§9 of proposal 16](./proposals/16-seo-llm-discoverability.md)). See [Site-level discovery](#site-level-discovery-generatesite-discoveryts).
- **WebVTT** ([spec][WebVTT]) **as an emitted export sidecar**: each aligned post emits `generated/<slug>/captions.vtt` — one cue per `<mark>`, intra-cue `<HH:MM:SS.mmm>` timestamp tags per word — generated from the same `marks[].words` table the runtime manifest carries. The file exists for the future social-media video subtitle pipeline (out of scope — see [proposals/17 §10](./proposals/17-word-level-narration-sync.md)) and for general interop with caption tooling. The drawer does **not** consume it (it reads the same data inline from the manifest, sidestepping a second fetch and a parser; we don't use a `<track>` overlay either — the browser's `TextTrack` API surfaces only whole cues on `cuechange`, never intra-cue tokens, so it wouldn't save us code). See [Word-level timing](#word-level-timing-drawer-karaoke--subtitle-sidecar).
- **GDPR / UK GDPR** ([Regulation (EU) 2016/679][GDPR]): the EU regulation that frames every data-handling decision the engine makes — the lawful-basis vocabulary (consent / legitimate interest), the transparency duties of Art. 12–14, the data-subject rights of Art. 15–22 mapped 1:1 in the policy, and the 72-hour breach window flagged for operator follow-through. See [Privacy & data protection](#privacy--data-protection).
- **CCPA / CPRA** ([Cal. Civ. Code §1798.100 et seq.][CCPA]) and **[CalOPPA][CalOPPA]**: California's privacy regime — drives the policy's "we do not sell or share" representation, the no-required "Do Not Sell" link rationale (no sale → not required), the 45-day response window, and CalOPPA's "conspicuously post" footer placement. See [Privacy & data protection](#privacy--data-protection).
- **APPI** ([Act on the Protection of Personal Information, Act No. 57 of 2003][APPI]): Japan's privacy law — the operator-jurisdiction floor for this blog. Drives the policy's PPC-as-supervisory-authority pointer, the 30-day response window, and the access/correction/deletion rights of Art. 33–35. See [Privacy & data protection](#privacy--data-protection).
- **ISO/IEC 29184:2020** ([spec][ISO29184]): the international standard for online privacy notices and consent. We follow its layered-notice structure (full policy + just-in-time disclosure + every-page link) without reproducing its prescriptive checklist verbatim — the document is paywalled, and our regime-by-regime rights mapping in `privacy.html` already covers the substantive content points. See [Privacy & data protection](#privacy--data-protection).

### Possibly usable later

- **JSON Feed 1.1** ([spec][JSONFeed]): a JSON-shaped sibling of the Atom feed — same data, friendlier to hand-author. Not added because every reader we care about consumes Atom; trivial to mirror from the same feed walker if a subscriber ever asks.
- **`/llms-full.txt` companion** ([llmstxt.org][LlmsTxt]): the whole-corpus-inlined-as-Markdown sibling of `llms.txt`. Deferred — the article body is already the canonical crawlable text, so a full dump duplicates what a crawler reads anyway. Worth revisiting if LLM indexers start clearly preferring it over the curated index form.
- **Background Sync** ([WICG draft][BackgroundSync]): would queue failed comment `PUT`s in an IndexedDB sidecar and replay them via a `sync` event when the device regains connectivity, closing the "user closed the tab while offline" loss case in `client/commentsSync.ts`. Chromium-only; degrades cleanly on Firefox/Safari to today's "next foreground request flushes" behavior. The SW it would extend is the same one [Offline / PWA](#offline--pwa-clientswjs-clientswregisterts-sharedinjectpwaheadts) builds — additive event listener, no change to install/activate/fetch. See [proposal 21 §2](./proposals/21-pwa-offline-followups.md).
- **Periodic Background Sync** ([WICG draft][PeriodicBackgroundSync]): would wake the SW on a schedule (browser-enforced minimum interval, gated on per-site engagement) to pre-load new comments / refresh cached post HTML / pre-check the doc-version banner. Same Chromium-only caveat; engagement-gated, so brand-new readers never get it. See [proposal 21 §2.1](./proposals/21-pwa-offline-followups.md).

### Considered, not used

- **EPUB 3 Media Overlays** ([spec][EPUB]) + **SMIL 3** ([spec][SMIL3]): the canonical "synchronized text-with-audio narration" pairing — a SMIL document `<par>`-pairs an HTML `id` fragment with an `<audio>` clip range. Rejected as the per-word timing transport because the model **requires the highlighted unit to be an HTML element with a stable `id`** — we'd have to mint and stabilize a `<span id>` per word across edits (10k+ extra spans on a long post) purely to fit the contract, with no EPUB consumer to benefit. Our drawer renders the spoken text as a string and slices it on character offsets instead, which is what `marks[].words` carries. See [Word-level timing](#word-level-timing-drawer-karaoke--subtitle-sidecar) and [proposals/17 §3.3](./proposals/17-word-level-narration-sync.md).
- **W3C Sync Media for Publications (Lite)** ([spec][SyncMedia]): the JSON-shaped HTML-first sibling of Media Overlays. Rejected for the same per-word-id reason as Media Overlays itself (its only differentiator is the contract, not the encoding); the in-manifest `marks[].words` shape is the same data without the structural distortion. See [Word-level timing](#word-level-timing-drawer-karaoke--subtitle-sidecar).
- **Media Fragments URI** ([spec][MediaFragments]) **as a player/URL feature**: we don't expose time-based URL fragments (ex: `#t=12,18`) for linking into the audio. The Media Fragments `t=` syntax *does* appear inside the comments data model (a narration comment carries the audio time range of its segment as a Web Annotation Media Fragments selector), but it's **best-effort, not authoritative** — audio is regenerated each revision, so a stored `t=` is only exactly valid for its build. The resolve-on-edit loop usually retires a comment before its timestamps drift — but [per-segment regeneration](#per-segment-regeneration-dev-author-only) can drift them with no text change at all (and cascades to every later segment), so the durable anchor is always the narration *text*. See [Comments → Anchoring](#anchoring-the-web-annotation-target-model) for the full staleness reasoning.
- **Spoken HTML** ([spec][SpokenHtml]) allows inlining SSML notation directly in HTML elements with attributes. However, our audio content is too different from the blog context for this to be useful (and instead use script tags)
- **PASETO** ([spec][PASETO]) for session tokens: removes JWT's `alg`-confusion footgun at the format level (algorithm implied by the version, no `alg` field, no `none`). Rejected in favour of [JWT] — smaller ecosystem, weaker Workers story, ~zero debugger tooling, and JWT is what our OIDC neighbours (arctic, Google, Microsoft) already speak, while `jose`'s pinned allowlist neutralizes the footgun anyway. See [Sessions](#sessions-jwt-cookie-hs256-jose).
- **Schema.org `SearchAction`** ([spec][SchemaSearchAction]): a `WebSite` `potentialAction` advertising a site-search endpoint (`{search_term_string}` → results URL). The engine has no search route to point at; emitting one that points nowhere is worse than omitting it. Revisit only if a search route is ever added. See [proposal 16 §6](./proposals/16-seo-llm-discoverability.md).
- **Schema.org `BreadcrumbList`** ([spec][SchemaBreadcrumb]): would convey `Home → <post>` site structure to crawlers and LLMs. The site is only two levels deep with no intermediate `/posts` index, so the breadcrumb would be a single-step `Home → <post>` — too thin to be worth the JSON-LD weight. Reconsider if a `/posts` listing is ever added.
- **Schema.org `TechArticle`** ([spec][SchemaTechArticle]) instead of `BlogPosting`: technically the more precise type for technical explainers, but its extra value-adds (`proficiencyLevel`, `dependencies`) need per-post authoring channels the engine doesn't have today. `BlogPosting` is not wrong, and switching gains little without the extra fields populated. Revisit if a per-post metadata channel ever lands (the same one that would feed `keywords`/`about` — see [proposal 16 §8](./proposals/16-seo-llm-discoverability.md)).
- **Sitemap image / video / news extensions** ([sitemap.org extensions][SitemapExt]): not applicable — this is a content-agnostic article blog, not an image gallery or news outlet. Plain `<urlset>` carries everything crawlers need.

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

<!-- For LLMs: local copies of the specs above. (No local copy of [TwitterCards]
— developer.x.com renders it client-side as a JS app, so there is no static
document to mirror; use the web link. The Twitter Card vocabulary we emit also
falls back to Open Graph, which IS mirrored. No local copies of the
Schema.org per-type pages [SchemaSpeakable]/[SchemaSearchAction]/
[SchemaBreadcrumb]/[SchemaTechArticle] — they are vocabulary references on
the same site already mirrored at [SchemaOrg]/SchemaOrg-spec.html.)
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
-->

