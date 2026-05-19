// Post-build step: rewrites every HTML file under `dist/` to
//   1. Remove generation-only tags (see `shared/stripServedHtml.ts`).
//   2. Inject the Cloudflare Web Analytics beacon if
//      `CF_ANALYTICS_TOKEN` is set in the environment (see
//      `shared/injectAnalytics.ts`).
// Runs in-place. Idempotent — running twice produces the same output.
//
// Dev (`bun --hot index.ts`) does NOT apply either transform — the
// full HTML is served on localhost and no analytics beacon fires.
// The dev/prod difference is harmless: stripped tags are inert at
// runtime (player loads from the pre-generated manifest; server-side
// author check reads source HTML rather than served HTML), and
// localhost views aren't something the analytics dashboard should
// count anyway.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { stripServedHtml } from "../shared/stripServedHtml.ts";
import { injectCloudflareAnalytics } from "../shared/injectAnalytics.ts";

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
  const analyticsToken = (process.env.CF_ANALYTICS_TOKEN ?? "").trim();
  const stages = ["author-email + narration + PLS strip"];
  if (analyticsToken) stages.push("Cloudflare Analytics beacon");
  else stages.push("(no CF_ANALYTICS_TOKEN — skipping analytics inject)");
  console.log(`Post-build HTML rewrite: ${stages.join(", ")}…`);

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
    let after = stripServedHtml(before);
    if (analyticsToken) {
      after = injectCloudflareAnalytics(after, analyticsToken);
    }
    if (after === before) continue;
    await writeFile(file, after, "utf8");
    const delta = before.length - after.length;
    totalSaved += delta;
    touched++;
    console.log(
      `  ${relative(ROOT, file)} — ${delta > 0 ? `${delta} bytes removed` : `${-delta} bytes added`}`,
    );
  }
  console.log(
    `Done. Net ${totalSaved} bytes across ${touched}/${files.length} file(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
