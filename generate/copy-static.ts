// Copies build-time static artifacts into `dist/` so Cloudflare's
// Static Assets binding can serve them in prod alongside the bundled
// HTML/JS/CSS. Static here means "doesn't change at runtime" —
// the output of an offline build step or a vendored binary asset.
// Truly dynamic content (user comments) lives in R2, not here.
//
// What we copy:
//   - `generated/<slug>/manifest.json` — narration timing manifest
//   - `generated/<slug>/*.mp3`         — pre-rendered audio
//   - `node_modules/@automerge/automerge/dist/automerge.wasm` — the
//     Automerge WASM core the comments client lazy-loads.
//
// What we deliberately don't copy (lives in `generated/` but is
// build-internal, not served):
//   - `generated/.tts-cache/`    — TTS cache buckets
//   - `generated/.comments-dev/` — dev-only fs-adapter comment blobs
//   - `generated/<slug>/cache-keys.json` — GC index for the TTS cache
//
// Runs as part of `bun run build` (between `bun build` and the HTML
// strip). Idempotent; safe to re-run.

import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";

const paths = resolveBlogPaths();
const ROOT = paths.contentRoot;
const DIST = paths.distDir;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Walks `generated/` and copies only the per-post audio + manifest
// files. Walking manually (rather than `cp -r` with a filter) keeps
// the include rule legible and avoids the surprising "filter returns
// false on a directory means we don't recurse into it" semantics of
// `fs.cp`.
async function copyGeneratedArtifacts(): Promise<number> {
  const src = join(ROOT, "generated");
  const dst = join(DIST, "generated");
  if (!(await exists(src))) {
    console.warn(
      `  generated/ does not exist — skipping (run \`bun run generate\` first if you want audio in the build)`,
    );
    return 0;
  }
  let copied = 0;
  const topEntries = await readdir(src, { withFileTypes: true });
  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    // Skip build-internal hidden dirs (.tts-cache, .comments-dev, …).
    if (top.name.startsWith(".")) continue;

    const slugSrc = join(src, top.name);
    const slugDst = join(dst, top.name);
    const slugEntries = await readdir(slugSrc, { withFileTypes: true });
    let createdDst = false;
    for (const f of slugEntries) {
      if (!f.isFile()) continue;
      const keep = f.name === "manifest.json" || f.name.endsWith(".mp3");
      if (!keep) continue;
      if (!createdDst) {
        await mkdir(slugDst, { recursive: true });
        createdDst = true;
      }
      await cp(join(slugSrc, f.name), join(slugDst, f.name));
      copied++;
    }
  }
  return copied;
}

async function copyAutomergeWasm(): Promise<boolean> {
  // Engine-owned vendored asset — resolves into the engine's node_modules even
  // when the build runs from an external content repo.
  const src = paths.automergeWasm;
  const dst = join(DIST, "assets", "automerge.wasm");
  if (!(await exists(src))) {
    console.warn(`  ${relative(ROOT, src)} not found — skipping WASM copy`);
    return false;
  }
  await mkdir(join(DIST, "assets"), { recursive: true });
  await cp(src, dst);
  return true;
}

async function main(): Promise<void> {
  console.log("Copying static assets into dist/…");
  if (!(await exists(DIST))) {
    console.warn(
      `  dist/ does not exist — run \`bun build\` first; skipping.`,
    );
    return;
  }
  const audioCount = await copyGeneratedArtifacts();
  console.log(`  generated/ → dist/generated/ (${audioCount} file(s))`);
  const wasmOk = await copyAutomergeWasm();
  if (wasmOk) console.log(`  automerge.wasm → dist/assets/automerge.wasm`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
