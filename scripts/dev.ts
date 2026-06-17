// Dev wrapper for a content repo. Spawns `bun --hot index.ts` and
// hard-restarts it when files change that bun's --hot can't reach or
// that require a regen step first.
//
// Why this wrapper exists: bun's --hot intentionally excludes node_modules
// from its watch registry, so engine edits via the `link:presidocs` symlink
// don't trigger reloads. It also can't re-run the post-routes codegen, so
// ADDING/REMOVING a post in posts/ requires regen + a manual restart (the
// generated `.generated/postRoutes.ts` is a static import — a new route only
// mounts once that module is re-evaluated).
//
// What this wrapper deliberately does NOT restart for: a *content* edit to an
// existing post. The post HTML is a static `Bun.HTMLBundle` in the child's
// import graph, so bun's own HMR re-bundles it in single-digit ms with the
// server still up. Hard-restarting on a content edit was pure harm: it tore
// down the server for the kill→regen→respawn window, which (a) dropped the HMR
// socket → forced full reload + scroll jump, (b) served `_bun/client/*.js`
// chunks with an empty MIME type mid-restart, and (c) refused connections if
// the browser navigated in that window. So posts/ changes are classified:
// regen post-routes and compare — if the route set is unchanged (a content
// edit; the codegen is idempotent) we leave the running server alone and let
// bun HMR do its thing; only an add/remove/rename triggers a restart.
//
// In-project edits to index.ts / worker.ts / etc. still go through bun's
// fast HMR in the child — the wrapper only handles cross-boundary changes.
//
// Usage (from a content repo): `bun presidocs/scripts/dev.ts`

import { spawn, type Subprocess } from "bun";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();
const enginePkg = resolve(cwd, "node_modules/presidocs");
const postsDir = resolve(cwd, "posts");
const authorsDir = resolve(cwd, "authors");
// The codegen output bun statically imports. Comparing it before/after a regen
// tells us whether a posts/ change altered the route SET (add/remove/rename →
// restart) or was a content-only edit (byte-identical → let bun HMR handle it).
const postRoutesFile = resolve(cwd, ".generated/postRoutes.ts");

const POST_ROUTES_GEN = ["bun", "engine/generate/post-routes.ts"];
const SERVER_CMD = ["bun", "--hot", "index.ts"];

let child: Subprocess | null = null;
let restarting = false;
let pending: Timer | null = null;
let queued = false;
// Sources of changes coalesced into the current debounce window. Engine/authors
// changes always force a restart (bun HMR can't see node_modules edits, and the
// per-post author/version chrome is injected at bundle time from files bun
// doesn't track in the post's import graph); posts changes are classified by
// whether the route set moved.
const pendingSources = new Set<"engine" | "authors" | "posts">();

async function readPostRoutes(): Promise<string> {
  try {
    return await Bun.file(postRoutesFile).text();
  } catch {
    return "";
  }
}

type RegenResult = "changed" | "unchanged" | "failed";

// Regenerate the route table and report whether it actually moved. Idempotent
// by construction (generate/post-routes.ts sorts its entries), so a content
// edit yields byte-identical output → "unchanged".
async function regenPostRoutes(): Promise<RegenResult> {
  const before = await readPostRoutes();
  const proc = spawn(POST_ROUTES_GEN, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[dev] post-routes codegen failed (exit ${code})`);
    return "failed";
  }
  const after = await readPostRoutes();
  return before === after ? "unchanged" : "changed";
}

let stoppingIntentionally = false;
// Crash-loop guard: if the child dies unexpectedly we respawn it (so a
// transient module-eval failure during a mid-edit save self-heals instead of
// leaving "can't connect to localhost:3000"), but bail out loudly if it can't
// stay up — a persistent crash must not become an invisible respawn storm.
const crashTimestamps: number[] = [];
const CRASH_WINDOW_MS = 10_000;
const CRASH_LIMIT = 5;

async function startChild(): Promise<void> {
  // onExit (not `await proc.exited`) because with inherited stdio the
  // exited promise can stay pending — onExit fires reliably either way.
  const proc = spawn(SERVER_CMD, {
    stdout: "inherit",
    stderr: "inherit",
    onExit: (subprocess, exitCode, _signalCode, _error) => {
      if (subprocess !== child) return; // superseded by a restart
      if (stoppingIntentionally) return;
      const now = Date.now();
      while (crashTimestamps.length && now - crashTimestamps[0]! > CRASH_WINDOW_MS) {
        crashTimestamps.shift();
      }
      crashTimestamps.push(now);
      if (crashTimestamps.length > CRASH_LIMIT) {
        console.error(
          `[dev] child server crashed ${crashTimestamps.length}× in ${CRASH_WINDOW_MS / 1000}s — giving up (last exit ${exitCode}). Fix the error above and re-run \`bun run dev\`.`,
        );
        process.exit(exitCode ?? 1);
      }
      console.error(`[dev] child server exited unexpectedly (code ${exitCode}) — respawning`);
      void startChild();
    },
  });
  child = proc;
}

