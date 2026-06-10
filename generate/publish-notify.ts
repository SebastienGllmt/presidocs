// Post-deploy step: announce a genuinely-new post to Discord / Slack / a generic
// HTTP webhook. The companion to websub-ping.ts — that serves feed readers; this
// serves chat channels (which don't speak WebSub). See methodology.md →
// "Subscription feeds" for the design rationale.
//
// THE TRIGGER ("new posts only, never re-spam"). A redundant chat ping is a
// visible message to humans, so we announce a post exactly once, on first
// publish. The state that makes this reliable is the LIVE DEPLOYED FEED itself:
// the set of new posts is `ids(new dist/feed.xml) − ids(currently-live
// feed.xml)`. Atom entry ids are immutable (`tag:host,year:postPath`, see
// generate/feeds.ts), so an EDIT keeps its id and is never in the delta, and a
// re-deploy with no new post yields an empty delta. No committed state, nothing
// to drift.
//
// TWO PHASES, because design (c) must read the live feed BEFORE `wrangler
// deploy` flips it, yet must POST AFTER the deploy is live. A single shell
// pipeline can't hold the pre-deploy feed across the wrangler subprocess, so:
//
//   build && publish-notify --snapshot && wrangler deploy && websub-ping && publish-notify --notify
//
//   --snapshot : fetch the currently-live feed, write its entry ids to an
//                ephemeral, gitignored scratch file (generated/.notify-snapshot.json).
//   --notify   : read that snapshot (old ids), diff against dist/feed.xml (new
//                ids), POST the delta (paced), then delete the snapshot.
//
// The scratch file is machine-local and consumed within one deploy run — NOT the
// committed notified-set that the design rejected.
//
// FAIL-SILENT, never fatal: the deploy already succeeded by --notify time. A
// dead webhook is logged and skipped; the process never exits non-zero. We
// under-notify rather than over-notify — a missing/unreadable snapshot, or a
// pre-deploy feed fetch that errored, announces NOTHING rather than risk a
// spurious re-ping.
//
// TRUST MODEL: post titles/summaries are forwarded verbatim (no mention
// stripping). Authors are trusted — see methodology.md → "Authored content is
// trusted at its source; readers are not."

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
// Official payload TYPES only (zero runtime deps) — so the compiler checks our
// Discord/Slack bodies against the platforms' own field definitions, without
// fitting our fetch pipeline into a heavyweight SDK. See methodology.md →
// "Subscription feeds".
import type { APIEmbed, RESTPostAPIWebhookWithTokenJSONBody } from "discord-api-types/v10";
import type { Block, KnownBlock } from "@slack/types";
import { type BlogPaths, resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveFeedConfig } from "../shared/feedConfig.ts";
import {
  hasAnyChannel,
  type NotifyConfig,
  resolveNotifyConfig,
} from "../shared/notifyConfig.ts";

/** The CloudEvents `type` for a new-post event (reverse-DNS, per CE spec). */
export const EVENT_TYPE = "com.presidocs.post.published";

/** One announceable post, parsed from a feed entry. */
export type FeedEntry = {
  /** Immutable Atom id (`tag:host,year:postPath`) — the diff key + CE id. */
  id: string;
  title: string;
  /** Canonical post URL (the entry's rel="alternate" link). */
  url: string;
  summary: string;
  /** RFC3339 publish time (for ordering + the CE `time`). */
  published: string;
};

// ---------------------------------------------------------------------------
// Feed parsing + diff (pure — no network, golden-testable)
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep every value a string: titles/ids must never be coerced to numbers.
  parseTagValue: false,
});

function entryUrl(link: unknown): string {
  const links = Array.isArray(link) ? link : [link];
  const alt =
    links.find((l) => l && typeof l === "object" && (l as Record<string, unknown>)["@_rel"] === "alternate") ??
    links[0];
  const href = alt && typeof alt === "object" ? (alt as Record<string, unknown>)["@_href"] : undefined;
  return href ? String(href) : "";
}

