<?xml version="1.0" encoding="UTF-8"?>
<!--
  Shared cross-post pronunciation lexicon. The generator merges this with
  each post's inline <script type="application/pls+xml"> block(s) and
  hands the combined lexicon to the TTS provider. Entries here apply to
  every post; post-specific terms go inline in the post itself.
  PLS spec: https://www.w3.org/TR/pronunciation-lexicon/

  Use <alias>: a respelling read through the engine's normal voice. Spell it
  out as UNAMBIGUOUS English words — "shah two fifty six", not "sha …" ("sha"
  was read "shay") and not hyphen shorthand. The bar is high: the respelling
  itself must have one obvious reading (see methodology.md, "Representing word
  pronunciation").

  Do NOT rely on <phoneme> (IPA): the local MOSS model does not interpret it —
  it reads the wrapping slashes literally as "slash". IPA support appears to be
  a flagship/larger-MOSS feature. The parser still reads <phoneme> and the
  pipeline can emit it to a genuinely IPA-capable engine, but MOSS today is not
  one, so every entry MUST carry a working <alias>.

  How adapters use this:
    - `moss` SUBSTITUTES matched graphemes with their pronunciation before
      synthesis (generate/pronunciation.ts), so MOSS honors these entries
      even though it has no native PLS API.
    - `say` ignores PLS entirely (macOS has no support) and warns at startup.
-->
<lexicon version="1.0"
         xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"
         xml:lang="en-US">
  <!-- "shah" (a real word, /ʃɑː/), not "sha" — MOSS read "sha" as "shay". -->
  <lexeme>
    <grapheme>SHA-256</grapheme>
    <grapheme>SHA256</grapheme>
    <grapheme>sha-256</grapheme>
    <grapheme>sha256</grapheme>
    <alias>shah two fifty six</alias>
  </lexeme>
  <!-- RIPEMD-160. Two lessons baked into "ripe M D one sixty":
       1. Acronym letters → STANDALONE CAPITALS ("M", "D"), not lowercase
          letter-words ("em", "dee"). Capitals get spelled correctly AND don't
          blend: lowercase "ripe em" was read "rape em" (the capital "M" breaks
          that merge), and "dee" was read "dey" while "D" reads "dee".
       2. Don't fight a misread with punctuation — "ripe, em" / "ripe. em" did
          fix the vowel but added an awkward pause; the capitals fix it cleanly.
       Moved here from the post's inline lexicon so its alias iterates cheaply
       (common-terms is excluded from the cache key → re-roll only the affected
       segments, no full-post re-render). -->
  <lexeme>
    <grapheme>RIPEMD-160</grapheme>
    <grapheme>RIPEMD160</grapheme>
    <grapheme>ripemd-160</grapheme>
    <grapheme>ripemd160</grapheme>
    <alias>ripe M D one sixty</alias>
  </lexeme>
</lexicon>
