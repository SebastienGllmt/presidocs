// happy-dom gives us document.visibilityState (defaults "visible"),
// window online/offline events, and timers — enough to drive the
// connectivity gating without a real browser.
import "../happydom.ts";
import { test, expect } from "bun:test";
import { CommentPolling } from "./commentsPolling.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INTERVAL = 20; // short so the test runs in well under a second

test("polls periodically while visible and online", async () => {
  let count = 0;
  const p = new CommentPolling(async () => {
    count++;
  }, INTERVAL);
  try {
    await sleep(INTERVAL * 4);
    expect(count, "the periodic poll fires").toBeGreaterThanOrEqual(1);
  } finally {
    p.stop();
  }
});

test("going offline pauses polling; coming back online resumes it", async () => {
  let count = 0;
  const p = new CommentPolling(async () => {
    count++;
  }, INTERVAL);
  try {
    // Baseline: polling works while online.
    await sleep(INTERVAL * 4);
    expect(count, "baseline polling fires").toBeGreaterThanOrEqual(1);

    // Offline cancels the timer, so NO further poll can fire — this is a
    // hard guarantee (there's no scheduled callback), not a timing race.
    window.dispatchEvent(new Event("offline"));
    await sleep(INTERVAL); // let any in-flight poll settle
    const atOffline = count;
    await sleep(INTERVAL * 6);
    expect(count, "no polls happen while offline").toBe(atOffline);

    // Reconnecting resumes — and since more than one interval has elapsed
    // since the last poll, it catches up immediately.
    window.dispatchEvent(new Event("online"));
    await sleep(INTERVAL * 3);
    expect(count, "polling resumes after reconnect").toBeGreaterThan(atOffline);
  } finally {
    p.stop();
  }
});

test("stop() halts polling and detaches the online/offline listeners", async () => {
  let count = 0;
  const p = new CommentPolling(async () => {
    count++;
  }, INTERVAL);
  await sleep(INTERVAL * 3);
  p.stop();
  const afterStop = count;

  // No more periodic polls…
  await sleep(INTERVAL * 5);
  expect(count, "stop() cancels the timer").toBe(afterStop);

  // …and a later connectivity event must not revive a stopped poller.
  window.dispatchEvent(new Event("online"));
  await sleep(INTERVAL * 3);
  expect(count, "stopped poller ignores online/offline events").toBe(afterStop);
});
