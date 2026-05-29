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

const LEXEME_RE = /<lexeme\b[^>]*>([\s\S]*?)<\/lexeme\s*>/gi;
const GRAPHEME_RE = /<grapheme\b[^>]*>([\s\S]*?)<\/grapheme\s*>/gi;
const ALIAS_RE = /<alias\b[^>]*>([\s\S]*?)<\/alias\s*>/i;
const PHONEME_RE = /<phoneme\b[^>]*>([\s\S]*?)<\/phoneme\s*>/i;

// Minimal XML entity decode for the small set that can legitimately appear in
// grapheme/alias/phoneme text. PLS files are real XML, so an author writing a
// grapheme containing `&` or `<` would escape it.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&"); // last, so a literal "&amp;amp;" survives correctly
}

// Collapse internal whitespace (graphemes/aliases are single tokens or short
// phrases; authored newlines/indentation are never significant) and trim.
function clean(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

// Parse a merged PLS lexicon (one <lexicon> root, many <lexeme>) into entries.
// Regex-based on purpose: it matches how the lexicon is already sliced
// upstream (generate.ts), and the format is small, flat, and author-written.
export function parseLexicon(xml: string): LexEntry[] {
  const entries: LexEntry[] = [];
  for (const lex of xml.matchAll(LEXEME_RE)) {
    const body = lex[1] ?? "";
    const graphemes: string[] = [];
    for (const g of body.matchAll(GRAPHEME_RE)) {
      const grapheme = clean(g[1] ?? "");
      if (grapheme) graphemes.push(grapheme);
    }
    if (graphemes.length === 0) continue; // nothing to match on
    const aliasM = ALIAS_RE.exec(body);
    const phonemeM = PHONEME_RE.exec(body);
    const alias = aliasM ? clean(aliasM[1] ?? "") : undefined;
    const ipa = phonemeM ? clean(phonemeM[1] ?? "") : undefined;
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

// Choose the pronunciation an entry contributes for this engine: IPA (wrapped)
// when supported and present, otherwise the alias. Returns null if the entry
// has nothing usable for this engine (e.g. IPA-only entry on a non-IPA engine).
function replacementFor(entry: LexEntry, opts: ApplyOptions): string | null {
  if (opts.ipaSupported && entry.ipa) return `/${entry.ipa}/`;
  if (entry.alias) return entry.alias;
  return null;
}

// Rewrite every matched grapheme in `text` to its pronunciation. Pure and
// deterministic: same (text, entries, opts) always yields the same string, so
// the result is safely captured by the TTS cache key (which already hashes the
// lexicon XML). Returns `text` unchanged when there's nothing to apply.
export function applyLexicon(text: string, entries: LexEntry[], opts: ApplyOptions): string {
  if (!text || entries.length === 0) return text;

  // Flatten to (grapheme → replacement), longest grapheme first so that at any
  // position the most specific spelling wins (regex alternation is left-biased,
  // so order is what enforces longest-match). First writer wins on duplicates.
  const pairs: { grapheme: string; replacement: string }[] = [];
  for (const entry of entries) {
    const replacement = replacementFor(entry, opts);
    if (replacement === null) continue;
    for (const grapheme of entry.graphemes) pairs.push({ grapheme, replacement });
  }
  if (pairs.length === 0) return text;
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
  return text.replace(re, (m) => map.get(m) ?? m);
}
