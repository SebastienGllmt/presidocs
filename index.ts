import { join, normalize } from "node:path";
import index from "./index.html";
import hashFunctions from "./posts/hash-functions.html";

const projectRoot = import.meta.dir;

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
    "/audio/*": serveFromDir("audio"),
  },
  development: { hmr: true, console: true },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(`read-demo running at ${server.url}`);
