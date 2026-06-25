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
//   bun authoring/r2Sync.ts pull <slug>            # prod R2 → local (comments + resolutions)
//   bun authoring/r2Sync.ts push <slug>            # local → prod R2 (resolutions only)
//   bun authoring/r2Sync.ts pull <slug> --local    # running dev server → local
//   bun authoring/r2Sync.ts push <slug> --local    # local → running dev server (resolutions)
//   bun authoring/r2Sync.ts seed <slug>            # local production-stamped blobs → running dev server
//
// `--local` bridges the RUNNING dev server instead of prod R2: since the
// dev/prod unification, dev-server comment writes land in Miniflare R2
// (`.wrangler/state/`), not in `generated/.comments-dev` — so comments left
// on localhost are invisible to the offline tools without this bridge. The
// one process that owns that store, live, is the dev server itself, so the
// bridge goes through its existing HTTP API (`/comments`, `/resolutions`)
// with a minted author-session JWT rather than opening Miniflare's SQLite
// state a second time. See proposals/56 and methodology → AI-assisted
// authoring. `--url` overrides the default `http://localhost:3000` (or
// `PRESIDOCS_DEV_URL`); non-localhost URLs are refused.
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
import { z } from "zod";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import {
  changeKey,
  postPrefix,
  resolutionKey,
  resolutionPrefix,
} from "../server/comments/store.ts";
import {
  ChangeList,
  CommentUsers,
  R2ListEntry,
  ResolutionList,
  type R2ListEntry as ListEntry,
} from "../shared/commentSchemas.ts";
import { createSessionToken } from "../server/auth/session.ts";
import { loadDevPostMetaIndex } from "../server/postMeta.dev.ts";
import { fsAdapter } from "../server/comments/fsAdapter.ts";

const R2List = z.array(R2ListEntry);

const WORKER = join(import.meta.dir, "r2SyncWorker.ts");

type Mode = "pull" | "push" | "seed";

type ParsedArgs = {
  mode: Mode;
  slug: string;
  local: boolean;
  url: string | null;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let local = false;
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--local") local = true;
    else if (arg === "--url") url = argv[++i] ?? "";
    else positional.push(arg);
  }
  const [mode, slug, ...rest] = positional;
  // `seed` is inherently a dev-server operation, so --url is valid there
  // without --local.
  const urlAllowed = local || mode === "seed";
  if (
    (mode !== "pull" && mode !== "push" && mode !== "seed") ||
    !slug ||
    rest.length > 0 ||
    (url !== null && (!urlAllowed || url === ""))
  ) {
    console.error(
      "Usage:\n" +
        "  bun authoring/r2Sync.ts pull <slug>            # prod R2 → local\n" +
        "  bun authoring/r2Sync.ts push <slug>            # local → prod R2 (resolutions)\n" +
        "  bun authoring/r2Sync.ts pull <slug> --local    # running dev server → local\n" +
        "  bun authoring/r2Sync.ts push <slug> --local    # local → running dev server\n" +
        "  bun authoring/r2Sync.ts seed <slug>            # local production-stamped blobs → running dev server\n" +
        "  (--local / seed also accept --url <http://localhost:PORT>)",
    );
    process.exit(1);
  }
  return { mode, slug, local, url };
}

