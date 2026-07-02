// Unit tests for the OAuth login flow route handlers (methodology.md →
// Hardening): state/PKCE/cookie binding, the open-redirect mitigation, the
// error-oracle uniformity (RFC 9457 non-leakage), plus whoami and logout.
//
// Handlers are exercised directly. Sessions/JWTs are real (createSessionToken /
// verifySessionToken); only the global `fetch` (arctic token exchange +
// provider userinfo) is stubbed, dispatched on URL substring per §1.7. No
// module mocking.
//
// NOTE: never import ../../happydom.ts here — and happy-dom leaked from
// client/* files would drop the forbidden `cookie` request header AND appended
// Set-Cookie headers, failing these assertions for the wrong reason. The
// useNativeWebClasses() call below restores Bun's native classes for this
// file's duration (see nativedom.ts for the leak mechanics).

import { test, expect, describe, beforeAll, afterEach } from "bun:test";
import { useNativeWebClasses } from "../../nativedom.ts";
import {
  startGoogleAuth,
  startMicrosoftAuth,
  googleCallback,
  microsoftCallback,
  whoami,
  logout,
} from "./routes.ts";
import { createSessionToken, verifySessionToken, SESSION_TTL_S } from "./session.ts";

const TOKEN_OK = {
  access_token: "tok",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid email profile",
};
const USERINFO_OK = {
  sub: "123",
  email: "a@b.com",
  email_verified: true,
  name: "A",
  picture: "p",
};

// ----- env hygiene (§1.8): SESSION_SECRET + the four OAuth client vars are set
// in beforeAll, snapshot is taken there, and afterEach restores it. The
// misconfig test (first) deletes the OAuth vars locally; afterEach restores.
let savedEnv: Record<string, string | undefined>;
let realFetch: typeof fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv as Record<string, string>);
});

// Must be called before the beforeAll below: hooks run in registration order,
// so the helper's unregister happens before realFetch captures native fetch.
useNativeWebClasses();

let validSession: string;

beforeAll(async () => {
  realFetch = globalThis.fetch; // native fetch, captured after unregister
  process.env.SESSION_SECRET = "test-secret-at-least-32-chars-long-xx";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "dummy-google-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "dummy-google-secret";
  process.env.MICROSOFT_OAUTH_CLIENT_ID = "dummy-ms-id";
  process.env.MICROSOFT_OAUTH_CLIENT_SECRET = "dummy-ms-secret";
  savedEnv = { ...process.env };
  validSession = await createSessionToken({
    userId: "google:alice-sub", email: "alice@example.com", emailVerified: true,
    name: "Alice", picture: "pic", provider: "google",
  });
});

// ----- fetch stub: dispatch on URL substring, record calls -----
function installFetch(opts: {
  token?: { status: number; body: unknown };
  userinfo?: { status: number; body: unknown };
} = {}): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    calls.push(u);
    if (u.includes("/token")) {
      const t = opts.token ?? { status: 200, body: TOKEN_OK };
      return new Response(JSON.stringify(t.body), { status: t.status, headers: { "content-type": "application/json" } });
    }
    if (u.includes("userinfo")) {
      const ui = opts.userinfo ?? { status: 200, body: USERINFO_OK };
      return new Response(JSON.stringify(ui.body), { status: ui.status, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected fetch: " + u);
  }) as unknown as typeof fetch;
  return calls;
}

// ----- helpers -----
function startReq(returnTo?: string): Request {
  const url = new URL("http://test.local/auth/google");
  if (returnTo !== undefined) url.searchParams.set("return_to", returnTo);
  return new Request(url);
}

