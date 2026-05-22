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
- **The narration is in the *author's own voice*.** The production audio is voice-cloned from a reference clip of the real author, so a listener feels the presentation is genuinely being given by the person who wrote it — not read by a generic synthetic narrator. This authenticity is the whole point of the spoken track. Crucially, auto-generating that voice is what makes it *sustainable*: the author can iterate on the document in response to feedback (see [AI-assisted iteration](#ai-assisted-authoring-authoring)) without re-recording a long presentation on every revision — the next build just re-synthesizes the changed segments in their voice. (This is also why the production TTS provider is a voice-cloning model; see [Providers](#providers-say-for-iteration-moss-for-production).)
- **Segment-level audio cache.** Edit one sentence and only that sentence is re-synthesized — the rest comes from cache. See [Audio caching](#audio-caching).
- **Non-linear narration is a first-class case.** Presenters reference earlier slides; our highlight/scroll logic has to handle going backwards as gracefully as forwards.
- **No light/dark toggle**: we will never support a dark-mode/light-mode switch, because we need to ensure generated visuals for charts, etc. appear correctly (too hard to do this for both modes)
- **Objects are CRDT-based; the *production* server is dumb storage.** Objects are managed via Automerge (CRDT library) and synced as content-addressed change objects in R2. Following this CRDT paradigm, the **production** server (the Cloudflare Worker) never runs Automerge or holds any other reconciliation logic — it just shuffles bytes. This is a *production deployment* constraint, not a universal one: it's what lets the comment data survive a malicious / buggy / different-version edge server, and it's why per-reader writes don't need server-side merge. **Localhost is exempt.** The dev Bun server and the offline build/authoring tools (`bun run generate`, `authoring/*`) run on the developer's machine, fully trusted, and freely run Automerge — merging every reader's blob, snapshotting, serializing to other formats. So "the server is dumb" should be read as "the *edge* server is dumb"; anything that only ever runs on localhost may be as smart as it likes.
- **Cloudflare ecosystem in prod, Bun in dev.** We focus on leveraging the Cloudflare ecosyhstem for production (Workers for the HTTP layer, R2 for any dynamic blob, the Static Assets binding for static content). Bun is dev-only (`bun --hot index.ts`) and build-time only (`bun run generate`)
- **Commenting as a core feature** Comments are done via OAuth login with the user's email. This allows us to not only apply recommended changes if relevant, but also follow-up with any commenter (via email or otherwise) to engage.
- **AI-assisted iteration: the comment system *is* the editing surface.** The author leaves their own comments on a post via the same UI a reader does, interleaved with readers' feedback ("rephrase this paragraph", "add an example for X"). An offline tool then hands every unresolved thread — both sources, undifferentiated — to Claude, which edits the source HTML in one reviewable diff. No separate editor view, no parallel workflow for human-driven vs. reader-driven edits. The same mechanism that gathers reader questions is the mechanism that drives the next revision. See [AI-assisted authoring](#ai-assisted-authoring-authoring).

## Repository layout

Each top-level folder is one concern, so finding code is "pick the folder that matches what you want to change":

- `generate/` — offline pipeline that turns a post into audio + manifest (`bun run generate`)
- `client/` — client-run JS code (ex: audio player)
- `server/` — server-side helpers used by `index.ts` (currently: `server/auth/` for OAuth + sessions)
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
- `silence`: insert silence as needed. A short `--segment-gap` (default 200ms) of silence is spliced between adjacent segments and between chapters at concat time, since TTS engines leave little/no pause of their own (especially under continuation prompting) and back-to-back sentences feel rushed. Mark/chapter times are computed against this gapped layout so highlighting stays in sync; `--segment-gap=0` disables it.
- `duration`: gets the duration of the audio file
- `concat`: combine audio buffers (note: ideally lossless to avoid re-encoding causing audio loss and no disk round-trip, but this is format-specific)
- `leadingSilenceMs`: how long the leading silence is in the audio (some audio-generating tools start with a lot of leading silence, making concatenation sound awkward)
- `trim`: trim the start of an audio file (usually used to remove leading silence)
- `encode`: encode to the final audio format served to the user

Every operation except `concat` is implemented as a shell-out to `ffmpeg` / `ffprobe`. `concat` stays as an in-memory byte-splice because ffmpeg's concat demuxer can't take multiple stdin pipes

The final audio format we serve to users is `mp3` (64 kbps mono, benefiting from its small size, and the fact that audio quality loss is not meaningful on spoken audio).  We try to avoid re-encoding many times to avoid accumulated quality loss — concat operates on the working PCM and the final mp3 encode happens once at the end.

### Providers: `say` for iteration, MOSS for production

Two providers are registered today (`--tts=NAME`, default `say`):

- **`say`** (macOS built-in) — fast and free, the iteration default. No pronunciation-hint support (it warns and ignores any PLS lexicon).
- **`moss`** — production voice via the local [OpenMOSS MOSS-TTS](https://github.com/OpenMoss/MOSS-TTS) model, **voice-cloned** from a reference clip. Higher quality, much slower, and heavyweight to load — so it's reserved for production renders while `say` carries the edit loop.

The two are deliberately interchangeable behind `TtsProvider`: the same post, cache, pipeline, and manifest code runs under either, so switching is just the flag. Because the cache key includes the provider name and voice, a `say` draft and a MOSS production render coexist in the cache rather than evicting each other — re-running with `--tts=say` after a MOSS render is still instant.

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

The MOSS repo is located via the **`MOSS_TTS_DIR`** env var (no portable default path; `MOSS_TTS_PYTHON` overrides the interpreter, `MOSS_TTS_DEVICE` forces the torch device). The factory validates the interpreter and the reference clip up front, so a misconfiguration fails immediately rather than 30 segments into a run. For convenience, the **`generate:prod`** npm script is just `generate --tts=moss`, and the clone reference clip defaults to **`MOSS_TTS_VOICE`** when `--voice` is omitted — so with `MOSS_TTS_DIR` and `MOSS_TTS_VOICE` in `.env` (Bun-autoloaded), a production render is `bun run generate:prod <post.html>` with no flags. These two are per-machine paths, hence env vars rather than committed config.

**One environment gotcha worth recording.** MOSS decodes the reference clip through `torchcodec`, which `dlopen`s the system FFmpeg shared libraries at runtime — and a venv python's default loader path doesn't include them, so torchcodec fails to load even when a perfectly compatible FFmpeg is installed (the error misleadingly lists *every* FFmpeg version as unloadable, because the real failure is "couldn't find `libavcodec` to try against any of them"). The provider works around this by adding FFmpeg's lib dir to the worker subprocess's loader path (`DYLD_FALLBACK_LIBRARY_PATH` on macOS, `LD_LIBRARY_PATH` on Linux), derived from the `ffmpeg` CLI's location (`<prefix>/bin/ffmpeg` → `<prefix>/lib`) and overridable via `MOSS_TTS_FFMPEG_LIB`. This one fix covers torchcodec everywhere it's used — both decoding the reference clip and the `torchaudio.save` of the output — so the worker writes its WAV with `torchaudio.save` exactly like the upstream MOSS scripts.

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

### Per-segment regeneration (dev, author-only)

MOSS is probabilistic (high `audio_temperature`), so a term can synthesize correctly nine times and mangle the tenth — a clean take never proves the next one is safe. The author therefore needs to **re-roll a single segment until it sounds right**, without re-rendering the post. That's a button on each segment in the [spoken-script drawer](#player--sync-clientnarratorts).

The mechanism reuses the cache rather than inventing an isolated render path — because there *can't* cleanly be one: segment durations cascade (change one segment's length and every later mark time in its chapter, and every later chapter's start, shift, and `full.mp3` must be re-concatenated). So "regenerate this segment" is really *"force-resynthesize one segment, then rebuild the whole post"* — which is cheap, because every *other* segment is an instant cache hit and only the chosen one calls MOSS:

- **`generate --force-mark=<name>`** maps the mark to its segment text and passes a `forceResynthesize` predicate to the cache wrapper (`tts-cache.ts`). A matching segment bypasses the cache *hit*, re-synthesizes a fresh take, and **overwrites** the stored bytes — so the accepted re-roll becomes the cached one. Everything else hits. The manifest + `full.mp3` are rebuilt normally.
- **`POST /dev/regenerate?post=<path>&mark=<name>`** (`server/regenerate.dev.ts`) shells out to that command with `--tts=moss`. It's **dev-only** (imported only by `index.ts`, absent from `worker.ts`) because it runs the build pipeline and loads the multi-GB model — a trusted-localhost operation, exactly what the [dumb-edge-server rule](#repository-layout) exempts — and **author-only** (the same server-authoritative `isPostAuthor` check the [version endpoint](#document-version-clientpostversionts-serverpostversionsroutets) uses). There's no per-click `--voice`, so it relies on **`MOSS_TTS_VOICE`** in `.env` for the clone reference (same as `generate:prod`); without it the spawn errors out at the provider's reference-clip check. It's **async by design**: a full render is minutes — longer than `Bun.serve`'s idle timeout, and even a one-segment re-roll exceeds it because the MOSS model load alone does — so awaiting the subprocess inside the request would get the connection killed mid-run while the child kept going. Instead POST *starts* the job and returns `202`; **`GET /dev/regenerate`** reports `{ running, ok?, error? }`, and the client polls it. Single-flight (one model load at a time; concurrent POST → 409).
- **Cold-cache caveat.** The button is "one segment fast" only when the rest of the post is already cached for the *current* voice + lexicon. Because the voice is part of the [cache key](#audio-caching), clicking it after a voice change (or before any full render with this voice) silently becomes a *full* re-synthesis of every segment. So the intended workflow is: one `generate:prod` to settle the post at its final voice, *then* per-segment re-rolls.
- **The client button** (`client/narrator.ts`) is injected per segment only when `location.hostname` is localhost *and* `/post-version` reports `isAuthor` — ordinary readers short-circuit before any fetch and never see it. It POSTs to start, then **polls** until the job finishes, so the spinner tracks the actual render rather than a connection that times out (the earlier bug: the spinner cleared at the idle timeout while generation silently continued, so stopping the dev server then killed the run mid-write). On success it sets the URL hash to the segment and hard-reloads: the rebuilt manifest + audio (served `no-cache` in dev) are picked up cleanly, the drawer reopens on that segment, and the author presses play to judge the new take. A full reload (rather than surgically swapping Shikwasa's source) is deliberate — it's bulletproof, and the per-click model-load latency already dwarfs it.

This is the operational backstop named in [Representing word pronunciation](#representing-word-pronunciation): substitution lowers the bad-roll rate, the cache freezes good takes, and per-segment re-roll cleans up the residue.

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
- Toggle player entirely (to hide it and focus on just the article). Two affordances depending on viewport:
    - **Desktop / wide viewport (>1000px)**: the floating "Listen" pill at bottom-right toggles the dock open and closed.
    - **Narrow viewport (≤1000px)**: the dock spans almost the full width, so the floating pill would otherwise sit on top of the dock's right edge when open. Instead of relocating the pill, we hide it while the dock is open and inject a close × (`.narrate-close-btn`) into the top-right corner of the player card. The pill returns as the *open* affordance once the dock is dismissed.
    - Shikwasa's own breakpoint switches the player to a vertically-stacked flex layout at ≤640px, so in the band between 641px and 1000px the player is still horizontal *and* our × is already showing. The highlight-toggle button (the rightmost item in the controls row) would otherwise collide with the corner × in that band, so an extra `padding-right: 44px` is applied to `.shk-player` there to push the controls inward and leave the corner clear.

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
- Same script also writes `server/postVersions.generated.ts` (an importable static map) for the Worker bundle.

**Dev parity:** `server/postVersions.dev.ts` recomputes the current hash from the source files at startup (so a fresh edit shows up without rerunning `bun run build`), and reads history from `posts/versions.json`. If the dev-computed current hash doesn't match the most-recent entry in `versions.json` (the author edited but hasn't built), we synthesize an in-memory "now" entry at the head of the history so the panel reflects the actual on-disk state. Not persisted — the build script remains the only writer.

**Visibility:** `GET /post-version?post=X` returns `{ currentHash, history? }`. Both fields require login (the post-version concept is comment-adjacent; pre-login readers don't need either signal). `history` is only included when the session is the post's author — every other logged-in user gets `currentHash` alone.

### UI

- **Selection → floating action bar.** A "Comment" pill appears above any selection inside a commentable root. Clicking it creates a draft card in the column, scrolls to it, and focuses its textarea.
- **Cards column** spans the document height. Each card is within it, so cards scroll with the page naturally. `repositionCards()` aligns each card's top with its anchor, then pushes later cards down so they don't overlap. It runs on scroll, resize, and after every render.
- **Bottom clearance.** Comments near the end of the page are kept scrollable clear of the fixed player dock (an invisible spacer adds just enough scroll room), so a comment on the very last paragraph isn't trapped behind the player.
- **Drafts vs threads.** A *draft* is an unsubmitted thread held in `this.drafts`. Drafts deliberately don't go into the CRDT, so they never sync to a server or to the user's other devices — but they DO persist to localStorage via `draftsStorage.ts` so closing the tab mid-compose doesn't lose the work (see [Draft persistence](#draft-persistence-clientdraftsstoragets)). The card looks the same as a saved one but is framed with a blue border; the composer's "Cancel" discards the entire draft, "Comment" promotes it (registering the thread and the reply). After the first reply lands the thread lives in the CRDT and subsequent typing in the same card just appends replies. Each card owns its own textarea, so drafts never collide with each other and the old "you have unsaved work" draft-protection logic isn't needed.
- **Cross-linking** between card and anchor: clicking a highlight scrolls its card into view and pulses it; clicking a card (anywhere outside its buttons / textarea) scrolls the article to the anchor and pulses the highlight.
- **Highlight color** is soft blue (`rgba(88, 166, 255, 0.22)`), deliberately not yellow — narration already paints the active sentence yellow/orange, and a sentence that's both being read and commented needs to be visually unambiguous. Nested highlight spans (overlapping threads) naturally compose to a darker blue, which reads as "denser commentary here."
- **Layout reservation.** When the column is visible (≥1100px viewport) `body { padding-right: 360px }` shifts the centered article left so the column has a clean gutter to live in. The narration dock stays viewport-centered and so no longer sits dead-center under the article when the column is showing; that visual mismatch is mild enough to ignore for v1.

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

### Future direction: Web Push notifications

The core motivation of the whole auth-gated comment system — "the author wants to follow up on real questions" — currently terminates in the author's verified email and a polling viewer. There is no active notification to the author that a comment landed; they have to revisit posts or check the aggregator manually. Outbound email would close that loop but introduces a paid third-party dependency (Resend / Postmark / SES — Cloudflare has Email Routing for *receiving* mail but no outbound send API). **Web Push** is the Cloudflare-native alternative: the entire flow stays inside the Workers + R2 model already in use.

**What it solves:** when a reader submits a comment, the author's browser (or installed PWA) gets an OS-level notification with the post title and a snippet, even if they're not currently on the site. Same architecture can later notify a commenter when the author replies to their thread; same plumbing, different sender/recipient direction.

**Why Web Push fits the Cloudflare-only constraint.** The Web Push protocol ([RFC 8030](https://datatracker.ietf.org/doc/html/rfc8030)) is just HTTP. The "push services" are run by browser vendors (FCM for Chrome / Edge, Mozilla autopush for Firefox, Apple Push for Safari) — they're free, no signup, no API keys, and the only credentials we need are a self-generated **VAPID** key pair to authenticate the *sender* (us) to those services. Workers can speak this protocol directly via `crypto.subtle` (ECDSA P-256 for the VAPID JWT, AES-128-GCM + HKDF for the payload encryption). No SDK with transitive deps, no separate hosted service.

**End-to-end shape:**

1. **Setup (one-time, build-time).** Generate a VAPID key pair (`crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" })`). Public key → embedded as a build-time constant in `client/`; private key → `wrangler secret put VAPID_PRIVATE_KEY`. The `sub` claim of every VAPID JWT is a `mailto:` URI for the operator (browser push services require it for abuse contact).

2. **Subscription (client, author-only).** When a logged-in user who is the author of *any* post lands on a page where they haven't yet granted notification permission, the comments column surfaces an "Enable notifications" button (gated identically to the existing aggregator surface — same `isAuthor` signal). On click:
   - Register a service worker (`/sw.js`, served from `dist/`).
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

**Status: not implemented.** This section exists so the decision space is captured before any code is written. If we go ahead, the implementation lands in `server/push/`, `client/pushSubscribe.ts`, and `client/sw.js`, with the trigger plumbed into the existing comment-PUT path.

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

The spam concern is mitigated by the build pipeline: the meta tag exists in **source** HTML (the author edits it there; the generator reads it there) but is **stripped from the served HTML** during the build process (crawlers hitting prod see no `author-email` tag). The server-side author lookup doesn't depend on the tag being in the served response — it reads the source HTML at build time (via `server/postMeta.generated.ts`) or dev startup (via `server/postMeta.dev.ts`), so dropping it from the response is purely cosmetic.

**Client-side author detection** can't read the stripped tag in prod, so it instead reads the server-computed `isAuthor` boolean returned by `GET /post-version?post=X`. Every author-only client surface (the aggregator, the resolve-foreign-thread button, the version history panel) gates on this single signal. The post-version endpoint is fetched once at boot before any author-only decisions are made; failure to fetch defaults to non-author, matching the safe-degrade behavior elsewhere.

The same strip step also removes other source-only tags from served HTML — see [Build-time HTML strip](#build-time-html-strip-generatestrip-served-htmlts).

### Email-verified check

The author check requires `session.emailVerified === true`. Without that gate, an attacker who controls an OAuth app with weak email verification (or one that accepts user-supplied emails without verification) could log in with the author's email and be treated as author.
- Google sets `email_verified` based on its own verification
- Microsoft doesn't emit the field (we treat that as verified)

### Dev + prod parity

- In dev builds, `posts/*.html` is the source of truth
- In prod builds, we use only the generated files (`wrangler dev` works without a build step)

## AI-assisted authoring (`authoring/` + the `process-comments` skill)

The comment system isn't just a feedback channel — it's the authoring interface itself. The author opens their own post, highlights text, leaves comments like "rephrase this", "add a paragraph about edge cases", etc. — through exactly the same UI a reader uses. The loop:

1. Publish the post.
2. Readers (and the author, on a re-read) leave comments through the in-page column.
3. In a Claude Code session, run the **`process-comments` skill** (`/process-comments <slug>`). It pulls every unresolved thread — readers' + the author's own — edits the post HTML in place to address them, and resolves the ones it addresses, with the author reviewing each change live and steering across passes.
4. Author regenerates audio (`bun run generate`) and redeploys (`bun run build && wrangler deploy`).

**Author-self comments and reader comments are treated identically.** "Rephrase the avalanche-effect paragraph to mention SHA-256 explicitly" (left by the author) sits in the same working set as "is this really deterministic for streaming inputs?" (left by a reader). The skill makes one coherent set of edits across both. That synthesis is the point: separating "what the author wants to change" from "what readers want explained" loses the case where one edit addresses both.

### How the loop works (the `process-comments` skill)

The skill (`.claude/skills/process-comments/SKILL.md`) runs inside an ordinary interactive Claude Code session and drives:

1. **Fetch** the open comments — `bun authoring/exportAnnotations.ts <slug>` — as a Web Annotation `AnnotationCollection` (see [Inputs the skill sees](#inputs-the-skill-sees)).
2. **Read the editing rules** (`authoring/authoringRules.md`) and the post, then **edit `posts/<slug>.html` in place**.
3. **Report a verdict per thread** (`APPLIED | PARTIAL | NOTE-ONLY`) and **pause for the author** to review (`git diff`), request changes, or ask for another pass.
4. On the author's sign-off, **resolve the `APPLIED` threads** — `bun authoring/resolveThreads.ts <slug> <id…>` (see [Resolution write-back](#resolution-write-back-resolve-iff-shipped)).

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

The loader walks the same store the in-browser author aggregator does (`generated/.comments-dev/` in dev; R2 in prod, currently fetched via `wrangler r2 object sync` before running). For each user it replays every `.bin` change-object against the shared seed (see [Storage layer](#storage-layer-clientcommentsstorets)), then drops:

- Threads with `resolvedAt !== undefined` (self-resolve).
- Threads whose id appears in the per-post resolutions namespace (author-resolve — see [Author-resolution](#author-resolution-clientresolutionsstorets-servercommentsresolutionsroutests)).
- Threads with zero live (non-tombstoned) replies — defensive against malformed blobs; the auto-resolve in `deleteReply` should already cover this.

What's left is what Claude sees — never a thread already addressed.

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

Resolutions land in the local dev store (`generated/.comments-dev/resolutions/`); the author pushes them to R2 alongside the next deploy (`wrangler r2 object put …`, symmetric with the `wrangler r2 object sync` used to fetch comments). A first-class R2 push step is a follow-up. Resolving is *not* bundled with a version bump — the post content-hash is recorded by `generate/post-versions.ts` on the next `bun run build`, which also arms readers' "doc changed" banner ([Document version](#document-version-clientpostversionts-serverpostversionsroutets)).

### Decided against — surfacing per-iteration AI history in the browser

We considered capturing each intermediate AI pass as a browsable version (a "show me what the AI tried across iterations" view in the UI). It's fundamentally incompatible with in-place editing: in-place means every pass overwrites `posts/<slug>.html`, so intermediate passes only ever exist as uncommitted working-tree states — there's nothing durable to surface unless we re-introduce per-pass snapshots, which is exactly the draft machinery in-place was chosen to drop. So iteration history lives in **git** (the author commits between passes if they want checkpoints), and only *shipped* revisions become browsable entries in the author's [Document versions](#document-version-clientpostversionts-serverpostversionsroutets) panel (via the post-version hash on the next build).

### Excluded from v1

- **R2 fetch from the loader.** Currently reads only the local dev store. Pulling prod comments is one `wrangler r2 object sync` away today; an R2 adapter shaped like `server/comments/r2Adapter.ts` is a follow-up.
- **R2 push for resolutions.** Symmetric to the read side; `resolveThreads.ts` writes into `generated/.comments-dev/resolutions/`, and the author pushes them with `wrangler r2 object put` until the sync step is automated.
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
| Comments | same `handleCommentsRequest` handler from `server/comments/routes.ts`, mounted on `Bun.serve` and backed by an fs-adapter under `generated/.comments-dev/` | same handler, mounted on the Worker `fetch` and backed by an R2 adapter, enforcing the [author-only visibility rules](#hardening) |
| Generated audio + manifest | served from `generated/` via `serveFromDir` | copied into `dist/generated/` by `generate/copy-static.ts`, served by the `ASSETS` binding |
| Automerge WASM | served from `node_modules` via `/assets/automerge.wasm` route | copied into `dist/assets/automerge.wasm`, served by the `ASSETS` binding |
| OAuth redirects | `http://localhost:3000/auth/<provider>/callback` | `https://<your-domain>/auth/<provider>/callback` — both URIs registered at each provider |

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

### Analytics (Cloudflare Web Analytics)

To know which posts are getting traffic, the build step also injects Cloudflare's **Web Analytics** beacon into every HTML file under `dist/`. Web Analytics is Cloudflare's cookieless, privacy-focused page-view counter — it's a single `<script defer>` tag that reports a beacon to `static.cloudflareinsights.com` on each page load; per-page view counts then show up in the Cloudflare dashboard under the bound domain.

**Why Web Analytics, not Analytics Engine.** Analytics Engine is the lower-level Workers-side write-arbitrary-events product — useful if we ever want to log "comment posted" or "listened past chapter 3," but overkill for the immediate question "which post is getting the most views." Web Analytics answers that out of the box with no Worker code and no schema to maintain.

**Configuration.** A single env var, `CF_ANALYTICS_TOKEN`, set in the build environment (Bun auto-loads `.env`). The token is public — it ends up in served HTML — so it's *configuration*, not a secret, and lives in `.env` next to non-sensitive build-time settings rather than in Cloudflare's secret store. If the var is unset (e.g., a contributor running `bun run build` locally), injection is skipped silently and the dist HTML is unchanged.

**Injection mechanism.** Done inside the existing post-build step (`generate/strip-served-html.ts`) via `shared/injectAnalytics.ts`. We piggy-back on the HTML strip pass rather than walking dist/ a second time — same `HTMLRewriter` instance per file, one read + one write. The injector appends the beacon `<script>` at the end of `<head>` and refuses to add a duplicate if the beacon URL is already present (idempotent under re-runs of the build step).

**Dev doesn't inject.** Same rationale as the strip step: localhost views aren't meaningful in the analytics dashboard, and skipping the network call to `cloudflareinsights.com` keeps dev tooling offline-friendly. If the dev/prod difference is ever a problem, the env var works on both — set `CF_ANALYTICS_TOKEN` in your local `.env` and the Bun server's dev HTML would need a Bun plugin to inject (see strip's "Dev doesn't strip" note).

### Secrets

All OAuth client secrets and `SESSION_SECRET` (or `SESSION_SECRETS=v1:…,v2:…` for [key rotation](#sessions-jwt-cookie-hs256-jose)) live in Cloudflare's encrypted secret store (`wrangler secret put ...`), *not* in `wrangler.toml`. Names line up with the dev `.env`, so the route handlers read the same `process.env.*` / `env.*` regardless of runtime.

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

### Excluded from v1

- **Separate API and asset deployments** (Pages + Worker). One Worker with the assets binding covers both.
- **Cloudflare KV** — see above.
- **Durable Objects** — overkill at this scale. The per-user R2 blob already serializes that user's writes; we don't need an actor model on top.
- **Turnstile / CAPTCHA** — wired in only when rate limits actually start tripping for legit users. The hooks (a 429-with-challenge path) can be added in a few lines later.
- **Audit log** of every PUT. Cheap insurance, but not load-bearing until something goes wrong.

## Terminology

Two units of spoken content come up throughout this doc

- **Chapter** — one `<script type="text/narration">` block in the post. Authored with `data-chapter-id` and `data-chapter-title` attributes. Maps 1:1 to a chapter in the audio player (chapter-skip lands here). Code type: `NarrationChapter`.
- **Segment** — the text between two `<mark>` boundaries inside a chapter. This is the unit that gets handed to the TTS provider, the unit that the audio cache keys on, and the unit the player highlights/scrolls to. Code type: `Segment`, produced by `splitChapter`. A chapter contains many segments.

The word **chunk** is deliberately *not* used as a user-facing concept (it's too generic to mean any one thing, and often already used in audio-processing contexts).

## Relation to other specifications

### In active use

- **Web Annotation Data Model** ([spec][AnnotationModel]): the comments system stores every anchor as a Web Annotation *target* (selectors over the post — `RangeSelector` + `TextQuoteSelector`, or a `FragmentSelector` for graphics), and exports threads as a JSON-LD `AnnotationCollection`. See [Comments → Anchoring](#anchoring-the-web-annotation-target-model) and [Exporting to the Web Annotation wire format](#exporting-to-the-web-annotation-wire-format). (Still *not* used for the narration `<mark>` ↔ `id` pairing — that relation is simple enough to need no annotation vocabulary.)
- **JWT / JWS / JWA** ([RFC 7519][JWT], [RFC 7515][JWS], [RFC 7518][JWA]): session cookies are HS256-signed JWTs — a compact JWS serialization, `HS256` from the JWA algorithm registry — verified by `jose` with a hard-pinned algorithm allowlist (the [JWT BCP][JWT-BCP], RFC 8725) and a `kid` header for key rotation. See [Sessions](#sessions-jwt-cookie-hs256-jose). Provider ID tokens are *also* JWTs, but we deliberately *don't* verify them — see [Userinfo from `/userinfo`](#userinfo-from-userinfo-not-from-a-decoded-id-token).

### Possibly usable later

- **EPUB 3 Media Overlays** ([spec][EPUB]): Media Overlays pair text fragments with audio clips via SMIL
- **SMIL 3** ([spec][SMIL3]): the host language behind Media Overlays
- **W3C Sync Media for Publications (Lite)** ([spec][SyncMedia]): HTML-first alternative to Media Overlays
- **Media Session API** ([spec][MediaSession]): browser-native API for surfacing media metadata (title, artwork) on the OS lock screen / notification shade and handling system play/pause/skip controls (headphone clicks, hardware media keys, Bluetooth remotes). Would slot in around the existing Shikwasa player — set `navigator.mediaSession.metadata` once the manifest loads, register `setActionHandler('play' | 'pause' | 'seekto' | 'previoustrack' | 'nexttrack', ...)` to route system events into our existing controls, and update `setPositionState` from the same rAF tick that already drives the progress bar. Chapter skip lines up naturally with `previoustrack`/`nexttrack`. No build-time work — pure runtime additions to `client/narrator.ts`.

### Considered, not used

- **WebVTT** ([spec][WebVTT]): primarily used to overlay captions on top of video tracks (or audio tracks) via `<track>` elements, but we don't use any overlay like this.
- **Media Fragments URI** ([spec][MediaFragments]) **as a player/URL feature**: we don't expose time-based URL fragments (ex: `#t=12,18`) for linking into the audio. The Media Fragments `t=` syntax *does* appear inside the comments data model (a narration comment carries the audio time range of its segment as a Web Annotation Media Fragments selector), but it's **best-effort, not authoritative** — audio is regenerated each revision, so a stored `t=` is only exactly valid for its build. The resolve-on-edit loop usually retires a comment before its timestamps drift — but [per-segment regeneration](#per-segment-regeneration-dev-author-only) can drift them with no text change at all (and cascades to every later segment), so the durable anchor is always the narration *text*. See [Comments → Anchoring](#anchoring-the-web-annotation-target-model) for the full staleness reasoning.
- **Spoken HTML** ([spec][SpokenHtml]) allows inlining SSML notation directly in HTML elements with attributes. However, our audio content is too different from the blog context for this to be useful (and instead use script tags)
- **PASETO** ([spec][PASETO]) for session tokens: removes JWT's `alg`-confusion footgun at the format level (algorithm implied by the version, no `alg` field, no `none`). Rejected in favour of [JWT] — smaller ecosystem, weaker Workers story, ~zero debugger tooling, and JWT is what our OIDC neighbours (arctic, Google, Microsoft) already speak, while `jose`'s pinned allowlist neutralizes the footgun anyway. See [Sessions](#sessions-jwt-cookie-hs256-jose).

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
[JWT]: https://datatracker.ietf.org/doc/html/rfc7519
[JWS]: https://datatracker.ietf.org/doc/html/rfc7515
[JWA]: https://datatracker.ietf.org/doc/html/rfc7518
[JWT-BCP]: https://datatracker.ietf.org/doc/html/rfc8725
[PASETO]: https://paseto.io/

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
[MediaSession]: ./specs/MediaSession-spec.html
[JWT]: ./specs/JWT-spec.html
[JWS]: ./specs/JWS-spec.html
[JWA]: ./specs/JWA-spec.html
[JWT-BCP]: ./specs/JWT-BCP-spec.html
[PASETO]: ./specs/PASETO-spec.html
-->

