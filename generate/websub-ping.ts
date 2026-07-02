// Post-deploy step: ping the [WebSub] hub that the feeds advertise, so a
// subscriber's reader gets the new post PUSHED within seconds instead of
// waiting out its poll interval. WebSub splits the work: the feeds declare the
// hub (a `<link rel="hub">` — see generate/feeds.ts), subscribers register
// their callback WITH the hub, and on each publish the publisher sends the hub
// a one-line notification; the hub re-fetches the feed, diffs it, and fans the
// new entries out to every subscriber. All the stateful subscriber bookkeeping
// lives in the hub — this script is just the publish notification.
//
// Runs AFTER `wrangler deploy` (the hub fetches the LIVE feed, so it must be
// deployed first), which is why this is a separate step from the build-time
// feeds.ts rather than part of it. Gated on both SITE_URL (feeds need absolute
// URLs) and WEBSUB_HUB (the opt-in hub) — with either unset it's a no-op, the
// same fail-silent posture as the feed/structured-data/analytics steps. A ping
// that the hub rejects is logged, never fatal: the deploy already succeeded, and
// a redundant or failed ping at worst delays one push to the next poll.
//
// Pinging on every deploy (not just on a new post) is intentional and safe: the
// hub DEDUPS by re-fetching and diffing the feed itself, so a deploy that didn't
// add a post produces no subscriber traffic. See methodology.md →
// "Subscription feeds".

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { resolveFeedConfig } from "./feedConfig.ts";

const paths = resolveBlogPaths();

// The publish-notification body. Sends BOTH `hub.topic` (the WebSub spec name,
// §7) and `hub.url` (the older PubSubHubbub name many deployed hubs still
// expect) so the same ping works across hub implementations.
export function websubPublishBody(topicUrl: string): string {
  const body = new URLSearchParams();
  body.set("hub.mode", "publish");
  body.set("hub.topic", topicUrl);
  body.set("hub.url", topicUrl);
  return body.toString();
}

// The feed topics to announce: the Atom feed always, the podcast feed only when
// it was emitted (it's suppressed on an audio-less blog). `baseUrl` has no
// trailing slash (resolveFeedConfig strips it).
export function websubTopics(baseUrl: string, hasPodcast: boolean): string[] {
  const topics = [`${baseUrl}/feed.xml`];
  if (hasPodcast) topics.push(`${baseUrl}/podcast.xml`);
  return topics;
}

async function pingHub(hubUrl: string, topicUrl: string): Promise<boolean> {
  try {
    const res = await fetch(hubUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: websubPublishBody(topicUrl),
    });
    // WebSub hubs return 2xx (often 202 Accepted) on a successful notification.
    if (res.ok) {
      console.log(`  WebSub: pinged hub for ${topicUrl} (${res.status})`);
      return true;
    }
    console.warn(`  WebSub: hub rejected ${topicUrl} (${res.status} ${res.statusText})`);
    return false;
  } catch (err) {
    console.warn(`  WebSub: ping failed for ${topicUrl}:`, err);
    return false;
  }
}

async function main(): Promise<void> {
  const cfg = resolveFeedConfig();
  if (!cfg.baseUrl) {
    console.log("WebSub: no SITE_URL — skipping hub ping.");
    return;
  }
  if (!cfg.hubUrl) {
    console.log("WebSub: no WEBSUB_HUB — skipping hub ping.");
    return;
  }
  const distDir = paths.distDir;
  // feed.xml is the gate that the build actually emitted feeds at all.
  if (!existsSync(join(distDir, "feed.xml"))) {
    console.warn("  WebSub: dist/feed.xml missing — run the build/deploy first; skipping ping.");
    return;
  }
  const hasPodcast = existsSync(join(distDir, "podcast.xml"));
  const topics = websubTopics(cfg.baseUrl, hasPodcast);
  for (const topic of topics) await pingHub(cfg.hubUrl, topic);
}

if (import.meta.main) {
  main().catch((err) => {
    // Never fail the deploy on a notification error.
    console.warn("WebSub ping error:", err);
  });
}
