// Real-browser e2e harness for presidocs blogs.
//
// The two surfaces stay deliberately separate (see methodology → Testing
// layout): happy-dom covers the JS-visible API surface in *.test.ts files;
// this harness covers the substrate — real CSS layout, the computed
// accessibility tree, real Popover/anchor positioning, the Service Worker
// lifecycle — things happy-dom cannot reach. It is NOT a parallel runner:
// `bun test` is still the only runner. e2e files are named `*.e2e.ts` so the
// default `bun test` glob (which matches `.test.`/`.spec.`) never picks them
// up; they run only when pathed explicitly. That keeps the unit run Chrome-free
// and fast while the browser tests run on demand / in their own CI lane.
//
// IMPORTANT — one file per `bun test` process: the `test:e2e` script loops and
// invokes `bun test` once per file (`for f in ./e2e/*.e2e.ts; …`), NOT a single
// `bun test ./e2e/*.e2e.ts` glob. Each file's `beforeAll` owns a browser + a dev
// server; within one `bun test` invocation the files overlap (their setup/
// teardown interleave), so several browsers and dev servers run at once and the
// later files hang/time out. A process per file forces full teardown (the OS
// reaps everything on exit) between files. Each file passes in isolation; only
// the all-in-one-invocation form collides. (Run a single file the same way:
// `bun test ./e2e/<file>.e2e.ts`.)
//
// Why the `playwright` *library* and not `@playwright/test`: one runner, no
// second framework, and `@playwright/test`'s worker model is flaky under Bun.
// Driving `chromium` from inside `bun:test` is stable and keeps assertions in
// the same `expect()` the rest of the suite uses.
//
// Why the system Chrome instead of a downloaded Chromium: a real installed
// Chrome is what readers actually use, and it sidesteps the ~150 MB per-CI
// browser download. Point at a specific binary with PRESIDOCS_E2E_CHROME, or
// let it probe the usual locations / fall back to Playwright's `chrome`
// channel.

import { spawn, type Subprocess } from "bun";
import { chromium, type Browser, type BrowserType } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { createSessionToken } from "../server/auth/session.ts";

/**
 * Mint a session cookie the dev server will accept. `nodejs_compat` maps the
 * blog's `.dev.vars` SESSION_SECRET into the dev server's `process.env`, so
 * signing with that same secret produces a token its verifier honours — i.e.
 * a real logged-in session without driving the OAuth redirect (which we
 * deliberately don't automate — it needs real IdP credentials and its failure
 * modes are loud in dev; see methodology → Testing layout). Sets
 * `process.env.SESSION_SECRET` as a side
 * effect so `createSessionToken` (which reads it) signs with the right key.
 *
 * Test isolation works on two axes. Across runs: `startBlogServer` points the
 * dev server at a throwaway Miniflare state dir (PRESIDOCS_DEV_STATE_DIR), so
 * the comment store starts empty every run and nothing accumulates or leaks
 * into the developer's interactive store. Within a run: threads are keyed per
 * (post, user), so a fresh, unique `userId` each call keeps concurrent
 * tests/engines sharing that one server from seeing each other's threads
 * (`uniq` forces a distinct identity per engine/run). The user is deliberately
 * NOT the post author, so the author-aggregator (which would surface every
 * user's threads) doesn't kick in.
 */
