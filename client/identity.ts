// Client-side identity helpers.
//
// The server holds the actual auth state in a signed cookie; the browser
// only sees a public projection of it via GET /auth/me. This module is a
// thin wrapper: one fetch on boot, cached for the page lifetime. We never
// trust the cached value for security decisions (the server re-checks
// the cookie on every protected request) — it's purely a UI hint.

export type Identity = {
  userId: string;                       // `<provider>:<sub>`
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  provider: "google" | "microsoft";
};

// Authorship is per-post, encoded in the page's `<meta name="author-email">`
// tag. Returns true if the logged-in user's verified email matches that
// tag. Used purely as a UI hint — the server independently enforces
// the same comparison on every author-only operation.
export function isAuthorOfCurrentPost(identity: Identity | null): boolean {
  if (!identity) return false;
  if (!identity.emailVerified) return false;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="author-email"]',
  );
  const authorEmail = meta?.content.trim().toLowerCase();
  if (!authorEmail) return false;
  return identity.email.trim().toLowerCase() === authorEmail;
}

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
    const body = (await res.json()) as Identity | null;
    _identity = body;
    return body;
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
