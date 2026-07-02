// Mirror of happydom.ts, for test files that must run on Bun's NATIVE web
// classes (Request/Response/Headers/fetch) even when earlier files in the
// same `bun test` process registered happy-dom. In the full suite all test
// files share one process, and a client file's GlobalRegistrator.register()
// LEAKS into every later file (verified empirically 2026-07-03): happy-dom's
// Request drops the forbidden `cookie` header (→ spurious 401s) and its
// Response drops appended Set-Cookie (`getSetCookie()` → []). Any server
// test that exercises cookies or Set-Cookie needs this defense.
//
// Call it at module scope, before registering your own hooks:
//
//     import { useNativeWebClasses } from "../nativedom.ts";
//     useNativeWebClasses();
//
// It MUST be a function you call — NOT a side-effect import like
// happydom.ts. Modules are cached per process, so a side-effect version
// would register its beforeAll/afterAll for the FIRST importing file only
// and silently no-op for every later one. Calling the function registers
// fresh hooks in each calling file.
//
// The unregister lasts for the calling file only: afterAll restores the
// exact pre-file state, so later DOM-dependent files are unaffected.
//
// Root-fix watch: `bun test --isolate` (fresh global per file) makes this
// whole class of leak impossible and the suite is green under it, but
// bunfig has no `[test] isolate` key (verified silently ignored on Bun
// 1.3.14), and a package-script alias wouldn't protect the raw `bun test`
// invocation everyone actually runs. Revisit when bunfig grows the key.

import { beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function useNativeWebClasses(): void {
  let hadHappyDom = false;
  beforeAll(async () => {
    hadHappyDom =
      (globalThis as { __HAPPY_DOM_REGISTERED__?: boolean })
        .__HAPPY_DOM_REGISTERED__ === true;
    if (hadHappyDom) await GlobalRegistrator.unregister();
  });
  afterAll(() => {
    if (hadHappyDom) GlobalRegistrator.register();
  });
}