export async function mintSessionCookie(
  blogDir: string,
  uniq: string,
): Promise<{ name: string; value: string }> {
  const devVars = readFileSync(join(blogDir, ".dev.vars"), "utf8");
  const m = devVars.match(/^SESSION_SECRET\s*=\s*"?([^"\n]+)"?/m);
  if (!m) throw new Error(`SESSION_SECRET not found in ${blogDir}/.dev.vars`);
  process.env.SESSION_SECRET = m[1]!.trim();
  const value = await createSessionToken({
    userId: `google:e2e-${uniq}`,
    email: `e2e-${uniq}@example.com`,
    emailVerified: true,
    name: "E2E Seed",
    provider: "google",
  });
  // Dev (http://localhost) uses the bare cookie name — the `__Host-` prefix
  // requires Secure, which dev doesn't set (server/auth/routes.ts).
  return { name: "blog-session", value };
}

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Resolve a Chrome executable, or null to fall back to the `chrome` channel. */
function resolveChrome(): string | null {
  const fromEnv = process.env.PRESIDOCS_E2E_CHROME;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`PRESIDOCS_E2E_CHROME points at a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/**
 * Launch the system Chrome. `--no-sandbox` is on by default because this is a
 * throwaway test browser and many CI/WSL/container hosts can't use the
 * sandbox; set PRESIDOCS_E2E_SANDBOX=1 to keep it.
 */
export async function launchChrome(): Promise<Browser> {
  const browser: BrowserType = chromium;
  const args = process.env.PRESIDOCS_E2E_SANDBOX ? [] : ["--no-sandbox"];
  const executablePath = resolveChrome();
  return executablePath
    ? browser.launch({ executablePath, args })
    : browser.launch({ channel: "chrome", args });
}

/** Pick a free TCP port by binding to :0 and reading the assigned port back. */
async function freePort(): Promise<number> {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  await srv.stop(true);
  if (port == null) throw new Error("could not allocate an ephemeral port");
  return port;
}

/**
 * Locate the content repo to drive. The engine itself has no posts, so e2e
 * always runs against a content repo's dev server. Set PRESIDOCS_E2E_BLOG to
 * an absolute path; otherwise probe sibling directories of the engine for one
 * that looks like a blog (has index.ts + posts/).
 */
export function resolveBlogDir(): string {
  const fromEnv = process.env.PRESIDOCS_E2E_BLOG;
  if (fromEnv) {
    const abs = resolve(fromEnv);
    if (!existsSync(join(abs, "index.ts"))) {
      throw new Error(`PRESIDOCS_E2E_BLOG is not a content repo (no index.ts): ${abs}`);
    }
    return abs;
  }
  const engineRoot = resolve(dirname(import.meta.dir)); // e2e/ -> engine root
  const siblings = dirname(engineRoot);
  for (const name of ["personal-blog", "blog"]) {
    const candidate = join(siblings, name);
    if (existsSync(join(candidate, "index.ts")) && existsSync(join(candidate, "posts"))) {
      return candidate;
    }
  }
  throw new Error(
    "No content repo found. Set PRESIDOCS_E2E_BLOG to a blog directory (the " +
      "engine has no posts of its own to serve).",
  );
}

function join(...parts: string[]): string {
  return resolve(...parts);
}

export interface BlogServer {
  baseURL: string;
  stop(): Promise<void>;
}

/**
 * Boot a content repo's dev server (`bun run dev` → the engine's dev wrapper →
 * `bun --hot index.ts`) on an ephemeral port and wait until it answers.
 *
 * Note on scope: the plain dev server does NOT register the Service Worker
 * (swRegister.ts gates on `__BUN_DEV__`), so SW-lifecycle tests need a built +
 * `wrangler dev` target instead — see the proposal. This boot is for the
 * layout / a11y / popover tier that the fast dev server serves identically to
 * prod.
 */
export async function startBlogServer(): Promise<BlogServer> {
  const blogDir = resolveBlogDir();
  const port = await freePort();
  const baseURL = `http://localhost:${port}`;

  // Throwaway Miniflare state dir for this run. The dev server (via
  // PRESIDOCS_DEV_STATE_DIR → getPlatformProxy persist path) backs its local
  // R2 comment store here instead of the content repo's shared
  // `.wrangler/state/`, so UI-seeded comments are isolated from the
  // developer's interactive `bun run dev` store and don't accumulate across
  // runs. Removed on stop(). See methodology.md → Dev server wrapper.
  const stateDir = await mkdtemp(resolve(tmpdir(), "presidocs-e2e-"));

  const proc: Subprocess = spawn(["bun", "run", "dev"], {
    cwd: blogDir,
    env: { ...process.env, PORT: String(port), PRESIDOCS_DEV_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr as ReadableStream).text();
      throw new Error(`dev server exited early (code ${proc.exitCode}):\n${err}`);
    }
    try {
      const res = await fetch(`${baseURL}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }

  return {
    baseURL,
    async stop() {
      // SIGTERM the wrapper; its shutdown handler kills the --hot child.
      proc.kill("SIGTERM");
      await proc.exited;
      // Drop this run's throwaway Miniflare state. `force` so a never-written
      // dir (server failed to boot) doesn't turn teardown into a failure.
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * Boot the content repo's PRODUCTION worker via `wrangler dev` (workerd/Miniflare
 * locally) on an ephemeral port — the tier the plain dev server can't cover. Use
 * this to exercise `createWorker.ts` itself: the static-asset fall-through,
 * `applyRangeSupport`, `withSecurityHeaders`, and the stable-episode route's
 * internal `env.ASSETS.fetch` + header rewrite (proposals/32 §10 prod gap).
 *
 * Runs a full `bun run build` first (the worker serves from `dist/` + imports the
 * `.generated/` maps). **That build is the normal pipeline and rewrites source
 * posts/*.html (managed <script> tags) + posts/versions.json** — expected; run
 * this on an ephemeral/CI checkout, or `git checkout` those afterward. Set
 * `PRESIDOCS_E2E_SKIP_BUILD=1` to reuse an existing fresh `dist/` (faster local
 * iteration; skips the source-rewrite).
 *
 * Requires the blog to have generated audio on disk (same precondition as the
 * browser subscribe tier) so there's an episode to serve.
 */
export async function startWranglerServer(): Promise<BlogServer> {
  const blogDir = resolveBlogDir();

  if (!process.env.PRESIDOCS_E2E_SKIP_BUILD) {
    const build = spawn(["bun", "run", "build"], {
      cwd: blogDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await build.exited) !== 0) {
      const err = await new Response(build.stderr as ReadableStream).text();
      throw new Error(`\`bun run build\` failed before wrangler dev:\n${err}`);
    }
  }

  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;

  // Local mode (the wrangler default): bindings (R2, rate limiters, analytics)
  // are simulated by Miniflare, secrets come from `.dev.vars`; no Cloudflare
  // auth or network needed.
  const proc: Subprocess = spawn(
    ["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"],
    {
      cwd: blogDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // First boot may unpack workerd, so allow generous headroom.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr as ReadableStream).text();
      throw new Error(`wrangler dev exited early (code ${proc.exitCode}):\n${err}`);
    }
    try {
      const res = await fetch(`${baseURL}/`, { signal: AbortSignal.timeout(2000) });
      if (res.status > 0) break;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }

  return {
    baseURL,
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}