// `ListEntry` is the inferred `R2ListEntry` shape (imported above) — the
// single source of truth shared with the worker that emits the listing.

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
  // Validate the listing rather than trusting it: a wrangler/edge hiccup that
  // returns an error page (or any non-array) is caught here instead of being
  // read as an empty bucket — which would look like "no comments" and
  // silently skip the mirror.
  const parsed = R2List.safeParse(await r.json());
  if (!parsed.success) {
    throw new Error(`list ${prefix} returned an unexpected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

// Pull loops used to fetch one blob per awaited round-trip; with hundreds of
// immutable change-objects that was minutes of pure latency. Cap how many
// fetches are in flight at once.
const PULL_CONCURRENCY = 24;

// Run `fn` over `items` with at most `limit` in flight.
// ponytail: fixed-size batches, not a sliding-window pool — one slow blob
// stalls its batch of `limit`; fine for the uniform small fetches here.
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
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
      await mapLimit(entries, PULL_CONCURRENCY, async (e) => {
        const isResolution = e.key.startsWith("resolutions/");
        // The R2 key carries a `//` (postPath starts with `/`); the local
        // fsAdapter normalizes that away, so mirror to the normalized path
        // it reads from.
        const dest = join(commentsDir, normalize(e.key));
        // Change blobs are content-addressed and immutable, so one already on
        // disk can't have changed — skip the fetch and just (re)stamp.
        // Resolutions are keyed by threadId and can be overwritten, so they
        // always refetch.
        if (isResolution || !(await Bun.file(dest).exists())) {
          const r = await fetch(`${base}/get?key=${encodeURIComponent(e.key)}`);
          if (!r.ok) throw new Error(`get ${e.key} failed: ${r.status}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length !== e.size) {
            throw new Error(
              `size mismatch for ${e.key}: got ${bytes.length}, want ${e.size}`,
            );
          }
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, bytes);
        }
        if (isResolution) {
          resolutions++;
        } else {
          await stampOrigin(dest, "production");
          comments++;
        }
      });
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

// ---------- Per-blob origin stamps ----------
//
// Each mirrored COMMENT blob gets a `<file>.bin.src` sidecar recording which
// live store it was born in ("production" | "localhost"). The rule exploits
// an asymmetry in the fences: comment blobs have no upward path (push is
// resolutions-only, and a prod tab's localStorage never holds localhost-
// authored changes), so a blob ever observed in prod was BORN in prod —
// `production` therefore always wins, and a `localhost` stamp is only an
// "observed nowhere else (yet)" claim, upgraded one-way if a later prod pull
// sees the blob. Order-independent and self-healing for blobs that were
// carried across stores by pre-migration localStorage history. Sidecars are
// invisible to the fsAdapter (its listings filter on `.bin`/`.json`) and as
// immutable as the blobs themselves. Resolutions aren't stamped — they're
// targeted by the push rule (push to every store whose pull found comments),
// never by birth origin. Read back by authoring/loadUnresolvedThreads.ts.
export async function stampOrigin(
  dest: string,
  origin: "production" | "localhost",
): Promise<void> {
  const sidecar = `${dest}.src`;
  if (origin === "localhost") {
    try {
      await readFile(sidecar); // already stamped (either value) → keep it
      return;
    } catch {
      // unstamped → fall through and write
    }
  }
  await writeFile(sidecar, origin);
}

// This slug's resolution envelopes on disk (`<threadId>.json` names), or []
// when the directory doesn't exist yet. Shared by both push modes.
async function listResolutionFiles(localResDir: string): Promise<string[]> {
  try {
    return (await readdir(localResDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
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

  const files = await listResolutionFiles(localResDir);
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

// ---------- `--local`: bridge the running dev server over HTTP ----------

// The dev (non-`__Host-`) session-cookie name — see server/auth/routes.ts
// (`SESSION_COOKIE_BASE`; the `__Host-` prefix is prod-only, gated on
// NODE_ENV === "production").
const DEV_SESSION_COOKIE = "blog-session";

// A minted dev token must never travel to a remote origin: it's signed with
// the operator's local dev secret and grants author power wherever that
// secret verifies. Exported for the unit test.
export function assertLocalDevUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid dev-server URL: ${raw}`);
  }
  // WHATWG URL keeps the brackets on an IPv6 hostname ("[::1]").
  const host = url.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
    throw new Error(
      `refusing non-localhost dev-server URL ${raw} — a minted dev session token must never be sent to a remote origin`,
    );
  }
  return url;
}

