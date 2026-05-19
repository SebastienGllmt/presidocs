// Thin fetch wrappers over the `/comments` route. Keeps the rest of
// the client free of URL strings + status-code branching. Every
// function throws on transport / authz failure; missing changes
// (404) return null, missing users (empty LIST) return an empty
// array.
//
// Route shape (mirrors server/comments/routes.ts):
//   GET    /comments?post=X                      → string[]   (userIds)            — author only
//   GET    /comments?post=X&user=Y               → ChangeListEntry[] (hash + meta)  — self or author
//   GET    /comments?post=X&user=Y&change=Z      → Uint8Array (one change's bytes)  — self or author
//   PUT    /comments?post=X&user=Y&change=Z      → 200                               — self only

export type ChangeListEntry = {
  hash: string;
  size: number;
  uploaded: string; // ISO 8601 (Date.toJSON())
};

function commentsUrl(
  post: string,
  user?: string,
  change?: string,
): string {
  const params = new URLSearchParams({ post });
  if (user !== undefined) params.set("user", user);
  if (change !== undefined) params.set("change", change);
  return `/comments?${params.toString()}`;
}

// Author-only — server returns 403 for non-authors.
export async function listUsers(post: string): Promise<string[]> {
  const res = await fetch(commentsUrl(post), { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`listUsers failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as string[];
}

export async function listChanges(
  post: string,
  user: string,
): Promise<ChangeListEntry[]> {
  const res = await fetch(commentsUrl(post, user), {
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`listChanges failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ChangeListEntry[];
}

export async function getChange(
  post: string,
  user: string,
  changeHash: string,
): Promise<Uint8Array | null> {
  const res = await fetch(commentsUrl(post, user, changeHash), {
    credentials: "same-origin",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`getChange failed: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function putChange(
  post: string,
  user: string,
  changeHash: string,
  bytes: Uint8Array,
): Promise<void> {
  const res = await fetch(commentsUrl(post, user, changeHash), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`putChange failed: ${res.status} ${res.statusText}`);
  }
}
