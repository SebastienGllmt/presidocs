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
// PWA files (proposal 06 §7 "Prod: bundle into dist/"):
//   - engine/client/sw.js         → dist/sw.js (with __SW_VERSION__ replaced)
//   - <content>/manifest.webmanifest → dist/manifest.webmanifest
//   - <content>/icons/*           → dist/icons/*
//   - dist/_headers gets `/sw.js → no-cache` appended (engine policy)
//
// Runs as part of `bun run build` (between `bun build` and the HTML
// strip). Idempotent; safe to re-run.

import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { buildAuthorMap } from "../shared/authorProfile.ts";
import { buildPublicPostVersionsMap } from "../shared/publicPostVersions.ts";

const paths = resolveBlogPaths();
const ROOT = paths.contentRoot;
const DIST = paths.distDir;
const ENGINE = paths.engineRoot;

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

// Author bylines: write the public author map the client byline fetches
// (`/assets/authors.json`, post path → {name, links, avatar}) and publish each
// author's avatar under its PUBLIC handle (`dist/assets/authors/<handle>.<ext>`)
// — never under the email, so the served byline can't re-leak the address the
// HTML strip removes. Dev produces the identical map/avatars from the same
// `buildAuthorMap`, so bylines match in dev and prod. See shared/authorProfile.ts.
async function copyAuthorAssets(): Promise<number> {
  const { map, avatars } = await buildAuthorMap(
    paths.postsDir,
    ROOT,
    (msg) => console.warn(msg),
  );

  const assetsDir = join(DIST, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(
    join(assetsDir, "authors.json"),
    JSON.stringify(map),
    "utf8",
  );

  const avatarEntries = Object.entries(avatars);
  if (avatarEntries.length > 0) {
    const dst = join(assetsDir, "authors");
    await mkdir(dst, { recursive: true });
    for (const [servedName, srcPath] of avatarEntries) {
      await cp(srcPath, join(dst, servedName));
    }
  }
  return avatarEntries.length;
}

// Public per-post last-updated date served at /assets/post-versions.json. The
// client byline fetches this and renders the date; we deliberately publish only
// the most recent builtAt (no hash, no per-build history) so this stays a
// human-readable freshness signal, distinct from the gated /post-version
// endpoint. Dev produces the identical file from the same `posts/versions.json`.
async function copyPublicPostVersions(): Promise<number> {
  const map = await buildPublicPostVersionsMap(paths.versionsJson);
  const assetsDir = join(DIST, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(
    join(assetsDir, "post-versions.json"),
    JSON.stringify(map),
    "utf8",
  );
  return Object.keys(map).length;
}

// PWA bundle: SW source (engine), manifest + icons (content), and the engine
// policy header for /sw.js (Cache-Control: no-cache so a deploy rolls out).
// See proposal 06 §7 for the engine/content split rationale.
async function copyPwaFiles(): Promise<{ sw: boolean; manifest: boolean; icons: number }> {
  const out = { sw: false, manifest: false, icons: 0 };

  // Engine-owned: the SW source. Substitute __SW_VERSION__ at copy time so
  // each deploy invalidates activate's cache reap. Bun's bundler doesn't
  // process sw.js (served as top-level /sw.js, not in the bundle graph), so
  // the rewrite happens here, not via Bun.build's `define`.
  const swSrc = join(ENGINE, "client/sw.js");
  if (await exists(swSrc)) {
    const swText = await Bun.file(swSrc).text();
    const version = Date.now().toString();
    await writeFile(
      join(DIST, "sw.js"),
      swText.replaceAll("__SW_VERSION__", version),
      "utf8",
    );
    out.sw = true;
  }

  // Content-owned: per-blog manifest. Missing → blog hasn't authored one yet;
  // the SW still works, the install prompt just won't fire on Chrome/Edge.
  const manifestSrc = join(ROOT, "manifest.webmanifest");
  if (await exists(manifestSrc)) {
    await cp(manifestSrc, join(DIST, "manifest.webmanifest"));
    out.manifest = true;
  }

  // Content-owned: per-blog icons.
  const iconsSrc = join(ROOT, "icons");
  if (await exists(iconsSrc)) {
    await mkdir(join(DIST, "icons"), { recursive: true });
    await cp(iconsSrc, join(DIST, "icons"), { recursive: true });
    out.icons = (await readdir(iconsSrc)).filter((n) => !n.startsWith(".")).length;
  }

  // Engine-owned policy: `Cache-Control: no-cache` on /sw.js. Append (not
  // overwrite) so a blog can add its own _headers rules later without losing
  // this one. Idempotent via the marker comment.
  if (out.sw) {
    await appendSwHeadersRule(join(DIST, "_headers"));
  }

  return out;
}

const SW_HEADERS_MARKER = "# presidocs: sw.js no-cache";
async function appendSwHeadersRule(headersPath: string): Promise<void> {
  let current = "";
  if (await exists(headersPath)) {
    current = await Bun.file(headersPath).text();
    if (current.includes(SW_HEADERS_MARKER)) return;
  }
  const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const block = `${sep}${SW_HEADERS_MARKER}\n/sw.js\n  Cache-Control: no-cache\n`;
  await writeFile(headersPath, current + block, "utf8");
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
  const avatarCount = await copyAuthorAssets();
  console.log(
    `  authors/ → dist/assets/authors.json + ${avatarCount} avatar(s)`,
  );
  const versionCount = await copyPublicPostVersions();
  console.log(
    `  posts/versions.json → dist/assets/post-versions.json (${versionCount} post(s))`,
  );
  const pwa = await copyPwaFiles();
  console.log(
    `  PWA: ${pwa.sw ? "sw.js + _headers" : "(no sw.js source)"}, ${
      pwa.manifest ? "manifest.webmanifest" : "(no manifest)"
    }, ${pwa.icons} icon(s)`,
  );
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
