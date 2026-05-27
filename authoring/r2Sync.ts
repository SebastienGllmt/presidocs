#!/usr/bin/env bun
//
// Mirror a post's production comments between R2 and the local
// `.comments-dev` store, so the offline authoring tools
// (`exportAnnotations`, `resolveThreads`, `listUnresolved`) — which only
// ever read/write the local store — can operate on real reader comments.
//
// Why this exists: there is no `wrangler r2 object sync`, and the v4 REST
// API can't list objects. The only way to reach R2 with the author's
// existing `wrangler deploy` login (no separate S3 credential) is a Worker
// bound to the bucket. So we briefly run `authoring/r2SyncWorker.ts` via
// `wrangler dev --remote` — which binds COMMENTS to the *production*
// bucket — talk to it over 127.0.0.1, and kill it. Running the merge
// locally is fine: the dumb-edge-server rule is a production constraint;
// localhost tooling may be as smart as it likes (methodology.md).
//
// Usage:
//   bun authoring/r2Sync.ts pull <slug>   # R2 → local (comments + resolutions)
//   bun authoring/r2Sync.ts push <slug>   # local → R2 (resolutions only)
//
// `pull` is additive/overwrite and never deletes: comment change-objects
// are immutable (content-addressed) and resolutions only grow, so mirroring
// down is safe. It is scoped to the one slug — other posts' local data is
// untouched. `push` uploads only this slug's resolution envelopes (the only
// thing the author writes back); reader comment blobs are never pushed.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import {
  postPrefix,
  resolutionKey,
  resolutionPrefix,
} from "../server/comments/store.ts";

const WORKER = join(import.meta.dir, "r2SyncWorker.ts");

type Mode = "pull" | "push";

function parseArgs(argv: string[]): { mode: Mode; slug: string } {
  const [mode, slug, ...rest] = argv;
  if ((mode !== "pull" && mode !== "push") || !slug || rest.length > 0) {
    console.error(
      "Usage:\n" +
        "  bun authoring/r2Sync.ts pull <slug>   # R2 → local\n" +
        "  bun authoring/r2Sync.ts push <slug>   # local → R2 (resolutions)",
    );
    process.exit(1);
  }
  return { mode, slug };
}

type ListEntry = { key: string; size: number; uploaded: string };

// --- Read the content repo's R2 binding out of its wrangler config. ----
// We don't hardcode the bucket name; it's per-blog. The binding *name* we
// then re-expose to the throwaway worker is always COMMENTS (we own the
// generated config), regardless of what the content repo called it.
async function resolveBucket(contentRoot: string): Promise<{
  bucketName: string;
  compatibilityDate: string;
}> {
  // Bun imports .toml/.json/.jsonc natively. Try each wrangler config name.
  let cfg: any = null;
  for (const name of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
    const path = join(contentRoot, name);
    if (await Bun.file(path).exists()) {
      cfg = (await import(path)).default;
      break;
    }
  }
  if (!cfg) {
    throw new Error(`no wrangler config found under ${contentRoot}`);
  }
  const buckets: Array<{ binding: string; bucket_name: string }> =
    cfg.r2_buckets ?? [];
  if (buckets.length === 0) {
    throw new Error("wrangler config declares no [[r2_buckets]]");
  }
  const chosen =
    buckets.find((b) => b.binding === "COMMENTS") ?? buckets[0]!;
  return {
    bucketName: chosen.bucket_name,
    // Reuse the content repo's compat date so the preview matches prod.
    compatibilityDate: cfg.compatibility_date ?? "2026-05-19",
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Boot the throwaway worker against the *remote* bucket and return a base
// URL + a teardown fn. Always pair the call with the returned `stop()` in a
// finally — a leaked `wrangler dev --remote` holds a remote preview open.
async function startWorker(
  contentRoot: string,
  bucketName: string,
  compatibilityDate: string,
): Promise<{ base: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const dir = await mkdtempConfig(bucketName, compatibilityDate);

  const proc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "--remote",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--config",
      join(dir, "wrangler.json"),
    ],
    {
      cwd: contentRoot, // so wrangler finds the OAuth login + .wrangler state
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const log: string[] = [];
  void pump(proc.stdout, log);
  void pump(proc.stderr, log);

  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    proc.kill();
    await proc.exited;
    await rm(dir, { recursive: true, force: true });
  };

  // Poll readiness. Remote preview upload can take a while on a cold run.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.killed) {
      throw new Error(`wrangler exited early:\n${log.join("")}`);
    }
    try {
      const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { base, stop };
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  await stop();
  throw new Error(
    `worker did not become ready within 90s. wrangler output:\n${log.join("")}`,
  );
}

async function pump(stream: ReadableStream<Uint8Array>, into: string[]) {
  const dec = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) into.push(dec.decode(value, { stream: true }));
  }
}

