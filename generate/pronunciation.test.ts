// Tests for the PLS-substitution layer. The matcher is the real risk surface
// (a PLS-aware engine would tokenize for us; here we do it ourselves), so the
// boundary / longest-match / case behavior is exercised hard.

import { test, expect } from "bun:test";
import {
  parseLexicon,
  applyLexicon,
  applyLexiconWithMap,
  projectSubstitutedPosToOriginal,
  matchesAnyGrapheme,
  type LexEntry,
} from "./pronunciation.ts";

const ipa = { ipaSupported: true };
const noIpa = { ipaSupported: false };

// --- parseLexicon ------------------------------------------------------------

test("parseLexicon reads multiple graphemes and the alias", () => {
  const xml = `<lexicon>
    <lexeme>
      <grapheme>SHA-256</grapheme>
      <grapheme>SHA256</grapheme>
      <grapheme>sha-256</grapheme>
      <alias>sha two fifty six</alias>
    </lexeme>
  </lexicon>`;
  expect(parseLexicon(xml)).toEqual([
    { graphemes: ["SHA-256", "SHA256", "sha-256"], alias: "sha two fifty six", ipa: undefined },
  ]);
});

test("parseLexicon reads <phoneme> as IPA", () => {
  const xml = `<lexicon><lexeme>
    <grapheme>Tao</grapheme>
    <phoneme alphabet="ipa">taʊ</phoneme>
  </lexeme></lexicon>`;
  expect(parseLexicon(xml)).toEqual([
    { graphemes: ["Tao"], alias: undefined, ipa: "taʊ" },
  ]);
});

test("parseLexicon keeps both alias and phoneme when a lexeme has both", () => {
  const xml = `<lexicon><lexeme>
    <grapheme>nginx</grapheme>
    <alias>engine x</alias>
    <phoneme>ˈɛndʒɪn ɛks</phoneme>
  </lexeme></lexicon>`;
  expect(parseLexicon(xml)).toEqual([
    { graphemes: ["nginx"], alias: "engine x", ipa: "ˈɛndʒɪn ɛks" },
  ]);
});

test("parseLexicon skips lexemes with no grapheme or no pronunciation", () => {
  const xml = `<lexicon>
    <lexeme><alias>no graphemes here</alias></lexeme>
    <lexeme><grapheme>FOO</grapheme></lexeme>
    <lexeme><grapheme>BAR</grapheme><alias>bar</alias></lexeme>
  </lexicon>`;
  expect(parseLexicon(xml)).toEqual([{ graphemes: ["BAR"], alias: "bar", ipa: undefined }]);
});

test("parseLexicon collapses whitespace and decodes entities", () => {
  const xml = `<lexicon><lexeme>
    <grapheme>R&amp;D</grapheme>
    <alias>research
       and    development</alias>
  </lexeme></lexicon>`;
  expect(parseLexicon(xml)).toEqual([
    { graphemes: ["R&D"], alias: "research and development", ipa: undefined },
  ]);
});

// --- applyLexicon: basic substitution ---------------------------------------

const shaEntry: LexEntry[] = [
  { graphemes: ["SHA-256", "SHA256", "sha-256", "sha256"], alias: "sha two fifty six" },
];

test("applyLexicon replaces a matched grapheme with its alias", () => {
  expect(applyLexicon("Use SHA-256 here.", shaEntry, noIpa)).toBe("Use sha two fifty six here.");
});

test("applyLexicon replaces every occurrence and every spelling variant", () => {
  expect(applyLexicon("SHA-256 vs sha256", shaEntry, noIpa)).toBe(
    "sha two fifty six vs sha two fifty six",
  );
});

test("applyLexicon leaves text untouched when nothing matches", () => {
  expect(applyLexicon("nothing to do here", shaEntry, noIpa)).toBe("nothing to do here");
});

test("applyLexicon is a no-op with no entries", () => {
  expect(applyLexicon("SHA-256", [], noIpa)).toBe("SHA-256");
});

// --- applyLexicon: boundaries (the alphanumeric-boundary rule) --------------

test("applyLexicon respects boundaries — no match mid-token", () => {
  // trailing alphanumeric after the grapheme → not a whole match
  expect(applyLexicon("SHA-2560 and xSHA256", shaEntry, noIpa)).toBe("SHA-2560 and xSHA256");
});

test("applyLexicon matches when bounded by punctuation, not just spaces", () => {
  expect(applyLexicon("(SHA-256),", shaEntry, noIpa)).toBe("(sha two fifty six),");
});

