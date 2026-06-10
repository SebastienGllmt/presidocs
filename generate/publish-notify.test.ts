import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJobs,
  cloudEventPayload,
  decideSnapshot,
  deliverJobs,
  buildSmokeJob,
  discordPayload,
  runSmoke,
  shareCardUrlFor,
  SMOKE_ENTRY,
  EVENT_TYPE,
  feedEntryIds,
  genericPayload,
  type FeedEntry,
  type Job,
  parseFeedEntries,
  runNotify,
  runSnapshot,
  selectNewEntries,
  signStandardWebhooks,
  slackPayload,
  truncate,
} from "./publish-notify.ts";
import { type BlogPaths } from "../shared/blogPaths.ts";
import { hasAnyChannel, resolveNotifyConfig } from "../shared/notifyConfig.ts";

// --- test doubles for the phase lifecycle -----------------------------------

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "notify-test-"));
  mkdirSync(join(d, "generated"), { recursive: true });
  mkdirSync(join(d, "dist"), { recursive: true });
  return d;
}
// The phases only touch generatedDir + distDir; a partial BlogPaths is enough.
function tmpPaths(dir: string): BlogPaths {
  return { generatedDir: join(dir, "generated"), distDir: join(dir, "dist") } as unknown as BlogPaths;
}
const snapFile = (dir: string) => join(dir, "generated", ".notify-snapshot.json");
const asFetch = (fn: (input?: unknown, init?: unknown) => Promise<Response>): typeof fetch =>
  fn as unknown as typeof fetch;
const respond = (body: string, status: number) => asFetch(async () => new Response(body, { status }));
// A fetch stub that records every POST it receives (the webhook deliveries).
function recordingFetch(received: Array<{ url: string; body: string }>): typeof fetch {
  return asFetch(async (url, init) => {
    received.push({ url: String(url), body: String((init as { body?: string } | undefined)?.body ?? "") });
    return new Response("", { status: 200 });
  });
}

// A minimal but structurally-real Atom feed, mirroring generate/feeds.ts.
function atomEntry(opts: {
  year: number;
  postPath: string;
  title: string;
  url: string;
  published: string;
  summary?: string;
}): string {
  return (
    `<entry>` +
    `<id>tag:blog.example.com,${opts.year}:${opts.postPath}</id>` +
    `<title>${opts.title}</title>` +
    `<link rel="alternate" type="text/html" href="${opts.url}"/>` +
    `<published>${opts.published}</published>` +
    `<updated>${opts.published}</updated>` +
    (opts.summary ? `<summary>${opts.summary}</summary>` : "") +
    `<content type="html">&lt;p&gt;body&lt;/p&gt;</content>` +
    `</entry>`
  );
}

function atomFeed(entries: string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom">` +
    `<id>tag:blog.example.com,2026:feed</id>` +
    `<title>Blog</title>` +
    `<link rel="self" type="application/atom+xml" href="https://blog.example.com/feed.xml"/>` +
    `<updated>2026-06-03T00:00:00.000Z</updated>` +
    entries.join("") +
    `</feed>\n`
  );
}

const E1 = atomEntry({
  year: 2026,
  postPath: "/posts/hash-functions",
  title: "Hash Functions",
  url: "https://blog.example.com/posts/hash-functions",
  published: "2026-05-25T04:07:37.106Z",
  summary: "What makes a good hash.",
});
const E2 = atomEntry({
  year: 2026,
  postPath: "/posts/offer-files",
  title: "Offer Files",
  url: "https://blog.example.com/posts/offer-files",
  published: "2026-06-03T03:19:03.240Z",
  summary: "Trading without a counterparty.",
});

const ENTRY: FeedEntry = {
  id: "tag:blog.example.com,2026:/posts/hash-functions",
  title: "Hash Functions",
  url: "https://blog.example.com/posts/hash-functions",
  summary: "What makes a good hash.",
  published: "2026-05-25T04:07:37.106Z",
};

// --- feed parsing -----------------------------------------------------------

test("parseFeedEntries — extracts id/title/url/summary/published", () => {
  const entries = parseFeedEntries(atomFeed([E1, E2]));
  expect(entries).toHaveLength(2);
  expect(entries[0]).toEqual({
    id: "tag:blog.example.com,2026:/posts/hash-functions",
    title: "Hash Functions",
    url: "https://blog.example.com/posts/hash-functions",
    summary: "What makes a good hash.",
    published: "2026-05-25T04:07:37.106Z",
  });
});