async function stopChild(): Promise<void> {
  if (!child) return;
  stoppingIntentionally = true;
  try {
    child.kill("SIGTERM");
    await child.exited;
    child = null;
  } finally {
    stoppingIntentionally = false;
  }
}

async function reconcile(reason: string): Promise<void> {
  if (restarting) {
    queued = true;
    return;
  }
  restarting = true;
  // Snapshot + clear this window's change sources; events that land mid-pass
  // repopulate the set and are handled by the queued re-run below.
  const sources = new Set(pendingSources);
  pendingSources.clear();
  try {
    // Regen FIRST, with the server still up. A failed codegen (e.g. an agent
    // mid-write left posts/ momentarily unparseable) must never leave us with a
    // stopped child and "can't connect to localhost:3000" — keep the running
    // server and let the next save retry.
    const regen = await regenPostRoutes();
    if (regen === "failed") return;
    const mustRestart =
      sources.has("engine") || sources.has("authors") || regen === "changed";
    if (!mustRestart) {
      // Only content edits to existing posts in this window: bun's own HMR has
      // already re-bundled the affected post(s) with the server still up. A
      // restart here would just drop the HMR socket and reload the page for no
      // reason.
      console.log(`[dev] ${reason} → bun HMR (no restart)`);
      return;
    }
    console.log(`[dev] ${reason} → restarting`);
    await stopChild();
    await startChild();
  } finally {
    restarting = false;
    if (queued) {
      queued = false;
      void reconcile("queued change");
    }
  }
}

function scheduleReconcile(reason: string): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void reconcile(reason);
  }, 100);
}

function watchDir(
  dir: string,
  label: "engine" | "posts" | "authors",
): FSWatcher | null {
  try {
    return watch(dir, { recursive: true }, (_event, file) => {
      if (!file) return;
      // Skip any path with a dot-prefixed segment (generator outputs like
      // .generated/.comments-dev, runtime state like .wrangler, editor
      // dotfiles) or a node_modules segment, at ANY depth — not just the top
      // level. The depth matters when a blog lives inside the watched engine
      // tree (the e2e fixture at templates/content-repo): its own Miniflare
      // state writes under <engine>/templates/content-repo/.wrangler would
      // otherwise read as engine changes and restart-loop the server.
      const segments = file.split(/[\\/]/);
      if (segments.some((s) => s.startsWith(".") || s === "node_modules")) return;
      // Skip transient editor swap files.
      if (file.endsWith("~")) return;
      pendingSources.add(label);
      scheduleReconcile(`${label}: ${file}`);
    });
  } catch (err) {
    console.warn(`[dev] could not watch ${dir}: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  if ((await regenPostRoutes()) === "failed") process.exit(1);
  await startChild();

  const watchers: FSWatcher[] = [];
  for (const [dir, label] of [
    [enginePkg, "engine"],
    [postsDir, "posts"],
    [authorsDir, "authors"],
  ] as const) {
    const w = watchDir(dir, label);
    if (w) watchers.push(w);
  }

  console.log(`[dev] watching engine + posts + authors; child server up`);

  const shutdown = async () => {
    for (const w of watchers) w.close();
    await stopChild();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