test("applyLexicon matches at string start and end", () => {
  expect(applyLexicon("SHA-256", shaEntry, noIpa)).toBe("sha two fifty six");
});

test("applyLexicon is case-sensitive (only listed spellings match)", () => {
  // "Sha-256" is not among the graphemes, so it is left alone.
  expect(applyLexicon("Sha-256", shaEntry, noIpa)).toBe("Sha-256");
});

// --- applyLexicon: longest-match-first --------------------------------------

test("applyLexicon prefers the longest matching grapheme", () => {
  const entries: LexEntry[] = [
    { graphemes: ["RIPEMD"], alias: "ripe em dee" },
    { graphemes: ["RIPEMD-160"], alias: "ripe em dee one sixty" },
  ];
  expect(applyLexicon("RIPEMD-160 builds on RIPEMD", entries, noIpa)).toBe(
    "ripe em dee one sixty builds on ripe em dee",
  );
});

// --- applyLexicon: IPA preference + capability gating -----------------------

const bothEntry: LexEntry[] = [
  { graphemes: ["Tao"], alias: "tao", ipa: "taʊ" },
];

test("applyLexicon emits IPA wrapped in /.../ for IPA-capable engines", () => {
  expect(applyLexicon("the Tao of it", bothEntry, ipa)).toBe("the /taʊ/ of it");
});

test("applyLexicon falls back to alias when the engine can't do IPA", () => {
  expect(applyLexicon("the Tao of it", bothEntry, noIpa)).toBe("the tao of it");
});

test("applyLexicon skips an IPA-only entry on a non-IPA engine", () => {
  const ipaOnly: LexEntry[] = [{ graphemes: ["Tao"], ipa: "taʊ" }];
  expect(applyLexicon("the Tao of it", ipaOnly, noIpa)).toBe("the Tao of it");
});

// --- applyLexicon: regex-special graphemes ----------------------------------

test("applyLexicon handles graphemes with regex-special characters", () => {
  const entries: LexEntry[] = [{ graphemes: ["C++"], alias: "see plus plus" }];
  expect(applyLexicon("I like C++.", entries, noIpa)).toBe("I like see plus plus.");
});

test("applyLexicon does not recursively rewrite its own replacement", () => {
  // Replacement "in C" must not get re-scanned for the "C" grapheme.
  const entries: LexEntry[] = [
    { graphemes: ["X"], alias: "written in C" },
    { graphemes: ["C"], alias: "see" },
  ];
  expect(applyLexicon("X", entries, noIpa)).toBe("written in C");
});

// --- matchesAnyGrapheme -----------------------------------------------------
// The sound-test page uses this to find segments containing a lexeme. It MUST
// agree with applyLexicon's matcher exactly — if it claims a match where the
// substitution wouldn't fire (or vice versa), the page lies about where audio
// can change.

test("matchesAnyGrapheme honors the alphanumeric boundary", () => {
  expect(matchesAnyGrapheme("we hash via SHA-256, then ...", ["SHA-256"])).toBe(true);
  expect(matchesAnyGrapheme("(SHA-256),", ["SHA-256"])).toBe(true);
  // adjacent alphanumeric on either side → not a match
  expect(matchesAnyGrapheme("SHA-2560", ["SHA-256"])).toBe(false);
  expect(matchesAnyGrapheme("xSHA-256", ["SHA-256"])).toBe(false);
});

test("matchesAnyGrapheme is case-sensitive (case variants are separate graphemes)", () => {
  expect(matchesAnyGrapheme("we use sha-256 here", ["SHA-256"])).toBe(false);
  expect(matchesAnyGrapheme("we use sha-256 here", ["SHA-256", "sha-256"])).toBe(true);
});

test("matchesAnyGrapheme returns false on empty inputs", () => {
  expect(matchesAnyGrapheme("", ["X"])).toBe(false);
  expect(matchesAnyGrapheme("nonempty", [])).toBe(false);
});

// --- applyLexiconWithMap (the substitution index map, proposals/17 §8) ------

test("applyLexiconWithMap: no entries → empty substitutions, text unchanged", () => {
  const r = applyLexiconWithMap("Use SHA-256 here.", [], noIpa);
  expect(r.substituted).toBe("Use SHA-256 here.");
  expect(r.substitutions).toEqual([]);
});

test("applyLexiconWithMap: no matches → empty substitutions, text unchanged", () => {
  const r = applyLexiconWithMap("nothing to do", shaEntry, noIpa);
  expect(r.substituted).toBe("nothing to do");
  expect(r.substitutions).toEqual([]);
});

