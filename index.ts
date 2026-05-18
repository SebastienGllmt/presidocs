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
  },
  development: { hmr: true, console: true },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(`read-demo running at ${server.url}`);
