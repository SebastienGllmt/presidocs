// Opt-in browser-like environment for client/* tests. Import this module
// (side-effect only) at the top of any *.test.ts that needs `document`,
// `window`, events, etc. — before importing the client module under test:
//
//     import "../happydom.ts";
//     import { installHeadingLinks } from "./headerLinks.ts";
//
// Why opt-in instead of a global `[test] preload`: a project-wide preload
// would also register happy-dom into the server / generate / shared tests,
// where it bites in two ways:
//   1. happy-dom installs a non-writable `localStorage` on globalThis,
//      breaking commentsStore.test.ts's in-memory shim assignment.
//   2. happy-dom replaces fields on `process` that Bun.spawn relies on,
//      breaking audio-pipeline.test.ts's stdio wiring.
// Per-file registration keeps that blast radius contained to the test files
// that actually need a DOM.
//
// Registration is idempotent — multiple test files can import this safely.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  // eslint-disable-next-line no-var
  var __HAPPY_DOM_REGISTERED__: boolean | undefined;
}

if (!globalThis.__HAPPY_DOM_REGISTERED__) {
  GlobalRegistrator.register();
  globalThis.__HAPPY_DOM_REGISTERED__ = true;
}
