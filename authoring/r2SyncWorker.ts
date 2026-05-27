// Throwaway R2 access Worker, driven by `authoring/r2Sync.ts`.
//
// It is NEVER deployed. `r2Sync.ts` runs it via `wrangler dev --remote`
// (so the COMMENTS binding points at the *production* bucket, using the
// author's existing wrangler OAuth login — no separate R2 credential),
// hits it over 127.0.0.1 for a few seconds, then kills it. This is the
// localhost-only "smart" tool the dumb-edge-server rule explicitly
// exempts (see methodology.md → "Why local tooling"): it merges nothing,
// it just shuttles opaque change-objects between R2 and the local
// `.comments-dev` store so the offline authoring tools can run against
// real reader comments.
//
// Endpoints:
//   GET  /list?prefix=<p>   → JSON [{ key, size, uploaded }]   (paginated)
//   GET  /get?key=<k>       → raw object bytes
//   PUT  /put?key=<k>       → store request body at <k>  (resolutions only)
//
// The PUT path is fenced to `resolutions/` keys: the only thing the
// author ever pushes back is resolution envelopes. Comment change-objects
// are immutable and reader-owned — this tool must never overwrite them.

import type { R2Bucket, R2Objects } from "@cloudflare/workers-types";

export interface Env {
  COMMENTS: R2Bucket;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys: Array<{ key: string; size: number; uploaded: string }> = [];
      let cursor: string | undefined = undefined;
      // Loop the paginated cursor (our buckets are tiny, but be correct).
      for (;;) {
        const r: R2Objects = await env.COMMENTS.list({
          prefix,
          cursor,
          limit: 1000,
        });
        for (const o of r.objects) {
          keys.push({
            key: o.key,
            size: o.size,
            uploaded: o.uploaded.toISOString(),
          });
        }
        if (r.truncated) cursor = r.cursor;
        else break;
      }
      return Response.json(keys);
    }

    if (req.method === "GET" && url.pathname === "/get") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing key", { status: 400 });
      const obj = await env.COMMENTS.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      // Buffer rather than stream: change-objects are tiny, and it sidesteps
      // the R2 ReadableStream ↔ global BodyInit type mismatch.
      const buf = await obj.arrayBuffer();
      return new Response(buf, {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    if (req.method === "PUT" && url.pathname === "/put") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing key", { status: 400 });
      // Fence: only resolution envelopes are ever pushed from local.
      if (!key.startsWith("resolutions/")) {
        return new Response(`refusing to write non-resolution key: ${key}`, {
          status: 403,
        });
      }
      const bytes = await req.arrayBuffer();
      await env.COMMENTS.put(key, bytes, {
        httpMetadata: { contentType: "application/json" },
      });
      return new Response("ok");
    }

    return new Response("ok");
  },
};
