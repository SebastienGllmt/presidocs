import { test, expect } from "bun:test";
import { parseVerdicts } from "./applyComments.ts";

test("parses a clean APPLIED/PARTIAL/NOTE-ONLY summary", () => {
  const out = `
  Thread #1 (id=abc123): APPLIED
    Rephrased the avalanche paragraph as requested.
  Thread #2 (id=def-456): NOTE-ONLY
    Comment is unclear; flagged for follow-up.
  Thread #3 (id=ghi_789): PARTIAL
    Addressed the article side; narration left for the author.
`;
  expect(parseVerdicts(out)).toEqual([
    { threadId: "abc123", status: "APPLIED" },
    { threadId: "def-456", status: "NOTE-ONLY" },
    { threadId: "ghi_789", status: "PARTIAL" },
  ]);
});

test("dedupes duplicate thread mentions — first verdict wins", () => {
  // If Claude double-mentions a thread (e.g. once in a draft summary,
  // once in the final) we want the first verdict to stick.
  const out = `
Thread #1 (id=abc123): APPLIED
  Edited the lede.
Thread #1 (id=abc123): NOTE-ONLY
  (recap)
`;
  expect(parseVerdicts(out)).toEqual([
    { threadId: "abc123", status: "APPLIED" },
  ]);
});

test("returns [] when Claude omits the structured summary", () => {
  expect(parseVerdicts("I made some edits but forgot to summarize.")).toEqual(
    [],
  );
});

test("tolerates surrounding prose / markdown bullets", () => {
  // The system prompt asks for the bare line, but Claude often emits
  // it inside markdown — leading dashes, indented bullets, etc.
  const out = `
Here's what I did:

- Thread #1 (id=t1): APPLIED — fixed the typo.
- Thread #2 (id=t2): NOTE-ONLY — needs author input.
`;
  expect(parseVerdicts(out)).toEqual([
    { threadId: "t1", status: "APPLIED" },
    { threadId: "t2", status: "NOTE-ONLY" },
  ]);
});

test("ignores Thread mentions with no `(id=…)` — those are prose references", () => {
  // E.g. "I addressed Thread #1 by …" must not parse — only the
  // verdict-line form does.
  const out = `
I addressed Thread #1 by reorganizing the section.

Thread #1 (id=real): APPLIED
  See above.
`;
  expect(parseVerdicts(out)).toEqual([
    { threadId: "real", status: "APPLIED" },
  ]);
});
