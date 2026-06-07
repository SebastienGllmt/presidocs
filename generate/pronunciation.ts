// Applies a PLS pronunciation lexicon to narration text by substitution, for
// engines that have no native PLS support but DO read whatever text we hand
// them (every LLM-TTS, e.g. MOSS). The idea: rewrite each matched grapheme to
// its pronunciation in-band, so the engine "doesn't have to know" a lexicon
// existed — it just reads the substituted text.
//
// Why substitution at all, when PLS-aware engines exist? We have none. `say`
// ignores PLS outright (macOS has no support); MOSS is an autoregressive LLM
// that takes text, not a pronunciation dictionary. So the only way to honor an
// author's pronunciation is to bake it into the text before synthesis.
//
// Why prefer <alias> (respelling) over <phoneme> (IPA) — see methodology.md
// ("Representing word pronunciation"). Short version: under a probabilistic
// engine the win is *entropy reduction at the input*. "SHA-256" has several
// plausible readings ("shah"/"S-H-A", "two-fifty-six"/"two-five-six"); each is
// a mode a high-temperature sampler can fall into, so it occasionally mangles
// the term even after getting it right ten times. Rewriting to one unambiguous
// English form ("sha two fifty six") collapses those modes. IPA injected via
// MOSS's `/.../` syntax is the escape hatch for the rare word where respelling
// itself reads badly — but it's not the default, because (a) it has the same
// syllable count so it doesn't obviously flow better, and (b) hand-authored
// IPA is unverifiable by the author, whereas anyone can read "sha two fifty
// six" and tell if it's right.
//
// Matching is the actual risk surface (not the notation), so it's deliberate:
// case-sensitive exact grapheme match (the lexeme lists case variants as
// separate graphemes by design — that's the author's control), longest-match-
// first (a "RIPEMD-160" entry beats a bare "RIPEMD"), and an "alphanumeric
// boundary" rather than regex \b so terms ending in punctuation ("SHA-256")
// still anchor correctly. Anything the matcher misses, the author fixes the
// way they already do: add another <grapheme>.

import { XMLParser } from "fast-xml-parser";

// One lexeme's worth of the lexicon: the spellings it matches plus the two
// pronunciation forms it can carry. PLS allows both in one <lexeme>; we read
// both and pick per-engine at apply time.
export type LexEntry = {
  graphemes: string[];
  // <alias> content: a respelling read through the engine's normal voice.
  alias?: string;
  // <phoneme> content, treated as IPA. Emitted only for IPA-capable engines,
  // wrapped in `/.../` (MOSS's marker that a span is a phoneme sequence).
  ipa?: string;
};

// PLS is real XML, so parse it with the same `XMLParser` the feed reader uses
// (fast-xml-parser — already a direct dependency, build-time only). This retires
// four hand-rolled element regexes (which mishandled CDATA / attributes-with-`>`
// / nested tags) AND the bespoke `decodeEntities`, whose self-documented
// `&amp;`-must-run-last ordering was a correctness hazard: the parser decodes
// the XML predefined + numeric entities natively. The substitution MATCHER below
// stays hand-rolled (no library does in-band PLS substitution), and the merge in
// generate.ts stays a string-stitch on purpose (its output feeds the TTS cache
// key — round-tripping it through a serializer would bust every cached segment).
const plsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep every grapheme/alias/phoneme a string — a pure-digit grapheme like
  // "256" must NOT be coerced to a number.
  parseTagValue: false,
});

// fast-xml-parser returns a scalar for a tag that appears once and an array when
// it repeats; normalize to an array either way (undefined → []).
function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// A parsed text node is a bare string, OR — when the element also carries an
// attribute (e.g. `<phoneme alphabet="ipa">taʊ</phoneme>`) — an object whose
// text content sits under `#text`. Pull the text out of either shape.
function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object" && "#text" in node) {
    const t = (node as { "#text"?: unknown })["#text"];
    return t == null ? "" : String(t);
  }
  return String(node);
}

