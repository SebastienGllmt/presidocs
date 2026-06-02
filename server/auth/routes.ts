// HTTP route handlers for the OAuth login flow.
//
// Flow per provider (Google shown; Microsoft is identical):
//   1. GET /auth/google           → generate state + PKCE verifier,
//                                   store in short-lived cookies, 302 to
//                                   Google's authorization endpoint.
//   2. (user authenticates at Google, possibly via their org's SAML IdP)
//   3. GET /auth/google/callback  → verify state matches, exchange code
//                                   for tokens, hit /userinfo, mint a
//                                   session cookie, 302 home.
//
// State + PKCE are bound to the *provider* in the cookie name so a stale
// callback from one provider can't be replayed against the other's
// in-flight flow. Both are HttpOnly with a 10-minute TTL.

import { StatusCodes } from "http-status-codes";
import {
  generateState,
  generateCodeVerifier,
  type OAuth2Tokens,
} from "arctic";

import {
  googleProvider,
  microsoftProvider,
  GOOGLE_SCOPES,
  MICROSOFT_SCOPES,
  type ProviderName,
} from "./providers.ts";
import {
  fetchGoogleUserInfo,
  fetchMicrosoftUserInfo,
  type UserInfo,
} from "./userinfo.ts";
import {
  createSessionToken,
  verifySessionToken,
  SESSION_TTL_MS,
  type Session,
} from "./session.ts";
import {
  serializeCookie,
  parseCookies,
  clearCookie,
  type CookieOpts,
} from "./cookies.ts";
import { problem } from "../../shared/problemDetails.ts";

// RFC 6749 §4.1.2.1 enumerates the legal `error` query values for the
// authorization-endpoint redirect. Reflecting the raw query value back
// in the problem-details body (even JSON-encoded) is attacker-
// controlled input; allow-list to the spec'd set and collapse the
// long tail to "unknown". Per RFC 9457 §5.
const RFC6749_ERROR_CODES = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

const SESSION_COOKIE_BASE = "blog-session";
const STATE_COOKIE_PREFIX = "blog-oauth-state-";
const VERIFIER_COOKIE_PREFIX = "blog-oauth-verifier-";
const RETURN_TO_COOKIE_PREFIX = "blog-oauth-return-to-";
const OAUTH_FLOW_TTL_S = 600; // 10 minutes

// Accept only local (same-origin) return paths. Rejects absolute URLs,
// protocol-relative URLs, and anything that isn't a single leading `/`.
// This is the standard open-redirect mitigation.
function safeReturnTo(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

// The `__Host-` prefix pins the cookie to this exact origin: the browser
// only accepts it when set with Secure, Path=/, and no Domain attribute
// (serializeCookie already satisfies the latter two). It requires Secure,
// which we only set in prod — so in dev (http://localhost, secure=false)
// the prefix would be rejected and we fall back to the bare name. The name
// is resolved consistently within an environment, so set/read/clear agree.
function sessionCookieName(): string {
  return isProd() ? `__Host-${SESSION_COOKIE_BASE}` : SESSION_COOKIE_BASE;
}

function tempCookieOpts(): CookieOpts {
  return {
    maxAge: OAUTH_FLOW_TTL_S,
    path: "/",
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
  };
}

function sessionCookieOpts(): CookieOpts {
  return {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    path: "/",
    httpOnly: true,
    secure: isProd(),
    sameSite: "lax",
  };
}

// ===== Begin flow =====

export function startGoogleAuth(req: Request): Response {
  return startAuth("google", req);
}

export function startMicrosoftAuth(req: Request): Response {
  return startAuth("microsoft", req);
}

function startAuth(provider: ProviderName, req: Request): Response {
  const returnTo = safeReturnTo(
    new URL(req.url).searchParams.get("return_to"),
  );

  let url: URL;
  let state: string;
  let codeVerifier: string;
  try {
    state = generateState();
    codeVerifier = generateCodeVerifier();
    url = provider === "google"
      ? googleProvider().createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES)
      : microsoftProvider().createAuthorizationURL(state, codeVerifier, MICROSOFT_SCOPES);
  } catch (err) {
    // Most likely: missing env var. Per RFC 9457 §5, do NOT surface the
    // raw provider/error message to the client — it can leak
    // implementation details. Log for the operator; respond with the
    // static problem-type title.
    console.warn(`auth misconfigured (${provider}):`, err);
    return problem(StatusCodes.INTERNAL_SERVER_ERROR, "auth/misconfigured");
  }

  const headers = new Headers({ Location: url.toString() });
  headers.append(
    "Set-Cookie",
    serializeCookie(`${STATE_COOKIE_PREFIX}${provider}`, state, tempCookieOpts()),
  );
  headers.append(
    "Set-Cookie",
    serializeCookie(
      `${VERIFIER_COOKIE_PREFIX}${provider}`,
      codeVerifier,
      tempCookieOpts(),
    ),
  );
  headers.append(
    "Set-Cookie",
    serializeCookie(
      `${RETURN_TO_COOKIE_PREFIX}${provider}`,
      returnTo,
      tempCookieOpts(),
    ),
  );
  return new Response(null, { status: StatusCodes.MOVED_TEMPORARILY, headers });
}

// ===== Callback =====

export async function googleCallback(req: Request): Promise<Response> {
  return handleCallback(req, "google");
}

