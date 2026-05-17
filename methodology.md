# Methodology

This document summarizes the goal, methodology for reaching the goal esp. in relation to technical decisions, progress towards the goal

## What we're building

A way to build explanatory technical blog posts that double as a talk via associated audio.

To ensure ease of AI authoring, each post is a self-contained HTML file that carries both the rendered article and a separate spoken script. A
"Listen" button plays a narration of the post; as it plays, the page
highlights and auto-scrolls to whichever element is being discussed.

The spoken track is deliberately **not** a read-aloud of the article —
it's a parallel narrative that can paraphrase, reorder, skip over, or
revisit visual elements the way a presenter does.

Hard constraints that shape every decision below:

- **One file per post.** Article + spoken script live in the same HTML
  so authoring tools (humans or LLMs) edit one document, not a
  bundle. No sidecar `.vtt` / `.srt` / `.smil` files.
- **Audio is generated offline**, then served as static assets.
  A `bun run generate` step turns the inline spoken script into MP3-
  shaped artifacts (currently WAV) plus a JSON timing manifest. The
  runtime player never calls a TTS API.
- **Chunked for cache-friendly regeneration.** Edit one section's
  script, regenerate only that chunk's audio.
- **Non-linear narration is a first-class case.** Presenters reference
  earlier slides; our highlight/scroll logic has to handle going
  backwards as gracefully as forwards.

## Authoring format

- Each blog post is a single HTML file. Content and narration live together
  so authoring tools only have to edit one file.
- Narration lives in `<script type="text/narration" data-chunk-id="..." data-chunk-title="...">`
  blocks. Browsers treat the contents as raw text (the type is unknown), so
  no rendering happens; these are only read at build-time by the generators
  to produce static artifacts (chapter information, voice files,
  html-friendly rendering of the narration, etc.). In other words, they
  could be stripped from the final HTML.
- Each `<script>` is one **chunk**, which becomes one chapter in the player.
  Chunks are the unit of cache-friendly regeneration (re-generate one chunk,
  one audio file changes).
- Inside a chunk: plain text plus `<mark name="..."/>` boundaries. The text
  between two marks (or from a mark to the chunk's end) is the spoken script
  for that segment. No `<speak>` wrapper, no SSML namespace, no other tags —
  this is **not** an SSML document (see "Specs we lean on").
- Mark-to-element mapping is plain: `<mark name="lede"/>` highlights
  `id="lede"` in the article. No CSS selectors, no aliases — keep it dumb.
- Pauses: write them as commas/periods in the prose. We don't ship a
  dedicated pause marker — natural punctuation gives better TTS pacing
  than explicit cues, and the format stays plain-text-with-marks.
- Per-term pronunciation (when the TTS mispronounces a technical word)
  lives **inline** as `<script type="application/pls+xml">...PLS XML...</script>`,
  same single-file principle as the narration chunks. The generator
  extracts it at build time (same HTMLRewriter pass) and hands it to
  the TTS provider as a `PlsLexicon`. One lexicon per post, not a
  shared project-wide file — see "Considered, not used" for why.
  See `specs/PronunciationLexicon-spec.html`. Note: not all TTS systems (ex: `say`) support PLS (in which case the PLS file is not used).

## Generation pipeline (`scripts/generate.ts`)

- macOS `say` for TTS. Chosen because it's a system command — no API key,
  no external service, no extra `npm install`. Forces `LEI16@22050` mono so
  every segment WAV has identical PCM format (essential for concatenation).
- Each chunk is split at `<mark>` boundaries; **one `say` invocation per
  segment** so we can measure each segment's exact duration. This gives
  sample-accurate mark times without forced alignment.
- The chunk parser is intentionally flat: walk the chunk looking for
  `<mark name>` (a segment boundary) or text (the current segment's
  content). No nested-tag handling, no XML namespace, no document root.
- WAV is the **working format** throughout the pipeline — every operation
  (synthesis, silence, duration, concat, trim) reads or returns WAV bytes.
  Picked because `say` writes WAV natively, lossless concat is just
  byte-splicing PCM, and sample-accurate trim needs raw PCM access.
- Leading-silence trim per chunk (RMS window detector, threshold 2000,
  consecutive-window check). This is **defensive**, not load-bearing:
  - `say` pads each segment with ~40ms of dead silence before the first
    phoneme. Cloud TTS engines (Google Cloud TTS, Azure) do the same.
  - Without trim, `chapter.startTime` would point at the start of silence
    rather than the start of speech.
  - Consecutive-window check is required because `say`'s consonants (esp.
    fricatives like "S") have non-monotonic attacks — energy spikes,
    dips, then stabilizes. A single threshold-crossing stops in the dip.
  - Threshold 2000 preserves leading soft consonants. Don't push past
    ~3000 without verifying you're not cutting first syllables.
