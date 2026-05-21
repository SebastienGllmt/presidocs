// Tests for the PLS-substitution layer. The matcher is the real risk surface
// (a PLS-aware engine would tokenize for us; here we do it ourselves), so the
// boundary / longest-match / case behavior is exercised hard.

import { test, expect } from "bun:test";
import { parseLexicon, applyLexicon, type LexEntry } from "./pronunciation.ts";

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
