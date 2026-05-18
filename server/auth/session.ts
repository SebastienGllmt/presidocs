// Session: HMAC-signed cookie carrying the logged-in user's identity.
//
// Format is `<base64url(json)>.<base64url(hmac)>` — JWT-shaped but
// without the JOSE header (we only ever sign with one algorithm, so the
// header would be dead weight). Verification is constant-time.
//
// All session state lives in the cookie. There's no server-side session
// store, which means there's no revocation path short of rotating
// SESSION_SECRET (which invalidates every active session). For a comments
// system this trade is fine: the blast radius of a stolen session is
// "someone posts as you for up to 30 days," not access to anything
// destructive. If revocation ever becomes a requirement, swap this file
// for an R2-backed session-id model — the route handlers don't need to
// know which one is in use.

import { createHmac, timingSafeEqual } from "node:crypto";

export type Session = {
  // `<provider>:<sub>` — globally unique across providers.
  userId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  provider: "google" | "microsoft";
  iat: number; // ms since epoch
  exp: number; // ms since epoch
};

// 400 days is the practical max — Chrome (since v104), Firefox, and
// Safari all clamp any cookie Max-Age beyond this down to 400 days, in
// line with the HTTP State Tokens proposal. Setting a larger value here
// would mismatch the JSON `exp` against the actual cookie lifetime.
export const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "SESSION_SECRET env var is required (≥32 chars). Generate one with `openssl rand -base64 48`.",
    );
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret())
    .update(payload)
    .digest("base64url");
}

export function createSessionToken(
  input: Omit<Session, "iat" | "exp">,
): string {
  const now = Date.now();
  const session: Session = { ...input, iat: now, exp: now + SESSION_TTL_MS };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string): Session | null {
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Session;
    if (typeof session.exp !== "number" || session.exp < Date.now()) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}