- Per-chunk files are written alongside `full.<ext>`. Future versioning /
  partial-regen work can use them; current player only loads `full`.

### Delivery format (MP3 @ 64 kbps mono)

The generator decouples the **working format** (WAV, lossless, in-memory)
from the **delivery format** (what the browser actually downloads) via the
`AudioPipeline` interface at the top of `scripts/generate.ts`.

- Delivery is **MP3 @ 64 kbps mono** — ~5–8× smaller than the raw WAV.
  64 kbps is comfortable for narration;
- **`ffmpeg` is required** (`brew install ffmpeg`). The generator
  preflight-checks every binary in `pipeline.requiredBinaries` and fails
  fast with a clear message if any are missing — much friendlier than a
  cryptic failure 30 segments in.
- Encoding happens **once per output file at the end**, not segment-by-
  segment. Each ffmpeg call takes a finished WAV via stdin and emits MP3
  on stdout, so no intermediate temp files. Doing it once avoids
  cumulative MP3 re-encode loss and keeps encoder padding (~26ms head /
  ~36ms tail) to a single occurrence per delivered file.
- The 26ms MP3 head padding is below human discrimination thresholds for
  speech-onset timing; we don't compensate for it in mark times. If a
  future codec has larger or more variable padding (e.g. AAC ADTS),
  measure it in `encode()` and bake the offset into the trim step.

### The `TtsProvider` and `AudioPipeline` interfaces

The generator splits TTS from audio handling into two orthogonal
interfaces. `TtsProvider` turns text into speech bytes; `AudioPipeline`
takes those bytes through concat / trim / final-mile encode. The two are
composed at the bootstrap — swapping engines doesn't touch the pipeline
and vice versa. We expect at least three providers over time: `say`
(macOS, today), a Linux dev equivalent (Piper / espeak-ng), and a
production cloud engine (TBD).

#### `TtsProvider`

- One concrete adapter per engine. Today: `createSayProvider` in
  `scripts/generate.ts`. New providers register a factory in the
  `ttsProviders` map; the bootstrap selects by `--tts=NAME`.
- Each adapter declares an `outputFormat` (sample rate / channels /
  bits-per-sample). The bootstrap asserts it matches
  `pipeline.workingFormat` before any synthesis runs — catching a
  format mismatch up-front rather than after 30 segments.
- The shared `TtsProviderConfig` carries `voice`, `rate`, target
  `format`, and an optional `PlsLexicon`. The lexicon is extracted
  from the post's inline `<script type="application/pls+xml">` block
  in the same HTMLRewriter pass as the narration chunks, then passed
  to every provider. Providers that don't honor PLS warn and ignore.
- `requiredBinaries` is per-provider (e.g. `["say"]` for the macOS
  adapter, `[]` for a pure-HTTP cloud adapter) and is unioned with
  the pipeline's binaries at preflight.

#### `AudioPipeline`

We keep the pipeline behind an interface even though there's only one backend today (MP3). The interface is the contract a future codec (Opus, AAC, FLAC) has to satisfy — every operation must be implemented, not silently dropped. That's what makes the codec swap safe.

Operations on the working-format buffer (WAV today):

