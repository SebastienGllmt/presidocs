// methodology.md → Narrator — author-only, dev-only per-segment tools surfaced
// in the drawer: the "regenerate this segment's audio" button and the
// copy-the-mark-name label, both gated on localhost + the server-authoritative
// isAuthor flag.

import type { Narrator } from "../narrator.ts";
import { copyToClipboard } from "../clipboard.ts";
import { SPOKEN_ID_PREFIX } from "../narratorDom.ts";

export class AuthorTools {
  constructor(private readonly sys: Narrator) {}

  // Timer that clears the transient "Copied" state on a dev-only segment-name
  // label after a click. One shared handle: only one label flashes at a time.
  private nameCopyTimer: number | null = null;

  // Author-only, dev-only per-segment "regenerate audio" tool. Gated on BOTH:
  //   - localhost — the `/dev/regenerate` endpoint that shells out to the
  //     generate pipeline exists only on the dev Bun server, never the prod
  //     Worker (see server/dev/regenerate.dev.ts). On any other host the button
  //     would 404, so we don't show it.
  //   - the server-authoritative `isAuthor` flag from `/post-version` — the
  //     same check the comments UI uses. Never trust the DOM for this.
  // Non-localhost visitors short-circuit before any fetch, so this is a no-op
  // for ordinary readers.
  async maybeEnableAuthorTools() {
    const isLocal =
      location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!isLocal || !this.sys.postPath) return;
    let isAuthor = false;
    try {
      const res = await fetch(`/post-version?post=${encodeURIComponent(this.sys.postPath)}`, {
        credentials: "same-origin",
      });
      if (res.ok) isAuthor = (await res.json())?.isAuthor === true;
    } catch {
      return;
    }
    if (!isAuthor) return;
    for (const [markName, seg] of this.sys.drawer.segmentEls) {
      // Marks the segment as carrying author tools so the controls row widens
      // to a third column for the name label (see narrator.css).
      seg.classList.add("has-dev-tools");
      this.addRegenButton(seg, markName);
      this.addSegmentName(seg, markName);
    }
  }

  // Author-only, dev-only segment-name label, gated identically to the regen
  // button (localhost + isAuthor). Surfaces the mark `name` — the id a segment
  // is keyed by — so the author can read straight off the drawer which segments
  // to feed a manual re-roll (`generate --force-mark=<name>`) without digging
  // through the post source. `user-select: all` (set in CSS) makes one click
  // select the whole id for a clean copy into that command.
  private addSegmentName(seg: HTMLElement, markName: string) {
    const label = document.createElement("button");
    label.type = "button";
    label.className = "spoken-name";
    label.textContent = markName;
    label.title = `Copy segment name (--force-mark=${markName})`;
    label.setAttribute("aria-label", `Copy segment name ${markName}`);
    // Click copies the bare mark name — the exact `--force-mark=<name>` token —
    // and flips the label to a "Copied" state briefly. A button (not the old
    // span) so it's keyboard-focusable and the gesture reads as "actionable".
    label.addEventListener("click", () => {
      void copyToClipboard(markName).then((ok) => {
        if (!ok) return;
        label.classList.add("is-copied");
        if (this.nameCopyTimer !== null) clearTimeout(this.nameCopyTimer);
        this.nameCopyTimer = window.setTimeout(() => {
          label.classList.remove("is-copied");
          this.nameCopyTimer = null;
        }, 1000);
      });
    });
    // Visual placement is by CSS grid (sits between the play chip and the regen
    // button), so DOM order only needs to keep it inside the segment. Insert
    // right after the play chip so reading order is play → name → regen.
    const play = seg.querySelector(".spoken-play");
    if (play?.nextSibling) seg.insertBefore(label, play.nextSibling);
    else seg.appendChild(label);
  }

  private addRegenButton(seg: HTMLElement, markName: string) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spoken-regen";
    btn.title = "Regenerate this segment's audio (MOSS, author-only)";
    btn.setAttribute("aria-label", `Regenerate audio for ${markName}`);
    btn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" fill="currentColor"/></svg>';
    btn.addEventListener("click", () => void this.regenerateSegment(btn, markName));
    // Sit between the play button and the spoken text.
    const play = seg.querySelector(".spoken-play");
    if (play?.nextSibling) seg.insertBefore(btn, play.nextSibling);
    else seg.appendChild(btn);
  }

  // Re-roll one segment, then hard-reload so the rebuilt manifest + audio are
  // picked up cleanly (MOSS is probabilistic, so each click is a fresh take).
  // We land back on this segment with the drawer open via the URL hash, so the
  // loop is: click → wait → reload here → press play → repeat. A full reload
  // (vs. surgically swapping Shikwasa's source) is deliberate: it's bulletproof
  // and the model-load latency dwarfs a page reload.
  //
  // The job runs ASYNCHRONOUSLY on the server (a full render is minutes, longer
  // than any HTTP idle timeout), so we POST to *start* it and then POLL for
  // completion — the spinner reflects the actual job, not the request. A naive
  // long-lived request would have its connection killed mid-render, clearing
  // the spinner while generation silently continued.
  private async regenerateSegment(btn: HTMLButtonElement, markName: string) {
    if (btn.dataset.busy === "true") return;
    btn.dataset.busy = "true";
    btn.classList.add("is-busy");
    btn.disabled = true;
    btn.title = "Regenerating… (full render is slow; don't stop the dev server)";
    try {
      const start = await fetch(
        `/dev/regenerate?post=${encodeURIComponent(this.sys.postPath)}&mark=${encodeURIComponent(markName)}`,
        { method: "POST", credentials: "same-origin" },
      );
      if (start.status === 409) {
        window.alert("A regeneration is already in progress — try again once it finishes.");
        return;
      }
      if (start.status !== 202) {
        window.alert(await this.regenErrorMessage(start));
        return;
      }
      // Poll until the server reports the job done.
      const result = await this.pollRegenStatus();
      if (result.ok) {
        window.location.hash = SPOKEN_ID_PREFIX + markName;
        window.location.reload();
        return;
      }
      window.alert(`Regeneration failed.${result.error ? `\n\n${result.error}` : ""}`);
    } catch (err) {
      window.alert(
        `Regeneration request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Reached on every non-reload path (error / 409); on success the page has
      // already navigated away.
      btn.dataset.busy = "false";
      btn.classList.remove("is-busy");
      btn.disabled = false;
      btn.title = "Regenerate this segment's audio (MOSS, author-only)";
    }
  }

  // Poll GET /dev/regenerate every few seconds until the job stops running.
  // Capped so a hung/never-finishing job doesn't spin forever.
  private async pollRegenStatus(): Promise<{ ok: boolean; error?: string }> {
    const intervalMs = 2500;
    const maxMs = 30 * 60 * 1000; // 30 min ceiling for a worst-case cold render
    const deadline = Date.now() + maxMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, intervalMs));
      let body: { running?: boolean; ok?: boolean; error?: string };
      try {
        const res = await fetch("/dev/regenerate", { credentials: "same-origin" });
        if (!res.ok) return { ok: false, error: `status poll failed (HTTP ${res.status})` };
        body = await res.json();
      } catch (err) {
        return {
          ok: false,
          error: `status poll failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (body.running === false) return { ok: body.ok === true, error: body.error };
      if (Date.now() > deadline) {
        return { ok: false, error: "timed out waiting for regeneration to finish" };
      }
    }
  }

  private async regenErrorMessage(res: Response): Promise<string> {
    let msg = `Could not start regeneration (HTTP ${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) msg += `\n\n${body.error}`;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) msg += `\n\n${text}`;
    }
    return msg;
  }
}
