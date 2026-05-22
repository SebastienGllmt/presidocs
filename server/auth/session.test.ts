import { test, expect, beforeEach, afterEach } from "bun:test";
import { decodeProtectedHeader, decodeJwt } from "jose";

// session.ts reads secrets from env at call time (getKeys), so each test
// sets the env it needs and we re-import a fresh module instance to reset
// ACTIVE_KID-bound state. A cache-busting query keeps imports isolated.
let n = 0;
async function loadSession(env: Record<string, string | undefined>) {
  for (const k of ["SESSION_SECRET", "SESSION_SECRETS"]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import(`./session.ts?t=${n++}`);
}

const SECRET = "test-secret-at-least-32-chars-long-xx";
const sampleInput = {
  userId: "google:123",
  email: "a@b.com",
  emailVerified: true,
  name: "A",
  picture: "p",
  provider: "google" as const,
};

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ["SESSION_SECRET", "SESSION_SECRETS"]) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

test("mints a real 3-segment JWT with HS256/typ/kid header", async () => {
  const { createSessionToken } = await loadSession({ SESSION_SECRET: SECRET });
  const tok = await createSessionToken(sampleInput);
  expect(tok.split(".").length).toBe(3);
  expect(decodeProtectedHeader(tok)).toEqual({
    alg: "HS256",
    typ: "JWT",
    kid: "v1",
  });
});

test("iat/exp are seconds-scale and TTL is 400 days", async () => {
  const { createSessionToken } = await loadSession({ SESSION_SECRET: SECRET });
  const claims = decodeJwt(await createSessionToken(sampleInput));
  const nowS = Math.floor(Date.now() / 1000);
  expect(Math.abs((claims.iat as number) - nowS)).toBeLessThan(5);
  expect(((claims.exp as number) - (claims.iat as number)) / 86400).toBe(400);
});

test("round-trips: verify returns the signed claims", async () => {
  const { createSessionToken, verifySessionToken } = await loadSession({
    SESSION_SECRET: SECRET,
  });
  const session = await verifySessionToken(await createSessionToken(sampleInput));
  expect(session?.userId).toBe("google:123");
  expect(session?.email).toBe("a@b.com");
  expect(session?.emailVerified).toBe(true);
});

test("rejects a tampered signature", async () => {
  const { createSessionToken, verifySessionToken } = await loadSession({
    SESSION_SECRET: SECRET,
  });
  const tok = await createSessionToken(sampleInput);
  expect(await verifySessionToken(tok.slice(0, -3) + "AAA")).toBeNull();
});

test("rejects garbage and legacy 2-segment tokens (hard cutover)", async () => {
  const { verifySessionToken } = await loadSession({ SESSION_SECRET: SECRET });
  expect(await verifySessionToken("not.a.jwt")).toBeNull();
  expect(await verifySessionToken("abc.def")).toBeNull(); // old headerless format
  expect(await verifySessionToken("")).toBeNull();
});

test("rejects a token signed under a different secret", async () => {
  const { createSessionToken } = await loadSession({
    SESSION_SECRET: "secret-number-one-at-least-32-chars-x",
  });
  const tok = await createSessionToken(sampleInput);
  const { verifySessionToken } = await loadSession({
    SESSION_SECRET: "secret-number-two-totally-different-y",
  });
  expect(await verifySessionToken(tok)).toBeNull();
});

test("SESSION_SECRETS map: signs with active kid, verifies during rotation overlap", async () => {
  // Both v1 (active) and v2 present — the rotation overlap window.
  const { createSessionToken, verifySessionToken } = await loadSession({
    SESSION_SECRETS:
      "v1:rotation-key-one-at-least-32-chars-xx,v2:rotation-key-two-at-least-32-chars-yy",
  });
  const tok = await createSessionToken(sampleInput);
  expect(decodeProtectedHeader(tok).kid).toBe("v1");
  expect((await verifySessionToken(tok))?.userId).toBe("google:123");
});

test("rejects a token whose kid is a prototype key name (__proto__/constructor)", async () => {
  const { createSessionToken, verifySessionToken } = await loadSession({
    SESSION_SECRET: SECRET,
  });
  // Take a valid token and rewrite its header `kid` to a prototype member.
  const tok = await createSessionToken(sampleInput);
  const [, body, sig] = tok.split(".");
  for (const kid of ["__proto__", "constructor", "toString"]) {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT", kid }),
    ).toString("base64url");
    expect(await verifySessionToken(`${header}.${body}.${sig}`)).toBeNull();
  }
});

test("empty SESSION_SECRETS does not shadow a valid SESSION_SECRET", async () => {
  // `||` (not `??`) precedence: an empty SESSION_SECRETS must fall through.
  const { createSessionToken, verifySessionToken } = await loadSession({
    SESSION_SECRETS: "",
    SESSION_SECRET: SECRET,
  });
  const session = await verifySessionToken(await createSessionToken(sampleInput));
  expect(session?.userId).toBe("google:123");
});

test("rejects a validly-signed token that has no exp claim", async () => {
  // Sign directly with jose, omitting setExpirationTime, using our secret.
  const { SignJWT } = await import("jose");
  const { verifySessionToken } = await loadSession({ SESSION_SECRET: SECRET });
  const noExp = await new SignJWT({ ...sampleInput })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: "v1" })
    .setIssuedAt()
    .sign(new TextEncoder().encode(SECRET));
  expect(await verifySessionToken(noExp)).toBeNull();
});

test("throws a clear error when no usable secret is configured", async () => {
  const { createSessionToken } = await loadSession({ SESSION_SECRET: "" });
  await expect(createSessionToken(sampleInput)).rejects.toThrow(/required/);
});

test("throws when the secret is shorter than 32 chars", async () => {
  const { createSessionToken } = await loadSession({ SESSION_SECRET: "tooshort" });
  await expect(createSessionToken(sampleInput)).rejects.toThrow(/required/);
});