- `workingFormat` — the `AudioFormat` (sampleRate / channels /
  bitsPerSample) every operation expects on its input/output. TTS
  providers must emit audio in this format.
- `silence(seconds)` — generate a padding clip of the given duration
  (used by `--mock`).
- `duration(buf)` — exact seconds, parsed from the WAV header.
- `concat(bufs[])` — lossless splice by re-emitting the header and
  byte-copying PCM data.
- `leadingSilenceSamples(buf)` — RMS-window detector returning a sample
  count, converted to seconds via `workingFormat.sampleRate`.
- `trim(buf, samples)` — drop leading PCM samples and rewrite the header.

Delivery-side metadata + final encode:

- `encode(buf)` — working → delivery bytes. For MP3 this is a single
  ffmpeg invocation via stdin/stdout.
- `deliveryExt` / `deliveryMime` — `.mp3` / `audio/mpeg`.
- `requiredBinaries` — `["ffmpeg"]`, unioned with the TTS provider's
  binaries at preflight.

### When adding a new TTS provider

- Implement the `TtsProvider` interface in `scripts/generate.ts` (or a
  new module) and register the factory in the `ttsProviders` map. No
  other call sites change.
- If the new engine exposes per-mark timing callbacks (Google Cloud TTS,
  ElevenLabs character-level timestamps), the provider can synthesize
  the whole chunk in one call and return its own segmentation; the
  current per-segment pattern is for engines that don't (`say`).
  Translate our `<mark name>` boundaries to whatever tag syntax the
  engine wants — SSML `<mark>` for SSML-aware engines, the engine's
  own bracket syntax (e.g. ElevenLabs v3's `[...]` tags) otherwise.
- For technical-term pronunciation, the lexicon is already plumbed
  through `TtsProviderConfig.lexicon`. The provider just needs to
  consume it (parse the PLS XML, or hand the bytes to the engine's
  pronunciation-dictionary API).
- Re-verify the silence trim. Different engines have different pre-roll;
  threshold 2000 RMS may need adjustment, or trim may become unnecessary.
- The provider's `outputFormat` must match `pipeline.workingFormat`
  (mono int16 @ 22050 Hz today). If the engine returns MP3/AAC, decode
  to PCM inside `synthesize`, or define a non-WAV pipeline that
  satisfies the same interface.


## Manifest format (`generated/<slug>/manifest.json`)

```json
{
  "audio": "/generated/<slug>/full.mp3",
  "duration": 84.21,
  "chapters": [
    { "id": "intro", "title": "Welcome", "startTime": 0, "endTime": 8.85 }
  ],
  "marks": [
    { "name": "title", "time": 0, "chapter": "intro",
      "text": "Hi everyone, and welcome to today's mini-talk." }
  ]
}
```

- Times are **absolute seconds** in the master track. The player never
  needs to know about chunks.
- `audio` is a path under `/generated/<slug>/`; Content-Type is inferred
  from the file extension by `Bun.file` at serve time.
- Marks shift backwards by each chunk's trim amount so they still align
  with speech after the leading silence is removed.

## Player & sync (`client/narrator.ts`)

- **Shikwasa** for the player chrome. Provides scrub, speed, ±15s skip,
  and a Chapter plugin. Lighter than building from scratch.
- `theme: "dark"` is forced (the dark style gives us the contrast we need, and our page only supports one color mode).
- The player's own chapter popover (`.shk-chapter`), "more" button
  (`.shk-btn_more`), extras panel (`.shk-controls_extra`), and empty
  cover slot (`.shk-cover`) are CSS-hidden. We render a custom chapter
  pill strip instead.
- Active-mark tracking uses **`requestAnimationFrame`** reading
  `player.currentTime`, not the audio element's `timeupdate` event
  (`timeupdate` fires ~4Hz, too coarse for sentence-level marks).
- Active mark = "latest mark whose `time` ≤ `currentTime`". Recomputed
  each tick from the current time rather than advanced as an index — this
  gives correct behavior on backward seeks for free.
- Auto-scroll only fires while playing **and** highlighting is enabled.
  Scrolling under a paused user is hostile, and scrolling while
  highlighting is disabled would defeat the point of the screenshot mode
  described below.
- **Highlighting toggle** — an eye-icon button that turns the narration highlighting on/off
  (`highlightEnabled` flag).
  - **Why it exists:** the article is the primary artifact and the player
    is an enhancement. Screenshots, exports, "show me what the page looks
    like" demos, or simply preferring a clean reading view all want the
    article in its as-authored state even while audio is playing.
  - **Why internal mark tracking continues when off:** so re-enabling
    snaps the highlight straight onto the current mark instead of
    waiting for the next one to fire. Only the DOM mutations are gated;
    the rAF tick still runs and `activeId` still advances.
  - **Why auto-scroll is also gated:** scrolling while the page is
    supposed to look static would defeat the point of the mode.
- The dock is dismissible via a single always-visible "Listen" pill
  fixed in the bottom-right corner. Audio intentionally **keeps
  playing** when hidden — users may dismiss the UI to read undistracted
  but still want narration. Pause via Space.
- Page-global keyboard shortcuts (in `setupKeyboardShortcuts()`):
  - **Space** toggles play/pause **always**, including when a button or
    link has focus. This deliberately overrides the default
    Space-activates-focused-button behavior so a focused chapter pill or
    the visibility toggle doesn't hijack playback control — matches
    Apple Podcasts / Spotify / YouTube semantics. Buttons can still be
    activated with Enter. Suppressed only when typing in an
    input/textarea/contenteditable.
  - **← / →** rewind / fast-forward 10s (matches the dock's own
    backward/forward buttons). Goes through `seekToSeconds()` for the
    same reason chapter seeks do — Shikwasa's `seekBySpan()` would round
    via its `parseInt` seek bug.
  - **1–9** jump to chapter N (1-indexed). No-op if chapter N doesn't
    exist. Chapter seeks route through `jumpToChapter()` → `seekToSeconds()`
    so they bypass Shikwasa's `parseInt` seek bug just like clicking a
    chapter pill does.
  - Modifier-held combinations (⌘/Ctrl/Alt + key) are ignored so browser
    shortcuts (find, refresh, etc.) aren't broken.

## Specs we lean on

Most of the building blocks here were already standardized. Notes on what's
load-bearing, what's inspiration, and what we considered and rejected.

### Directly used

- **SSML 1.0 — `<mark>` only** (`specs/SSML-spec.html`) — we borrow
  exactly one primitive from SSML: `<mark name="..."/>` as the segment
  boundary marker (the spec's own synchronization point). We reuse
  `name` directly as the target element id, no aliasing. The chunk's
  inner content is otherwise plain text — no `<speak>` root, no
  namespace, no prosody/voice/sub vocabulary. See "Considered, not
  used" for why we dropped full SSML.

### Conceptual basis (not on-the-wire)

- **EPUB 3 Media Overlays** (`specs/EPUB3-spec.html`) — the closest
  existing standard to what we're doing. Media Overlays pair text
  fragments with audio clips via SMIL `<par>` containers
  (`<text src="...#id"/>` next to an `<audio clipBegin clipEnd/>`).
  Our manifest is the same data model in JSON: each mark is one
  `<par>` (element id + time-in-audio). If we ever need EPUB export,
  the conversion is mechanical.
- **SMIL 3** (`specs/SMIL3-spec.html`) — the host language behind
  Media Overlays. We don't ship SMIL XML, but the data model
  (parallel time containers indexing into one audio track) is exactly
  what the player walks each rAF tick.
- **W3C Sync Media for Publications (Lite)**
  (`specs/SyncMediaLite-spec.html`) — the Publishing WG's newer,
  HTML-first alternative to Media Overlays. Same shape as our
  manifest: a cue list keyed by element id, with `startTime` /
  `endTime` into a single audio track. The manifest is roughly one
  rename away from being a Sync Media Lite document. If/when this
  spec stabilizes we should adopt its field names verbatim.

### Considered, not used

- **WebVTT** (`specs/WebVTT-spec.html`) — first instinct for "audio
  synced to content", and `<track kind=chapters>` is an obvious
  match for our chapter strip. Rejected because (a) WebVTT must live
  in a separate sidecar file, breaking the single-HTML authoring
  goal, and (b) cue payloads are CSS-styled text, not element
  references — encoding "highlight `#title`" would require ad-hoc
  conventions inside cue text. Chapters specifically could still be
  exported as WebVTT `kind=chapters` for hosts that want it.
- **Media Fragments URI** (`specs/MediaFragmentUrl-spec.html`) — the
  `#t=12,18` URL fragment syntax. Not used today, but
  `marks[].time` and `chapters[].startTime` / `endTime` are exactly
  what share-links like `/posts/hash-functions#t=12.4` would consume.
  Cheap to add when wanted; no schema changes required.
- **Spoken HTML** (`specs/spoken-html-spec.html`) — proposes
  annotating HTML elements directly with attributes like `data-ssml=`
  to drive narration. Right idea (single file, narration co-located
  with content) but the wrong knob: it forces the spoken script to
  mirror the visual one, defeating the "feels like a talk, not a
  read-aloud" goal. Our `<script>`-block-with-marks pattern keeps the
  same single-file property while letting the spoken script diverge.
- **Web Annotation Data Model**
  (`specs/WebAnnotationDataModel-spec.html`) — a mark **is** an
  annotation (target = element via `FragmentSelector`, body = the
  narration segment + its audio range). We don't use the JSON-LD form
  because nothing in the pipeline benefits from RDF semantics yet,
  but if marks ever need richer metadata (speaker attribution,
  translations, alt-text fallback) this is the data model to grow
  into rather than inventing one.
- **SSML 1.0 (full vocabulary)** (`specs/SSML-spec.html`) — we don't support SSML as TTS is moving off SSML (ex: ElevenLabs v3 replaced it with human-language tags like `[whisper]` / `[shout]`). As a technical blog, we don't really need any SSML feature other than marks and the specifying pronunciation. To achieve this,
    (a) we keep `<mark name>` support (only SSML tag we allow) for segment boundaries
    (b) we instead use PLS to specify pronunciations insteaed of full SSML
- **Pronunciation Lexicon Specification 1.0**
  (`specs/PronunciationLexicon-spec.html`) — the W3C lexicon format
  for per-term pronunciation overrides. Authored inline in each post
  as `<script type="application/pls+xml">...</script>` and extracted
  at build time. Note that some engines do not support PLS, and so
  the lexicon is a no-op in those cases (e.g. `say` on macOS).
- **Shared / project-wide PLS file** — rejected. Would reintroduce
  the sidecar pattern the "one file per post" constraint forbids, and
  every AI session editing a post would need to remember to also
  update it. Per-post inline PLS instead. To handle frequent cross-post duplication
  of common terms, place it in `common-terms.pls` which is merged in.

## Known bugs & workarounds

- **Shikwasa `seek(time)` calls `parseInt(time)`** (line 953 of
  `shikwasa.es.js` v2.2.1), truncating fractional seconds to whole-second
  integers. `seek(8.826)` actually seeks to `8.0`.
  - Workaround: `seekToSeconds()` in `narrator.ts` writes
    `player.audio.currentTime` directly, bypassing the broken wrapper.
  - **Same bug affects Shikwasa's own scrubber UI** — dragging the
    progress handle also rounds to integer seconds. Not yet worked around.
    Worth filing upstream (`parseInt` → `parseFloat`).
- The `+ 0.01` in `seekToSeconds(chapter.startTime + 0.01)` is unrelated
  to the above. It nudges the seek 10ms past the boundary so Shikwasa's
  chapter plugin reliably considers us *inside* the new chapter range
  (its boundary check is `t >= startTime && t < endTime`).

## CSS layout, in case it surprises you later

- we will never support a dark-mode/light-mode switch, because we need to ensure generated visuals for charts, etc. appear correctly (too hard to do this for both modes)
