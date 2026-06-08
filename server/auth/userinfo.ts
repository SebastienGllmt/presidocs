// Provider-specific userinfo fetchers. Both providers expose a standard
// OIDC `/userinfo` endpoint that returns the user's identity claims
// given a valid access token; we use that rather than decoding the ID
// token directly so we don't have to verify JWT signatures against each
// provider's JWKS. The trust model: we got the access token from the
// provider over TLS five milliseconds ago, then called the provider's
// userinfo endpoint over TLS with that token — there's no extra
// guarantee that JWT signature verification would add here.
//
// TLS authenticates the *peer*; it does not guarantee a well-formed
// *payload*. `sub` is OIDC-REQUIRED and becomes the permanent identity —
// it is folded into `userId = "<provider>:<sub>"`, the R2 object key for
// every comment the user ever writes and the value every authz check
// compares. An empty/missing/wrong-typed `sub` would silently mint a
// degenerate `google:`/`microsoft:` bucket keyed on the empty string,
// discovered only after it had been written to a permanent path. So we
// validate the response shape at this boundary instead of `as`-casting
// network JSON: a parse failure throws here, where the caller's existing
// try/catch maps it to `502 auth/userinfo-unavailable`.

import "../../shared/zodJitless.ts"; // configure jitless before any parse (CSP / Workers no-eval)
import { z } from "zod";

export type UserInfo = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

// Google's OIDC userinfo. Fields match what the fetcher already read; the
// new guarantees the cast never gave are `sub` / `email` non-empty and
// `email_verified` actually boolean. Unknown keys pass through (bare
// `z.object`), so a provider adding claims can't break a login.
const GoogleUserInfo = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

// Microsoft's OIDC userinfo. `sub` is REQUIRED-non-empty; the
// email-or-preferred_username presence check folds into the schema as a
// `transform` that also *normalizes* the chosen address, so the result
// carries a guaranteed `email: string` (no post-parse `!` assertion). A
// missing-both payload adds an issue → `parse` throws.
const MicrosoftUserInfo = z
  .object({
    sub: z.string().min(1),
    email: z.string().optional(),
    preferred_username: z.string().optional(),
    name: z.string().optional(),
    picture: z.string().optional(),
  })
  .transform((d, ctx) => {
    // Some work accounts ship `preferred_username` instead of `email` when
    // the admin has configured a non-mail UPN. preferred_username is also
    // an email address in practice for Entra accounts, so fall back to it.
    const email = d.email ?? d.preferred_username;
    if (!email) {
      ctx.addIssue({
        code: "custom",
        message:
          "Microsoft userinfo returned neither email nor preferred_username",
      });
      return z.NEVER;
    }
    return { sub: d.sub, email, name: d.name, picture: d.picture };
  });

export async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<UserInfo> {
  const res = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Google userinfo failed: ${res.status} ${res.statusText}`);
  }
  const data = GoogleUserInfo.parse(await res.json());
  return {
    sub: data.sub,
    email: data.email,
    emailVerified: data.email_verified,
    name: data.name,
    picture: data.picture,
  };
}

export async function fetchMicrosoftUserInfo(
  accessToken: string,
): Promise<UserInfo> {
  // Microsoft's OIDC userinfo lives on graph.microsoft.com (not on the
  // login endpoint). Requires only the `openid` scope.
  const res = await fetch("https://graph.microsoft.com/oidc/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Microsoft userinfo failed: ${res.status} ${res.statusText}`,
    );
  }
  // The schema validates `sub`, normalizes email-or-UPN, and throws if
  // neither is present (see MicrosoftUserInfo above) — so `data.email` is a
  // guaranteed non-empty string here.
  const data = MicrosoftUserInfo.parse(await res.json());
  return {
    sub: data.sub,
    email: data.email,
    // Microsoft doesn't emit `email_verified` — Entra owns the address
    // namespace, so any email it returns is verified by definition.
    emailVerified: true,
    name: data.name,
    picture: data.picture,
  };
}
