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
// Two endpoints:
//   GET  /dev/sound-test/list        → lexemes + which already have audio
//   POST /dev/sound-test/regenerate?index=N   → re-roll one lexeme (start, 202)
//   POST /dev/sound-test/regenerate?all=1     → render every missing/stale one
//   GET  /dev/sound-test/regenerate           → { running, ok?, error? }
// The page polls GET until the job finishes, then refreshes the list.

import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { getSessionFromRequest } from "./auth/routes.ts";
import { parseLexicon } from "../generate/pronunciation.ts";
import {
  SOUND_TEST_DIR,
  audioFileName,
  mossVoiceId,
  synthTextFor,
  type SoundTestVoice,
} from "../shared/soundTest.ts";

export type SoundTestDeps = {
  // Content repo root (its posts/ + generated/ live here; the spawned CLI's
  // cwd resolves against it).
  contentRoot: string;
  // Engine root (where generate/sound-test.ts lives).
  engineRoot: string;
};

// Audio identity for the sound test is fixed to the production MOSS voice — the
// engine whose mispronunciations this page exists to catch. `say` ignores PLS
// and can't reveal them, so it's intentionally not offered here.
const PROVIDER = "moss";
const FORMAT = { sampleRate: 22050, channels: 1, bitsPerSample: 16 } as const;

function plsPathFor(deps: SoundTestDeps): string {
  return join(deps.contentRoot, "posts", "common-terms.pls");
}

function soundTestDir(deps: SoundTestDeps): string {
  return join(deps.contentRoot, "generated", SOUND_TEST_DIR);
}

// Resolve the MOSS clone reference into a machine-independent voice id without
// loading the model — just a content hash of the (small) clip file. Null when
// MOSS_TTS_VOICE is unset or the file is gone, in which case the page can still
// list lexemes but can't address (or play) their audio.
function voiceIdentity(): SoundTestVoice | null {
  const ref = process.env.MOSS_TTS_VOICE;
  if (!ref || !existsSync(ref)) return null;
  return { providerName: PROVIDER, voiceId: mossVoiceId(ref), format: { ...FORMAT } };
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
  const voice = voiceIdentity();
  const dir = soundTestDir(deps);

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
    return {
      index,
      graphemes: entry.graphemes,
      alias: entry.alias ?? null,
      ipa: entry.ipa ?? null,
      synthText,
      available,
      audioUrl,
      version,
    };
  });

  return Response.json(
    { provider: PROVIDER, voiceConfigured: voice !== null, lexemes, job: jobStatus() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// --- async regenerate job (single-flight, mirrors regenerate.dev.ts) ---------

type Job = {
  running: boolean;
  target: string; // "all" or "#<index>"
  startedAt: number;
  ok?: boolean;
  error?: string;
};
let job: Job | null = null;

function jobStatus(): Job | { running: false } {
  return job ?? { running: false };
}

export async function handleSoundTestRegenerate(
  req: Request,
  deps: SoundTestDeps,
): Promise<Response> {
  if (req.method === "GET") {
    return Response.json(jobStatus(), { headers: { "Cache-Control": "no-store" } });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Regeneration loads the multi-GB model — gate it behind a logged-in session
  // so a stray request to a dev box doesn't kick one off. (No per-post author
  // check: the lexicon is cross-post, not owned by one post.)
  const session = await getSessionFromRequest(req);
  if (!session) return new Response("unauthorized", { status: 401 });

  const plsPath = plsPathFor(deps);
  if (!existsSync(plsPath)) return new Response("no posts/common-terms.pls", { status: 404 });
  if (!voiceIdentity()) {
    return new Response("MOSS_TTS_VOICE is not set (or the clip is missing)", { status: 400 });
  }

  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  const indexParam = url.searchParams.get("index");
  if (!all && (indexParam === null || !/^\d+$/.test(indexParam))) {
    return new Response("provide ?all=1 or ?index=<n>", { status: 400 });
  }

  if (job?.running) {
    return Response.json(
      { running: true, error: "a sound-test regeneration is already in progress" },
      { status: 409 },
    );
  }

  const target = all ? "all" : `#${indexParam}`;
  job = { running: true, target, startedAt: Date.now() };
  const cmd = [
    "bun",
    join(deps.engineRoot, "generate", "sound-test.ts"),
    plsPath,
    `--tts=${PROVIDER}`,
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
