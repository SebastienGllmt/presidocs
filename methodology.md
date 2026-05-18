# Methodology

This document summarizes the goal, methodology for reaching the goal esp. in relation to technical decisions, progress towards the goal of this project

## What we're building

A way to build explanatory technical blog posts that doubles as a talk via associated audio.

To ensure ease of AI authoring, each post is a self-contained HTML file that contains all relevant information inline (text, graphics, spoken script, etc.). Generator tools then parse this file to power things like a "Listen" button that plays a narration of the post.

The spoken track is deliberately **not** a read-aloud of the article - it's a parallel narrative that can paraphrase, reorder, skip over, or revisit visual elements the way a presenter does.

Key design decisions that shape the architecture:
- **One file per post.** Article + spoken script live in the same HTML
  so authoring tools (humans or LLMs) edit one document, not a
  bundle. No other content input is allowed (note: multiple files are allowed to be served, but they have to be generated from the single input)
- **Audio is generated offline**, then served as static assets. A `bun run generate` step turns the inline spoken script into MP3-shaped artifacts plus a JSON timing manifest. The runtime player never calls a TTS API.
- **Segment-level audio cache.** Edit one sentence and only that sentence is re-synthesized — the rest comes from cache. See [Audio caching](#audio-caching).
- **Non-linear narration is a first-class case.** Presenters reference earlier slides; our highlight/scroll logic has to handle going backwards as gracefully as forwards.
- **No light/dark toggle**: we will never support a dark-mode/light-mode switch, because we need to ensure generated visuals for charts, etc. appear correctly (too hard to do this for both modes)

## Repository layout

Each top-level folder is one concern, so finding code is "pick the folder that matches what you want to change":

- `generate/` — offline pipeline that turns a post into audio + manifest (`bun run generate`)
- `client/` — client-run JS code (ex: audio player)
- `shared/` — types/helpers used by both sides (e.g. common types / structures)
- `posts/` — authored inputs (one HTML file per post + the shared PLS lexicon)
- `generated/` — pipeline output (gitignored)
- `specs/` — local copies of the W3C specs referenced above

Folder boundaries follow runtime/process boundaries (offline build vs. browser runtime vs. authored input vs. derived output), not file kind — co-locate types and tests with the code that owns them rather than splitting them into `types/` or `tests/`.

## SSML usage

Although [SSML] has historically been used to represent spoken text concepts, it has been losing traction given newer LLM-based models tend to focus on natural language hints over SSML-like DSLs.

While spoken text scripts often encode notes about delivery (ex: dramatic pauses, emotional cues), we generally do not need these for technical blogs. However, we *do* still often need two concepts from SSML

### Representing word pronunciation

Our use-case still requires pronunciation hints (which are not supported by every model) for technical words.

Therefore, to we allow specifying pronunciations using the [PLS] in two ways:
1. For commonly-used technical term, we allow a global `common-terms.pls` that is shared by all blog posts
2. For post-specific technical terms, we allow a `<script type="application/pls+xml">` to be inlined into the document

### Connecting spoken text to blog content

We want our spoken text to be able to highlight different parts of the HTML document that it is referring to. Essentially, listening to the audio should eventually take you down the entire blog (auto-scroll)

To facilitate this, blog content can be marked with `id`s in the HTML (ex: `<p id="foo">`), and spoken text can refer to these IDs using SSML `<mark>` tags (ex: `<mark name="foo"/>`. See [spec][SSML-mark] for more).

These `<mark>` tags in the audio also act as natural splitting boundaries — they delimit the **segments** that are individually synthesized and individually cached (see [Audio caching](#audio-caching)), and they're the unit of per-mark navigation in the player.

### Chapters

All SSML and spoken content in general lives inside `<script type="text/narration" data-chapter-id="unique-id" data-chapter-title="Visible Title">` blocks.

Usage of script blocks allows us to ensure that this text does not actually appear on the page (and instead, SSML/narration blocks are fed into generation tools to process)

We call this `text/narration` blocks instead of SSML blocks as we only allow the `<mark>` SSML notation, and so calling it a `SSML` block in general may confuse AI (it may write general SSML notation, which we don't support. For example, no `<speak>` tag)

These blocks each define a "chapter" for usage in audio narration (which allows skipping between chapters)

### Generation pipeline

The pipeline for generating audio needs to take into account that different models have different requirements:
1. The input format (some models support [SSML], some [PLS], some custom systems and some have no pronunciation hint support at all)
2. The performance (some models are fast which are great for debugging, some are slow but higher quality. Additionally, some like `say` only work on Mac)
3. The output audio format produced (ex: `mp3`, `wav`)

Therefore, we split these concerns into two steps:
1. `TtsProvider`: synthesizes narrations into audio files (handles different models needing different inputs)
2. `AudioPipeline`: takes audio files, and does any processing on them (ex: concat, change encoding) to be ready to serve (note: handles different models having different output formats, yet wanting one consistent audio format to serve to users). It supports
- `silence`: insert silence as needed (ex: between marks if needed)
- `duration`: gets the duration of the audio file
- `concat`: combine audio buffers (note: ideally lossless to avoid re-encoding causing audio loss and no disk round-trip, but this is format-specific)
- `leadingSilenceMs`: how long the leading silence is in the audio (some audio-generating tools start with a lot of leading silence, making concatenation sound awkward)
- `trim`: trim the start of an audio file (usually used to remove leading silence)
- `encode`: encode to the final audio format served to the user

Every operation except `concat` is implemented as a shell-out to `ffmpeg` / `ffprobe`. `concat` stays as an in-memory byte-splice because ffmpeg's concat demuxer can't take multiple stdin pipes

The final audio format we serve to users is `mp3` (64 kbps mono, benefiting from its small size, and the fact that audio quality loss is not meaningful on spoken audio).  We try to avoid re-encoding many times to avoid accumulated quality loss — concat operates on the working PCM and the final mp3 encode happens once at the end.

## Audio caching

Audio synthesis is slow (seconds to minutes per segment for LLM TTS models) and often paid per character. A typical authoring loop — tweak one sentence, regenerate — would otherwise re-synthesize the whole post on every iteration.

The cache operates per **segment** — the text between two `<mark>` boundaries — not per chapter.

**Cache key** is a `sha256` over every input that influences the synthesized bytes:
- TTS provider name (`say`, `piper`, …)
- Voice
- Rate
- Output audio format (sample rate, channels, bits/sample)
- Local PLS lexicon XML (the post's inline `<script type="application/pls+xml">` blocks merged together, or `null` if none)
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

## Audio Player

The audio player is managed by [shikwasa](https://shikwasa.js.org/), and exposes the following features:
- Shows chapters for the audio (skip to chapters with numpad)
- Pause/start with button (or by pressing spacebar anytime - even if the player is unselected/hidden)
- Control speed (up to 2x)
- Skip/Rewind 10s (also doable with arrow keys)
- Hide/show highlighting in the article 
    - also turns off auto-scroll to facilitate taking screenshots, but snaps back when re-enabled
    - highlighting is hidden, but still logically processed (even if now shown) as this is much simlper and snappier than trying to recalculate what highlights should be shown at any given point the user re-enables highlighting
- Show a progress bar & timer for position in the audio
- Toggle player entirely (to hide it and focus on just the article)

*Note*:
- `Shikwasa`s `seek(time)` calls `parseInt(time)` internally (truncating fractions), so we bypass it with our own `seekToMs`
- `Shikwasa` has built-in chapter detection, but to avoid the edge-case of briefly showing the wrong chapter when seeking to exactly the chapter boundary, we add `+ 0.01` to the chapter start time when seeking so that it reliably considers us *inside* the new chapter range
- `Shikwasa` updates the progress-bar on the audio element's `timeupdate` event, which fires ~4×/sec; its CSS transition smooths each step but still leaves a visible ~150ms idle between them. We disable that transition and write the bar's width from our existing rAF tick (the same one driving mark highlighting), so the bar advances smoothly
- `theme: "dark"` is forced

## Player & sync (`client/narrator.ts`)

We need to keep the highlighted content in sync with the player controls (ex: skipping forward/backwards)

Key architectural things to make this work properly:
- Active-mark tracking uses **`requestAnimationFrame`** reading
  `player.currentTime`, and not the audio element's `timeupdate` event (`timeupdate` fires ~4x/sec, too coarse for sentence-level marks).
- Active mark = "latest mark whose `time` ≤ `currentTime`" (recomputed each tick so backward seeks are efficient).

## Manifest format (`generated/<slug>/manifest.json`)

- Times are **absolute milliseconds** in the master track (the player never needs to know that the audio was assembled from per-chapter files)
- `audio` is a path under `/generated/<slug>/`; Content-Type is inferred
- The time of different marks is calculated taking into account trimming out silent audio (to avoid slowly going out of sync)

## Comments (`client/comments.ts`)

Google-Docs-style threads anchored to selections in the article body, selections in the spoken-script drawer, *or* whole graphics. Every thread (and every in-progress draft) renders as its own card in a **right-side margin column** that scrolls with the article — same idea as Google Docs's comment pane.

### Why a column, not a single popover

One floating popover per span breaks as soon as you have **multiple threads on the same selection** — a real requirement for comments that sync across users, since two readers can independently comment on the same sentence.

The column sidesteps the disambiguation problem entirely: every thread is always visible, stacked next to its anchor. Clicking a highlight scrolls its card into view (and pulses it); clicking a card scrolls the article back to its anchor (and pulses that). Two threads on the same selection just appear as two cards at the same vertical position.

### Anchoring (text)

Selections aren't stored as DOM ranges (those break on any edit). Each *block* gets a stable id and a sha256 of its normalized text content. A text anchor is:

- **`segments`** — the ordered list of blocks the selection touches, each `{ id, hash }`. Multi-segment selections (e.g., spanning two paragraphs) carry one entry per block.
- **`startOffset` / `endOffset`** — character offsets within the *first* and *last* segment respectively, measured against `textContent` (which is invariant under our highlight-span DOM wrapping, so re-anchoring after a reload is deterministic).
- **`quote`** — the verbatim selected text at creation time, kept for the outdated-comments list so an orphaned thread can still tell you what it used to point at.

Every block needs an id so we can refer to it later. We try them in this order:

1. **Use the author's existing `id` attribute** if there is one. These are usually present because the block is also a `<mark>` target for the spoken track, so the comment system gets stable ids "for free" wherever the narration already anchored. An id like `definition-body` stays the same even if the author moves that paragraph around in the document.
2. **Otherwise, make one up** of the form `<context>:__b-<n>` — e.g. `article:__b-7` for the 8th block found while walking the article. This works fine when the document doesn't change, but the index shifts the moment a paragraph is inserted earlier in the file. That's okay: when that happens, the block's text content also shifts under the comment, the stored hash no longer matches, and the comment gets flagged as outdated rather than silently pointing at the wrong sentence.

The takeaway: blocks the author labelled stay rock-solid, and blocks they didn't label still work — they just become eligible for the "outdated" flow as soon as the surrounding document changes.

### Stale anchors: orphan + flag

On every render, each segment's current hash is recomputed and compared to the stored one. If *any* segment in a thread mismatches, the thread is marked **outdated**:

- Its highlight is not drawn in the article (we don't want to point at the wrong sentence).
- Its card still renders in the column, with an "outdated" tag in the anchor preview and the original `quote` text intact so the reader can find what it used to point at. The card falls back to the first segment's element for vertical positioning; if even that segment is gone, it stacks at the bottom of the column.
- Stale text cards **bypass the hide list** and lose their Hide button. Hide's contract is "click the highlight to bring it back," but stale threads have no highlight — leaving the button there would orphan the card with no recovery affordance. Surfacing stale cards unconditionally keeps them visible until the user either updates the article or deletes the obsolete thread.

Note this means we reject these alternatives:
- silently dropping stale comments (dangerous loss of content)
- Fuzzy re-anchoring (too hard to get correct)

### Anchoring (graphics)

Whole-graphic only in v1, scoped to `<figure>` (the authoring convention from [SSML usage](#ssml-usage)). The anchor is just the figure's id — no hash, because the graphic's content isn't text and isn't comparable across edits. If a figure is replaced (same id, new contents) the comment intentionally follows; that's almost always the right behavior when an author iterates on a diagram. Multiple threads on the same figure simply stack as multiple cards in the column — there's no dedupe.

Standalone `<svg>`/`<img>`/`<canvas>` are deferred: `<img>` is a void element, `<svg>` is a different DOM namespace, both need a wrapper before we can drop an HTML trigger button inside. The figure-only restriction keeps the indexing code free of those edge cases.

### Storage layer (`client/commentsStore.ts`)

Comments live in an **Automerge document** (CRDT) rather than a plain JSON array. The store module owns the document; `comments.ts` is purely a UI layer reading snapshots and routing mutations through the store API.

**Why a CRDT given how little concurrency we have today.** In v1 there's almost no concurrent-write surface — each `(post, reader)` pair gets its own R2 blob, so two writers on the same blob is rare even after sync lands (it only happens when one reader uses two devices). The CRDT is here to make the *future* trivial: Phase 2's R2 sync becomes `merge + save + PUT-with-If-Match` instead of a hand-rolled op log, and if "readers see each other" is ever a feature we want, the merge is already correct. Picking up the CRDT mental model now also forces the data shape to be merge-friendly (maps not lists, tombstones not deletions) — that's mostly what shaped the design decisions one section above.

**Why Automerge over Yjs / json-joy.** Automerge's plain-object mutation API (`change(doc, "op name", d => { d.threads[id].replies[rid] = {...} })`) maps almost 1:1 onto the v1 `Thread`/`Reply` types, so the refactor was a port not a rewrite. Yjs's `Y.Map`/`Y.Array` wrappers would have been imposed on every read path for a comments use case that doesn't need any of Yjs's rich-text power. The Automerge WASM core is <1MB and loads on first interaction only so it doesn't bloat the initial JS bundle. Standards-wise, neither Yjs nor Automerge is a "spec" in the IETF sense — there's no portable CRDT format, so we'd have picked one library no matter what. Automerge's [JSON-CRDT paper](https://arxiv.org/abs/1608.03960) is the closest thing to a published formal model.

**Doc shape.** The internal document keeps threads and replies as maps (not arrays) so two devices adding records concurrently never tussle over list positions:
```ts
type CommentDoc = {
  threads: {
    [id: string]: {
      anchor: Anchor,
      replies: { [id: string]: Reply },  // map; sorted on render by createdAt
      createdAt: number,
      resolvedAt?: number,
    }
  }
}
```
The public `snapshot()` method converts both maps to arrays (replies sorted by `createdAt`) so the UI can keep iterating naturally.

**Reader identity.** A UUID per browser, generated once and stashed in `localStorage` under `blog-reader-id`. Independent of post — it's a device identity, not a per-post token. The blob key in R2 will be `comments/<post>/<reader-id>.amrg` so each browser writes to its own slot. Once login lands, the user's account id replaces the UUID and the per-device docs merge into one logical user doc; the CRDT makes that merge a non-event.

**Persistence.** `Automerge.save(doc)` produces a `Uint8Array`; we base64-encode it into `localStorage` under `blog-comments:<path>:<reader-id>.amrg`. localStorage is string-only and snapshots are small (a hundred bytes per op), so the base64 inefficiency doesn't register; if comments ever grow huge we'd switch to IndexedDB (which stores binary natively).

**Author identity.** Still deliberately omitted in v1 (every reply renders as "Anonymous"); the `Reply` type leaves the field reserved.

### UI

- **Selection → floating action bar.** A "Comment" pill appears above any selection inside a commentable root. Clicking it creates a draft card in the column, scrolls to it, and focuses its textarea.
- **Cards column** spans the document height. Each card is within it, so cards scroll with the page naturally. `repositionCards()` aligns each card's top with its anchor's `getBoundingClientRect().top + scrollY`, then walks in sort order pushing later cards down by at least `CARD_GAP_PX` so they don't overlap. It runs on scroll, resize, and after every render.
- **Drafts vs threads.** A *draft* is an unsubmitted thread held in `this.drafts` (in-memory only — drafts deliberately don't go into the CRDT, so they never sync to a server or the user's other devices until committed). Its card looks the same as a saved one but is framed with a blue border; the composer's "Cancel" discards the entire draft, "Comment" promotes it (registering the thread and the reply). After the first reply lands the thread lives in the CRDT and subsequent typing in the same card just appends replies. Each card owns its own textarea, so drafts never collide with each other and the old "you have unsaved work" draft-protection logic isn't needed.
- **Cross-linking** between card and anchor: clicking a highlight scrolls its card into view and pulses it; clicking a card (anywhere outside its buttons / textarea) scrolls the article to the anchor and pulses the highlight.
- **Highlight color** is soft blue (`rgba(88, 166, 255, 0.22)`), deliberately not yellow — narration already paints the active sentence yellow/orange, and a sentence that's both being read and commented needs to be visually unambiguous. Nested highlight spans (overlapping threads) naturally compose to a darker blue, which reads as "denser commentary here."
- **Layout reservation.** When the column is visible (≥1100px viewport) `body { padding-right: 360px }` shifts the centered article left so the column has a clean gutter to live in. The narration dock stays viewport-centered and so no longer sits dead-center under the article when the column is showing; that visual mismatch is mild enough to ignore for v1.

### Lifecycle: Hide vs Resolve

Three ways a thread can leave the UI, with very different semantics:

| | Trigger | UI effect | Storage effect | How to undo |
|---|---|---|---|---|
| **Hide** | "Hide" button on a non-stale saved card | Card removed; highlight stays | None (session-only `hiddenCardIds` Set) | Click the highlight, or reload |
| **Resolve** | "Resolve" button on any saved card (incl. stale) | Card removed; highlight removed | `resolvedAt` timestamp set on the thread; record stays in localStorage | Not in v1 — permanent |
| **Delete reply** | "x" on each reply | Reply removed; thread auto-resolves when last visible reply is gone | `deletedAt` timestamp set on the reply (and `resolvedAt` on the thread if it's the last one); both stay in localStorage | Not in v1 — permanent |

**Why three?** Hide is a casual "I'm done looking at this for now." Resolve is the decisive "this is addressed, get rid of it." Reply-delete is for fixing typos / removing individual replies. Conflating them would force every dismissal to feel either too cavalier (one-click delete-everything) or too cautious (confirm-every-time).

**Localstorage as the deletion queue.** Resolved threads and deleted replies aren't removed from localStorage — they sit there as **tombstones** (`resolvedAt` on the thread, `deletedAt` on the reply), filtered out of every render path. When a server sync lands, the client will iterate tombstones, send a DELETE for each, and only then remove them locally. Using the existing store as the queue (instead of a separate `pendingDeletions` array) means there's no second data structure to keep in sync and no migration once networking arrives.

The same logic applies symmetrically to threads (Resolve) and replies (Delete) — different user-facing actions, same architectural pattern. Deleting the *last* visible reply on a thread additionally sets `thread.resolvedAt`, so the server sync issues both reply-level DELETEs and a thread-level DELETE; a zero-reply thread is a dead record server-side anyway, so the extra request is harmless.

Two notes on what's deferred:
- **"Never synced → remove immediately."** Once networking lands, items will gain a `syncedAt` field set after a successful server write. At that point Delete/Resolve on an item that's still local-only could skip the tombstone and remove outright. In v1 there's no `syncedAt`, so everything tombstones — slightly more work than necessary but ready for the future without a data migration.
- **Tombstone GC.** In v1 (no networking) tombstones accumulate in localStorage forever. At the scale of "comments on one blog post" this is kilobytes, not megabytes, and reloading the page never re-surfaces them, so the user doesn't notice. The eventual server-sync sweep will GC them.

### Responsive

- **≥1100px:** column visible alongside the article.
- **<1100px:** column hidden entirely (not enough horizontal room without overlapping content). The action bar and selection capture still work, so comments can be authored — they just won't render as cards until the user widens the window. A mobile-friendly bottom sheet / toggle is a follow-up.

### Excluded from v1

- Reply threading beyond a flat list per anchor.
- Resolve undo (resolutions are one-way until server sync exists to round-trip).
- Garbage-collecting accumulated `resolvedAt` / `deletedAt` tombstones (the future server-sync sweep does this).
- Draft persistence across reloads (drafts live in `this.drafts` in-memory, deliberately not in the CRDT).
- Sub-region selection on graphics (drag-rectangle, SVG child clicks).
- Author identity / login (every reply renders as "Anonymous"; `Reply` reserves the field).
- **R2 sync (Phase 2)** — the CRDT layer is in place; the GET/PUT-with-If-Match loop and the author-side aggregating viewer come next.
- Cross-document selections (selection must stay within one of: article body OR drawer).
- Narrow-viewport UI for viewing existing threads.

## Terminology

Two units of spoken content come up throughout this doc

- **Chapter** — one `<script type="text/narration">` block in the post. Authored with `data-chapter-id` and `data-chapter-title` attributes. Maps 1:1 to a chapter in the audio player (chapter-skip lands here). Code type: `NarrationChapter`.
- **Segment** — the text between two `<mark>` boundaries inside a chapter. This is the unit that gets handed to the TTS provider, the unit that the audio cache keys on, and the unit the player highlights/scrolls to. Code type: `Segment`, produced by `splitChapter`. A chapter contains many segments.

The word **chunk** is deliberately *not* used as a user-facing concept (it's too generic to mean any one thing, and often already used in audio-processing contexts).

## Relation to other specifications

### Possibly usable later

- **EPUB 3 Media Overlays** ([spec][EPUB]): Media Overlays pair text fragments with audio clips via SMIL
- **SMIL 3** ([spec][SMIL3]): the host language behind Media Overlays
- **W3C Sync Media for Publications (Lite)** ([spec][SyncMedia]): HTML-first alternative to Media Overlays

### Considered, not used

- **WebVTT** ([spec][WebVTT]): primarily used to overlay captions on top of video tracks (or audio tracks) via `<track>` elements, but we don't use any overlay like this.
- **Media Fragments URI** ([spec][MediaFragments]): allows time-based URL fragment syntax (ex: `#t=12,18`), but we don't need any of these.
- **Spoken HTML** ([spec][SpokenHtml]) allows inlining SSML notation directly in HTML elements with attributes. However, our audio content is too different from the blog context for this to be useful (and instead use script tags)
- **Web Annotation Data Model** ([spec][AnnotationModel]): defines usage of JSON-LD to encode relations between objects. Although `mark`s are relations between the spoken track and the HTML content, it's a simple enough relation that we don't need a complex annotation system.

---

[EPUB]: https://www.w3.org/TR/epub/
[SMIL3]: https://www.w3.org/TR/SMIL3/
[SyncMedia]: https://w3c.github.io/sync-media-pub/sync-media-lite
[WebVTT]: https://www.w3.org/TR/webvtt1/
[MediaFragments]: https://www.w3.org/TR/media-frags/
[SpokenHtml]: https://www.w3.org/TR/spoken-html/
[AnnotationModel]: https://www.w3.org/TR/annotation-model/
[PLS]: https://www.w3.org/TR/pronunciation-lexicon/
[SSML]: https://www.w3.org/TR/speech-synthesis11/
[SSML-mark]: https://www.w3.org/TR/speech-synthesis11/#S3.3.2

<!-- For LLMs: local copies of the specs above.
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
-->

