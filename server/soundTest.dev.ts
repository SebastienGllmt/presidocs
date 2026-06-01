// Dev-only endpoints backing the sound-test page (client/sound-test/). The page
// lists every lexeme in `posts/common-terms.pls` and lets the author hear how
// the production MOSS voice reads each respelling, re-rolling any that come out
// wrong — the listening loop the methodology calls for ("verify by ear").
//
// Like /dev/regenerate, this is dev/localhost-only: regeneration shells out to
// the offline `generate/sound-test.ts` (which loads the multi-GB MOSS model and
// writes under `generated/`). It is imported only by createDevServer.ts and is
// absent from the prod Worker — the trusted-localhost carve-out from the "dumb
// edge server" rule.
//
// Endpoints:
//   GET  /dev/sound-test/list                       → lexemes + which posts each occurs in
//   POST /dev/sound-test/regenerate?index=N         → re-roll one lexeme's audition clip
//   POST /dev/sound-test/regenerate?all=1           → render every missing/stale audition clip
//   POST /dev/sound-test/regenerate?index=N&inPosts=1
//        → re-roll IN-POST audio for every segment matching that lexeme, across every
//          post that contains it. Surgical: only matching marks (force-mark) re-synth;
//          unrelated segments hit cache. Requires the session to author every affected post.
//   GET  /dev/sound-test/regenerate                 → { running, ok?, error?, posts? }
// The page polls GET until the job finishes, then refreshes the list.
//
// Error bodies here are deliberately plain-text, NOT RFC 9457 Problem Details
// (see methodology.md → "HTTP error responses" → "Out of scope"): same
// rationale as regenerate.dev.ts — dev-only, author-only, and the error
// strings encode dynamic shape hints (valid `?index` range, per-post auth
// failures listing the failing posts) that don't fit a closed slug set.

import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { getSessionFromRequest } from "./auth/routes.ts";
import { isPostAuthor, type PostMetaIndex } from "./postMeta.ts";
import { matchesAnyGrapheme, parseLexicon, type LexEntry } from "../generate/pronunciation.ts";
import { extractNarration, splitChapter } from "../generate/narration.ts";
import {
  SOUND_TEST_DIR,
  audioFileName,
  mossVoiceId,
  synthTextFor,
  type SoundTestVoice,
} from "../shared/soundTest.ts";
import { resolveAuthorVoice } from "../shared/voiceResolution.ts";

export type SoundTestDeps = {
  // Content repo root (its posts/ + generated/ live here; the spawned CLI's
  // cwd resolves against it).
  contentRoot: string;
  // Engine root (where generate/sound-test.ts lives).
  engineRoot: string;
  // Per-post author index — used to author-gate the in-posts regenerate action.
  // The audition-only POSTs (index=N / all=1) don't need this; they touch only
  // the cross-post sound-test store and require any logged-in session.
  postMeta: PostMetaIndex;
};

// One affected post for a lexeme: which marks match the lexeme's graphemes
// under applyLexicon's matcher (case-sensitive, alphanumeric-boundary).
type AffectedPost = {
  slug: string; // posts/<slug>.html
  postPath: string;
  marks: string[]; // mark names whose segment text matches at least one grapheme
  manifestMtime: number; // last in-post generate.ts run (0 if never)
};

// Walk posts/*.html once, parse narration, and return a per-lexeme map of which
// posts contain it and where. Done on each list request — for a handful of
// posts it's cheap (a few KB of narration each, regex-light matching). Keeps
// the page accurate when posts change without a server restart.
async function scanPostsForLexicon(
  deps: SoundTestDeps,
  entries: LexEntry[],
): Promise<Map<number, AffectedPost[]>> {
  const postsDir = join(deps.contentRoot, "posts");
  const result = new Map<number, AffectedPost[]>();
  let files: string[] = [];
  try {
    files = await readdir(postsDir);
  } catch {
    return result;
  }
  for (const f of files) {
    if (!/\.html?$/i.test(f)) continue;
    const slug = f.replace(/\.html?$/i, "");
    const postPath = join(postsDir, f);
    const html = await Bun.file(postPath).text();
    const { disabled, chapters } = extractNarration(html);
    if (disabled || chapters.length === 0) continue;
    // Flatten every chapter's segments into one list — we only care which
    // marks contain the lexeme, not which chapter they belong to.
    const segments = chapters.flatMap((ch) => splitChapter(ch.content));
    const manifestPath = join(deps.contentRoot, "generated", slug, "manifest.json");
    const manifestMtime = existsSync(manifestPath)
      ? Math.floor(statSync(manifestPath).mtimeMs)
      : 0;
    entries.forEach((entry, idx) => {
      const marks = new Set<string>();
      for (const seg of segments) {
        if (!seg.markName) continue;
        if (matchesAnyGrapheme(seg.text, entry.graphemes)) marks.add(seg.markName);
      }
      if (marks.size === 0) return;
      const list = result.get(idx) ?? [];
      list.push({ slug, postPath, marks: [...marks], manifestMtime });
      result.set(idx, list);
    });
  }
  return result;
}