function callbackReq(
  provider: "google" | "microsoft",
  query: Record<string, string>,
  cookies: Record<string, string>,
): Request {
  const url = new URL(`http://test.local/auth/${provider}/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  const headers: Record<string, string> = {};
  if (cookieHeader) headers.cookie = cookieHeader;
  return new Request(url, { headers });
}

function parseSetCookie(sc: string) {
  const parts = sc.split(";").map((p) => p.trim());
  const nv = parts[0]!;
  const eq = nv.indexOf("=");
  const name = nv.slice(0, eq);
  const value = decodeURIComponent(nv.slice(eq + 1));
  const attrs: Record<string, string> = {};
  for (const a of parts.slice(1)) {
    const i = a.indexOf("=");
    if (i >= 0) attrs[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
    else attrs[a.toLowerCase()] = "";
  }
  return { name, value, attrs, raw: sc };
}

function cookiesByName(res: Response) {
  const out: Record<string, ReturnType<typeof parseSetCookie>> = {};
  for (const sc of res.headers.getSetCookie()) {
    const parsed = parseSetCookie(sc);
    out[parsed.name] = parsed;
  }
  return out;
}

async function problemBody(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  return (await res.json()) as Record<string, unknown>;
}

// The set of flow cookies startAuth would set, hand-crafted for callback tests.
function flowCookies(state: string, returnTo = "/posts/x") {
  return {
    "blog-oauth-state-google": state,
    "blog-oauth-verifier-google": "verifier-value",
    "blog-oauth-return-to-google": returnTo,
  };
}

// =====================================================================
// MUST BE THE FIRST test() IN THIS FILE. providers.ts caches its Google /
// Microsoft singletons in module scope, and a FAILED required() throw does NOT
// cache (the instance stays null). So the only moment we can observe a
// misconfigured-provider 500 is before any test successfully constructs a
// provider. Keep this first; do not reorder above it. (§1.3 / D2)
test("0. misconfigured provider → 500 auth/misconfigured, no underlying error text leaked", async () => {
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const res = startGoogleAuth(startReq());
  expect(res.status).toBe(500);
  const body = await problemBody(res);
  expect(body.type as string).toEndWith("auth/misconfigured");
  // RFC 9457 non-leakage: the underlying "GOOGLE_OAUTH_CLIENT_ID ... required"
  // message must not reach the client.
  expect(JSON.stringify(body)).not.toContain("GOOGLE_OAUTH_CLIENT_ID");
});

// =====================================================================
describe("startAuth", () => {
  test("1. google: 302 to accounts.google.com with client_id/state/PKCE/redirect_uri", () => {
    const res = startGoogleAuth(startReq());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("client_id")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")!).toEndWith("/auth/google/callback");
  });

  test("1b. microsoft: 302 to login.microsoftonline.com with matching redirect_uri", () => {
    const res = startMicrosoftAuth(new Request(new URL("http://test.local/auth/microsoft")));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.host).toBe("login.microsoftonline.com");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")!).toEndWith("/auth/microsoft/callback");
  });

  test("2. exactly 3 flow cookies, correct attrs, state cookie value == Location state", () => {
    const res = startGoogleAuth(startReq());
    const set = res.headers.getSetCookie();
    expect(set.length).toBe(3);
    const by = cookiesByName(res);
    for (const name of ["blog-oauth-state-google", "blog-oauth-verifier-google", "blog-oauth-return-to-google"]) {
      const c = by[name]!;
      expect(c.raw).toContain("HttpOnly");
      expect(c.attrs["max-age"]).toBe("600");
      // Code emits `SameSite=lax` (opts.sameSite === "lax"); browsers treat the
      // token case-insensitively, so assert case-insensitively.
      expect(c.attrs["samesite"]!.toLowerCase()).toBe("lax");
      expect(c.attrs["path"]).toBe("/");
      expect(c.raw).not.toContain("Secure"); // dev posture
    }
    const loc = new URL(res.headers.get("Location")!);
    expect(by["blog-oauth-state-google"]!.value).toBe(loc.searchParams.get("state")!);
  });

  test("3. return_to filtering (via the return-to cookie value)", () => {
    const cases: Array<[string | undefined, string]> = [
      ["/posts/x", "/posts/x"],
      ["https://evil.example", "/"],
      ["//evil.example", "/"],
      ["/\\evil.example", "/"],
      [undefined, "/"],
    ];
    for (const [input, expected] of cases) {
      const res = startGoogleAuth(startReq(input));
      const by = cookiesByName(res);
      expect(by["blog-oauth-return-to-google"]!.value).toBe(expected);
    }
  });
});

// =====================================================================
describe("handleCallback", () => {
  test("4. ?error=access_denied → 400 oauth-provider-error, providerError echoed, zero fetches", async () => {
    const calls = installFetch();
    const res = await googleCallback(callbackReq("google", { error: "access_denied" }, {}));
    expect(res.status).toBe(400);
    const b = await problemBody(res);
    expect(b.type as string).toEndWith("auth/oauth-provider-error");
    expect(b.providerError).toBe("access_denied");
    expect(calls).toEqual([]);
  });

  test("5. ?error= non-RFC6749 marker → providerError 'unknown', raw marker not reflected", async () => {
    installFetch();
    const marker = 'evil"<script>marker';
    const res = await googleCallback(callbackReq("google", { error: marker }, {}));
    expect(res.status).toBe(400);
    const b = await problemBody(res);
    expect(b.providerError).toBe("unknown");
    expect(JSON.stringify(b)).not.toContain("marker");
  });

  test("6. missing code (or state) → 400 auth/callback-invalid", async () => {
    installFetch();
    const res = await googleCallback(callbackReq("google", { state: "s" }, {}));
    expect(res.status).toBe(400);
    expect((await problemBody(res)).type as string).toEndWith("auth/callback-invalid");
  });

  test("7. state mismatch → 400, SAME slug as row 6 (no oracle for which check failed)", async () => {
    installFetch();
    const missing = await googleCallback(callbackReq("google", { code: "c" }, {}));
    const mismatch = await googleCallback(
      callbackReq("google", { code: "c", state: "query-state" }, flowCookies("different-cookie-state")),
    );
    expect(mismatch.status).toBe(400);
    const a = await problemBody(missing);
    const b = await problemBody(mismatch);
    expect(b.type).toBe(a.type);
    expect(b.type as string).toEndWith("auth/callback-invalid");
  });

  test("8. missing cookies entirely (query fine) → 400 auth/callback-invalid", async () => {
    installFetch();
    const res = await googleCallback(callbackReq("google", { code: "c", state: "s" }, {}));
    expect(res.status).toBe(400);
    expect((await problemBody(res)).type as string).toEndWith("auth/callback-invalid");
  });

  test("9. provider binding: -google cookies, microsoft callback → 400", async () => {
    installFetch();
    const res = await microsoftCallback(
      callbackReq("microsoft", { code: "c", state: "s" }, flowCookies("s")),
    );
    expect(res.status).toBe(400);
    expect((await problemBody(res)).type as string).toEndWith("auth/callback-invalid");
  });

  test("10. token exchange fails (token endpoint 400) → 400 auth/callback-invalid", async () => {
    installFetch({ token: { status: 400, body: { error: "invalid_grant" } } });
    const res = await googleCallback(
      callbackReq("google", { code: "c", state: "s" }, flowCookies("s")),
    );
    expect(res.status).toBe(400);
    expect((await problemBody(res)).type as string).toEndWith("auth/callback-invalid");
  });

  test("11. userinfo fails (token OK, userinfo 500) → 502 auth/userinfo-unavailable", async () => {
    installFetch({ userinfo: { status: 500, body: {} } });
    const res = await googleCallback(
      callbackReq("google", { code: "c", state: "s" }, flowCookies("s")),
    );
    expect(res.status).toBe(502);
    expect((await problemBody(res)).type as string).toEndWith("auth/userinfo-unavailable");
  });

  test("12. happy path → 302 /posts/x, valid session cookie, 3 flow cookies cleared", async () => {
    installFetch();
    const res = await googleCallback(
      callbackReq("google", { code: "c", state: "s" }, flowCookies("s", "/posts/x")),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/posts/x");

    const set = res.headers.getSetCookie();
    expect(set.length).toBe(4);
    const by = cookiesByName(res);

    const session = by["blog-session"]!;
    expect(session.raw).toContain("HttpOnly");
    expect(session.attrs["samesite"]!.toLowerCase()).toBe("lax");
    expect(session.attrs["path"]).toBe("/");
    expect(session.attrs["max-age"]).toBe(String(SESSION_TTL_S)); // 34560000 (400d)

    const verified = await verifySessionToken(session.value);
    expect(verified?.userId).toBe("google:123");
    expect(verified?.email).toBe("a@b.com");
    expect(verified?.emailVerified).toBe(true);
    expect(verified?.provider).toBe("google");

    for (const name of ["blog-oauth-state-google", "blog-oauth-verifier-google", "blog-oauth-return-to-google"]) {
      expect(by[name]!.attrs["max-age"]).toBe("0");
    }
  });

  test("13. return-to re-validation: forged cookie https://evil.example → Location /", async () => {
    installFetch();
    const res = await googleCallback(
      callbackReq("google", { code: "c", state: "s" }, flowCookies("s", "https://evil.example")),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });
});

// =====================================================================
describe("whoami", () => {
  test("14. no cookie → 200 null, private no-store", async () => {
    const res = await whoami(new Request("http://test.local/auth/me"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toBeNull();
  });

  test("15. garbage cookie → 200 null (degrades to logged-out)", async () => {
    const res = await whoami(new Request("http://test.local/auth/me", { headers: { cookie: "blog-session=nonsense" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("16. valid session → 200; exact public key set, no iat/exp, no-store", async () => {
    const res = await whoami(new Request("http://test.local/auth/me", { headers: { cookie: `blog-session=${validSession}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["email", "emailVerified", "name", "picture", "provider", "userId"],
    );
    expect(body).not.toHaveProperty("iat");
    expect(body).not.toHaveProperty("exp");
    expect(body.userId).toBe("google:alice-sub");
  });
});

