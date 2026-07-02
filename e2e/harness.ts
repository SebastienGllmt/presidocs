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
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { parseHTML } from "linkedom";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { relative, resolve, dirname } from "node:path";
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
 * the default target is a fixture *materialized into a scratch dir outside the
 * repo* by {@link ensureFixtureBlog} (template tracked files + the committed
 * `e2e/fixture-content/` overlay). The fixture default is what lets the
 * engine's CI run the e2e tiers without any private content repo (proposal 22
 * §3), and materializing off-repo is what keeps `git status` clean across a
 * full e2e run (nothing bootstraps or builds inside `templates/`).
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
 * The public fixture blog, materialized into a scratch dir (see
 * {@link materializeFixture}) and returned as an absolute path. Byte-identical
 * to what {@link ensurePrivateFixtureBlog} does, minus the private posture.
 * CI can front-load the slow first install with `bun run e2e:fixture`.
 */
export function ensureFixtureBlog(): string {
  return materializeFixture("blog", {
    SITE_URL: "https://fixture.example.com",
    // A published build (SITE_URL set) hard-fails audit-own-license.ts without a
    // declared content license; CODE_LICENSE silences its companion warning.
    // The append-only convergence loop retrofits an existing fixture .env.
    CONTENT_LICENSE: "CC-BY-4.0",
    CODE_LICENSE: "MIT",
  });
}

/**
 * The PRIVATE fixture — the SAME public template materialized with the private
 * overlay (`e2e/fixture-content/private-blog/`), `BLOG_PRIVATE=1`, and the
 * structural `--private` build/deploy scripts (see {@link materializeFixture}
 * step 5). That mix runs the discovery inversion + `audit-private.ts`
 * (methodology → Private blogs). Driven only by its own tier
 * (`e2e/privateBlog.ts`); never the `resolveBlogDir()` default.
 */
export function ensurePrivateFixtureBlog(): string {
  return materializeFixture("private-blog", {
    SITE_URL: "https://private-fixture.example.com",
    BLOG_PRIVATE: "1",
    // See ensureFixtureBlog: audit-own-license.ts hard-fails a published build with
    // no CONTENT_LICENSE; CODE_LICENSE silences the companion warning.
    CONTENT_LICENSE: "CC-BY-4.0",
    CODE_LICENSE: "MIT",
  });
}

type FixtureKind = "blog" | "private-blog";

/**
 * Scratch root for materialized fixtures: `PRESIDOCS_E2E_FIXTURE_ROOT`
 * override, else `~/.cache/presidocs-e2e/<first 8 hex of sha256(engineRoot)>/`
 * (D1). The hash keys multiple engine checkouts apart; XDG cache is the right
 * home for regenerable install state — `os.tmpdir()` was rejected because a
 * reboot/reaper wipe would force a full `bun install` re-run every time.
 */
export function fixtureRoot(): string {
  const override = process.env.PRESIDOCS_E2E_FIXTURE_ROOT;
  if (override) return resolve(override);
  const engineRoot = resolve(dirname(import.meta.dir)); // e2e/ -> engine root
  const key = createHash("sha256").update(engineRoot).digest("hex").slice(0, 8);
  return join(homedir(), ".cache", "presidocs-e2e", key);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Relative paths of every file under `root` (recursive), or [] if absent. */
function listFilesRel(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(root, abs));
    }
  };
  walk(root);
  return out;
}

/**
 * Materialize a bootable fixture blog into a scratch dir outside the engine
 * repo and return its absolute path. This replaces the old in-place
 * `templates/` bootstrap (the thing 1.4 kills): nothing here writes inside
 * `templates/`, so a full `bun run test:e2e*` leaves `git status` clean by
 * construction.
 *
 * The source is always the PUBLIC template `templates/content-repo` (D3 — even
 * the private fixture builds from it) UNION the kind's committed overlay
 * `e2e/fixture-content/<kind>/` (overlay wins on collision). Every real-blog
 * setup product a copied repo makes — the `engine` symlink, `node_modules`, a
 * generated `.env`/`.dev.vars` secret — the materializer creates lazily in the
 * scratch dir instead. Concurrency: the wrangler tiers run sequentially (CI
 * steps / `&&` chains), so no locking is needed.
 */
