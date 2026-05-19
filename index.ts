import { join, normalize } from "node:path";
import index from "./index.html";
import hashFunctions from "./posts/hash-functions.html";
import {
  startGoogleAuth,
  startMicrosoftAuth,
  googleCallback,
  microsoftCallback,
  whoami,
  logout,
} from "./server/auth/routes.ts";
import { handleCommentsRequest } from "./server/comments/routes.ts";
import { fsAdapter } from "./server/comments/fsAdapter.ts";
import { loadDevPostMetaIndex } from "./server/postMeta.dev.ts";

const projectRoot = import.meta.dir;

// Automerge ships its WebAssembly module as a binary file in its `dist/`.
// We serve it directly here so the browser can `fetch()` it once and
// cache it, instead of carrying a ~3.6MB base64-encoded copy inline in
// the JS bundle. `commentsStore.ts` calls `initializeWasm()` with this
// URL.
const AUTOMERGE_WASM_PATH = join(
  projectRoot,
  "node_modules/@automerge/automerge/dist/automerge.wasm",
);

// Dev-mode CommentBlobStore: writes blobs to disk under generated/
// so the same `server/comments/routes.ts` handlers exercised in prod
// (with R2) run unchanged here. The directory is inside `generated/`
// because that's already in .gitignore.
const commentsDevStore = fsAdapter(join(projectRoot, "generated", ".comments-dev"));

// Per-post author index — scans posts/*.html at startup. The Worker
// uses a build-time-generated static map; this is the dev equivalent
// so a new post is picked up after a server restart (no build step
// required).
const postMetaIndex = await loadDevPostMetaIndex(join(projectRoot, "posts"));

// Serve files from a fixed subdirectory of the project — used for the
// generated audio + manifest files which Bun's bundler doesn't manage.
function serveFromDir(dir: string) {
  return async (req: Bun.BunRequest) => {
    const url = new URL(req.url);
    // Drop the leading `/<dir>/` prefix and refuse traversal.
    const sub = decodeURIComponent(url.pathname.replace(`/${dir}/`, ""));
    const safe = normalize(sub);
    if (safe.startsWith("..") || safe.includes("\0")) {
      return new Response("forbidden", { status: 403 });
    }
    const file = Bun.file(join(projectRoot, dir, safe));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  };
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,
    "/posts/hash-functions": hashFunctions,
    "/generated/*": serveFromDir("generated"),
    "/assets/automerge.wasm": async () =>
      new Response(Bun.file(AUTOMERGE_WASM_PATH), {
        headers: {
          "Content-Type": "application/wasm",
          // 30-day cache — the WASM only changes when the dep does.
          "Cache-Control": "public, max-age=2592000, immutable",
        },
      }),
    "/auth/google": startGoogleAuth,
    "/auth/google/callback": googleCallback,
    "/auth/microsoft": startMicrosoftAuth,
    "/auth/microsoft/callback": microsoftCallback,
    "/auth/me": whoami,
    "/auth/logout": { POST: logout },
    // Comments R2 proxy — same handler as the Worker, but backed by a
    // filesystem adapter in dev. No rate limiting locally (the Workers
    // Rate Limiting API doesn't exist in Bun); per-post author is
    // resolved from posts/*.html `<meta name="author-email">`.
    "/comments": (req) =>
      handleCommentsRequest(req, {
        store: commentsDevStore,
        postMeta: postMetaIndex,
        rateLimiter: null,
      }),
  },
  development: { hmr: true, console: true },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(`read-demo running at ${server.url}`);