test("applyLexiconWithMap records each substitution's original AND substituted span", () => {
  // "Use SHA-256 here." — SHA-256 occupies [4, 11) in the original (7 chars);
  // gets rewritten to "sha two fifty six" (17 chars). The trailing " here." is
  // identity-mapped at a shifted output offset.
  const r = applyLexiconWithMap("Use SHA-256 here.", shaEntry, noIpa);
  expect(r.substituted).toBe("Use sha two fifty six here.");
  expect(r.substitutions).toEqual([
    {
      originalStart: 4,
      originalEnd: 11,
      substitutedStart: 4,
      substitutedEnd: 4 + "sha two fifty six".length,
      grapheme: "SHA-256",
      replacement: "sha two fifty six",
    },
  ]);
  // Sanity: the substituted span content matches the replacement field exactly.
  const sub = r.substitutions[0]!;
  expect(r.substituted.slice(sub.substitutedStart, sub.substitutedEnd)).toBe(sub.replacement);
  expect("Use SHA-256 here.".slice(sub.originalStart, sub.originalEnd)).toBe(sub.grapheme);
});

test("applyLexiconWithMap: multiple substitutions accumulate the shift correctly", () => {
  const r = applyLexiconWithMap("SHA-256 then sha256.", shaEntry, noIpa);
  expect(r.substituted).toBe("sha two fifty six then sha two fifty six.");
  expect(r.substitutions).toHaveLength(2);
  const [a, b] = r.substitutions;
  // First substitution is at the very start.
  expect(a).toMatchObject({ originalStart: 0, originalEnd: 7, substitutedStart: 0, grapheme: "SHA-256" });
  // Identity stretch " then " (6 chars) sits between them in BOTH coordinates.
  expect(b!.originalStart).toBe(7 + " then ".length);
  expect(b!.substitutedStart).toBe(a!.substitutedEnd + " then ".length);
  expect(b!.grapheme).toBe("sha256");
  // The substituted-text slice still equals the replacement field.
  for (const sub of r.substitutions) {
    expect(r.substituted.slice(sub.substitutedStart, sub.substitutedEnd)).toBe(sub.replacement);
  }
});

test("applyLexiconWithMap: longest-match-first wins (RIPEMD-160 over RIPEMD)", () => {
  const entries: LexEntry[] = [
    { graphemes: ["RIPEMD"], alias: "ripe em dee" },
    { graphemes: ["RIPEMD-160"], alias: "ripe em dee one sixty" },
  ];
  const r = applyLexiconWithMap("RIPEMD-160 vs RIPEMD", entries, noIpa);
  expect(r.substituted).toBe("ripe em dee one sixty vs ripe em dee");
  expect(r.substitutions.map((s) => s.grapheme)).toEqual(["RIPEMD-160", "RIPEMD"]);
});

test("applyLexiconWithMap: IPA-capable engine records the /.../-wrapped replacement", () => {
  const r = applyLexiconWithMap("the Tao of it", bothEntry, ipa);
  expect(r.substituted).toBe("the /taʊ/ of it");
  expect(r.substitutions).toHaveLength(1);
  expect(r.substitutions[0]!.replacement).toBe("/taʊ/");
});

test("applyLexicon (the wrapper) is byte-identical to applyLexiconWithMap.substituted", () => {
  const cases: { text: string; entries: LexEntry[]; opts: typeof ipa | typeof noIpa }[] = [
    { text: "Use SHA-256 here.", entries: shaEntry, opts: noIpa },
    { text: "SHA-256 vs sha256", entries: shaEntry, opts: noIpa },
    { text: "the Tao of it", entries: bothEntry, opts: ipa },
    { text: "the Tao of it", entries: bothEntry, opts: noIpa },
    { text: "nothing to do here", entries: shaEntry, opts: noIpa },
    { text: "", entries: shaEntry, opts: noIpa },
  ];
  for (const c of cases) {
    expect(applyLexicon(c.text, c.entries, c.opts)).toBe(
      applyLexiconWithMap(c.text, c.entries, c.opts).substituted,
    );
  }
});

// --- projectSubstitutedPosToOriginal ----------------------------------------
// This is the lookup the aligner integration uses to project a token's
// character offset in the substituted (spoken) text to the highlight span in
// the original (displayed) text. The collapse property — any position inside
// a substitution maps to the WHOLE original grapheme — is the §8 contract.

