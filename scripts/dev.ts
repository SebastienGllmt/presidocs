// Dev wrapper for a content repo. Spawns `bun --hot index.ts` and
// hard-restarts it when files change that bun's --hot can't reach or
// that require a regen step first.
//
// Why this wrapper exists: bun's --hot intentionally excludes node_modules
// from its watch registry, so engine edits via the `link:presidocs` symlink
// don't trigger reloads. It also can't re-run the post-routes codegen, so
// adding/removing a post in posts/ requires a manual restart. This wrapper
// folds both into one rule: "if any of {engine, posts/, authors/} changes,
// regen post-routes and respawn the server."
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

const POST_ROUTES_GEN = ["bun", "engine/generate/post-routes.ts"];
const SERVER_CMD = ["bun", "--hot", "index.ts"];

let child: Subprocess | null = null;
let restarting = false;
let pending: Timer | null = null;
let queued = false;

async function regenPostRoutes(): Promise<boolean> {
  const proc = spawn(POST_ROUTES_GEN, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[dev] post-routes codegen failed (exit ${code})`);
    return false;
  }
  return true;
}

let stoppingIntentionally = false;

async function startChild(): Promise<void> {
  // onExit (not `await proc.exited`) because with inherited stdio the
  // exited promise can stay pending — onExit fires reliably either way.
  const proc = spawn(SERVER_CMD, {
    stdout: "inherit",
    stderr: "inherit",
    onExit: (subprocess, exitCode, _signalCode, _error) => {
      if (subprocess !== child) return; // superseded by a restart
      if (stoppingIntentionally) return;
      console.error(`[dev] child server exited unexpectedly (code ${exitCode})`);
      process.exit(exitCode ?? 1);
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

async function restart(reason: string): Promise<void> {
  if (restarting) {
    queued = true;
    return;
  }
  restarting = true;
  try {
    console.log(`[dev] ${reason} → restarting`);
    await stopChild();
    if (!(await regenPostRoutes())) return;
    await startChild();
  } finally {
    restarting = false;
    if (queued) {
      queued = false;
      void restart("queued change");
    }
  }
}

function scheduleRestart(reason: string): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void restart(reason);
  }, 100);
}

function watchDir(dir: string, label: string): FSWatcher | null {
  try {
    return watch(dir, { recursive: true }, (_event, file) => {
      if (!file) return;
      // Skip generator outputs to avoid restart loops.
      if (file.includes(".generated") || file.includes(".comments-dev")) return;
      // Skip transient editor swap files.
      if (file.startsWith(".") || file.endsWith("~")) return;
      scheduleRestart(`${label}: ${file}`);
    });
  } catch (err) {
    console.warn(`[dev] could not watch ${dir}: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  if (!(await regenPostRoutes())) process.exit(1);
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
