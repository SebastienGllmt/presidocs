// Branded time-unit types. Every time value in the codebase is currently
// in seconds; we want to migrate to milliseconds. Branding both units
// turns the migration into a compile-error-driven walk through the code:
// mixing a `Seconds` and a `Milliseconds` (or assigning a raw `number`
// to either) won't typecheck.
//
// The runtime schemas (`SecondsSchema` / `MillisecondsSchema`) are kept
// around for callers that want validated parsing at I/O boundaries
// (e.g. `SecondsSchema.parse(json.duration)`). Inside the codebase, use
// the cheap `as*` cast helpers — branding has no runtime cost.
//
// Arithmetic between two branded numbers (`a + b`) returns plain
// `number` in TypeScript's view, so cast the result back at the
// boundary where it leaves the expression: `asSeconds(a + b)`.

import { z } from "zod";

export const SecondsSchema = z.number().brand<"Seconds">();
export type Seconds = z.infer<typeof SecondsSchema>;

export const MillisecondsSchema = z.number().brand<"Milliseconds">();
export type Milliseconds = z.infer<typeof MillisecondsSchema>;

export const asSeconds = (n: number): Seconds => n as Seconds;
export const asMs = (n: number): Milliseconds => n as Milliseconds;

export const secondsToMs = (s: Seconds): Milliseconds => asMs(s * 1000);
export const msToSeconds = (ms: Milliseconds): Seconds => asSeconds(ms / 1000);