// Audio identity for the sound test is fixed to the production MOSS voice — the
// engine whose mispronunciations this page exists to catch. `say` ignores PLS
// and can't reveal them, so it's intentionally not offered here.
const PROVIDER = "moss";
const FORMAT = { sampleRate: 22050, channels: 1, bitsPerSample: 16 } as const;

type SessionLike = { email: string };

function plsPathFor(deps: SoundTestDeps): string {
  return join(deps.contentRoot, "posts", "common-terms.pls");
}

function soundTestDir(deps: SoundTestDeps): string {
  return join(deps.contentRoot, "generated", SOUND_TEST_DIR);
}

// The audition voice is the SESSION USER's own voice — they audition the
// respelling in the voice they author posts with. On a multi-author blog each
// author sees their own audition state (the store keys on voice identity, so
// Alice and Bob's clips coexist under different hash filenames). Returns null
// when the user has no authors/<email>.wav, in which case the page lists the
// lexemes for reference but can't generate/play audio for them.
function voiceIdentityFor(
  session: SessionLike | null,
  deps: SoundTestDeps,
): { voice: SoundTestVoice; clipPath: string } | null {
  if (!session?.email) return null;
  const r = resolveAuthorVoice(deps.contentRoot, session.email);
  if (!r.ok) return null;
  return {
    voice: { providerName: PROVIDER, voiceId: mossVoiceId(r.clipPath), format: { ...FORMAT } },
    clipPath: r.clipPath,
  };
}

