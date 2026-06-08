// Session: standard JWT (RFC 7519), HS256-signed, carried in an HttpOnly
// cookie. The token is `<header>.<payload>.<signature>` — a real JWS
// compact serialization, so jwt.io / the `jose` CLI / any JWT debugger
// reads it, and `jose` owns the constant-time verify and the algorithm
// allowlist (the standard defense against the `alg:none` / algorithm-
// confusion class).
//
// All session state lives in the cookie; there's no server-side store.
// Revocation is by KEY ROTATION: every token carries a `kid`, and the
// verifier resolves the signing key from a small in-memory map. Introduce
// a new key, sign new tokens with it, and old tokens keep verifying
// against the old key until you drop it — so rotation no longer means
// force-logging-out everyone (the gap the bespoke format had). If
// per-session revocation ever matters, swap this file for an R2-backed
// session-id model — the route handlers only ever call
// `verifySessionToken`, so nothing else changes.

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import "../../shared/zodJitless.ts"; // configure jitless before any parse (CSP / Workers no-eval)
import { z } from "zod";
import { UserId } from "../../shared/commentSchemas.ts";

// The session-cookie claim shape. `jose` verifies the bytes are *authentic*
// (HMAC, the algorithm allowlist, `exp`); this schema validates the JSON
// inside is the *shape* the app trusts. Reuses the `UserId` primitive
// (`<provider>:<sub>`) rather than re-stating the regex, so the security-
// critical identity field is pinned identically here and at the comment
// store boundary.
//
// Deliberately a bare `z.object` (strips unknown keys, NOT `.strict()`): an
// *additive* future claim — a sliding-window refresh marker, a later
// `iss`/`aud` — must not log everyone out on a deploy skew. `iat`/`exp` are
// `jose`-injected and already enforced by the verifier (`requiredClaims`,
// `clockTolerance`), so they're plain `z.number()` here — we don't
// re-validate temporal bounds.
//
// Validating shape is NOT authorization: a passing parse means "well-formed
// session", never "allowed" — per-method authz stays in the handlers (the
// same rule the comment schemas carry).
const SessionClaims = z.object({
  userId: UserId, // `<provider>:<sub>` — globally unique across providers.
  email: z.string(),
  emailVerified: z.boolean(),
  name: z.string().optional(),
  picture: z.string().optional(),
  provider: z.enum(["google", "microsoft"]),
  iat: z.number(), // seconds since epoch (JWT standard — RFC 7519 §4.1.6)
  exp: z.number(), // seconds since epoch (JWT standard — RFC 7519 §4.1.4)
});

// Single source of truth: the type is derived from the validator, so the two
// can't drift (the pattern the rest of the codebase already follows).
export type Session = z.infer<typeof SessionClaims>;

// 400 days is the practical max — Chrome (since v104), Firefox, and
// Safari all clamp any cookie Max-Age beyond this down to 400 days, in
// line with the HTTP State Tokens proposal. Setting a larger value here
// would mismatch the JWT `exp` against the actual cookie lifetime.
export const SESSION_TTL_S = 400 * 24 * 60 * 60;
export const SESSION_TTL_MS = SESSION_TTL_S * 1000; // kept for routes.ts cookie maxAge

const ALG = "HS256";

// The key new tokens are signed with. Bump this (and add the new key to
// SESSION_SECRETS) to rotate; old tokens keep verifying against whichever
// `kid` they carry until that key is dropped from the map.
const ACTIVE_KID = "v1";

// Resolve the signing keys from env. Two accepted shapes:
//   - SESSION_SECRETS=v1:<secret>,v2:<secret>  — explicit kid→secret map
//   - SESSION_SECRET=<secret>                  — single key, becomes `v1`
// Each secret must be ≥32 chars. ACTIVE_KID must be present.
function getKeys(): Record<string, Uint8Array> {
  // `||` (not `??`) on purpose: an empty-string SESSION_SECRETS must NOT
  // shadow a valid SESSION_SECRET — it should fall through to it.
  const raw =
    process.env.SESSION_SECRETS ||
    `${ACTIVE_KID}:${process.env.SESSION_SECRET ?? ""}`;
  // Prototype-free map so `keys["__proto__"]` / `["constructor"]` resolve
  // to `undefined`, not an inherited Object.prototype member — otherwise
  // the resolver's `!k` guard below wouldn't fire for those kids.
  const out: Record<string, Uint8Array> = Object.create(null);
  const enc = new TextEncoder();
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i === -1) continue;
    const kid = pair.slice(0, i).trim();
    const secret = pair.slice(i + 1).trim();
    if (kid && secret.length >= 32) {
      out[kid] = enc.encode(secret);
    }
  }
  if (!out[ACTIVE_KID]) {
    throw new Error(
      "SESSION_SECRET (or SESSION_SECRETS with kid=v1) is required (≥32 chars). " +
        "Generate one with `openssl rand -base64 48`.",
    );
  }
  return out;
}

export async function createSessionToken(
  input: Omit<Session, "iat" | "exp">,
): Promise<string> {
  const keys = getKeys();
  return await new SignJWT({ ...input })
    .setProtectedHeader({ alg: ALG, typ: "JWT", kid: ACTIVE_KID })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .sign(keys[ACTIVE_KID]!);
}

export async function verifySessionToken(
  token: string,
): Promise<Session | null> {
  const keys = getKeys();
  try {
    const { payload } = await jwtVerify(
      token,
      // Key resolver — `jose` calls this with the parsed (but not yet
      // verified) header so we can pick the key by `kid` before the HMAC
      // check runs.
      (header) => {
        const k =
          typeof header.kid === "string" ? keys[header.kid] : undefined;
        if (!k) throw new joseErrors.JWKSNoMatchingKey();
        return k;
      },
      {
        // Hard-pin the algorithm so a token can't dictate its own verify
        // algorithm (the `alg:none` / confusion defense).
        algorithms: [ALG],
        // Reject any token without an `exp` claim. We always mint with one,
        // and there's no server-side store — an exp-less token would be
        // effectively immortal, revocable only by dropping its key.
        requiredClaims: ["exp"],
        clockTolerance: "5s",
      },
    );
    // `jwtVerify` proved the bytes are authentic and enforced `exp`. The
    // remaining fields are app claims `jose` doesn't know about — validate
    // their *shape* before handing back a security context. A validly-signed
    // but malformed payload (a future minting bug, a `provider` drifting out
    // of {google, microsoft}, a missing `emailVerified`) degrades to `null`
    // (logged out), exactly like a bad signature, instead of impersonating
    // with an ill-typed session.
    const parsed = SessionClaims.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
