// Bun dev server entry for personal-blog. Thin wrapper over the engine's
// dev-server factory (in the `presidocs` package). The static post/landing
// HTML bundles come from the generated `.generated/postRoutes.ts` — run
// `bun run dev`, which regenerates it first.

import { resolveBlogPaths } from "presidocs/shared/blogPaths.ts";
import { createDevServer } from "presidocs/server/createDevServer.ts";
import { staticRoutes } from "./.generated/postRoutes.ts";

const paths = resolveBlogPaths();
const server = Bun.serve(await createDevServer({ paths, staticRoutes }));
console.log(`my-blog running at ${server.url}`);
