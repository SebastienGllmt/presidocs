// ============================================================================
// !!!  DESTRUCTIVE  !!!
//
// Wipes the LOCAL dev comment store — the Miniflare-backed R2 state the dev
// server persists under `<content-repo>/.wrangler/state/v3/r2/`. Use this to
// clear comments/resolutions that accumulated locally, most commonly
// e2e-seeded threads that the author aggregator surfaces in `bun run dev`
// (see methodology.md → Dev server wrapper). The e2e harness now
// isolates each run in a throwaway state dir, so going forward this is a
// one-time cleanup for already-polluted stores and for the `dev:edge`
// (wrangler dev) path, which still uses the shared default location.
//
// This is LOCAL DEV DATA ONLY. It does NOT touch prod R2 — that lives in
// Cloudflare, reachable via `bun run pull-comments` / `push-resolutions`,
// never under `.wrangler/`. Nothing deleted here is recoverable locally, but
// nothing here is canonical either: prod is the source of truth, and a
// developer reseeds dev by commenting again or running `pull-comments`.
//
// USAGE:  bun run dev:reset-comments
//
// ----- LLM GUIDANCE -----
//
// Before invoking, EXPLICITLY ASK the user to confirm intent — e.g. "About to
// wipe the local dev comment store at <path>. This is local-only (prod is
// untouched). Proceed?" The permission prompt is a backstop, not consent.
//
// PREFER this script to `rm -rf .wrangler/...` by hand: it resolves the path
// correctly across the engine/content split, prints what it removes (audit
// trail), and refuses to delete anything that isn't the expected R2 state dir.
//
// ----- SAFETY LAYERS -----
//
//   1. Targets exactly `<contentRoot>/.wrangler/state/v3/r2` — no arguments,
//      no slug, nothing user-controllable feeds the path.
//   2. No-ops (exit 0) if that directory doesn't exist.
//   3. Prints a loud banner + the bucket dirs about to be removed BEFORE
//      deleting, so the conversation log / terminal shows the blast radius.
//   4. Interactive callers (TTY) get a type-"reset" confirmation backstop;
//      non-interactive callers proceed after the warning (consent path = the
//      in-conversation ask + the permission prompt).
// ============================================================================

import { existsSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";

const paths = resolveBlogPaths();

// Miniflare persists local bindings under `.wrangler/state/v3`; R2 (the
// comment + resolution store) sits in the `r2/` subdir. Wiping the whole
// `r2/` resets every local bucket plus the R2 durable-object metadata in one
// shot — the clean way to reset, since blobs and their index live separately.
const r2StateDir = join(paths.contentRoot, ".wrangler", "state", "v3", "r2");

// Safety 2: nothing to do.
if (!existsSync(r2StateDir)) {
  console.log(`Nothing to do: ${r2StateDir} does not exist.`);
  process.exit(0);
}

const entries = await readdir(r2StateDir);

// Safety 3: loud warning + audit trail.
const bar = "═".repeat(64);
console.log(`\n${bar}`);
console.log("  !!!  DESTRUCTIVE OPERATION (local dev data)  !!!");
console.log(bar);
console.log(`  About to permanently delete the local dev comment store:`);
console.log(`    ${r2StateDir}`);
for (const e of entries) console.log(`    └─ ${e}`);
console.log("");
console.log("  This is LOCAL ONLY — prod R2 is untouched. Reseed by");
console.log("  commenting again, or `bun run pull-comments` from prod.");
console.log(`${bar}\n`);

// Safety 4: interactive confirmation backstop.
if (process.stdin.isTTY) {
  const answer = prompt('Type "reset" to confirm wiping the local dev comment store:');
  if (answer?.trim() !== "reset") {
    console.error("Aborted — input did not match.");
    process.exit(1);
  }
}

await rm(r2StateDir, { recursive: true, force: true });
console.log(`Deleted ${r2StateDir}`);
