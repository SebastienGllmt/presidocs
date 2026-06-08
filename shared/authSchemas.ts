// Auth identity shapes, declared once. Two schemas, one family:
//
//   SessionClaims    — the full signed JWT claim shape (server-only consumer:
//                      `server/auth/session.ts` validates the decoded payload
//                      after `jose` proves the bytes authentic).
//   IdentityResponse — the PUBLIC subset `GET /auth/me` returns to the browser,
//                      derived from SessionClaims so the two can't drift.
//
// IdentityResponse lives here (in `shared/`, not `server/`) because both the
// client (`client/identity.ts` parses the /auth/me body) and the OpenAPI
// document (`server/openapi.ts`) consume it; deriving it from SessionClaims
// keeps the wire shape a provable subset of the claim shape. SessionClaims
// only depends on zod + the shared `UserId` primitive, so nothing server-only
// reaches the client bundle.
//
// Validates SHAPE only, never authorization (the same rule the comment schemas
// carry): a passing parse means "well-formed", never "allowed".

import "./zodJitless.ts"; // configure jitless before any parse (CSP / Workers no-eval)
import { z } from "zod";
import { UserId } from "./commentSchemas.ts";

// The session-cookie claim shape. `jose` verifies the bytes are *authentic*
// (HMAC, the algorithm allowlist, `exp`); this validates the JSON inside is the
// *shape* the app trusts. Reuses the `UserId` primitive (`<provider>:<sub>`)
// rather than re-stating the regex, so the security-critical identity field is
// pinned identically here and at the comment-store boundary.
//
// Deliberately a bare `z.object` (strips unknown keys, NOT `.strict()`): an
// *additive* future claim — a sliding-window refresh marker, a later
// `iss`/`aud` — must not log everyone out on a deploy skew. `iat`/`exp` are
// `jose`-injected and already enforced by the verifier (`requiredClaims`,
// `clockTolerance`), so they're plain `z.number()` — we don't re-validate
// temporal bounds.
export const SessionClaims = z.object({
  userId: UserId, // `<provider>:<sub>` — globally unique across providers.
  email: z.string(),
  emailVerified: z.boolean(),
  name: z.string().optional(),
  picture: z.string().optional(),
  provider: z.enum(["google", "microsoft"]),
  iat: z.number(), // seconds since epoch (JWT standard — RFC 7519 §4.1.6)
  exp: z.number(), // seconds since epoch (JWT standard — RFC 7519 §4.1.4)
});

// Single source of truth: the Session type is derived from the validator.
export type Session = z.infer<typeof SessionClaims>;

// The public projection `GET /auth/me` serves. A strict subset of the claims
// (no `iat`/`exp`), with one wire-shape difference: `whoami` emits
// `session.name ?? null` / `session.picture ?? null`, so on the wire these are
// `string | null` (always present), not the optional `string?` of the claim.
export const IdentityResponse = SessionClaims.omit({
  iat: true,
  exp: true,
}).extend({
  name: z.string().nullable(),
  picture: z.string().nullable(),
});

export type Identity = z.infer<typeof IdentityResponse>;
