<?xml version="1.0" encoding="UTF-8"?>
<!--
  Shared cross-post pronunciation lexicon. The generator merges this with
  each post's inline <script type="application/pls+xml"> block(s) and
  hands the combined lexicon to the TTS provider. Entries here apply to
  every post; post-specific terms go inline in the post itself.
  PLS spec: https://www.w3.org/TR/pronunciation-lexicon/

  We use <alias> rather than <phoneme> because PLS-aware engines feed the
  alias text back through their normal TTS — so "sha 2 56" is interpreted
  by whatever voice/dialect is configured, no IPA hand-tuning needed.

  The `say` adapter ignores PLS entirely (macOS has no PLS support) and
  warns at startup so authors aren't surprised. A future cloud adapter
  (ElevenLabs, Google Cloud TTS, …) will honor these entries.
-->
<lexicon version="1.0"
         xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"
         xml:lang="en-US">
  <lexeme>
    <grapheme>SHA-256</grapheme>
    <grapheme>SHA256</grapheme>
    <grapheme>sha-256</grapheme>
    <grapheme>sha256</grapheme>
    <alias>sha 2 56</alias>
  </lexeme>
</lexicon>
