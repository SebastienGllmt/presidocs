// Client-side identity helpers.
//
// The server holds the actual auth state in a signed cookie; the browser
// only sees a public projection of it via GET /auth/me. This module is a
// thin wrapper: one fetch on boot, cached for the page lifetime. We never
// trust the cached value for security decisions (the server re-checks
// the cookie on every protected request) — it's purely a UI hint.

// The identity shape is the `z.infer` of the shared `IdentityResponse`
// schema (`<provider>:<sub>` userId + public profile subset). Deriving it
// from the schema keeps this client view and the server's `/auth/me` body
// from drifting — the same single-source-of-truth pattern every other
// client fetch wrapper already follows.
import { z } from "zod";
import { IdentityResponse, type Identity } from "../shared/authSchemas.ts";
export type { Identity };

// `/auth/me` returns either the identity object or the JSON literal `null`.
const IdentityOrNull = z.union([IdentityResponse, z.null()]);

let _identity: Identity | null | undefined = undefined;

export async function loadIdentity(): Promise<Identity | null> {
  if (_identity !== undefined) return _identity;
  try {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    if (!res.ok) {
      _identity = null;
      return null;
    }
    // /auth/me returns the literal `null` (not an error) when not logged in.
    // Validate the body instead of blind-casting it: a malformed response
    // degrades to `null` (the login-button branch), exactly like a logged-out
    // reader — the same degrade-don't-trust posture the other fetch wrappers use.
    const result = IdentityOrNull.safeParse(await res.json());
    _identity = result.success ? result.data : null;
    return _identity;
  } catch {
    _identity = null;
    return null;
  }
}

export function loginUrl(
  provider: "google" | "microsoft",
  returnTo: string = window.location.pathname + window.location.search,
): string {
  return `/auth/${provider}?return_to=${encodeURIComponent(returnTo)}`;
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } finally {
    _identity = null;
    window.location.reload();
  }
}