// Collapse internal whitespace (graphemes/aliases are single tokens or short
// phrases; authored newlines/indentation are never significant) and trim. The
// XMLParser already decoded entities, so this no longer decodes.
function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Parse a merged PLS lexicon (one <lexicon> root, many <lexeme>) into entries.
export function parseLexicon(xml: string): LexEntry[] {
  const parsed = plsParser.parse(xml) as { lexicon?: { lexeme?: unknown } };
  const entries: LexEntry[] = [];
  for (const lex of toArray(parsed.lexicon?.lexeme) as Record<string, unknown>[]) {
    const graphemes: string[] = [];
    for (const g of toArray(lex.grapheme)) {
      const grapheme = clean(textOf(g));
      if (grapheme) graphemes.push(grapheme);
    }
    if (graphemes.length === 0) continue; // nothing to match on
    // A lexeme may carry several <alias>/<phoneme>; the original took the first.
    const aliasNode = toArray(lex.alias)[0];
    const phonemeNode = toArray(lex.phoneme)[0];
    const alias = aliasNode != null ? clean(textOf(aliasNode)) : undefined;
    const ipa = phonemeNode != null ? clean(textOf(phonemeNode)) : undefined;
    if (!alias && !ipa) continue; // nothing to say
    entries.push({ graphemes, alias: alias || undefined, ipa: ipa || undefined });
  }
  return entries;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True iff `text` contains any of `graphemes` under the SAME matching rules as
// applyLexicon — case-sensitive exact spelling, alphanumeric boundary (not regex
// `\b`, so terms beginning/ending in punctuation like "SHA-256" still anchor).
// Used by the sound-test page to find narration segments where a lexeme occurs,
// so its in-post audio can be re-rolled surgically — and crucially, "occurs"
// must mean exactly what the substitution would match, otherwise the page would
// claim a term occurs where it would never actually be substituted (or miss a
// term it would). Sharing the matcher is the only way to keep those agreed.
export function matchesAnyGrapheme(text: string, graphemes: string[]): boolean {
  if (!text || graphemes.length === 0) return false;
  const alternation = graphemes.map(escapeRegExp).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`);
  return re.test(text);
}

export type ApplyOptions = {
  // Whether the target engine accepts inline IPA wrapped in `/.../`. MOSS does;
  // `say` does not (it would read the slashes). When false, an entry's IPA is
  // ignored and we fall back to its alias (if any).
  ipaSupported: boolean;
};

// One PLS substitution that happened during applyLexiconWithMap. Spans are
// half-open ranges into the original / substituted strings respectively. Used
// by the forced-aligner integration (proposals/17 §8) to project alignment
// timings — which are produced against the substituted text MOSS actually
// spoke — back to character offsets in the displayed (original) text, so the
// drawer can highlight the term the reader sees, not the respelling MOSS
// pronounced. Identity-mapped stretches between substitutions are implicit
// (they have the same length in both strings); only the substitutions
// themselves are recorded.
export type Substitution = {
  originalStart: number;
  originalEnd: number;
  substitutedStart: number;
  substitutedEnd: number;
  // The matched grapheme verbatim (== text.slice(originalStart, originalEnd)).
  // Carried so consumers don't have to slice the original text just to label a
  // substitution in logs / debug output.
  grapheme: string;
  // What it was substituted with (== substituted.slice(substitutedStart,
  // substitutedEnd)). For an IPA-capable engine this is the `/.../`-wrapped
  // phoneme string; otherwise it's the alias verbatim.
  replacement: string;
};

export type ApplyResult = {
  // The substituted text — what we hand to the TTS engine (and what the
  // aligner sees).
  substituted: string;
  // The list of substitutions in document order. Empty when nothing matched.
  substitutions: Substitution[];
};

// Choose the pronunciation an entry contributes for this engine: IPA (wrapped)
// when supported and present, otherwise the alias. Returns null if the entry
// has nothing usable for this engine (e.g. IPA-only entry on a non-IPA engine).
function replacementFor(entry: LexEntry, opts: ApplyOptions): string | null {
  if (opts.ipaSupported && entry.ipa) return `/${entry.ipa}/`;
  if (entry.alias) return entry.alias;
  return null;
}

// Build the matcher (regex + grapheme→replacement map) shared by
// applyLexicon{,WithMap}. Returns null when there's nothing to match.
function compileMatcher(
  entries: LexEntry[],
  opts: ApplyOptions,
): { re: RegExp; map: Map<string, string> } | null {
  // Flatten to (grapheme → replacement), longest grapheme first so that at any
  // position the most specific spelling wins (regex alternation is left-biased,
  // so order is what enforces longest-match). First writer wins on duplicates.
  const pairs: { grapheme: string; replacement: string }[] = [];
  for (const entry of entries) {
    const replacement = replacementFor(entry, opts);
    if (replacement === null) continue;
    for (const grapheme of entry.graphemes) pairs.push({ grapheme, replacement });
  }
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => b.grapheme.length - a.grapheme.length);

  const map = new Map<string, string>();
  for (const { grapheme, replacement } of pairs) {
    if (!map.has(grapheme)) map.set(grapheme, replacement);
  }

  // Alphanumeric boundary (not \b, which is defined against \w and misbehaves
  // for graphemes that begin/end in punctuation like "SHA-256"): a match is
  // valid only when neither neighbor is [A-Za-z0-9].
  const alternation = [...map.keys()].map(escapeRegExp).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`, "g");
  return { re, map };
}

