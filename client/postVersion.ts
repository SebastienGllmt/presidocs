// Client helpers for the per-post document-version concept.
//
// On boot we ask /post-version for the post's current SHA-256 (plus,
// for the post author, the history of past hashes). The comments UI
// compares the current hash to a localStorage entry of "last hash I
// showed this user" — if it differs (and a previous one was recorded),
// we render a banner so the user understands why their old comments
// might appear outdated or have been resolved.

export type PostVersionEntry = {
  hash: string;
  builtAt: string; // ISO 8601
};

export type PostVersionResponse = {
  currentHash: string;
  // Server-computed authoritative author flag (TLS-verified session
  // email vs. post's author-email meta tag). Use this instead of any
  // DOM-based check — the served HTML's `<meta name="author-email">`
  // tag is stripped in prod for spam reasons, so a client-side
  // `document.querySelector` check returns false there.
  isAuthor: boolean;
  // Only present when isAuthor === true.
  history?: PostVersionEntry[];
};

const LAST_SEEN_PREFIX = "blog-doc-version:";

function lastSeenKey(postPath: string): string {
  return `${LAST_SEEN_PREFIX}${postPath}`;
}

export async function fetchPostVersion(
  postPath: string,
): Promise<PostVersionResponse | null> {
  try {
    const res = await fetch(
      `/post-version?post=${encodeURIComponent(postPath)}`,
      { credentials: "same-origin" },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`fetchPostVersion: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as PostVersionResponse;
  } catch (err) {
    console.warn("fetchPostVersion failed:", err);
    return null;
  }
}

export function getLastSeenVersion(postPath: string): string | null {
  try {
    return localStorage.getItem(lastSeenKey(postPath));
  } catch {
    return null;
  }
}

export function setLastSeenVersion(postPath: string, hash: string): void {
  try {
    localStorage.setItem(lastSeenKey(postPath), hash);
  } catch {
    // localStorage may be disabled — fail silently; the worst-case is
    // a banner that won't go away.
  }
}