// =====================================================================
describe("logout", () => {
  test("17. → 200 null; one Set-Cookie clearing blog-session, Max-Age=0, Path=/", async () => {
    const res = logout(new Request("http://test.local/auth/logout"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    const set = res.headers.getSetCookie();
    expect(set.length).toBe(1);
    const c = parseSetCookie(set[0]!);
    expect(c.name).toBe("blog-session");
    expect(c.attrs["max-age"]).toBe("0");
    expect(c.attrs["path"]).toBe("/");
  });
});

// =====================================================================
describe("prod posture (D3)", () => {
  test("18. NODE_ENV=production: __Host- session cookie + Secure across callback/logout/whoami", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      installFetch();
      const cb = await googleCallback(
        callbackReq("google", { code: "c", state: "s" }, flowCookies("s", "/posts/x")),
      );
      const cbCookies = cookiesByName(cb);
      const hostSession = cbCookies["__Host-blog-session"];
      expect(hostSession).toBeDefined();
      expect(hostSession!.raw).toContain("Secure");

      const out = logout(new Request("http://test.local/auth/logout"));
      const lc = parseSetCookie(out.headers.getSetCookie()[0]!);
      expect(lc.name).toBe("__Host-blog-session");
      expect(lc.raw).toContain("Secure");
      expect(lc.attrs["path"]).toBe("/");
      expect(lc.attrs["max-age"]).toBe("0");

      // whoami must resolve a session from a __Host-blog-session cookie in prod.
      const me = await whoami(
        new Request("http://test.local/auth/me", {
          headers: { cookie: `__Host-blog-session=${encodeURIComponent(hostSession!.value)}` },
        }),
      );
      expect(me.status).toBe(200);
      const body = (await me.json()) as Record<string, unknown> | null;
      expect(body?.userId).toBe("google:123");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
