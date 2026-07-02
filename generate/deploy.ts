// Engine-owned deploy orchestrator (methodology → Deploy unit; the "Deploy:
// `bun run deploy`" line). Companion to `generate/build.ts` — the 9-stage deploy
// ordering contract, previously an `&&` string in each content repo's
// `package.json`, now lives here once. Consumers shrink to
// `"deploy": "bun engine/generate/deploy.ts"`.
//
// The private posture drops the announce stages (publish-notify snapshot/notify,
// websub-ping) exactly as templates/private-content-repo/package.json:7
// documents — announcing posts is the opposite of a capability-URL blog's job.
//
// `--dry-run`: skips every stage with external side effects (R2 writes,
// webhooks, hub ping) and passes `--dry-run` to `wrangler deploy`. All audits +
// the full build still run.

import { resolveBlogPaths, type BlogPaths } from "../shared/blogPaths.ts";
import { isPrivateBlog } from "../shared/blogPrivacy.ts";
import { runBuild, runStage, type Stage, type StageContext } from "./build.ts";

// Mirrors the §1b chain; --bucket dropped everywhere (auto-discovered from
// wrangler.toml's AUDIO binding, upload-audio-r2.ts:20–26).
export const DEPLOY_STAGES: readonly Stage[] = [
  { name: "audit-deps", script: "generate/audit-deps.ts" },
  { name: "audit-licenses", script: "generate/audit-licenses.ts" },
  { name: "verify-narration", script: "generate/verify-narration.ts" },
  { name: "build", run: (c) => runBuild(c.paths, { private: c.private }) },
  {
    name: "upload-audio-r2",
    script: "generate/upload-audio-r2.ts",
    args: () => ["--remote"],
    when: (c) => !c.dryRun,
  },
  {
    name: "publish-notify --snapshot",
    script: "generate/publish-notify.ts",
    args: () => ["--snapshot"],
    when: (c) => !c.private && !c.dryRun,
  },
  {
    name: "wrangler deploy",
    command: (c) => ["wrangler", "deploy", ...(c.dryRun ? ["--dry-run"] : [])],
  },
  {
    name: "websub-ping",
    script: "generate/websub-ping.ts",
    when: (c) => !c.private && !c.dryRun,
  },
  {
    name: "publish-notify --notify",
    script: "generate/publish-notify.ts",
    args: () => ["--notify"],
    when: (c) => !c.private && !c.dryRun,
  },
];

export type DeployOpts = { private?: boolean; dryRun?: boolean };

/** Throws on first stage failure — `&&` semantics. */
export async function runDeploy(
  paths: BlogPaths = resolveBlogPaths(),
  opts: DeployOpts = {},
): Promise<void> {
  const ctx: StageContext = {
    paths,
    private: opts.private ?? isPrivateBlog(),
    dryRun: opts.dryRun ?? false,
  };
  for (const stage of DEPLOY_STAGES) {
    if (stage.when && !stage.when(ctx)) continue;
    await runStage(stage, ctx);
  }
}

if (import.meta.main) {
  runDeploy(undefined, { dryRun: process.argv.includes("--dry-run") }).catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
