// Minimal cookie utilities. We avoid pulling in `cookie` from npm — the
// only things we need are: serialize one Set-Cookie with the attributes we
// care about, parse a Cookie header into a record, and emit a delete
// directive (Max-Age=0). Multiple cookies on one response are sent by
// calling Headers.append("Set-Cookie", ...) per cookie.

export type CookieOpts = {
  maxAge?: number; // seconds; omit for a session cookie
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
};

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOpts = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.httpOnly ?? true) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function clearCookie(name: string, opts: CookieOpts = {}): string {
  return serializeCookie(name, "", { ...opts, maxAge: 0 });
}