test("parseFeedEntries — single entry (parser yields object, not array)", () => {
  expect(parseFeedEntries(atomFeed([E1]))).toHaveLength(1);
});

test("parseFeedEntries — missing/empty feed is tolerated", () => {
  expect(parseFeedEntries("")).toEqual([]);
  expect(parseFeedEntries("<html>404</html>")).toEqual([]);
  expect(parseFeedEntries(atomFeed([]))).toEqual([]);
});

test("feedEntryIds — just the immutable ids", () => {
  expect(feedEntryIds(atomFeed([E1, E2]))).toEqual([
    "tag:blog.example.com,2026:/posts/hash-functions",
    "tag:blog.example.com,2026:/posts/offer-files",
  ]);
});

// --- diff / selection -------------------------------------------------------

test("selectNewEntries — set difference, oldest-first", () => {
  const entries = parseFeedEntries(atomFeed([E1, E2]));
  const oldIds = new Set(["tag:blog.example.com,2026:/posts/hash-functions"]);
  const got = selectNewEntries(entries, oldIds, false);
  expect(got.map((e) => e.title)).toEqual(["Offer Files"]);
});

test("selectNewEntries — multiple new posts come back chronologically", () => {
  const entries = parseFeedEntries(atomFeed([E2, E1])); // feed order: newest first
  const got = selectNewEntries(entries, new Set(), false);
  expect(got.map((e) => e.title)).toEqual(["Hash Functions", "Offer Files"]); // oldest → newest
});

test("selectNewEntries — an edit keeps its id, so it is NOT re-announced", () => {
  const entries = parseFeedEntries(atomFeed([E1, E2]));
  const oldIds = new Set([
    "tag:blog.example.com,2026:/posts/hash-functions",
    "tag:blog.example.com,2026:/posts/offer-files",
  ]);
  expect(selectNewEntries(entries, oldIds, false)).toEqual([]);
});

test("selectNewEntries — first run announces only the single newest", () => {
  const entries = parseFeedEntries(atomFeed([E1, E2]));
  const got = selectNewEntries(entries, new Set(), true);
  expect(got.map((e) => e.title)).toEqual(["Offer Files"]); // newest by published
});

// --- payload builders -------------------------------------------------------

test("genericPayload — bare title/url/summary", () => {
  expect(genericPayload(ENTRY)).toEqual({
    title: "Hash Functions",
    url: "https://blog.example.com/posts/hash-functions",
    summary: "What makes a good hash.",
  });
});

test("discordPayload — single embed, title-as-link + description", () => {
  expect(discordPayload(ENTRY)).toEqual({
    embeds: [
      {
        title: "Hash Functions",
        url: "https://blog.example.com/posts/hash-functions",
        description: "What makes a good hash.",
      },
    ],
  });
});

test("discordPayload — omits description when there is no summary", () => {
  expect(discordPayload({ ...ENTRY, summary: "" }).embeds[0]).not.toHaveProperty("description");
});

