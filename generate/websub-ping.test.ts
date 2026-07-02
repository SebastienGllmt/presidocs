import { test, expect } from "bun:test";
import { websubPublishBody, websubTopics } from "./websub-ping.ts";
import { resolveFeedConfig } from "./feedConfig.ts";

test("websubPublishBody — publish mode with both topic + url keys", () => {
  const body = new URLSearchParams(websubPublishBody("https://blog.example.com/feed.xml"));
  expect(body.get("hub.mode")).toBe("publish");
  // Both the WebSub (hub.topic) and the older PubSubHubbub (hub.url) names, so
  // the same ping works across hub implementations.
  expect(body.get("hub.topic")).toBe("https://blog.example.com/feed.xml");
  expect(body.get("hub.url")).toBe("https://blog.example.com/feed.xml");
});

test("websubTopics — Atom always; podcast only when it was emitted", () => {
  expect(websubTopics("https://blog.example.com", false)).toEqual([
    "https://blog.example.com/feed.xml",
  ]);
  expect(websubTopics("https://blog.example.com", true)).toEqual([
    "https://blog.example.com/feed.xml",
    "https://blog.example.com/podcast.xml",
  ]);
});

test("resolveFeedConfig — WEBSUB_HUB is opt-in (null when unset)", () => {
  expect(resolveFeedConfig({}).hubUrl).toBeNull();
  expect(resolveFeedConfig({ WEBSUB_HUB: "  " }).hubUrl).toBeNull();
  // Preserved verbatim — including the /hub path (unlike baseUrl, which is
  // trailing-slash-stripped); the value must be the hub's POST endpoint.
  expect(resolveFeedConfig({ WEBSUB_HUB: "https://websubhub.com/hub" }).hubUrl).toBe(
    "https://websubhub.com/hub",
  );
});
