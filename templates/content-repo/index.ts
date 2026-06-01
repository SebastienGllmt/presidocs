// Bun dev server entry for my-blog. Thin wrapper over the engine's
// dev-server factory (in the `presidocs` package). The static post/landing
// HTML bundles come from the generated `.generated/postRoutes.ts` — run
// `bun run dev`, which regenerates it first.
//
// The site footer (Home / How this blog works / Privacy) runs at *build*
// time via the Bun.build plugin wired in `engine/generate/build-html.ts`.
// It deliberately does NOT run here: Bun's runtime plugin system rejects
// `loader: "html"` in onLoad, so a `Bun.plugin(siteFooterPlugin())` call
// before `Bun.serve` would crash the dev server when an HTMLBundle loads.
// The footer is engine-owned — don't hand-author one in source HTML; it's
// simply absent under `bun run dev` and present at build/deploy (and dev:edge).

import { resolveBlogPaths } from "presidocs/shared/blogPaths.ts";
import { createDevServer } from "presidocs/server/createDevServer.ts";
import { staticRoutes } from "./.generated/postRoutes.ts";

const paths = resolveBlogPaths();
const server = Bun.serve(await createDevServer({ paths, staticRoutes }));
console.log(`my-blog running at ${server.url}`);
