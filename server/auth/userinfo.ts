// Provider-specific userinfo fetchers. Both providers expose a standard
// OIDC `/userinfo` endpoint that returns the user's identity claims
// given a valid access token; we use that rather than decoding the ID
// token directly so we don't have to verify JWT signatures against each
// provider's JWKS. The trust model: we got the access token from the
// provider over TLS five milliseconds ago, then called the provider's
// userinfo endpoint over TLS with that token — there's no extra
// guarantee that JWT signature verification would add here.

export type UserInfo = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

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
  const data = (await res.json()) as {
    sub: string;
    email: string;
    email_verified: boolean;
    name?: string;
    picture?: string;
  };
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
  const data = (await res.json()) as {
    sub: string;
    email?: string;
    preferred_username?: string;
    name?: string;
    picture?: string;
  };
  // Some work accounts ship `preferred_username` instead of `email` when
  // the admin has configured a non-mail UPN. preferred_username is also
  // an email address in practice for Entra accounts, so fall back to it.
  const email = data.email ?? data.preferred_username;
  if (!email) throw new Error("Microsoft userinfo returned no email");
  return {
    sub: data.sub,
    email,
    // Microsoft doesn't emit `email_verified` — Entra owns the address
    // namespace, so any email it returns is verified by definition.
    emailVerified: true,
    name: data.name,
    picture: data.picture,
  };
}
