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
- **Chunked for cache-friendly regeneration.** Edit one section's script, regenerate only that chunk's audio to facilitate quick iteration of documents.
- **Non-linear narration is a first-class case.** Presenters reference earlier slides; our highlight/scroll logic has to handle going backwards as gracefully as forwards.
- **No light/dark toggle**: we will never support a dark-mode/light-mode switch, because we need to ensure generated visuals for charts, etc. appear correctly (too hard to do this for both modes)

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

These `<mark>` tags in the audio are also used as the natural chunking points of the audio as well (both for audio generation purposes, but also to allow per-mark navigation of the spoken audio)

### Chapters

All SSML and spoken content in general lives inside `<script type="text/narration" data-chunk-id="unique-id" data-chunk-title="Visible Title">` blocks.

Usage of script blocks allows us to ensure that this text does not actually appear on the page (and instead, SSML/narration blocks are fed into generation tools to process)

We call this `text/narration` blocks instead of SSML blocks as we only allow the `<mark>` SSML notation, and so calling it a `SSML` block in general may confuse AI (it may write general SSML notation, which we don't support. For example, no `<speak>` tag)

These blocks each define a "chapter" for usage in audio narration (which allows skipping between chapters)

### Generation pipeline

The pipeline for generating audio needs to take into account that different models have different requirements:
1. The input format (some models support [SSML], some [PLS], some custom systems and some have no pronunciation hint support at all)
2. The performance (some models are fast which are great for debugging, some are slow but higher quality. Additionally, some like `say` only work on Mac)
3. The output format for the chunk (ex: `mp3`, `wav`)

Therefore, we split these concerns into two steps:
1. `TtsProvider`: synthesizes narrations into audio files (handles different models needing different inputs)
2. `AudioPipeline`: takes audio files, and does any processing on them (ex: concat, change encoding) to be ready to serve (note: handles different models having different output formats, yet wanting one consistent audio format to serve to users). It supports
- `silence`: insert silence as needed (ex: between marks if needed)
- `duration`: gets the duration of the audio file
- `concat`: combine audio chunks  (note: ideally lossless to avoid re-encoding causing audio loss and no disk round-trip, but this is format-specific)
- `leadingSilenceSeconds`: how long the leading silence is in the audio (some audio-generating tools start with a lot of leading silence, making concatenation sound awkward)
- `trim`: trim the start of an audio file (usually used to remove leading silence)
- `encode`: encode to the final audio format served to the user

Every operation except `concat` is implemented as a shell-out to `ffmpeg` / `ffprobe`. `concat` stays as an in-memory byte-splice because ffmpeg's concat demuxer can't take multiple stdin pipes

The final audio format we serve to users is `mp3` (64 kbps mono, benefiting from its small size, and the fact that audio quality loss is not meaningful on spoken audio).  We try to avoid re-encoding many times to avoid accumulated quality loss — concat operates on the working PCM and the final mp3 encode happens once at the end.

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
- `Shikwasa`s `seek(time)` calls `parseInt(time)` internally (truncating fractions), so we bypass it with our own `seekToSeconds`
- `Shikwasa` has built-in chapter detection, but to avoid the edge-case of briefly showing the wrong chapter when seeking to exactly the chapter boundary, we add `+ 0.01` to the chapter start time when seeking so that it reliably considers us *inside* the new chapter range
- `theme: "dark"` is forced

## Player & sync (`client/narrator.ts`)

We need to keep the highlighted content in sync with the player controls (ex: skipping forward/backwards)

Key architectural things to make this work properly:
- Active-mark tracking uses **`requestAnimationFrame`** reading
  `player.currentTime`, and not the audio element's `timeupdate` event (`timeupdate` fires ~4x/sec, too coarse for sentence-level marks).
- Active mark = "latest mark whose `time` ≤ `currentTime`" (recomputed each tick so backward seeks are efficient).

## Manifest format (`generated/<slug>/manifest.json`)

- Times are **absolute seconds** in the master track (the player never needs to know about chunks)
- `audio` is a path under `/generated/<slug>/`; Content-Type is inferred
- The time of different marks is calculated taking into account trimming out silent audio (to avoid slowly going out of sync)


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