test("projectSubstitutedPosToOriginal: identity mapping when no substitutions", () => {
  // No substitutions at all: position N in substituted == position N in original.
  for (const pos of [0, 1, 5, 17]) {
    const r = projectSubstitutedPosToOriginal(pos, [], 17);
    expect(r).toEqual({ start: pos, end: pos });
  }
});

test("projectSubstitutedPosToOriginal: before a substitution → identity-mapped", () => {
  // "Use SHA-256 here." → "Use sha two fifty six here." — positions in "Use "
  // (substituted [0,4)) match positions in "Use " in the original.
  const r = applyLexiconWithMap("Use SHA-256 here.", shaEntry, noIpa);
  for (const pos of [0, 1, 2, 3, 4]) {
    expect(projectSubstitutedPosToOriginal(pos, r.substitutions, "Use SHA-256 here.".length)).toEqual({
      start: pos,
      end: pos,
    });
  }
});

test("projectSubstitutedPosToOriginal: at a substitution BOUNDARY → identity (not collapsed)", () => {
  // The leading edge (substitutedStart) and trailing edge (substitutedEnd) are
  // both treated as the adjacent identity-mapped position, NOT as "inside the
  // substitution." This is what makes a two-query "[start, end) of a token"
  // call correct when the token sits exactly at a substitution boundary.
  const original = "Use SHA-256 here.";
  const r = applyLexiconWithMap(original, shaEntry, noIpa);
  const sub = r.substitutions[0]!;
  expect(projectSubstitutedPosToOriginal(sub.substitutedStart, r.substitutions, original.length)).toEqual({
    start: sub.originalStart,
    end: sub.originalStart,
  });
  expect(projectSubstitutedPosToOriginal(sub.substitutedEnd, r.substitutions, original.length)).toEqual({
    start: sub.originalEnd,
    end: sub.originalEnd,
  });
});

test("projectSubstitutedPosToOriginal: INSIDE a substitution → whole original span (collapse)", () => {
  // Every STRICTLY-INTERIOR position projects to the original "SHA-256" span
  // [4, 11). Boundary edges are tested separately above (they're identity).
  const original = "Use SHA-256 here.";
  const r = applyLexiconWithMap(original, shaEntry, noIpa);
  const sub = r.substitutions[0]!;
  for (const pos of [sub.substitutedStart + 1, sub.substitutedStart + 2, sub.substitutedEnd - 1]) {
    expect(projectSubstitutedPosToOriginal(pos, r.substitutions, original.length)).toEqual({
      start: 4,
      end: 11,
    });
  }
});

test("projectSubstitutedPosToOriginal: after a substitution → identity-mapped with shift", () => {
  // After "SHA-256" → "sha two fifty six" the shift is +10 (17-7). So the
  // substituted-text position right at the end of the substitution maps to the
  // original position right after "SHA-256".
  const original = "Use SHA-256 here.";
  const r = applyLexiconWithMap(original, shaEntry, noIpa);
  const sub = r.substitutions[0]!;
  // Position right at sub.substitutedEnd is past the substitution → identity-
  // mapped at originalEnd (11).
  expect(projectSubstitutedPosToOriginal(sub.substitutedEnd, r.substitutions, original.length)).toEqual({
    start: 11,
    end: 11,
  });
  // Position at the end of " here." in the substituted text maps to the end
  // of " here." in the original.
  expect(projectSubstitutedPosToOriginal(r.substituted.length, r.substitutions, original.length)).toEqual({
    start: original.length,
    end: original.length,
  });
});

test("projectSubstitutedPosToOriginal: accumulates shifts across multiple substitutions", () => {
  // "SHA-256 then sha256." → "sha two fifty six then sha two fifty six."
  const original = "SHA-256 then sha256.";
  const r = applyLexiconWithMap(original, shaEntry, noIpa);
  const [a, b] = r.substitutions;
  // A position between the two substitutions (inside " then ") maps with the
  // first substitution's shift applied.
  // " then "[2] (the space before "sha256") in substituted == position
  // a.substitutedEnd + 1; should project to originalEnd-of-first (7) + 1 = 8.
  expect(projectSubstitutedPosToOriginal(a!.substitutedEnd + 1, r.substitutions, original.length)).toEqual({
    start: 8,
    end: 8,
  });
  // A position past the second substitution should land on the trailing "." in
  // the original.
  expect(projectSubstitutedPosToOriginal(b!.substitutedEnd, r.substitutions, original.length)).toEqual({
    start: b!.originalEnd,
    end: b!.originalEnd,
  });
});