export async function microsoftCallback(req: Request): Promise<Response> {
  return handleCallback(req, "microsoft");
}

async function handleCallback(
  req: Request,
  provider: ProviderName,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    // User cancelled at the provider, or admin blocked the app, etc.
    // The OAuth `error` codes are enumerated in RFC 6749 §4.1.2.1;
    // anything outside the enum collapses to "unknown" so we don't
    // reflect attacker-controlled query content into our problem body.
    const providerError = RFC6749_ERROR_CODES.has(oauthError)
      ? oauthError
      : "unknown";
    if (providerError === "unknown") {
      console.warn(`${provider} callback: unknown oauth error code:`, oauthError);
    }
    return problem(StatusCodes.BAD_REQUEST, "auth/oauth-provider-error", undefined, {
      providerError,
    });
  }
  if (!code || !state) {
    return problem(StatusCodes.BAD_REQUEST, "auth/callback-invalid");
  }
  const cookies = parseCookies(req.headers.get("cookie"));
  const expectedState = cookies[`${STATE_COOKIE_PREFIX}${provider}`];
  const verifier = cookies[`${VERIFIER_COOKIE_PREFIX}${provider}`];
  if (!expectedState || !verifier || state !== expectedState) {
    // CSRF surface — do NOT leak which of the three checks failed.
    // Same slug as the missing-code/state branch above.
    return problem(StatusCodes.BAD_REQUEST, "auth/callback-invalid");
  }

  let tokens: OAuth2Tokens;
  try {
    tokens = provider === "google"
      ? await googleProvider().validateAuthorizationCode(code, verifier)
      : await microsoftProvider().validateAuthorizationCode(code, verifier);
  } catch (err) {
    console.warn(`${provider} code exchange failed:`, err);
    return problem(StatusCodes.BAD_REQUEST, "auth/callback-invalid");
  }

  let userInfo: UserInfo;
  try {
    userInfo = provider === "google"
      ? await fetchGoogleUserInfo(tokens.accessToken())
      : await fetchMicrosoftUserInfo(tokens.accessToken());
  } catch (err) {
    console.warn(`${provider} userinfo failed:`, err);
    return problem(StatusCodes.BAD_GATEWAY, "auth/userinfo-unavailable");
  }

  const sessionToken = await createSessionToken({
    userId: `${provider}:${userInfo.sub}`,
    email: userInfo.email,
    emailVerified: userInfo.emailVerified,
    name: userInfo.name,
    picture: userInfo.picture,
    provider,
  });

  // Re-validate the cookie's return_to too — defense in depth, even
  // though startAuth already filtered it on the way in.
  const returnTo = safeReturnTo(cookies[`${RETURN_TO_COOKIE_PREFIX}${provider}`] ?? "/");

  const headers = new Headers({ Location: returnTo });
  headers.append(
    "Set-Cookie",
    serializeCookie(sessionCookieName(), sessionToken, sessionCookieOpts()),
  );
  headers.append(
    "Set-Cookie",
    clearCookie(`${STATE_COOKIE_PREFIX}${provider}`),
  );
  headers.append(
    "Set-Cookie",
    clearCookie(`${VERIFIER_COOKIE_PREFIX}${provider}`),
  );
  headers.append(
    "Set-Cookie",
    clearCookie(`${RETURN_TO_COOKIE_PREFIX}${provider}`),
  );
  return new Response(null, { status: StatusCodes.MOVED_TEMPORARILY, headers });
}

// ===== Session inspection / logout =====

export async function getSessionFromRequest(
  req: Request,
): Promise<Session | null> {
  const token = parseCookies(req.headers.get("cookie"))[sessionCookieName()];
  if (!token) return null;
  return await verifySessionToken(token);
}

// `GET /auth/me` — returns the public subset of the session as JSON, or
// `null` if not logged in. The client renders the login button when this
// is null and the user's name/avatar when it isn't. Whether this user
// is the *current post's* author is computed client-side by comparing
// `email` against the post's `<meta name="author-email">` tag (per-post,
// not site-wide — see `server/postMeta.ts`). The server independently
// enforces the same check on every author-only operation.
export async function whoami(req: Request): Promise<Response> {
  const session = await getSessionFromRequest(req);
  // This response echoes the logged-in user's identity (email, name,
  // picture), so it must not be cached by the browser or any shared cache —
  // same `private, no-store` the comment endpoints use.
  const noStore = { "Cache-Control": "private, no-store" };
  if (!session) {
    return new Response("null", {
      status: StatusCodes.OK,
      headers: { "Content-Type": "application/json", ...noStore },
    });
  }
  return Response.json(
    {
      userId: session.userId,
      email: session.email,
      emailVerified: session.emailVerified,
      name: session.name ?? null,
      picture: session.picture ?? null,
      provider: session.provider,
    },
    { headers: noStore },
  );
}

export function logout(_req: Request): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  // A `__Host-` cookie's clearing Set-Cookie must itself carry Secure +
  // Path=/ or the browser rejects it (the prefix rules apply to deletes
  // too), leaving the session cookie in place. Mirror sessionCookieOpts.
  headers.append(
    "Set-Cookie",
    clearCookie(sessionCookieName(), { secure: isProd(), path: "/" }),
  );
  return new Response("null", { status: StatusCodes.OK, headers });
}
