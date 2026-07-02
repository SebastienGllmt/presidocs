// Tests for the build/deploy orchestrators (generate/build.ts + deploy.ts).
// Pure assertions on the encoded ordering contract — no subprocess spawning.
// The stage lists ARE the ordering contract (they replaced three drifting `&&`
// strings in the content-repo package.json files); these tests are the guard
// that keeps them column-for-column with §1a/§1b of the 1.1-1.3 spec.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILD_STAGES,
  buildHtmlEntries,
  type Stage,
  type StageContext,
} from "./build.ts";
import { DEPLOY_STAGES } from "./deploy.ts";
import type { BlogPaths } from "../shared/blogPaths.ts";

function ctx(overrides: Partial<StageContext> = {}): StageContext {
  return { paths: {} as BlogPaths, private: false, dryRun: false, ...overrides };
}

/** Names of the stages that survive `when`-filtering for the given context. */
function activeNames(stages: readonly Stage[], c: StageContext): string[] {
  return stages.filter((s) => !s.when || s.when(c)).map((s) => s.name);
}

// (a) BUILD_STAGES in the §1a order.
test("BUILD_STAGES declare the §1a chain order", () => {
  expect(BUILD_STAGES.map((s) => s.name)).toEqual([
    "audit-license",
    "post-meta",
    "post-versions",
    "episode-audio",
    "build-html",
    "copy-static",
    "share-card",
    "strip-served-html",
    "figure-source-export",
    "markdown-export",
    "feeds",
    "site-discovery",
    "help-page",
    "licenses-page",
    "audit-posts",
    "audit-private",
  ]);
});

// (b) audit-private is posture-gated, and lands last when present.
test("public build drops audit-private; private build appends it last", () => {
  const pub = activeNames(BUILD_STAGES, ctx({ private: false }));
  expect(pub).not.toContain("audit-private");

  const priv = activeNames(BUILD_STAGES, ctx({ private: true }));
  expect(priv).toContain("audit-private");
  expect(priv[priv.length - 1]).toBe("audit-private");
  // Every public stage is still present, in order, ahead of it.
  expect(priv.slice(0, pub.length)).toEqual(pub);
});

// (c) DEPLOY_STAGES private posture == the private template's §1b column.
test("private deploy equals the private template's deploy chain", () => {
  expect(activeNames(DEPLOY_STAGES, ctx({ private: true }))).toEqual([
    "audit-deps",
    "audit-licenses",
    "verify-narration",
    "build",
    "upload-audio-r2",
    "wrangler deploy",
  ]);
});

// public posture keeps the announce stages (§1b column A/B).
test("public deploy keeps the announce stages", () => {
  expect(activeNames(DEPLOY_STAGES, ctx({ private: false }))).toEqual([
    "audit-deps",
    "audit-licenses",
    "verify-narration",
    "build",
    "upload-audio-r2",
    "publish-notify --snapshot",
    "wrangler deploy",
    "websub-ping",
    "publish-notify --notify",
  ]);
});

// (d) dry-run drops side-effecting stages and passes --dry-run to wrangler.
test("dry-run deploy runs audits+build, skips side effects, dry-runs wrangler", () => {
  const c = ctx({ private: false, dryRun: true });
  expect(activeNames(DEPLOY_STAGES, c)).toEqual([
    "audit-deps",
    "audit-licenses",
    "verify-narration",
    "build",
    "wrangler deploy",
  ]);
  const wrangler = DEPLOY_STAGES.find((s) => s.name === "wrangler deploy")!;
  const cmd = (wrangler as { command: (c: StageContext) => string[] }).command(c);
  expect(cmd).toEqual(["wrangler", "deploy", "--dry-run"]);
});

test("non-dry-run wrangler command has no --dry-run", () => {
  const wrangler = DEPLOY_STAGES.find((s) => s.name === "wrangler deploy")!;
  const cmd = (wrangler as { command: (c: StageContext) => string[] }).command(
    ctx({ dryRun: false }),
  );
  expect(cmd).toEqual(["wrangler", "deploy"]);
});

// upload-audio-r2 always drops --bucket (auto-discovered from wrangler.toml).
test("upload-audio-r2 passes only --remote (no --bucket)", () => {
  const stage = DEPLOY_STAGES.find((s) => s.name === "upload-audio-r2")! as {
    args: (c: StageContext) => string[];
  };
  expect(stage.args(ctx())).toEqual(["--remote"]);
});

// (e) buildHtmlEntries: index → privacy (when present) → sorted posts.
test("buildHtmlEntries orders index, privacy, then lexicographically-sorted posts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "presidocs-buildhtml-"));
  const postsDir = join(dir, "posts");
  mkdirSync(postsDir);
  writeFileSync(join(dir, "index.html"), "");
  writeFileSync(join(dir, "privacy.html"), "");
  // Write out of order to prove the sort.
  for (const name of ["c-post.html", "a-post.html", "b-post.html"]) {
    writeFileSync(join(postsDir, name), "");
  }
  const paths = { contentRoot: dir, postsDir } as BlogPaths;

  const entries = await buildHtmlEntries({ paths, private: false, dryRun: false });
  expect(entries).toEqual([
    join(dir, "index.html"),
    join(dir, "privacy.html"),
    join(postsDir, "a-post.html"),
    join(postsDir, "b-post.html"),
    join(postsDir, "c-post.html"),
  ]);
});

test("buildHtmlEntries omits privacy.html when the file is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "presidocs-buildhtml-noprivacy-"));
  const postsDir = join(dir, "posts");
  mkdirSync(postsDir);
  writeFileSync(join(dir, "index.html"), "");
  writeFileSync(join(postsDir, "only.html"), "");
  const paths = { contentRoot: dir, postsDir } as BlogPaths;

  const entries = await buildHtmlEntries({ paths, private: false, dryRun: false });
  expect(entries).toEqual([join(dir, "index.html"), join(postsDir, "only.html")]);
});