/**
 * Per-process memo: a fixture is materialized ONCE per `bun test` process, and
 * every later `resolveBlogDir()` in that process reuses it. This is what
 * "always-fresh source" means — fresh per materialization run, where the test
 * process is the run (matching the old idempotent `ensureFixture`). It is NOT a
 * staleness short-circuit: a genuinely new run (a new process, e.g. the G6
 * second `test:e2e:sw`) starts with an empty memo and re-copies from source,
 * resetting a prior build's in-place `posts/*.html` rewrites. Memoizing also
 * keeps a re-copy from firing mid-run under the live `bun --hot` dev server —
 * the harness's cookie-minting beforeAll calls `resolveBlogDir()` a second time
 * while the server is watching the fixture's files.
 */
const materializedFixtures = new Map<FixtureKind, string>();

function materializeFixture(kind: FixtureKind, env: Record<string, string>): string {
  const memo = materializedFixtures.get(kind);
  if (memo) return memo;

  const engineRoot = resolve(dirname(import.meta.dir)); // e2e/ -> engine root
  const dir = join(fixtureRoot(), kind);
  mkdirSync(dir, { recursive: true });

  // 1. SOURCE SET. `git ls-files` is the copy filter: it never lists gitignored
  //    residue (node_modules/dist/generated/…) and it tracks template file
  //    deletions for the stale-file sweep. Path-strip the template prefix, then
  //    union the overlay (overlay wins). Overlay is walked off disk so an
  //    uncommitted overlay edit still reaches the next materialization.
  const lsFiles = spawnSync(["git", "-C", engineRoot, "ls-files", "-z", "templates/content-repo"], {
    cwd: engineRoot,
  });
  if (lsFiles.exitCode !== 0) {
    throw new Error(
      `\`git ls-files templates/content-repo\` failed (not a git checkout?):\n${lsFiles.stderr.toString()}\n` +
        `Set PRESIDOCS_E2E_BLOG to a real content repo to bypass fixture materialization.`,
    );
  }
  const templatePrefix = "templates/content-repo/";
  const sources = new Map<string, string>(); // fixture-relative path -> absolute source
  for (const path of lsFiles.stdout.toString().split("\0").filter(Boolean)) {
    sources.set(path.slice(templatePrefix.length), join(engineRoot, path));
  }
  const overlayRoot = join(engineRoot, "e2e", "fixture-content", kind);
  for (const rel of listFilesRel(overlayRoot)) {
    sources.set(rel, join(overlayRoot, rel)); // overlay wins on collision
  }

  // 2. Stale-file sweep + always-copy. `.fixture-manifest.json` records the rel
  //    paths the previous run copied; delete the ones that dropped out of the
  //    source set (a template/overlay file was removed), then ALWAYS copy the
  //    full new set — always-fresh source is the point (a prior build's managed
  //    `<script>`-tag rewrites in posts/*.html get reset every run). Only
  //    manifest-listed paths are ever deleted, so gitignored products in `dir`
  //    (node_modules, dist, .generated, .wrangler, .env, .dev.vars, bun.lock)
  //    survive untouched.
  const manifestPath = join(dir, ".fixture-manifest.json");
  const prev: string[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  const next = [...sources.keys()].sort();
  const nextSet = new Set(next);
  for (const rel of prev) {
    if (!nextSet.has(rel)) rmSync(join(dir, rel), { force: true });
  }
  for (const [rel, src] of sources) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");

  // 3. engine symlink — ABSOLUTE target (the scratch dir is outside the repo, so
  //    a relative `../..` wouldn't resolve). Relink if a moved checkout left it
  //    pointing elsewhere.
  const engineLink = join(dir, "engine");
  let linkOk = false;
  if (isSymlink(engineLink)) {
    try {
      linkOk = readlinkSync(engineLink) === engineRoot;
    } catch {
      linkOk = false;
    }
    if (!linkOk) unlinkSync(engineLink);
  }
  if (!linkOk) symlinkSync(engineRoot, engineLink);

  // 4. node_modules via `bun link` (registers the engine as linkable) +
  //    `bun install` (resolves `"presidocs": "link:presidocs"` plus
  //    gsap/wrangler). Guarded on `node_modules/presidocs`, so steady-state
  //    calls cost one existsSync.
  if (!existsSync(join(dir, "node_modules", "presidocs"))) {
    const link = spawnSync(["bun", "link"], { cwd: engineRoot });
    if (link.exitCode !== 0) {
      throw new Error(`\`bun link\` in ${engineRoot} failed:\n${link.stderr.toString()}`);
    }
    const install = spawnSync(["bun", "install"], { cwd: dir });
    if (install.exitCode !== 0) {
      throw new Error(`\`bun install\` in ${dir} failed:\n${install.stderr.toString()}`);
    }
  }

  // 5. Private posture is STRUCTURAL, not env-only (the 1.1 blocker fix): patch
  //    the copied public package.json so build/deploy carry --private. Re-applied
  //    every run because step 2 re-copies the public package.json each time.
  if (kind === "private-blog") {
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.scripts.build = "bun engine/generate/build.ts --private";
    pkg.scripts.deploy = "bun engine/generate/deploy.ts --private";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  // 6. .env + .dev.vars with a generated SESSION_SECRET — the dev server reads
  //    `.env` (Bun auto-loads it), `mintSessionCookie` reads `.dev.vars`, and
  //    the pair must agree for minted sessions to verify. An existing secret is
  //    reused so the two files never diverge across partial runs. `.env` also
  //    carries a fixture SITE_URL (RFC 2606-reserved host) so the build
  //    exercises the full discovery pipeline the way every deployable repo does.
  const envFile = join(dir, ".env");
  const devVarsFile = join(dir, ".dev.vars");
  if (!existsSync(envFile) || !existsSync(devVarsFile)) {
    const existing = [envFile, devVarsFile]
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, "utf8").match(/^SESSION_SECRET\s*=\s*"?([^"\n]+)"?/m)?.[1])
      .find(Boolean);
    const secret = existing ?? randomBytes(48).toString("base64");
    for (const f of [envFile, devVarsFile]) {
      if (!existsSync(f)) {
        writeFileSync(f, `# generated by e2e/harness.ts materializeFixture()\nSESSION_SECRET=${secret}\n`);
      }
    }
  }
  // Converge an older materialization's `.env` (append-only, so a hand-edited
  // value is never overwritten).
  for (const [key, value] of Object.entries(env)) {
    if (!new RegExp(`^${key}\\s*=`, "m").test(readFileSync(envFile, "utf8"))) {
      writeFileSync(envFile, readFileSync(envFile, "utf8") + `${key}=${value}\n`);
    }
  }

  materializedFixtures.set(kind, dir);
  return dir;
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
 * `.generated/` maps). For the fixture default that build runs inside the scratch
 * materialization, so it mutates nothing tracked (1.5 build-once, mutate-nothing).
 * Only when `PRESIDOCS_E2E_BLOG` points at a real repo does the build rewrite that
 * repo's source posts/*.html (managed <script> tags) + posts/versions.json in
 * place — D6, documented not fixed; `git checkout` those afterward. Set
 * `PRESIDOCS_E2E_SKIP_BUILD=1` to reuse an existing fresh `dist/` — the build-once
 * mechanism the `test:e2e:wrangler` script threads across the csp/links/prod tiers.
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

  // Full narration tracks are served from R2, not dist, so the
  // prod Worker (createWorker.ts → env.AUDIO) needs them in Miniflare's local R2.
  // Seed it from generated/ on disk before booting wrangler dev, into the SAME
  // default local state dir wrangler dev uses below (cwd=blogDir, no
  // --persist-to). Auto-discovers the AUDIO bucket from the blog's wrangler.toml;
  // a graceful no-op for a blog without the binding.
  const seed = spawn(["bun", "engine/generate/upload-audio-r2.ts", "--local"], {
    cwd: blogDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await seed.exited) !== 0) {
    const err = await new Response(seed.stderr as ReadableStream).text();
    throw new Error(`audio R2 seed failed before wrangler dev:\n${err}`);
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
