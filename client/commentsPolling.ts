// Visibility- AND connectivity-gated polling for the comment sync layer.
// Runs the supplied poll callback on a fixed interval, but only while the
// tab is BOTH `document.visibilityState === "visible"` AND online. When the
// tab becomes hidden OR the browser goes offline we cancel the timer entirely
// — there's no point pulling fresh comments the user isn't looking at, and no
// point firing a fetch we know will fail offline (which otherwise repeats every
// `intervalMs`, spamming the console with caught errors on a PWA that is
// expected to work offline). On becoming active again (visible AND online) we
// trigger an immediate poll if more than `intervalMs` has elapsed since the
// last one (so a user who comes back — from another tab, or from a tunnel that
// dropped the connection — doesn't wait for the next 60-second mark).
//
// Single-flight: if `requestPoll()` or the timer fires while a poll is already
// running, we set a `rerun` flag and run again as soon as the in-flight one
// completes. Avoids stacking N concurrent hydrate/aggregate sweeps if the
// network is slow.

const DEFAULT_INTERVAL_MS = 60_000;

export class CommentPolling {
  private timer: number | null = null;
  private inFlight = false;
  private rerun = false;
  // Connectivity, mirrored from the online/offline events. Initialized from
  // navigator.onLine (treating "unknown" as online so a non-browser/test env
  // still polls).
  private online = typeof navigator === "undefined" || navigator.onLine !== false;
  // Initialized to "now" because the caller has just finished the
  // boot-time hydrate before constructing us — there's no point
  // re-polling immediately.
  private lastPollAt = Date.now();

  constructor(
    private readonly poll: () => Promise<void>,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {
    document.addEventListener("visibilitychange", this.reconcile);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    if (this.active) this.schedule();
  }

  // Remove listeners and cancel any pending poll. Not called in the current
  // single-page lifetime (the comment layer lives as long as the page), but
  // exposed so a host can dispose us — and so tests don't leak a timer.
  stop(): void {
    document.removeEventListener("visibilitychange", this.reconcile);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Force an immediate poll regardless of the interval. Not used
  // today but cheap to expose; the obvious caller is "user just
  // submitted a comment, do a fresh aggregate so any concurrent
  // writes show up."
  requestPoll(): void {
    this.run();
  }

  // Active = the only state in which polling makes sense: the tab is visible
  // AND the browser believes it's online.
  private get active(): boolean {
    return document.visibilityState === "visible" && this.online;
  }

  private onOnline = (): void => {
    this.online = true;
    this.reconcile();
  };

  private onOffline = (): void => {
    this.online = false;
    this.reconcile();
  };

  // Reconcile the timer with the current active state. Fires on
  // visibilitychange and on online/offline. Inactive ⇒ stop the timer;
  // newly active ⇒ catch up if stale, else resume on the remaining interval.
  private reconcile = (): void => {
    if (!this.active) {
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
    if (!this.active) return;
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