export async function handleSoundTestList(
  req: Request,
  deps: SoundTestDeps,
): Promise<Response> {
  const plsPath = plsPathFor(deps);
  if (!existsSync(plsPath)) {
    return Response.json(
      { provider: PROVIDER, voiceConfigured: false, lexemes: [], message: "no posts/common-terms.pls" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const entries = parseLexicon(await Bun.file(plsPath).text());
  // Audition state is keyed on the session user's voice — each author sees
  // their own clips. If they haven't logged in (or have no authors/<email>.wav)
  // we still list lexemes for reference, just without audio status.
  const session = await getSessionFromRequest(req);
  const identity = voiceIdentityFor(session, deps);
  const voice = identity?.voice ?? null;
  const dir = soundTestDir(deps);
  // Per-lexeme list of posts where it occurs (with which marks would re-roll).
  // Computed once for all lexemes rather than per-lexeme so we read each post
  // file only once.
  const affectedByIndex = await scanPostsForLexicon(deps, entries);

  const lexemes = entries.map((entry, index) => {
    const synthText = synthTextFor(entry, /* ipaSupported (MOSS) */ true);
    let available = false;
    let audioUrl: string | null = null;
    let version = 0; // file mtime: cache-buster for the sticky media cache
    if (voice && synthText) {
      const file = audioFileName(voice, synthText);
      const abs = join(dir, file);
      if (existsSync(abs)) {
        available = true;
        version = Math.floor(statSync(abs).mtimeMs);
        audioUrl = `/generated/${SOUND_TEST_DIR}/${file}`;
      }
    }
    const inPosts = (affectedByIndex.get(index) ?? []).map((p) => {
      // Per-post voice resolution at list time, so the page can show which
      // clip the sweep would use BEFORE the user clicks. `voiceError` is
      // surfaced as a per-row warning rather than blocking the whole page;
      // the POST handler refuses the sweep if any post still can't resolve.
      const meta = deps.postMeta.get(`/posts/${p.slug}`);
      const r = resolveAuthorVoice(deps.contentRoot, meta?.authorEmail ?? null);
      return {
        slug: p.slug,
        marks: p.marks,
        manifestMtime: p.manifestMtime,
        authorEmail: meta?.authorEmail ?? null,
        voiceError: r.ok ? null : r.reason,
      };
    });
    return {
      index,
      graphemes: entry.graphemes,
      alias: entry.alias ?? null,
      ipa: entry.ipa ?? null,
      synthText,
      available,
      audioUrl,
      version,
      inPosts,
    };
  });

  return Response.json(
    { provider: PROVIDER, voiceConfigured: voice !== null, lexemes, job: jobStatus() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// --- async regenerate job (single-flight, mirrors regenerate.dev.ts) ---------
//
// One job covers BOTH the audition-clip actions (index=N / all=1) and the in-
// posts sweep — MOSS only loads one model at a time, so they must mutually
// exclude. The audition actions spawn one child to completion; the in-posts
// sweep spawns one child per affected post in sequence, and the `posts` field
// reports per-post progress so the page can show "post 2/3 …" rather than a
// silent multi-minute wait.

type PostProgress = {
  slug: string;
  marks: string[];
  // Reference clip the sweep will pass as `--voice=` for this post. Resolved
  // upfront from the post's author (see resolveAuthorVoice). Surfaced so the
  // page can show which clip is currently being rendered.
  voiceClipPath: string;
  status: "pending" | "running" | "ok" | "error";
  error?: string;
};

type Job = {
  running: boolean;
  target: string; // "all" | "#<i>" | "in-posts:#<i>"
  startedAt: number;
  ok?: boolean;
  error?: string;
  // Set only for the in-posts sweep; one entry per affected post.
  posts?: PostProgress[];
};
let job: Job | null = null;

function jobStatus(): Job | { running: false } {
  return job ?? { running: false };
}

// Runs `bun engine/generate/generate.ts <post> --tts=moss --force-mark=...`
// once per affected post, sequentially. Sequential because MOSS loads one model
// per `generate.ts` process; running two in parallel would contend for GPU/RAM.
// (A future optimization: one orchestrator process that holds the provider open
// across posts — would amortize the per-post model load. Not done now because
// generate.ts is monolithic and per-post; spawning is robust and reuses the
// proven pipeline.)
async function runInPostsSweep(deps: SoundTestDeps, current: Job): Promise<void> {
  for (const p of current.posts!) {
    p.status = "running";
    // EXPLICIT --voice per post (resolved from authors/<author-email>.wav) so a
    // multi-author blog renders each post in its OWN author's clone. There's
    // intentionally no global default; a single fallback would silently
    // overwrite `full.<hash>.<ext>` with the wrong voice on a multi-author
    // blog. The per-post resolution happened above (resolved[]).
    const proc = Bun.spawn({
      cmd: [
        "bun",
        join(deps.engineRoot, "generate", "generate.ts"),
        join(deps.contentRoot, "posts", `${p.slug}.html`),
        `--tts=${PROVIDER}`,
        `--voice=${p.voiceClipPath}`,
        `--force-mark=${p.marks.join(",")}`,
      ],
      cwd: deps.contentRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) {
      p.status = "ok";
      continue;
    }
    // Stop on first failure: a generate.ts error usually means something needs
    // human attention (missing env, model load failure, …) and continuing would
    // just produce N copies of the same error.
    const tail = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
    p.status = "error";
    p.error = tail;
    current.error = `${p.slug}: ${tail}`;
    return;
  }
}

export async function handleSoundTestRegenerate(
  req: Request,
  deps: SoundTestDeps,
): Promise<Response> {
  if (req.method === "GET") {
    return Response.json(jobStatus(), { headers: { "Cache-Control": "no-store" } });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Regeneration loads the multi-GB model — gate every action behind a logged-
  // in session so a stray request to a dev box doesn't kick one off. The
  // in-posts action additionally requires being the author of EVERY affected
  // post (checked once we know which posts, below).
  const session = await getSessionFromRequest(req);
  if (!session) return new Response("unauthorized", { status: 401 });

  const plsPath = plsPathFor(deps);
  if (!existsSync(plsPath)) return new Response("no posts/common-terms.pls", { status: 404 });
  // Voice checks are action-specific. The audition actions key on ONE voice
  // (the page's audition store); the in-posts sweep resolves voice PER POST
  // (so multi-author blogs render each post in its own author's clone).
  // Keep the audition-voice gate inside its branch; the in-posts branch does
  // its own per-post resolution below.

  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  const inPosts = url.searchParams.get("inPosts") === "1";
  const indexParam = url.searchParams.get("index");
  const hasIndex = indexParam !== null && /^\d+$/.test(indexParam);
  if (!all && !hasIndex) {
    return new Response("provide ?all=1 or ?index=<n>[&inPosts=1]", { status: 400 });
  }
  if (inPosts && all) {
    return new Response("?inPosts=1 is per-lexeme; combine with ?index=N, not ?all=1", { status: 400 });
  }

  if (job?.running) {
    return Response.json(
      { running: true, error: "a sound-test regeneration is already in progress" },
      { status: 409 },
    );
  }

  // --- in-posts sweep --------------------------------------------------------
  if (inPosts) {
    const idx = Number(indexParam);
    const entries = parseLexicon(await Bun.file(plsPath).text());
    if (idx < 0 || idx >= entries.length) {
      return new Response(`?index=${idx} is out of range (0..${entries.length - 1})`, { status: 400 });
    }
    const affectedByIndex = await scanPostsForLexicon(deps, entries);
    const affected = affectedByIndex.get(idx) ?? [];
    if (affected.length === 0) {
      return new Response("this lexeme doesn't occur in any post's narration", { status: 400 });
    }
    // Author every affected post; refuse on any mismatch rather than silently
    // skip — the user should know which posts they don't own.
    const notOwned = affected
      .map((p) => p.slug)
      .filter((slug) => !isPostAuthor(session, deps.postMeta.get(`/posts/${slug}`)));
    if (notOwned.length > 0) {
      return new Response(
        `forbidden: you don't author these post(s): ${notOwned.join(", ")}`,
        { status: 403 },
      );
    }
    // Resolve a voice clip per post BEFORE starting. Each post must render in
    // its own author's voice (`authors/<author-email>.wav`). An unresolved post
    // means the sweep would have no voice at all — refuse, listing the
    // offending posts so the gap is fixable.
    type Resolved = { slug: string; marks: string[]; clipPath: string };
    const resolved: Resolved[] = [];
    const unresolved: { slug: string; reason: string }[] = [];
    for (const p of affected) {
      const meta = deps.postMeta.get(`/posts/${p.slug}`);
      const r = resolveAuthorVoice(deps.contentRoot, meta?.authorEmail ?? null);
      if (r.ok) {
        resolved.push({ slug: p.slug, marks: p.marks, clipPath: r.clipPath });
      } else {
        unresolved.push({ slug: p.slug, reason: r.reason });
      }
    }
    if (unresolved.length > 0) {
      const lines = unresolved.map((u) => `  ${u.slug}: ${u.reason}`).join("\n");
      return new Response(
        `cannot resolve a MOSS voice clip for these post(s):\n${lines}\n` +
          `Add the missing authors/<author-email>.wav file(s).`,
        { status: 400 },
      );
    }

    const target = `in-posts:#${idx}`;
    const current: Job = {
      running: true,
      target,
      startedAt: Date.now(),
      posts: resolved.map((p) => ({
        slug: p.slug,
        marks: p.marks,
        voiceClipPath: p.clipPath,
        status: "pending",
      })),
    };
    job = current;
    void (async () => {
      try {
        await runInPostsSweep(deps, current);
        current.running = false;
        current.ok = current.error === undefined;
      } catch (err) {
        current.running = false;
        current.ok = false;
        current.error = err instanceof Error ? err.message : String(err);
      }
    })();
    return Response.json({ running: true, target, posts: current.posts }, { status: 202 });
  }

  // --- audition-clip action (existing): one shell-out, one child -------------
  // The audition store keys on ONE voice — the session user's own — so the
  // user auditions the respelling in the voice they author posts with. The
  // session is required (gated above) AND the user must have authors/<email>.wav;
  // refuse with a clear hint if they don't.
  const identity = voiceIdentityFor(session, deps);
  if (!identity) {
    return new Response(
      `cannot resolve your voice clip (authors/${session.email.toLowerCase()}.wav). ` +
        `Add it to audition. Per-post voice resolution for ?inPosts=1 is separate.`,
      { status: 400 },
    );
  }
  const target = all ? "all" : `#${indexParam}`;
  job = { running: true, target, startedAt: Date.now() };
  const cmd = [
    "bun",
    join(deps.engineRoot, "generate", "sound-test.ts"),
    plsPath,
    `--tts=${PROVIDER}`,
    `--voice=${identity.clipPath}`,
    all ? "--all" : `--index=${indexParam}`,
  ];
  const proc = Bun.spawn({
    cmd,
    cwd: deps.contentRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode === 0) {
        job = { running: false, ok: true, target, startedAt: job!.startedAt };
      } else {
        const tail = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
        job = { running: false, ok: false, error: tail, target, startedAt: job!.startedAt };
      }
    } catch (err) {
      job = {
        running: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        target,
        startedAt: job!.startedAt,
      };
    }
  })();

  return Response.json({ running: true, target }, { status: 202 });
}