async function mkdtempConfig(
  bucketName: string,
  compatibilityDate: string,
): Promise<string> {
  const dir = join(tmpdir(), `presidocs-r2sync-${Date.now()}-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const config = {
    name: "presidocs-r2sync",
    main: WORKER,
    compatibility_date: compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    r2_buckets: [{ binding: "COMMENTS", bucket_name: bucketName }],
  };
  await writeFile(join(dir, "wrangler.json"), JSON.stringify(config, null, 2));
  return dir;
}

async function listPrefix(base: string, prefix: string): Promise<ListEntry[]> {
  const r = await fetch(`${base}/list?prefix=${encodeURIComponent(prefix)}`);
  if (!r.ok) throw new Error(`list ${prefix} failed: ${r.status}`);
  return (await r.json()) as ListEntry[];
}

async function pull(slug: string): Promise<void> {
  const paths = resolveBlogPaths();
  const postPath = `/posts/${slug}`;
  const commentsDir = join(paths.generatedDir, ".comments-dev");
  const { bucketName, compatibilityDate } = await resolveBucket(
    paths.contentRoot,
  );

  console.error(`Pulling comments for ${postPath} from R2 (${bucketName})…`);
  const { base, stop } = await startWorker(
    paths.contentRoot,
    bucketName,
    compatibilityDate,
  );
  try {
    let comments = 0;
    let resolutions = 0;
    for (const prefix of [postPrefix(postPath), resolutionPrefix(postPath)]) {
      const entries = await listPrefix(base, prefix);
      for (const e of entries) {
        const r = await fetch(`${base}/get?key=${encodeURIComponent(e.key)}`);
        if (!r.ok) throw new Error(`get ${e.key} failed: ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length !== e.size) {
          throw new Error(
            `size mismatch for ${e.key}: got ${bytes.length}, want ${e.size}`,
          );
        }
        // The R2 key carries a `//` (postPath starts with `/`); the local
        // fsAdapter normalizes that away, so mirror to the normalized path
        // it reads from.
        const dest = join(commentsDir, normalize(e.key));
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        if (e.key.startsWith("resolutions/")) resolutions++;
        else comments++;
      }
    }
    console.error(
      `Pulled ${comments} comment change-object(s) + ${resolutions} resolution(s) into ${commentsDir}.`,
    );
    if (comments === 0 && resolutions === 0) {
      console.error(`(No production comments found for ${postPath}.)`);
    }
  } finally {
    await stop();
  }
}

async function push(slug: string): Promise<void> {
  const paths = resolveBlogPaths();
  const postPath = `/posts/${slug}`;
  const commentsDir = join(paths.generatedDir, ".comments-dev");
  const localResDir = join(
    commentsDir,
    normalize(resolutionPrefix(postPath)),
  );

  let files: string[];
  try {
    files = (await readdir(localResDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") files = [];
    else throw err;
  }
  if (files.length === 0) {
    console.error(`No local resolutions to push for ${postPath}.`);
    return;
  }

  const { bucketName, compatibilityDate } = await resolveBucket(
    paths.contentRoot,
  );
  console.error(
    `Pushing ${files.length} resolution(s) for ${postPath} to R2 (${bucketName})…`,
  );
  const { base, stop } = await startWorker(
    paths.contentRoot,
    bucketName,
    compatibilityDate,
  );
  try {
    let pushed = 0;
    for (const file of files) {
      const threadId = file.slice(0, -".json".length);
      const bytes = await readFile(join(localResDir, file));
      const key = resolutionKey(postPath, threadId);
      const r = await fetch(`${base}/put?key=${encodeURIComponent(key)}`, {
        method: "PUT",
        body: bytes,
      });
      if (!r.ok) {
        throw new Error(`put ${key} failed: ${r.status} ${await r.text()}`);
      }
      pushed++;
      console.error(`  pushed ${threadId}`);
    }
    console.error(`Pushed ${pushed} resolution(s) to R2.`);
  } finally {
    await stop();
  }
}

async function main() {
  const { mode, slug } = parseArgs(process.argv.slice(2));
  if (mode === "pull") await pull(slug);
  else await push(slug);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