/** Parse an Atom feed's entries into FeedEntry[]. Tolerant of a missing feed. */
export function parseFeedEntries(feedXml: string): FeedEntry[] {
  if (!feedXml || !feedXml.trim()) return [];
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(feedXml);
  } catch {
    return [];
  }
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (!feed) return [];
  const raw = feed.entry;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries
    .map((e) => {
      const o = e as Record<string, unknown>;
      return {
        id: o.id ? String(o.id) : "",
        title: o.title ? String(o.title) : "",
        url: entryUrl(o.link),
        summary: o.summary ? String(o.summary) : "",
        published: o.published ? String(o.published) : "",
      };
    })
    .filter((e) => e.id);
}

/** Just the entry ids — what the --snapshot phase persists. */
export function feedEntryIds(feedXml: string): string[] {
  return parseFeedEntries(feedXml).map((e) => e.id);
}

/**
 * The posts to announce. On a normal run, the set-difference of new entries
 * against the live ids, oldest-first (so a channel reads chronologically). On a
 * first run (no prior live feed), at most the single newest entry — never the
 * whole backlog (the newest-only first-run rule).
 */
export function selectNewEntries(
  entries: FeedEntry[],
  oldIds: Set<string>,
  firstRun: boolean,
): FeedEntry[] {
  if (firstRun) {
    if (entries.length === 0) return [];
    const newest = entries.reduce((a, b) => (b.published > a.published ? b : a));
    return [newest];
  }
  return entries
    .filter((e) => !oldIds.has(e.id))
    .sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Payload builders (pure)
// ---------------------------------------------------------------------------

/** Bare generic payload — the v1 default for an arbitrary WEBHOOK_URL. */
export function genericPayload(e: FeedEntry): { title: string; url: string; summary: string } {
  return { title: e.title, url: e.url, summary: e.summary };
}

// Discord embed field caps (discord.com/developers/docs/resources/channel#embed-limits).
// We MUST respect these: an embed that exceeds them is rejected outright, and our
// fail-silent posture would then drop the announcement without a trace. Slack's
// incoming-webhook `text` has no comparably tight limit (far above a title +
// one-line summary), so it is left whole — but a Block Kit `section` text IS
// capped (3000), so the blocks path truncates like Discord does.
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESC_MAX = 4096;
const SLACK_SECTION_MAX = 3000;
const SLACK_ALT_TEXT_MAX = 2000;

/**
 * The post's share-card image URL (the 1200×630 OG card the build renders to
 * `dist/assets/og/<slug>.png`), or null when the entry isn't a post URL or the
 * card wasn't generated (post supplies its own og:image, or the card build was
 * skipped). `cardExists` is injected so this stays pure/golden-testable; the
 * caller backs it with an existsSync against dist. Null simply means the
 * richer message degrades to the text-only shape — emit-if-present, no
 * channel-specific branching.
 */
export function shareCardUrlFor(
  e: FeedEntry,
  baseUrl: string,
  cardExists: (slug: string) => boolean,
): string | null {
  let pathname: string;
  try {
    pathname = new URL(e.url).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/posts\/([A-Za-z0-9-]+)$/);
  if (!m) return null;
  return cardExists(m[1]!) ? `${baseUrl}/assets/og/${m[1]!}.png` : null;
}

/** Truncate to `max` chars, with a trailing ellipsis when shortened. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Discord incoming-webhook body: an embed renders title-as-link + summary,
 * plus the post's share card as the embed image when one exists. Title/
 * description are truncated to Discord's hard limits. The embed is typed as
 * Discord's official `APIEmbed` and the whole body `satisfies` the official
 * webhook-execute body, so a wrong/renamed field is a compile error. */
export function discordPayload(e: FeedEntry, imageUrl: string | null = null): { embeds: APIEmbed[] } {
  const embed: APIEmbed = {
    title: truncate(e.title, DISCORD_TITLE_MAX),
    url: e.url,
    ...(e.summary ? { description: truncate(e.summary, DISCORD_DESC_MAX) } : {}),
    ...(imageUrl ? { image: { url: imageUrl } } : {}),
  };
  return { embeds: [embed] } satisfies RESTPostAPIWebhookWithTokenJSONBody;
}

/** Slack incoming-webhook body: a Block Kit `section` (mrkdwn title link +
 * summary) plus an `image` block for the share card when one exists. The
 * single-line `text` is kept as the notification fallback — Slack uses it for
 * push/preview when `blocks` are present, and old clients render it whole.
 * Block shapes are the official `@slack/types` ones, so a wrong/renamed field
 * is a compile error. */
export function slackPayload(e: FeedEntry, imageUrl: string | null = null): { text: string; blocks: (KnownBlock | Block)[] } {
  const link = `<${e.url}|${e.title}>`;
  const text = e.summary ? `${link}\n${e.summary}` : link;
  const blocks: (KnownBlock | Block)[] = [
    { type: "section", text: { type: "mrkdwn", text: truncate(text, SLACK_SECTION_MAX) } },
  ];
  if (imageUrl) {
    blocks.push({ type: "image", image_url: imageUrl, alt_text: truncate(e.title, SLACK_ALT_TEXT_MAX) });
  }
  return { text, blocks };
}

/**
 * CloudEvents structured-mode envelope for the GENERIC path (opt-in). The
 * immutable Atom id becomes the CE `id` (unique per source → free idempotency);
 * `source` is the feed, `subject` the post path, `data` the bare payload.
 */
export function cloudEventPayload(
  e: FeedEntry,
  source: string,
): {
  specversion: "1.0";
  type: string;
  source: string;
  subject: string;
  id: string;
  time: string;
  datacontenttype: "application/json";
  data: { title: string; url: string; summary: string };
} {
  let subject = e.url;
  try {
    subject = new URL(e.url).pathname;
  } catch {
    /* non-absolute url — fall back to the full string */
  }
  return {
    specversion: "1.0",
    type: EVENT_TYPE,
    source,
    subject,
    id: e.id,
    time: e.published,
    datacontenttype: "application/json",
    data: genericPayload(e),
  };
}

// ---------------------------------------------------------------------------
// Standard Webhooks signing (pure) — GENERIC path only
// ---------------------------------------------------------------------------

/**
 * Standard Webhooks `v1` symmetric signature: base64(HMAC-SHA256(secret,
 * "{id}.{timestamp}.{body}")), returned as `v1,<sig>`. `secret` is base64,
 * optionally `whsec_`-prefixed. `timestampSec` is unix seconds.
 */
export function signStandardWebhooks(
  msgId: string,
  timestampSec: number,
  body: string,
  secret: string,
): string {
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const keyBytes = Buffer.from(key, "base64");
  const sig = createHmac("sha256", keyBytes).update(`${msgId}.${timestampSec}.${body}`).digest("base64");
  return `v1,${sig}`;
}

// ---------------------------------------------------------------------------
// Format-agnostic delivery driver
// ---------------------------------------------------------------------------

/** A single POST: the unit the driver delivers, regardless of channel shape. */
export type Job = { url: string; headers: Record<string, string>; body: string; label: string };

/**
 * Build the per-channel jobs for one post. Discord/Slack emit their native
 * shapes; the generic path optionally upgrades to CloudEvents and/or signs with
 * Standard Webhooks (both generic-only). This is the ONLY place the channels
 * differ — the driver below treats every job identically.
 */
export function buildJobs(e: FeedEntry, cfg: NotifyConfig, feedSource: string, imageUrl: string | null = null): Job[] {
  const jobs: Job[] = [];
  const json = (body: unknown) => JSON.stringify(body);

  for (const url of cfg.discord) {
    jobs.push({ url, headers: { "content-type": "application/json" }, body: json(discordPayload(e, imageUrl)), label: "discord" });
  }
  for (const url of cfg.slack) {
    jobs.push({ url, headers: { "content-type": "application/json" }, body: json(slackPayload(e, imageUrl)), label: "slack" });
  }
  if (cfg.generic.length > 0) {
    const cloud = cfg.format === "cloudevents";
    const body = json(cloud ? cloudEventPayload(e, feedSource) : genericPayload(e));
    const contentType = cloud ? "application/cloudevents+json" : "application/json";
    for (const url of cfg.generic) {
      const headers: Record<string, string> = { "content-type": contentType };
      if (cfg.signingSecret) {
        const ts = Math.floor(Date.now() / 1000);
        headers["webhook-id"] = e.id;
        headers["webhook-timestamp"] = String(ts);
        headers["webhook-signature"] = signStandardWebhooks(e.id, ts, body, cfg.signingSecret);
      }
      jobs.push({ url, headers, body, label: "generic" });
    }
  }
  return jobs;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POST one job. Logs loudly on non-2xx (the fail-silent posture would otherwise
 * hide a rejected message), but never throws — one dead webhook can't block the
 * rest or fail the deploy. */
async function postJob(job: Job, fetchImpl: typeof fetch): Promise<void> {
  try {
    const res = await fetchImpl(job.url, { method: "POST", headers: job.headers, body: job.body });
    if (res.ok) console.log(`  notify: ${job.label} ${res.status} ${job.url}`);
    else console.warn(`  notify: ${job.label} REJECTED ${res.status} ${res.statusText} ${job.url}`);
  } catch (err) {
    console.warn(`  notify: ${job.label} POST failed ${job.url}:`, err);
  }
}

/** Deliver jobs sequentially, pacing between them so a multi-post deploy doesn't
 * trip rate limits. fetchImpl and sleepImpl are injectable for tests (the latter
 * lets pacing be asserted without wall-clock flakiness). */
export async function deliverJobs(
  jobs: Job[],
  opts: { paceMs?: number; fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const paceMs = opts.paceMs ?? 0;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  for (let i = 0; i < jobs.length; i++) {
    if (i > 0 && paceMs > 0) await sleepImpl(paceMs);
    await postJob(jobs[i]!, fetchImpl);
  }
}

// ---------------------------------------------------------------------------
// Phases (--snapshot / --notify)
// ---------------------------------------------------------------------------

export type Snapshot = { firstRun: boolean; ids: string[] } | { skip: true };

/**
 * Dependencies the two phases touch the outside world through. Defaulted from
 * the real environment in main(); overridden in tests so the snapshot/notify
 * lifecycle (the "never re-spam" guarantee) can be exercised in-process against
 * a local server + temp dir, with no real network or deploy.
 */
export type PhaseDeps = {
  paths: BlogPaths;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
};

export function defaultPhaseDeps(): PhaseDeps {
  return { paths: resolveBlogPaths(), env: process.env, fetchImpl: fetch };
}

function snapshotPath(paths: BlogPaths): string {
  return join(paths.generatedDir, ".notify-snapshot.json");
}

/**
 * Decide the snapshot from the pre-deploy live-feed fetch outcome (pure). The
 * whole "never over-notify" posture lives here: a clean 404 is a genuine first
 * deploy (newest-only later); ANY other failure (5xx, network error) yields a
 * `skip` so a transient outage can't make us re-announce the backlog.
 *   - { ok: true, xml }      → diff against these ids next phase
 *   - { ok: false, status: 404 } → first run (newest-only)
 *   - anything else / thrown → skip (announce nothing this deploy)
 */
export function decideSnapshot(
  outcome: { ok: true; xml: string } | { ok: false; status: number },
): Snapshot {
  if (outcome.ok) return { firstRun: false, ids: feedEntryIds(outcome.xml) };
  if (outcome.status === 404) return { firstRun: true, ids: [] };
  return { skip: true };
}

// Pre-deploy: capture the currently-live feed's ids so --notify can diff against
// them after the deploy flips the live copy.
export async function runSnapshot(deps: PhaseDeps = defaultPhaseDeps()): Promise<void> {
  const cfg = resolveNotifyConfig(deps.env);
  if (!hasAnyChannel(cfg)) {
    console.log("notify: no webhook channels configured — skipping snapshot.");
    return;
  }
  const feed = resolveFeedConfig(deps.env);
  if (!feed.baseUrl) {
    console.log("notify: no SITE_URL — skipping snapshot.");
    return;
  }
  let snap: Snapshot;
  try {
    const res = await deps.fetchImpl(`${feed.baseUrl}/feed.xml`);
    snap = decideSnapshot(res.ok ? { ok: true, xml: await res.text() } : { ok: false, status: res.status });
    if ("skip" in snap) {
      console.warn(`notify: live feed fetch ${res.status} ${res.statusText} — will announce nothing this deploy.`);
    } else if (snap.firstRun) {
      console.log(`notify: no live feed yet (${res.status}) — first-run (newest-only on notify).`);
    } else {
      console.log(`notify: snapshot captured ${snap.ids.length} live id(s).`);
    }
  } catch (err) {
    snap = { skip: true };
    console.warn(`notify: live feed fetch failed — will announce nothing this deploy:`, err);
  }
  mkdirSync(deps.paths.generatedDir, { recursive: true });
  writeFileSync(snapshotPath(deps.paths), JSON.stringify(snap));
}

// Post-deploy: diff the deployed feed against the snapshot and POST the delta.
export async function runNotify(deps: PhaseDeps = defaultPhaseDeps()): Promise<void> {
  const cfg = resolveNotifyConfig(deps.env);
  if (!hasAnyChannel(cfg)) {
    console.log("notify: no webhook channels configured — skipping.");
    return;
  }
  const feed = resolveFeedConfig(deps.env);
  if (!feed.baseUrl) {
    console.log("notify: no SITE_URL — skipping.");
    return;
  }
  const newFeedFile = join(deps.paths.distDir, "feed.xml");
  if (!existsSync(newFeedFile)) {
    console.warn("notify: dist/feed.xml missing — run the build/deploy first; skipping.");
    return;
  }
  const sp = snapshotPath(deps.paths);
  if (!existsSync(sp)) {
    console.warn("notify: no pre-deploy snapshot — run --snapshot before `wrangler deploy`; skipping (under-notify).");
    return;
  }
  let snap: Snapshot;
  try {
    snap = JSON.parse(readFileSync(sp, "utf8"));
  } catch {
    rmSync(sp, { force: true });
    console.warn("notify: unreadable snapshot — skipping (under-notify).");
    return;
  }
  rmSync(sp, { force: true }); // consumed; we hold it in memory now

  if ("skip" in snap && snap.skip) {
    console.log("notify: snapshot marked skip (live feed unavailable pre-deploy) — announcing nothing.");
    return;
  }
  const { firstRun, ids } = snap as { firstRun: boolean; ids: string[] };

  const entries = parseFeedEntries(readFileSync(newFeedFile, "utf8"));
  const delta = selectNewEntries(entries, new Set(ids), firstRun);
  if (delta.length === 0) {
    console.log("notify: no new posts — nothing to announce.");
    return;
  }
  const baseUrl = feed.baseUrl; // narrowed by the guard above; bind for the closures
  const source = `${baseUrl}/feed.xml`;
  const cardExists = (slug: string) => existsSync(join(deps.paths.distDir, "assets", "og", `${slug}.png`));
  const jobs = delta.flatMap((e) => buildJobs(e, cfg, source, shareCardUrlFor(e, baseUrl, cardExists)));
  console.log(`notify: announcing ${delta.length} post(s) across ${jobs.length} webhook(s).`);
  await deliverJobs(jobs, { paceMs: cfg.paceMs, fetchImpl: deps.fetchImpl });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--snapshot") return runSnapshot();
  if (mode === "--notify") return runNotify();
  console.warn("publish-notify: pass --snapshot (pre-deploy) or --notify (post-deploy).");
}

if (import.meta.main) {
  main().catch((err) => {
    // Never fail the deploy on a notification error.
    console.warn("publish-notify error:", err);
  });
}
