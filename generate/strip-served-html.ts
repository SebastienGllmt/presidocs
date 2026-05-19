// Post-build step: rewrites every HTML file under `dist/` to remove
// generation-only tags (see `shared/stripServedHtml.ts` for the spec).
// Runs in-place. Idempotent — running twice produces the same output.
//
// Dev (`bun --hot index.ts`) does NOT apply this strip — the full
// HTML is served on localhost. The dev/prod difference is harmless:
// the stripped tags are inert at runtime (the player loads from the
// pre-generated manifest, and the server-side author check reads
// source HTML rather than served HTML), so behavior is identical
// either way.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { stripServedHtml } from "../shared/stripServedHtml.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

async function walkHtml(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...await walkHtml(full));
    } else if (ent.isFile() && ent.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log("Stripping author-email + narration + PLS from served HTML…");
  const files = await walkHtml(DIST);
  if (files.length === 0) {
    console.warn(
      `  No HTML files found under ${relative(ROOT, DIST)} — did you run \`bun build\` first?`,
    );
    return;
  }
  let totalSaved = 0;
  let touched = 0;
  for (const file of files) {
    const before = await readFile(file, "utf8");
    const after = stripServedHtml(before);
    if (after.length === before.length) continue;
    await writeFile(file, after, "utf8");
    const saved = before.length - after.length;
    totalSaved += saved;
    touched++;
    console.log(`  ${relative(ROOT, file)} — ${saved} bytes`);
  }
  console.log(
    `Done. ${totalSaved} bytes removed across ${touched}/${files.length} file(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