// Rewrite every matched grapheme in `text` to its pronunciation, also
// returning the index map from original→substituted spans. Pure and
// deterministic. This is the primitive; `applyLexicon` is a convenience
// wrapper that discards the map for callers (MOSS synth) that don't need it.
export function applyLexiconWithMap(
  text: string,
  entries: LexEntry[],
  opts: ApplyOptions,
): ApplyResult {
  if (!text || entries.length === 0) return { substituted: text, substitutions: [] };
  const matcher = compileMatcher(entries, opts);
  if (!matcher) return { substituted: text, substitutions: [] };
  const { re, map } = matcher;

  // Walk matches in order, copying the unchanged stretches verbatim (identity
  // mapping; not recorded) and recording each substitution span in both
  // coordinate systems. Re-create the regex's lastIndex walk by reading
  // .exec() in a loop rather than .replace()'ing, because the replacement
  // callback in .replace() doesn't expose the *output* position we need for
  // substitutedStart.
  re.lastIndex = 0;
  const subs: Substitution[] = [];
  let originalCursor = 0;
  let outParts: string[] = [];
  let substitutedCursor = 0;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    const grapheme = m[0];
    const originalStart = m.index;
    const originalEnd = originalStart + grapheme.length;
    const replacement = map.get(grapheme);
    if (replacement === undefined) continue; // can't happen — matcher built from map
    // Copy the identity-mapped stretch up to this match.
    const unchanged = text.slice(originalCursor, originalStart);
    outParts.push(unchanged);
    substitutedCursor += unchanged.length;
    // Record the substitution span and emit the replacement.
    const substitutedStart = substitutedCursor;
    outParts.push(replacement);
    substitutedCursor += replacement.length;
    subs.push({
      originalStart,
      originalEnd,
      substitutedStart,
      substitutedEnd: substitutedCursor,
      grapheme,
      replacement,
    });
    originalCursor = originalEnd;
  }
  // Trailing identity-mapped stretch.
  outParts.push(text.slice(originalCursor));
  return { substituted: outParts.join(""), substitutions: subs };
}

// Rewrite every matched grapheme in `text` to its pronunciation. Pure and
// deterministic: same (text, entries, opts) always yields the same string, so
// the result is safely captured by the TTS cache key (which already hashes the
// lexicon XML). Returns `text` unchanged when there's nothing to apply.
export function applyLexicon(text: string, entries: LexEntry[], opts: ApplyOptions): string {
  return applyLexiconWithMap(text, entries, opts).substituted;
}

// Given a position in the substituted text (e.g. an aligned token's character
// offset), return the corresponding span in the original text. Three cases:
//
//   - Identity-mapped stretch (before / between / after substitutions):
//     returns a zero-width span at the shifted offset. The caller combines a
//     token's start + end queries to form its highlight range.
//
//   - Strictly inside a substitution: returns the WHOLE original grapheme's
//     span (the §8 collapse rule). A sub-token of "shah" inside the
//     substitution for "SHA-256" maps to the whole "SHA-256" range, so the
//     drawer highlights the displayed term continuously.
//
//   - Exactly at a substitution boundary (substitutedStart or
//     substitutedEnd): treated as the *adjacent identity-mapped* position
//     (originalStart or originalEnd respectively). This is what makes a
//     two-query "find this token's range" call correct: a token whose start
//     offset lands exactly on substitutedStart maps to originalStart, not to
//     the whole substitution; only a non-boundary position inside the
//     substitution triggers the collapse.
//
// `substitutedPos` follows the half-open cursor convention: 0 is "before the
// first character"; substituted.length is "after the last character".
export function projectSubstitutedPosToOriginal(
  substitutedPos: number,
  substitutions: readonly Substitution[],
  originalLength: number,
): { start: number; end: number } {
  // Walk substitutions in order tracking the offset between coordinate
  // systems. The shift is (substitutedStart - originalStart) on an identity
  // stretch; it changes by (substitution.replacement.length - grapheme.length)
  // at each substitution.
  let shift = 0;
  for (const sub of substitutions) {
    if (substitutedPos <= sub.substitutedStart) {
      // Identity stretch up to and including the leading boundary.
      const orig = substitutedPos - shift;
      return { start: orig, end: orig };
    }
    if (substitutedPos < sub.substitutedEnd) {
      // STRICTLY inside this substitution — collapse to the whole original span.
      return { start: sub.originalStart, end: sub.originalEnd };
    }
    shift += sub.substitutedEnd - sub.substitutedStart - (sub.originalEnd - sub.originalStart);
  }
  // After every substitution — final identity stretch.
  const orig = substitutedPos - shift;
  return { start: Math.min(orig, originalLength), end: Math.min(orig, originalLength) };
}
