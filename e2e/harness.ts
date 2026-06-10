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

import { spawn, spawnSync, type Subprocess } from "bun";
import { chromium, devices, type Browser, type BrowserContext, type BrowserType } from "playwright";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { createSessionToken } from "../server/auth/session.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";

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

/**
 * Like `mintSessionCookie`, but signs the session with a post's *author*
 * email so the server-authoritative `isPostAuthor` check passes and the UI
 * runs in author mode (the unresolved-count badge, the per-card thread-id
 * chip, author-resolve). The email is read from the post's
 * `<meta name="author-email">` so the test isn't pinned to one blog. The
 * `userId` stays unique per call for store isolation — `isPostAuthor` keys on
 * email, not id, so a distinct id is still "the author".
 */
export async function mintAuthorSessionCookie(
  blogDir: string,
  slug: string,
  uniq: string,
): Promise<{ name: string; value: string }> {
  const html = readFileSync(join(blogDir, "posts", `${slug}.html`), "utf8");
  // Use the shared, parser-based extractor (server/postMeta.ts) — same answer
  // the real auth path uses — rather than re-implementing a `<meta …>` regex.
  const email = parseAuthorEmailFromHtml(html);
  if (!email) throw new Error(`no <meta name="author-email"> in posts/${slug}.html`);
  const devVars = readFileSync(join(blogDir, ".dev.vars"), "utf8");
  const secret = devVars.match(/^SESSION_SECRET\s*=\s*"?([^"\n]+)"?/m);
  if (!secret) throw new Error(`SESSION_SECRET not found in ${blogDir}/.dev.vars`);
  process.env.SESSION_SECRET = secret[1]!.trim();
  const value = await createSessionToken({
    userId: `google:e2e-author-${uniq}`,
    email,
    emailVerified: true,
    name: "E2E Author",
    provider: "google",
  });
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

/**
 * A representative mobile device for the mobile e2e tier. Playwright's device
 * descriptors carry a full emulation profile — a small device-width viewport,
 * a mobile user-agent, `deviceScaleFactor`, and crucially `isMobile: true` +
 * `hasTouch: true`. That last pair is what a bare narrow `viewport` does NOT
 * give you: a real **coarse pointer with no hover** (`@media (pointer: coarse)`
 * / `(hover: none)`) and touch input (`page.tap()`, touch events) — the surface
 * the blog's mobile-only UI uses (the hide-all FAB hidden ≥1100px, the
 * tap-to-popover comment cards). Pixel 5 is a Chromium-default descriptor, which
 * matches this Chromium-only harness (`isMobile` is a Chromium feature).
 *
 * Use it via `newMobileContext`; contrast it against the default desktop
 * `browser.newContext({ viewport: { width: 1400, height: 900 } })` the other
 * tiers use.
 */
export const MOBILE_DEVICE = devices["Pixel 5"];

/**
 * A touch-enabled mobile browser context (see {@link MOBILE_DEVICE}). Spread
 * `extra` last to override any field (e.g. `{ locale }`) without losing the
 * device profile.
 */
export function newMobileContext(
  browser: Browser,
  extra: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  return browser.newContext({ ...MOBILE_DEVICE, ...extra });
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
 * a real blog's path (a content repo's own e2e script does this); otherwise
 * the default target is the engine's own `templates/content-repo`, made
 * bootable on first use by {@link ensureFixtureBlog}. The fixture default is
 * what lets the engine's CI run the e2e tiers without any private content
 * repo (proposal 22 §3).
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
  return ensureFixtureBlog();
}

/**
 * Materialize the engine's `templates/content-repo` as a bootable blog and
 * return its path. The committed template is content-only; what a real blog
 * gets from its one-time setup (README → Setup) the fixture creates lazily,
 * idempotently, and only inside the template directory (every product is
 * already in the template's .gitignore):
 *
 * - `engine` → `../..` — the symlink posts use for `../engine/client/...`
 *   asset references. Relative, so a moved checkout keeps working.
 * - `node_modules/` via `bun link` (registers the engine as linkable — the
 *   same one-time registration the README asks of a real blog) + `bun install`
 *   (resolves `"presidocs": "link:presidocs"` plus gsap/wrangler). Run only
 *   when `node_modules/presidocs` is missing, so steady-state calls cost two
 *   existsSync checks.
 * - `.env` + `.dev.vars` with a generated SESSION_SECRET — the dev server
 *   reads `.env` (Bun auto-loads it), `mintSessionCookie` reads `.dev.vars`,
 *   and the pair must agree for minted sessions to verify. An existing
 *   secret is reused so the two files never diverge across partial runs.
 *   `.env` also carries a fixture SITE_URL (RFC 2606-reserved host): a
 *   SITE_URL-less `bun run build` fails the post audit by design (no
 *   injected meta description), and setting it makes the fixture exercise
 *   the full discovery pipeline — structured data, feeds, share cards —
 *   the way every deployable repo does. Build-time only; the worker tiers
 *   serve from 127.0.0.1, so the baked SITE_HOST also exercises the
 *   off-canonical-host noindex path for free.
 *
 * CI can front-load the slow first install with `bun run e2e:fixture`.
 */