test("slackPayload — mrkdwn link + summary; section block mirrors the text", () => {
  const text = "<https://blog.example.com/posts/hash-functions|Hash Functions>\nWhat makes a good hash.";
  expect(slackPayload(ENTRY)).toEqual({
    text, // kept as the notification/preview fallback alongside blocks
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
});

test("slackPayload — share card becomes an image block; alt text is the title", () => {
  const p = slackPayload(ENTRY, "https://blog.example.com/assets/og/hash-functions.png");
  expect(p.blocks).toHaveLength(2);
  expect(p.blocks[1]).toEqual({
    type: "image",
    image_url: "https://blog.example.com/assets/og/hash-functions.png",
    alt_text: "Hash Functions",
  });
});

test("slackPayload — section text truncated to Slack's 3000 cap; fallback text left whole", () => {
  const p = slackPayload({ ...ENTRY, summary: "S".repeat(5000) });
  const section = p.blocks[0] as { text: { text: string } };
  expect(section.text.text.length).toBe(3000);
  expect(p.text.length).toBeGreaterThan(3000);
});

test("discordPayload — share card becomes the embed image", () => {
  const p = discordPayload(ENTRY, "https://blog.example.com/assets/og/hash-functions.png");
  expect(p.embeds[0]!.image).toEqual({ url: "https://blog.example.com/assets/og/hash-functions.png" });
});

test("discordPayload — no image field without a card (degrade, don't fabricate)", () => {
  expect(discordPayload(ENTRY).embeds[0]).not.toHaveProperty("image");
});

test("shareCardUrlFor — post URL + existing card → absolute og card URL", () => {
  expect(shareCardUrlFor(ENTRY, "https://blog.example.com", (slug) => slug === "hash-functions")).toBe(
    "https://blog.example.com/assets/og/hash-functions.png",
  );
});

test("shareCardUrlFor — null when the card was never generated", () => {
  expect(shareCardUrlFor(ENTRY, "https://blog.example.com", () => false)).toBeNull();
});

test("shareCardUrlFor — null for a non-post or unparseable entry URL", () => {
  expect(shareCardUrlFor({ ...ENTRY, url: "https://blog.example.com/about" }, "https://blog.example.com", () => true)).toBeNull();
  expect(shareCardUrlFor({ ...ENTRY, url: "not a url" }, "https://blog.example.com", () => true)).toBeNull();
});

test("buildJobs — the image URL reaches both chat payloads", () => {
  const cfg = resolveNotifyConfig({
    DISCORD_WEBHOOK_URL: "https://d.example/hook",
    SLACK_WEBHOOK_URL: "https://s.example/hook",
  });
  const jobs = buildJobs(ENTRY, cfg, "https://blog.example.com/feed.xml", "https://blog.example.com/assets/og/hash-functions.png");
  const discord = JSON.parse(jobs.find((j) => j.label === "discord")!.body);
  const slack = JSON.parse(jobs.find((j) => j.label === "slack")!.body);
  expect(discord.embeds[0].image.url).toBe("https://blog.example.com/assets/og/hash-functions.png");
  expect(slack.blocks[1].image_url).toBe("https://blog.example.com/assets/og/hash-functions.png");
});

test("cloudEventPayload — structured envelope; Atom id maps to CE id", () => {
  const ce = cloudEventPayload(ENTRY, "https://blog.example.com/feed.xml");
  expect(ce).toEqual({
    specversion: "1.0",
    type: EVENT_TYPE,
    source: "https://blog.example.com/feed.xml",
    subject: "/posts/hash-functions",
    id: "tag:blog.example.com,2026:/posts/hash-functions",
    time: "2026-05-25T04:07:37.106Z",
    datacontenttype: "application/json",
    data: {
      title: "Hash Functions",
      url: "https://blog.example.com/posts/hash-functions",
      summary: "What makes a good hash.",
    },
  });
});

// --- Standard Webhooks signing ----------------------------------------------

test("signStandardWebhooks — canonical Svix test vector", () => {
  // From the Standard Webhooks / Svix reference docs.
  const sig = signStandardWebhooks(
    "msg_p5jXN8AQM9LWM0D4loKWxJek",
    1614265330,
    '{"test": 2432232314}',
    "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  );
  expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("signStandardWebhooks — accepts secret with or without whsec_ prefix", () => {
  const a = signStandardWebhooks("id", 1, "body", "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
  const b = signStandardWebhooks("id", 1, "body", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
  expect(a).toBe(b);
});

// --- config -----------------------------------------------------------------

test("resolveNotifyConfig — all empty → no channels, step is a no-op", () => {
  const cfg = resolveNotifyConfig({});
  expect(cfg.discord).toEqual([]);
  expect(hasAnyChannel(cfg)).toBe(false);
});

test("resolveNotifyConfig — comma-separated lists, format, signing, pacing", () => {
  const cfg = resolveNotifyConfig({
    DISCORD_WEBHOOK_URL: "https://d1, https://d2",
    WEBHOOK_URL: "https://g",
    WEBHOOK_FORMAT: "cloudevents",
    WEBHOOK_SIGNING_SECRET: "whsec_abc",
    WEBHOOK_PACE_MS: "250",
  });
  expect(cfg.discord).toEqual(["https://d1", "https://d2"]);
  expect(cfg.generic).toEqual(["https://g"]);
  expect(cfg.format).toBe("cloudevents");
  expect(cfg.signingSecret).toBe("whsec_abc");
  expect(cfg.paceMs).toBe(250);
  expect(hasAnyChannel(cfg)).toBe(true);
});

// --- buildJobs --------------------------------------------------------------

test("buildJobs — one job per channel; only generic is signed", () => {
  const cfg = resolveNotifyConfig({
    DISCORD_WEBHOOK_URL: "https://discord",
    SLACK_WEBHOOK_URL: "https://slack",
    WEBHOOK_URL: "https://generic",
    WEBHOOK_SIGNING_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  });
  const jobs = buildJobs(ENTRY, cfg, "https://blog.example.com/feed.xml");
  expect(jobs.map((j) => j.label)).toEqual(["discord", "slack", "generic"]);

  const discord = jobs.find((j) => j.label === "discord")!;
  const generic = jobs.find((j) => j.label === "generic")!;
  // Signing headers only on the generic path.
  expect(discord.headers["webhook-signature"]).toBeUndefined();
  expect(generic.headers["webhook-signature"]).toMatch(/^v1,/);
  expect(generic.headers["webhook-id"]).toBe(ENTRY.id);

  // And the signature actually verifies against the sent body + headers.
  const expected = signStandardWebhooks(
    generic.headers["webhook-id"]!,
    Number(generic.headers["webhook-timestamp"]!),
    generic.body,
    "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  );
  expect(generic.headers["webhook-signature"]).toBe(expected);
});

test("buildJobs — cloudevents format sets the CE content-type + envelope body", () => {
  const cfg = resolveNotifyConfig({ WEBHOOK_URL: "https://generic", WEBHOOK_FORMAT: "cloudevents" });
  const job = buildJobs(ENTRY, cfg, "https://blog.example.com/feed.xml")[0]!;
  expect(job.headers["content-type"]).toBe("application/cloudevents+json");
  expect(JSON.parse(job.body).specversion).toBe("1.0");
});

// --- delivery driver (localhost recorder, no real network) ------------------

test("deliverJobs — sequential, in order, survives one failing webhook", async () => {
  const got: Array<{ path: string; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      got.push({ path: url.pathname, body: await req.text() });
      if (url.pathname === "/bad") return new Response("nope", { status: 500 });
      return new Response("ok", { status: 200 });
    },
  });
  try {
    const base = `http://localhost:${server.port}`;
    const jobs: Job[] = [
      { url: `${base}/a`, headers: { "content-type": "application/json" }, body: '{"n":1}', label: "generic" },
      { url: `${base}/bad`, headers: {}, body: '{"n":2}', label: "discord" },
      { url: `${base}/c`, headers: {}, body: '{"n":3}', label: "slack" },
    ];
    await deliverJobs(jobs, { paceMs: 0 });
    // All three attempted, in order — the /bad 500 did not abort /c.
    expect(got.map((g) => g.path)).toEqual(["/a", "/bad", "/c"]);
    expect(JSON.parse(got[0]!.body).n).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("end-to-end on localhost — feed delta → Discord embed reaches the channel", async () => {
  const received: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push(await req.json());
      return new Response("", { status: 204 }); // Discord-style success
    },
  });
  try {
    const cfg = resolveNotifyConfig({ DISCORD_WEBHOOK_URL: `http://localhost:${server.port}/hook` });
    const entries = parseFeedEntries(atomFeed([E1, E2]));
    const delta = selectNewEntries(entries, new Set([ENTRY.id]), false); // only Offer Files is new
    const jobs = delta.flatMap((e) => buildJobs(e, cfg, "https://blog.example.com/feed.xml"));
    await deliverJobs(jobs, { paceMs: 0 });
    expect(received).toHaveLength(1);
    expect((received[0] as { embeds: Array<{ title: string }> }).embeds[0]!.title).toBe("Offer Files");
  } finally {
    server.stop(true);
  }
});

// --- Discord field-limit conformance (gap 2) --------------------------------

test("truncate — leaves short strings untouched, ellipsizes long ones", () => {
  expect(truncate("abc", 256)).toBe("abc");
  const t = truncate("x".repeat(300), 256);
  expect(t.length).toBe(256);
  expect(t.endsWith("…")).toBe(true);
});

test("discordPayload — title truncated to Discord's 256 cap", () => {
  const p = discordPayload({ ...ENTRY, title: "T".repeat(300) });
  expect(p.embeds[0]!.title!.length).toBe(256);
});

test("discordPayload — description truncated to Discord's 4096 cap", () => {
  const p = discordPayload({ ...ENTRY, summary: "S".repeat(5000) });
  expect(p.embeds[0]!.description!.length).toBe(4096);
});

test("slackPayload — link only when there is no summary", () => {
  const text = "<https://blog.example.com/posts/hash-functions|Hash Functions>";
  expect(slackPayload({ ...ENTRY, summary: "" })).toEqual({
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
});

test("mentions pass through verbatim (trusted-author model — no stripping)", () => {
  const e: FeedEntry = { ...ENTRY, title: "Big news @everyone" };
  expect(discordPayload(e).embeds[0]!.title).toBe("Big news @everyone");
  expect(slackPayload(e).text).toContain("@everyone");
});

test("buildJobs — one job per URL in a comma-listed channel", () => {
  const cfg = resolveNotifyConfig({ DISCORD_WEBHOOK_URL: "https://d1, https://d2" });
  const jobs = buildJobs(ENTRY, cfg, "https://blog.example.com/feed.xml");
  expect(jobs.map((j) => j.url)).toEqual(["https://d1", "https://d2"]);
});

// --- pacing (gap 3) ---------------------------------------------------------

test("deliverJobs — paces between jobs: n-1 sleeps of paceMs, in order", async () => {
  const slept: number[] = [];
  const jobs: Job[] = [0, 1, 2].map((n) => ({
    url: `https://x/${n}`,
    headers: {},
    body: `${n}`,
    label: "generic",
  }));
  await deliverJobs(jobs, {
    paceMs: 1100,
    fetchImpl: respond("", 200),
    sleepImpl: async (ms) => {
      slept.push(ms);
    },
  });
  expect(slept).toEqual([1100, 1100]); // between 3 jobs, never before the first
});

test("deliverJobs — paceMs 0 inserts no sleeps", async () => {
  const slept: number[] = [];
  const jobs: Job[] = [0, 1].map((n) => ({ url: `https://x/${n}`, headers: {}, body: "", label: "generic" }));
  await deliverJobs(jobs, { paceMs: 0, fetchImpl: respond("", 200), sleepImpl: async (ms) => void slept.push(ms) });
  expect(slept).toEqual([]);
});

// --- snapshot decision (gap 1, pure) ----------------------------------------

test("decideSnapshot — ok → diff these ids; 404 → first-run; else → skip", () => {
  expect(decideSnapshot({ ok: true, xml: atomFeed([E1]) })).toEqual({
    firstRun: false,
    ids: ["tag:blog.example.com,2026:/posts/hash-functions"],
  });
  expect(decideSnapshot({ ok: false, status: 404 })).toEqual({ firstRun: true, ids: [] });
  expect(decideSnapshot({ ok: false, status: 500 })).toEqual({ skip: true });
  expect(decideSnapshot({ ok: false, status: 503 })).toEqual({ skip: true });
});

// --- snapshot/notify lifecycle (gap 1 — the "never re-spam" guarantee) -------

const CHANNEL_ENV = { SITE_URL: "https://blog.example.com", WEBHOOK_URL: "https://hook.example/h" };

test("runSnapshot — live feed (200) writes its ids for the diff", async () => {
  const dir = makeTmp();
  try {
    await runSnapshot({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: respond(atomFeed([E1, E2]), 200) });
    expect(JSON.parse(readFileSync(snapFile(dir), "utf8"))).toEqual({
      firstRun: false,
      ids: [
        "tag:blog.example.com,2026:/posts/hash-functions",
        "tag:blog.example.com,2026:/posts/offer-files",
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnapshot — 404 records a first-run (newest-only later)", async () => {
  const dir = makeTmp();
  try {
    await runSnapshot({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: respond("", 404) });
    expect(JSON.parse(readFileSync(snapFile(dir), "utf8"))).toEqual({ firstRun: true, ids: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnapshot — a 5xx records skip (under-notify, never re-blast)", async () => {
  const dir = makeTmp();
  try {
    await runSnapshot({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: respond("", 500) });
    expect(JSON.parse(readFileSync(snapFile(dir), "utf8"))).toEqual({ skip: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnapshot — a thrown fetch (network down) records skip", async () => {
  const dir = makeTmp();
  try {
    await runSnapshot({
      paths: tmpPaths(dir),
      env: CHANNEL_ENV,
      fetchImpl: asFetch(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(JSON.parse(readFileSync(snapFile(dir), "utf8"))).toEqual({ skip: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSnapshot — no channels configured writes nothing", async () => {
  const dir = makeTmp();
  try {
    await runSnapshot({ paths: tmpPaths(dir), env: {}, fetchImpl: respond(atomFeed([E1]), 200) });
    expect(existsSync(snapFile(dir))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runNotify — announces the delta, then deletes the snapshot", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, "dist", "feed.xml"), atomFeed([E1, E2]));
    writeFileSync(
      snapFile(dir),
      JSON.stringify({ firstRun: false, ids: ["tag:blog.example.com,2026:/posts/hash-functions"] }),
    );
    const received: Array<{ url: string; body: string }> = [];
    await runNotify({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: recordingFetch(received) });
    expect(received).toHaveLength(1); // only Offer Files is new
    expect(JSON.parse(received[0]!.body).title).toBe("Offer Files");
    expect(existsSync(snapFile(dir))).toBe(false); // consumed
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runNotify — first-run snapshot announces only the newest, not the backlog", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, "dist", "feed.xml"), atomFeed([E1, E2]));
    writeFileSync(snapFile(dir), JSON.stringify({ firstRun: true, ids: [] }));
    const received: Array<{ url: string; body: string }> = [];
    await runNotify({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: recordingFetch(received) });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body).title).toBe("Offer Files"); // newest
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runNotify — a skip snapshot announces nothing", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, "dist", "feed.xml"), atomFeed([E1, E2]));
    writeFileSync(snapFile(dir), JSON.stringify({ skip: true }));
    const received: Array<{ url: string; body: string }> = [];
    await runNotify({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: recordingFetch(received) });
    expect(received).toEqual([]);
    expect(existsSync(snapFile(dir))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runNotify — no new posts (all ids known) announces nothing", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, "dist", "feed.xml"), atomFeed([E1, E2]));
    writeFileSync(
      snapFile(dir),
      JSON.stringify({
        firstRun: false,
        ids: [
          "tag:blog.example.com,2026:/posts/hash-functions",
          "tag:blog.example.com,2026:/posts/offer-files",
        ],
      }),
    );
    const received: Array<{ url: string; body: string }> = [];
    await runNotify({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: recordingFetch(received) });
    expect(received).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runNotify — a missing snapshot announces nothing (under-notify, no throw)", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, "dist", "feed.xml"), atomFeed([E1, E2]));
    const received: Array<{ url: string; body: string }> = [];
    await runNotify({ paths: tmpPaths(dir), env: CHANNEL_ENV, fetchImpl: recordingFetch(received) });
    expect(received).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- --smoke (live-channel acceptance check; transport mocked here) ---------

test("buildSmokeJob — infers the channel from the webhook host", () => {
  expect(buildSmokeJob("https://discord.com/api/webhooks/1/x").label).toBe("discord");
  expect(buildSmokeJob("https://discordapp.com/api/webhooks/1/x").label).toBe("discord");
  expect(buildSmokeJob("https://hooks.slack.com/services/T/B/x").label).toBe("slack");
  expect(buildSmokeJob("https://example.com/hook").label).toBe("generic");
});

test("buildSmokeJob — fixed fixture body; --image threads into the rich shapes", () => {
  const discord = JSON.parse(buildSmokeJob("https://discord.com/api/webhooks/1/x", "https://b.example/card.png").body);
  expect(discord.embeds[0].title).toBe(SMOKE_ENTRY.title);
  expect(discord.embeds[0].image.url).toBe("https://b.example/card.png");
  const slack = JSON.parse(buildSmokeJob("https://hooks.slack.com/services/T/B/x").body);
  expect(slack.blocks).toHaveLength(1); // no --image → no image block
  expect(slack.text).toContain(SMOKE_ENTRY.title);
});

test("runSmoke — true on 2xx, false (loud) on rejection or network failure", async () => {
  const accept = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  expect(await runSmoke("https://example.com/hook", null, accept)).toBe(true);
  const reject = (async () => new Response('{"error":"invalid_blocks"}', { status: 400 })) as unknown as typeof fetch;
  expect(await runSmoke("https://hooks.slack.com/services/T/B/x", null, reject)).toBe(false);
  const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await runSmoke("https://example.com/hook", null, boom)).toBe(false);
});
