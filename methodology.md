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
- Inline SSML lives in `<script type="application/ssml+xml" data-chunk-id="..." data-chunk-title="...">`
  blocks. Browsers treat the contents as raw text (the type is unknown), so
  no rendering happens; the generator reads them via regex.
- Each script is one **chunk**, which becomes one chapter in the player.
  Chunks are the unit of cache-friendly regeneration (re-generate one chunk,
  one audio file changes).
- Mark-to-element mapping is plain: `<mark name="lede"/>` highlights
  `id="lede"` in the article. No CSS selectors, no aliases — keep it dumb.

## Generation pipeline (`scripts/generate.ts`)

- macOS `say` for TTS. Chosen because it's a system command — no API key,
  no external service, no extra `npm install`. Forces `LEI16@22050` mono so
  every segment WAV has identical PCM format (essential for concatenation).
- SSML is split at `<mark>` boundaries; **one `say` invocation per
  segment** so we can measure each segment's exact duration. This gives
  sample-accurate mark times without forced alignment.
- `<break>` is mapped to a comma; other SSML tags are stripped before
  passing to `say` (it ignores SSML markup). When swapping for an
  SSML-aware TTS, replace `sayToWav` and the splitter can stay.
- WAV concatenation is done in Bun — no `ffmpeg`/`sox`/`lame` dependency.
  The full audio for a post is `intro.wav + definition.wav + ...` spliced
  into `full.wav` by byte-copying PCM data and rewriting the RIFF header.
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
- Per-chunk WAVs are still written alongside `full.wav`. Future versioning
  / partial-regen work can use them; current player only loads `full.wav`.

### When swapping `say` for a real SSML TTS

- Replace `sayToWav` in `scripts/generate.ts`. Everything else stays.
- If the new TTS exposes per-mark timing callbacks (ElevenLabs, Google
  Cloud TTS), skip the per-segment generation pattern entirely: synthesize
  the whole chunk in one call and read the engine's mark timestamps.
- Re-verify the silence trim. Different engines have different pre-roll;
  threshold 2000 RMS may need adjustment, or trim may become unnecessary.
- `say`'s output is mono int16 @ 22050 Hz; the WAV helpers assume that
  format. If the new TTS returns MP3/AAC, decode to PCM or rewrite the
  concat path.


## Manifest format (`audio/<slug>/manifest.json`)

```json
{
  "audio": "/audio/<slug>/full.wav",
  "duration": 84.21,
  "chapters": [
    { "id": "intro", "title": "Welcome", "startTime": 0, "endTime": 8.85 }
  ],
  "marks": [
    { "name": "title", "time": 0, "chapter": "intro" }
  ]
}
```

- Times are **absolute seconds** in `full.wav`. The player never needs to
  know about chunks.
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

- **SSML 1.0** (`specs/SSML-spec.html`) — the inline
  `<script type="application/ssml+xml">` blocks **are** SSML documents.
  - `<speak>` as the root, with the
    `http://www.w3.org/2001/10/synthesis` namespace preserved so blocks
    are valid SSML if extracted standalone.
  - `<mark name="..."/>` is the spec's own synchronization primitive —
    we reuse `name` directly as the target element id, no aliasing.
  - `<break time="..."/>` for prosody pauses; mapped to a comma when
    handing off to `say`.
  - `<prosody>`, `<emphasis>`, `<voice>`, etc. are stripped today
    because `say` ignores them; they come "for free" when we swap in
    an SSML-aware TTS.

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
  SSML segment + its audio range). We don't use the JSON-LD form
  because nothing in the pipeline benefits from RDF semantics yet,
  but if marks ever need richer metadata (speaker attribution,
  translations, alt-text fallback) this is the data model to grow
  into rather than inventing one.

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
