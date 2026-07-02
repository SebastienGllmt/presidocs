// Opt Zod into "jitless" mode, as a side effect, before any schema is parsed.
//
// Why: Zod 4 JIT-compiles validators with `new Function(...)` for speed, gated
// behind a feature-probe that calls `new Function("")` inside a try/catch
// (zod/v4/core/util.ts `allowsEval`). Under our strict CSP — `script-src` has
// no `'unsafe-eval'` (server/securityHeaders.ts) — that probe is *blocked*: the
// browser fires a `securitypolicyviolation` (surfaced as a DevTools Issue and a
// Lighthouse Best-Practices `errors-in-console` hit) and Zod falls back to the
// interpreter anyway. So the JIT can never actually run in our client; the only
// effect of the probe is the violation noise.
//
// `z.config({ jitless: true })` short-circuits the probe (Zod #4461 / #5414): no
// `new Function`, no violation, identical runtime behavior (interpreter either
// way). `allowsEval.value` is memoised on first access, so this MUST run before
// the first parse — hence it's imported for its side effect at the top of every
// shared schema module (commentSchemas, analyticsSchema, time), which are the
// only paths into a client-side parse.
//
// Guarded by e2e/cspConsole.ts (the prod-CSP console/violation gate).
import { z } from "zod";

z.config({ jitless: true });