export function ensureFixtureBlog(): string {
  return ensureFixture("content-repo", { SITE_URL: "https://fixture.example.com" });
}

/**
 * The PRIVATE fixture (`templates/private-content-repo`) — same bootstrap,
 * plus `BLOG_PRIVATE=1` so the build runs the discovery inversion +
 * `audit-private.ts` (methodology → Private blogs). Driven only by its own
 * tier (`e2e/privateBlog.ts`); never the `resolveBlogDir()` default.
 */
export function ensurePrivateFixtureBlog(): string {
  return ensureFixture("private-content-repo", {
    SITE_URL: "https://private-fixture.example.com",
    BLOG_PRIVATE: "1",
  });
}

function ensureFixture(templateName: string, env: Record<string, string>): string {
  const engineRoot = resolve(dirname(import.meta.dir)); // e2e/ -> engine root
  const fixtureDir = join(engineRoot, "templates", templateName);

  if (!existsSync(join(fixtureDir, "engine"))) {
    symlinkSync("../..", join(fixtureDir, "engine"));
  }

  if (!existsSync(join(fixtureDir, "node_modules", "presidocs"))) {
    const link = spawnSync(["bun", "link"], { cwd: engineRoot });
    if (link.exitCode !== 0) {
      throw new Error(`\`bun link\` in ${engineRoot} failed:\n${link.stderr.toString()}`);
    }
    const install = spawnSync(["bun", "install"], { cwd: fixtureDir });
    if (install.exitCode !== 0) {
      throw new Error(`\`bun install\` in ${fixtureDir} failed:\n${install.stderr.toString()}`);
    }
  }

  const envFile = join(fixtureDir, ".env");
  const devVarsFile = join(fixtureDir, ".dev.vars");
  if (!existsSync(envFile) || !existsSync(devVarsFile)) {
    const existing = [envFile, devVarsFile]
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, "utf8").match(/^SESSION_SECRET\s*=\s*"?([^"\n]+)"?/m)?.[1])
      .find(Boolean);
    const secret = existing ?? randomBytes(48).toString("base64");
    for (const f of [envFile, devVarsFile]) {
      if (!existsSync(f)) {
        writeFileSync(f, `# generated by e2e/harness.ts ensureFixture()\nSESSION_SECRET=${secret}\n`);
      }
    }
  }
  // Converge an older bootstrap's `.env` (append-only, so a hand-edited value
  // is never overwritten).
  for (const [key, value] of Object.entries(env)) {
    if (!new RegExp(`^${key}\\s*=`, "m").test(readFileSync(envFile, "utf8"))) {
      writeFileSync(envFile, readFileSync(envFile, "utf8") + `${key}=${value}\n`);
    }
  }

  return fixtureDir;
}

function join(...parts: string[]): string {
  return resolve(...parts);
}

/**
 * The blog's post slugs, sorted, optionally including the `_`-prefixed
 * dev-only fixtures (`build-html` never deploys those, but the dev server
 * serves them — that's how `_figjourneys` exercises otherwise-unused figures).
 */
export function postSlugs(blogDir: string, opts: { devOnly?: boolean } = {}): string[] {
  return readdirSync(join(blogDir, "posts"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -".html".length))
    .filter((slug) => (opts.devOnly ?? true) || !slug.startsWith("_"))
    .sort();
}

/**
 * The deployable post the single-post tests drive (first slug alphabetically,
 * dev-only fixtures excluded) — the content-agnostic replacement for a
 * hardcoded slug, so the same test runs against any content repo.
 */
export function firstPostSlug(blogDir: string): string {
  const slug = postSlugs(blogDir, { devOnly: false })[0];
  if (!slug) throw new Error(`no posts in ${blogDir}/posts`);
  return slug;
}

/**
 * Posts whose source HTML loads at least one of the blog's own figure modules
 * (`<script type="module" src="../figures/….ts">`) — the posts the figure
 * gates (conformance / height / contrast) must drive. Detected from the
 * *source* markup, not the runtime registry, so a bundling or registration
 * regression on a figure-bearing post fails the gate loudly instead of
 * vacuously skipping it. Includes `_`-prefixed dev-only posts: `_figjourneys`
 * exists precisely to put otherwise-unembedded figures under the gates.
 */
export function figurePostSlugs(blogDir: string): string[] {
  return postSlugs(blogDir).filter((slug) => {
    const html = readFileSync(join(blogDir, "posts", `${slug}.html`), "utf8");
    const { document } = parseHTML(html);
    return [...document.querySelectorAll('script[type="module"]')].some((s) =>
      (s.getAttribute("src") ?? "").startsWith("../figures/"),
    );
  });
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
export async function startBlogServer(blogDirOverride?: string): Promise<BlogServer> {
  const blogDir = blogDirOverride ?? resolveBlogDir();
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
export async function startWranglerServer(blogDirOverride?: string): Promise<BlogServer> {
  const blogDir = blogDirOverride ?? resolveBlogDir();

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
