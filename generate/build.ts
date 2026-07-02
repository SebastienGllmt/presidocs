// Engine-owned build orchestrator (methodology → Deploy unit; the "Build:
// `bun run build`" line). The 14–15-stage ordering contract used to live only as
// an `&&` string hand-copied into each content repo's `package.json` (three
// drifting copies). It now lives here, once, as an explicit stage list, and each
// consumer's `package.json` shrinks to `"build": "bun engine/generate/build.ts"`.
//
// Design: subprocess-per-stage, NOT in-process imports. Each `generate/*.ts`
// stage already runs as its own `bun` process today (module-level
// `resolveBlogPaths()` at import, `process.exit()` on failure). Spawning
// `bun <stage>.ts` per stage is byte-neutral by construction and keeps every
// stage independently CLI-invokable for debugging (`bun engine/generate/post-meta.ts`).
// Same rationale as `generate/generate-all.ts`.

import { join } from "node:path";
import { resolveBlogPaths, type BlogPaths } from "../shared/blogPaths.ts";
import { isPrivateBlog } from "../shared/blogPrivacy.ts";

export type StageContext = {
  paths: BlogPaths;
  /** Posture, resolved ONCE per run from isPrivateBlog(process.env) (BLOG_PRIVATE). */
  private: boolean;
  /** Deploy-only; always false for build. */
  dryRun: boolean;
};

export type Stage = { name: string; when?: (ctx: StageContext) => boolean } & (
  | { script: string; args?: (ctx: StageContext) => string[] | Promise<string[]> } // bun <engineRoot>/<script>
  | { command: (ctx: StageContext) => string[] } // external binary (wrangler), PATH-prefixed
  | { run: (ctx: StageContext) => Promise<void> } // in-process composite (deploy's build step)
);

// Replaces the shell glob `./index.html ./privacy.html ./posts/*.html`.
// Exported for the unit test (§2.6 e); not part of the consumer contract.
export async function buildHtmlEntries({ paths }: StageContext): Promise<string[]> {
  const entries = [join(paths.contentRoot, "index.html")];
  const privacy = join(paths.contentRoot, "privacy.html");
  if (await Bun.file(privacy).exists()) entries.push(privacy); // live has one; templates until 1.3 don't
  const posts = [...new Bun.Glob("*.html").scanSync({ cwd: paths.postsDir, absolute: true })].sort(); // MUST sort: shell glob expansion is lexicographic; entry order feeds Bun.build
  return [...entries, ...posts];
}

// Mirrors the §1a chain column-for-column; posture branches are `when`.
export const BUILD_STAGES: readonly Stage[] = [
  { name: "audit-license", script: "generate/audit-license.ts" },
  { name: "post-meta", script: "generate/post-meta.ts" },
  { name: "post-versions", script: "generate/post-versions.ts" },
  // Live-blog stage folded in (1.3): harmless on episode-less repos — writes an
  // empty .generated/episodeAudio.ts map (episode-audio.ts tail).
  { name: "episode-audio", script: "generate/episode-audio.ts" },
  { name: "build-html", script: "generate/build-html.ts", args: buildHtmlEntries },
  { name: "copy-static", script: "generate/copy-static.ts" },
  { name: "share-card", script: "generate/share-card.ts" },
  { name: "strip-served-html", script: "generate/strip-served-html.ts" },
  { name: "figure-source-export", script: "generate/figure-source-export.ts" },
  { name: "markdown-export", script: "generate/markdown-export.ts" },
  { name: "feeds", script: "generate/feeds.ts" },
  { name: "site-discovery", script: "generate/site-discovery.ts" },
  { name: "help-page", script: "generate/help-page.ts" },
  { name: "licenses-page", script: "generate/licenses-page.ts" },
  { name: "audit-posts", script: "generate/audit-posts.ts" },
  { name: "audit-private", script: "generate/audit-private.ts", when: (c) => c.private },
];

/** Runs a single stage. Throws on non-zero exit (`&&` semantics). Shared by build+deploy. */
export async function runStage(stage: Stage, ctx: StageContext): Promise<void> {
  const cmd =
    "script" in stage
      ? ["bun", join(ctx.paths.engineRoot, stage.script), ...((await stage.args?.(ctx)) ?? [])]
      : "command" in stage
        ? stage.command(ctx)
        : null;
  if (cmd === null) return (stage as { run: (c: StageContext) => Promise<void> }).run(ctx);
  console.log(`\n▶ ${stage.name}`);
  const proc = Bun.spawn(cmd, {
    cwd: ctx.paths.contentRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // npm-script parity: consumer-local binaries (wrangler) resolve first.
      PATH: `${join(ctx.paths.contentRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`stage \`${stage.name}\` failed (exit ${code})`);
}

export type BuildOpts = { private?: boolean };

/** Throws Error("stage `<name>` failed (exit N)") on first failure — `&&` semantics. */
export async function runBuild(
  paths: BlogPaths = resolveBlogPaths(),
  opts: BuildOpts = {},
): Promise<void> {
  const ctx: StageContext = { paths, private: opts.private ?? isPrivateBlog(), dryRun: false };
  for (const stage of BUILD_STAGES) {
    if (stage.when && !stage.when(ctx)) continue;
    await runStage(stage, ctx);
  }
}

if (import.meta.main) {
  // `--private` declares the private posture STRUCTURALLY at the invocation
  // (templates/private-content-repo/package.json passes it), forcing
  // ctx.private = true so audit-private always runs. audit-private.ts then
  // re-checks isPrivateBlog() and fails loudly if BLOG_PRIVATE was lost — a
  // lost env var must fail the build, not silently ship a private blog public.
  // No flag ⇒ opts.private stays undefined ⇒ isPrivateBlog() governs (PUBLIC
  // behavior unchanged).
  runBuild(undefined, { private: process.argv.includes("--private") ? true : undefined }).catch(
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(1);
    },
  );
}
