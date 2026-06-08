// Shared zod building blocks for the env-var config boundary.
//
// The project validates every untrusted *wire* shape with zod
// (`shared/commentSchemas.ts`, `server/requestSchemas.ts`, …); the deploy-time
// **environment** is the other untrusted-string boundary, and it used to be
// parsed by hand with a different ad-hoc idiom per spot (three different
// string→boolean conventions, a `list()` helper duplicated against an inline
// split, a hand-rolled parseInt+clamp). These helpers express those idioms once
// so the per-config schemas (`feedConfig`, `notifyConfig`) and the Worker's
// `isBlockedUser` agree by construction.
//
// The transforms are deliberately FAITHFUL to the prior hand-rolled semantics
// (case-insensitive token sets pinned explicitly; parseInt, not Number-coerce)
// so the migration is semantics-preserving and test-gated, not a behavior change
// smuggled in under a refactor.

import "./zodJitless.ts"; // configure jitless before any parse (CSP / Workers no-eval)
import { z } from "zod";

// Comma-separated env value → trimmed, empty-dropped `string[]`. Replaces both
// notifyConfig's `list()` helper and the inline split in `isBlockedUser`, so the
// CSV convention lives in exactly one place. A missing/empty var yields `[]`.
export const csvList = z
  .string()
  .default("")
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

// Trimmed string, or `null` when empty/unset — the `.trim() || null` opt-in idiom.
export const trimmedOrNull = z
  .string()
  .default("")
  .transform((v) => v.trim() || null);

// Trimmed string with a non-empty fallback — the `.trim() || "default"` idiom.
export function trimmedOr(fallback: string) {
  return z
    .string()
    .default("")
    .transform((v) => v.trim() || fallback);
}

// A boolean env flag decided by an explicit, case-insensitive, trimmed token
// set — matching the hand-rolled `=== "x"` / `!== "y"` conventions exactly.
//   - `{ truthy }`: true iff the value is one of these tokens (everything else,
//     including unset, is false — e.g. `PODCAST_EXPLICIT`, true only for "true").
//   - `{ falsy }`: false iff the value is one of these tokens, true otherwise
//     (so unset defaults true — e.g. `PODCAST_LOCKED`, false only for "no").
export function envFlag(opts: { truthy: string[] } | { falsy: string[] }) {
  return z
    .string()
    .default("")
    .transform((v) => {
      const s = v.trim().toLowerCase();
      return "truthy" in opts ? opts.truthy.includes(s) : !opts.falsy.includes(s);
    });
}
