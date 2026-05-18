// arctic OAuth provider instances. Lazily constructed so that missing env
// vars don't blow up the whole server at boot — only the auth routes
// themselves fail (with a useful error) if someone hits them without
// configured credentials.

import { Google, MicrosoftEntraId } from "arctic";

export type ProviderName = "google" | "microsoft";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required for OAuth`);
  return v;
}

export function getRedirectBase(): string {
  return (
    process.env.OAUTH_REDIRECT_BASE ??
    `http://localhost:${process.env.PORT ?? 3000}`
  );
}

export function redirectUri(provider: ProviderName): string {
  return `${getRedirectBase()}/auth/${provider}/callback`;
}

let _google: Google | null = null;
export function googleProvider(): Google {
  if (!_google) {
    _google = new Google(
      required("GOOGLE_OAUTH_CLIENT_ID"),
      required("GOOGLE_OAUTH_CLIENT_SECRET"),
      redirectUri("google"),
    );
  }
  return _google;
}

let _microsoft: MicrosoftEntraId | null = null;
export function microsoftProvider(): MicrosoftEntraId {
  if (!_microsoft) {
    // The `common` tenant endpoint accepts any Entra ID account from any
    // organization (work/school across companies + universities) plus
    // personal Microsoft accounts. This is what makes "Sign in with
    // Microsoft" cover the long tail of corporate / .edu emails without us
    // pre-registering each tenant.
    _microsoft = new MicrosoftEntraId(
      "common",
      required("MICROSOFT_OAUTH_CLIENT_ID"),
      required("MICROSOFT_OAUTH_CLIENT_SECRET"),
      redirectUri("microsoft"),
    );
  }
  return _microsoft;
}

// `openid` enables the OIDC layer; `email` and `profile` add the
// corresponding userinfo claims. We deliberately do *not* request
// `offline_access` — sessions are cookie-bound and we never need to
// refresh a token after the initial userinfo call.
export const GOOGLE_SCOPES = ["openid", "email", "profile"];
export const MICROSOFT_SCOPES = ["openid", "email", "profile"];