// Mint a dev-session cookie for an arbitrary userId/email pair. Used for
// the author session every `--local`/`seed` call rides on, and by `seed`
// for the per-reader sessions the own-folder PUT fence requires.
async function mintDevCookie(userId: string, email: string): Promise<string> {
  let token: string;
  try {
    token = await createSessionToken({
      userId,
      email,
      emailVerified: true,
      provider: "google",
    });
  } catch (err) {
    // getKeys() already explains the SESSION_SECRET requirement; add where
    // the CLI expects it to come from.
    throw new Error(
      `${(err as Error).message}\n(--local reads it from the content repo's .env — the same file ` +
        `the dev server loads. See .env.example.)`,
    );
  }
  return `${DEV_SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

// Mint an author session and verify the dev server is up and accepts it.
// Returns the base origin + the Cookie header value to send on every call.
//
// Auth model (proposals/56 §5.1): sessions are stateless HS256 JWTs; the
// author-only routes gate on `isPostAuthor`, which compares the session
// email against the post's `<meta name="author-email">`. Both this CLI and
// the dev server read SESSION_SECRET(S) from `process.env` — Bun autoloads
// the content repo's `.env` for each — so `createSessionToken` here mints a
// token the server verifies, with zero extra parsing. This grants nothing
// the dev operator doesn't already have (they hold the secret).
async function connectDevServer(
  slug: string,
  urlArg: string | null,
): Promise<{ base: string; cookie: string; authorEmail: string }> {
  const paths = resolveBlogPaths();
  const postPath = `/posts/${slug}`;
  const base = assertLocalDevUrl(
    urlArg ??
      process.env.PRESIDOCS_DEV_URL ??
      // The dev server's own default: `opts.port ?? Number(process.env.PORT
      // ?? 3000)` (createDevServer.ts) — reading the same PORT keeps the two
      // in step when a repo overrides it in `.env`.
      `http://localhost:${process.env.PORT ?? 3000}`,
  ).origin;

  // Author identity = the post's author-email; author power comes from the
  // email match in `isPostAuthor`, not from the userId (which only needs to
  // satisfy the `<provider>:<sub>` schema).
  const meta = (await loadDevPostMetaIndex(paths.postsDir)).get(postPath);
  if (!meta) {
    throw new Error(
      `no <meta name="author-email"> found for posts/${slug}.html — cannot mint an author session`,
    );
  }

  const cookie = await mintDevCookie(
    "google:presidocs-local-authoring",
    meta.authorEmail,
  );

  // Probe before doing any work: a crisp "not running" / "secret mismatch"
  // beats a confusing failure mid-listing. /auth/me returns the identity for
  // a valid session and JSON `null` for a rejected one.
  let probe: Response;
  try {
    probe = await fetch(`${base}/auth/me`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(
      `no dev server reachable at ${base} — start it first (bun run dev), or point --url at it`,
    );
  }
  if (!probe.ok || (await probe.json()) === null) {
    throw new Error(
      `the dev server at ${base} rejected the minted session — is it running against the same ` +
        `.env SESSION_SECRET this CLI just read? (Restart it if the secret changed.)`,
    );
  }
  return { base, cookie, authorEmail: meta.authorEmail };
}

async function localPull(slug: string, urlArg: string | null): Promise<void> {
  const paths = resolveBlogPaths();
  const postPath = `/posts/${slug}`;
  const commentsDir = join(paths.generatedDir, ".comments-dev");
  const { base, cookie } = await connectDevServer(slug, urlArg);
  const headers = { Cookie: cookie };
  const q = (params: Record<string, string>) =>
    new URLSearchParams(params).toString();

  console.error(`Pulling comments for ${postPath} from the dev server (${base})…`);

  // Mirror one fetched blob to the normalized path the fsAdapter reads (the
  // raw key carries a `//` because postPath starts with `/` — same
  // normalization the remote pull applies). Comment blobs get an origin
  // stamp (`localhost` is weak — it never downgrades a `production` one).
  async function mirror(
    key: string,
    bytes: Uint8Array,
    stamp: "production" | "localhost" | null,
  ): Promise<string> {
    const dest = join(commentsDir, normalize(key));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    if (stamp) await stampOrigin(dest, stamp);
    return dest;
  }

  async function getOk(path: string): Promise<Response> {
    const r = await fetch(`${base}${path}`, { headers });
    if (!r.ok) {
      throw new Error(`GET ${path} failed: ${r.status} ${await r.text()}`);
    }
    return r;
  }

  // Validate every listing shape rather than trusting it (same rationale as
  // the remote pull's R2List check): an error page read as an empty/odd list
  // must fail loudly, not silently skip the mirror.
  const users = CommentUsers.parse(
    await (await getOk(`/comments?${q({ post: postPath })}`)).json(),
  );

  let comments = 0;
  for (const user of users) {
    const entries = ChangeList.parse(
      await (await getOk(`/comments?${q({ post: postPath, user })}`)).json(),
    );
    // Change-objects are content-addressed and immutable, so one already on
    // disk can't have changed — skip its fetch and just refresh the (cheap)
    // origin stamp. The rest are fetched with bounded concurrency instead of
    // one serial round-trip each (844 blobs went from ~2.5 min to seconds).
    await mapLimit(entries, PULL_CONCURRENCY, async (e) => {
      const key = changeKey(postPath, user, e.hash);
      // Stamp what the dev store declares (seeded blobs carry `production`
      // provenance); an undeclared blob was born on this dev server.
      const stamp = e.origin ?? "localhost";
      const dest = join(commentsDir, normalize(key));
      if (await Bun.file(dest).exists()) {
        await stampOrigin(dest, stamp);
      } else {
        const r = await getOk(
          `/comments?${q({ post: postPath, user, change: e.hash })}`,
        );
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length !== e.size) {
          throw new Error(
            `size mismatch for change ${e.hash}: got ${bytes.length}, want ${e.size}`,
          );
        }
        await mirror(key, bytes, stamp);
      }
      comments++;
    });
  }

  const resolutionEntries = ResolutionList.parse(
    await (await getOk(`/resolutions?${q({ post: postPath })}`)).json(),
  );
  let resolutions = 0;
  for (const e of resolutionEntries) {
    const r = await getOk(
      `/resolutions?${q({ post: postPath, thread: e.threadId })}`,
    );
    await mirror(
      resolutionKey(postPath, e.threadId),
      new Uint8Array(await r.arrayBuffer()),
      null, // resolutions aren't stamped — see stampOrigin
    );
    resolutions++;
  }

  console.error(
    `Pulled ${comments} comment change-object(s) + ${resolutions} resolution(s) into ${commentsDir}.`,
  );
  if (comments === 0 && resolutions === 0) {
    console.error(`(No dev-server comments found for ${postPath}.)`);
  }
}

