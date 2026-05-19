// Visibility-gated polling for the comment sync layer. Runs the
// supplied poll callback on a fixed interval while the tab is
// `document.visibilityState === "visible"`. When the tab becomes
// hidden we cancel the timer entirely — there's no point pulling
// fresh comments the user isn't looking at — and on becoming visible
// again we trigger an immediate poll if more than `intervalMs` has
// elapsed since the last one (so a user who comes back after a long
// absence doesn't have to wait for the next 60-second mark).
//
// Single-flight: if `requestPoll()` or the timer fires while a poll
// is already running, we set a `rerun` flag and run again as soon as
// the in-flight one completes. Avoids stacking N concurrent
// hydrate/aggregate sweeps if the network is slow.

const DEFAULT_INTERVAL_MS = 60_000;

export class CommentPolling {
  private timer: number | null = null;
  private inFlight = false;
  private rerun = false;
  // Initialized to "now" because the caller has just finished the
  // boot-time hydrate before constructing us — there's no point
  // re-polling immediately.
  private lastPollAt = Date.now();

  constructor(
    private readonly poll: () => Promise<void>,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {
    document.addEventListener("visibilitychange", this.onVisibility);
    if (document.visibilityState === "visible") this.schedule();
  }

  // Force an immediate poll regardless of the interval. Not used
  // today but cheap to expose; the obvious caller is "user just
  // submitted a comment, do a fresh aggregate so any concurrent
  // writes show up."
  requestPoll(): void {
    this.run();
  }

  private onVisibility = (): void => {
    if (document.visibilityState !== "visible") {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    const since = Date.now() - this.lastPollAt;
    if (since >= this.intervalMs) {
      this.run();
    } else {
      this.schedule(this.intervalMs - since);
    }
  };

  private schedule(delay: number = this.intervalMs): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (document.visibilityState !== "visible") return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.run();
    }, delay);
  }

  private run(): void {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    this.inFlight = true;
    try {
      do {
        this.rerun = false;
        try {
          await this.poll();
        } catch (err) {
          console.warn("comment polling iteration failed:", err);
        }
        this.lastPollAt = Date.now();
      } while (this.rerun);
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}
