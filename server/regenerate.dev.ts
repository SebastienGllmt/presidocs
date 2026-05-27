// Dev-only, author-only endpoint that re-rolls one narration segment's audio.
//
// Why dev-only: it shells out to the offline `bun run generate` pipeline (which
// loads the multi-GB MOSS model and writes to `generated/`). That's a trusted-
// localhost operation — exactly the kind the methodology's "the *edge* server
// is dumb" rule carves out for the dev Bun server. It is therefore imported
// ONLY by index.ts and is absent from worker.ts, so it never reaches the
// production Worker bundle.
//
// Async by design (start + poll), NOT a single long request. A full MOSS render
// is minutes, and even a one-segment re-roll exceeds Bun.serve's idle timeout
// (~10s) because the model load alone does — so awaiting the subprocess inside
// the request would get the connection killed mid-run while the child kept
// going (the spinner would clear early and the user would think it was done).
// Instead:
//   POST /dev/regenerate?post=<path>&mark=<name>  → starts the job, 202 now
//   GET  /dev/regenerate                          → { running, ok?, error? }
// The client polls GET until `running` is false, then reloads (ok) or shows the
// error. Single-flight: one job at a time (MOSS loads one model); a second POST
// while one runs gets 409.

import { getSessionFromRequest } from "./auth/routes.ts";
import { isPostAuthor, type PostMetaIndex } from "./postMeta.ts";
import { join } from "node:path";

export type RegenerateDeps = {
  // Where the posts + generated/ live (the content repo). The post file and
  // the spawned process's cwd resolve against this; generate.ts derives its
  // output root from the post path, so writes land under contentRoot/generated.
  contentRoot: string;
  // Where the engine's generate.ts lives (this repo / node_modules/presidocs).
  engineRoot: string;
  postMeta: PostMetaIndex;
};

// Slugs and mark names are simple identifiers. Validating them keeps the post
// path inside `posts/` (no traversal) and the mark a single CLI token.
const ID_RE = /^[A-Za-z0-9_-]+$/;

const ALLOWED_TTS = new Set(["say", "moss"]);

// Single in-flight job, process-wide (MOSS loads one model per `generate` run).
// `running` gates new POSTs; `ok`/`error` carry the last result for pollers.
type Job = {
  running: boolean;
  post: string;
  mark: string;
  startedAt: number;
  ok?: boolean;
  error?: string;
};
let job: Job | null = null;

function statusResponse(): Response {
  return Response.json(
    job ?? { running: false },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleRegenerateRequest(
  req: Request,
  deps: RegenerateDeps,
): Promise<Response> {
  // Both verbs require a logged-in session; POST additionally requires being
  // the post's author (checked below, once we know which post).
  const session = await getSessionFromRequest(req);
  if (!session) return new Response("unauthorized", { status: 401 });

  // GET = poll the current job's status.
  if (req.method === "GET") return statusResponse();
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const url = new URL(req.url);
  // `post` is the post's URL PATH (e.g. "/posts/hash-functions") — the key the
  // post index is built on (server/postMeta.dev.ts), matching how the client
  // and comments.ts identify a post. The bare slug is derived from it below.
  const post = url.searchParams.get("post");
  const mark = url.searchParams.get("mark");
  const tts = url.searchParams.get("tts") ?? "moss";

  if (!post) return new Response("missing ?post", { status: 400 });
  if (!mark || !ID_RE.test(mark)) {
    return new Response("bad or missing ?mark", { status: 400 });
  }
  if (!ALLOWED_TTS.has(tts)) {
    return new Response(`unsupported ?tts (allowed: ${[...ALLOWED_TTS].join(", ")})`, {
      status: 400,
    });
  }

  // Author gate, keyed on the post PATH (so it must run before we reduce to the
  // slug). Same server-authoritative check the version endpoint uses.
  if (!isPostAuthor(session, deps.postMeta.get(post))) {
    return new Response("forbidden", { status: 403 });
  }

  // Reduce the post path to a flat slug for the source file + the generate CLI.
  // ID_RE keeps it a single safe path segment (no traversal, no nested posts).
  const slug = post.startsWith("/posts/") ? post.slice("/posts/".length) : post;
  if (!ID_RE.test(slug)) {
    return new Response("post must be /posts/<slug>", { status: 400 });
  }
  const postFile = join(deps.contentRoot, "posts", `${slug}.html`);
  if (!(await Bun.file(postFile).exists())) {
    return new Response("post not found", { status: 404 });
  }

  if (job?.running) {
    return Response.json(
      { running: true, error: "a regeneration is already in progress" },
      { status: 409 },
    );
  }

  // Start the job and return immediately. The subprocess runs in the
  // background; its result is recorded onto `job` for GET pollers.
  job = { running: true, post, mark, startedAt: Date.now() };
  const proc = Bun.spawn({
    cmd: [
      "bun",
      join(deps.engineRoot, "generate", "generate.ts"),
      postFile,
      `--tts=${tts}`,
      `--force-mark=${mark}`,
    ],
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
        job = { running: false, ok: true, post, mark, startedAt: job!.startedAt };
      } else {
        // Surface the tail of stderr so the author sees *why* (e.g. a MOSS
        // synthesis error) rather than a bare failure.
        const tail = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
        job = { running: false, ok: false, error: tail, post, mark, startedAt: job!.startedAt };
      }
    } catch (err) {
      job = {
        running: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        post,
        mark,
        startedAt: job!.startedAt,
      };
    }
  })();

  return Response.json({ running: true, post, mark }, { status: 202 });
}