// PUT every local resolution envelope for the slug to the dev server
// (author-only route; `cookie` must be an author session). Returns the
// count pushed. Shared by `push --local` and `seed`.
async function putLocalResolutions(
  base: string,
  cookie: string,
  postPath: string,
  localResDir: string,
): Promise<number> {
  const files = await listResolutionFiles(localResDir);
  let pushed = 0;
  for (const file of files) {
    const threadId = file.slice(0, -".json".length);
    const bytes = await readFile(join(localResDir, file));
    const params = new URLSearchParams({ post: postPath, thread: threadId });
    const r = await fetch(`${base}/resolutions?${params}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: bytes,
    });
    if (!r.ok) {
      throw new Error(`put ${threadId} failed: ${r.status} ${await r.text()}`);
    }
    pushed++;
    console.error(`  pushed resolution ${threadId}`);
  }
  return pushed;
}

async function localPush(slug: string, urlArg: string | null): Promise<void> {
  const paths = resolveBlogPaths();
  const postPath = `/posts/${slug}`;
  const commentsDir = join(paths.generatedDir, ".comments-dev");
  const localResDir = join(commentsDir, normalize(resolutionPrefix(postPath)));

  const files = await listResolutionFiles(localResDir);
  if (files.length === 0) {
    console.error(`No local resolutions to push for ${postPath}.`);
    return;
  }

  const { base, cookie } = await connectDevServer(slug, urlArg);
  console.error(
    `Pushing ${files.length} resolution(s) for ${postPath} to the dev server (${base})…`,
  );
  const pushed = await putLocalResolutions(base, cookie, postPath, localResDir);
  console.error(
    `Pushed ${pushed} resolution(s) to the dev server (live for its browser clients on the next poll).`,
  );
}

// ---------- `seed`: local production-stamped blobs → the dev server ----------
//
// Restores the pre-migration "see prod comments on localhost" loop: after a
// prod `pull`, the production-stamped blobs in `.comments-dev` are PUT into
// the running dev server's store (with `origin=production` provenance, which
// the dev LIST then exposes and the comments UI badges). The `/comments` PUT
// fence is own-folder-only by design, so the seeder mints a session PER user
// folder — the userId satisfies the fence; the email is the author's on
// every minted session because it IS the author acting (and the trusted-
// owner rate-limit exemption applies, exactly as for the author's own
// browser PUTs — the limiter's threat model is external commenters, not the
// operator bulk-copying immutable reader blobs they already hold on disk).
// Resolutions are seeded too, so a thread resolved on prod doesn't reappear
// unresolved in the localhost browser. Idempotent: blobs the dev store
// already has with `production` provenance are skipped; present-but-
// unstamped ones are re-PUT, which upgrades their metadata in place.
async function seed(slug: string, urlArg: string | null): Promise<void> {
  const paths = resolveBlogPaths();
  const postPath = `/posts/${slug}`;
  const commentsDir = join(paths.generatedDir, ".comments-dev");
  const local = fsAdapter(commentsDir);
  const { base, cookie: authorCookie, authorEmail } = await connectDevServer(
    slug,
    urlArg,
  );
  const q = (params: Record<string, string>) =>
    new URLSearchParams(params).toString();

  console.error(`Seeding ${postPath} production comments into the dev server (${base})…`);

  let seeded = 0;
  let alreadyStamped = 0;
  for (const user of await local.listUsers(postPath)) {
    const prodEntries = (await local.listChanges(postPath, user)).filter(
      (e) => e.origin === "production",
    );
    if (prodEntries.length === 0) continue;

    // What the dev store already holds with provenance — the author
    // session may list any user's folder.
    const devRes = await fetch(`${base}/comments?${q({ post: postPath, user })}`, {
      headers: { Cookie: authorCookie },
    });
    if (!devRes.ok) {
      throw new Error(
        `list dev changes for ${user} failed: ${devRes.status} ${await devRes.text()}`,
      );
    }
    const devStamped = new Set(
      ChangeList.parse(await devRes.json())
        .filter((e) => e.origin === "production")
        .map((e) => e.hash),
    );

    const toPut = prodEntries.filter((e) => !devStamped.has(e.hash));
    alreadyStamped += prodEntries.length - toPut.length;
    if (toPut.length === 0) continue;

    const userCookie = await mintDevCookie(user, authorEmail);
    for (const e of toPut) {
      const bytes = await local.getChange(postPath, user, e.hash);
      if (!bytes) continue; // LIST/GET disagreed mid-run; skip defensively
      const r = await fetch(
        `${base}/comments?${q({ post: postPath, user, change: e.hash, origin: "production" })}`,
        {
          method: "PUT",
          headers: { Cookie: userCookie, "Content-Type": "application/octet-stream" },
          body: bytes as BodyInit,
        },
      );
      if (!r.ok) {
        throw new Error(
          `seed put ${user}/${e.hash} failed: ${r.status} ${await r.text()}`,
        );
      }
      seeded++;
    }
    console.error(`  seeded ${toPut.length} blob(s) for ${user}`);
  }

  const resolutions = await putLocalResolutions(
    base,
    authorCookie,
    postPath,
    join(commentsDir, normalize(resolutionPrefix(postPath))),
  );

  console.error(
    `Seeded ${seeded} comment blob(s) (${alreadyStamped} already present with provenance) ` +
      `+ ${resolutions} resolution(s). Reload the post on localhost to see them.`,
  );
  if (seeded === 0 && alreadyStamped === 0) {
    console.error(
      `(No production-stamped blobs in ${commentsDir} for ${postPath} — run \`pull ${slug}\` first.)`,
    );
  }
}

async function main() {
  const { mode, slug, local, url } = parseArgs(process.argv.slice(2));
  if (mode === "seed") await seed(slug, url);
  else if (mode === "pull") await (local ? localPull(slug, url) : pull(slug));
  else await (local ? localPush(slug, url) : push(slug));
}

// Guarded so the unit test can import parseArgs/assertLocalDevUrl without
// running the CLI.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
