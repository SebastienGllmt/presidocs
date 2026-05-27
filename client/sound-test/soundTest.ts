// Client for the dev-only sound-test page (served at /dev/sound-test). Lists the
// lexemes in posts/common-terms.pls, plays the production-voice audio for each,
// and drives the async regenerate endpoint so the author can re-roll a term that
// MOSS reads wrong. React-free (the whole site is); plain DOM + fetch.
//
// See server/soundTest.dev.ts for the endpoints and shared/soundTest.ts for the
// audio identity contract.

import "./soundTest.css";

type Lexeme = {
  index: number;
  graphemes: string[];
  alias: string | null;
  ipa: string | null;
  synthText: string | null;
  available: boolean;
  audioUrl: string | null;
  version: number; // file mtime; cache-buster for the sticky <audio> media cache
};

type ListResponse = {
  provider: string;
  voiceConfigured: boolean;
  lexemes: Lexeme[];
  message?: string;
  job?: JobStatus;
};

type JobStatus = {
  running: boolean;
  target?: string;
  ok?: boolean;
  error?: string;
};

const listEl = document.getElementById("st-list") as HTMLDivElement;
const statusEl = document.getElementById("st-status") as HTMLSpanElement;
const bannerEl = document.getElementById("st-banner") as HTMLDivElement;
const genAllBtn = document.getElementById("st-gen-all") as HTMLButtonElement;
const refreshBtn = document.getElementById("st-refresh") as HTMLButtonElement;

let busy = false; // a regenerate job is running (ours or a poll-detected one)

function setStatus(text: string) {
  statusEl.textContent = text;
}

function showBanner(text: string | null) {
  if (!text) {
    bannerEl.hidden = true;
    bannerEl.textContent = "";
  } else {
    bannerEl.hidden = false;
    bannerEl.textContent = text;
  }
}

function setBusy(next: boolean) {
  busy = next;
  genAllBtn.disabled = next;
  refreshBtn.disabled = next;
  listEl.querySelectorAll("button").forEach((b) => {
    (b as HTMLButtonElement).disabled = next;
  });
}

async function fetchList(): Promise<ListResponse> {
  const res = await fetch("/dev/sound-test/list", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json();
}

function render(data: ListResponse) {
  listEl.replaceChildren();

  if (data.message && data.lexemes.length === 0) {
    showBanner(data.message);
    return;
  }
  if (!data.voiceConfigured) {
    showBanner(
      "MOSS_TTS_VOICE is not set (or its clip is missing), so audio can't be generated. " +
        "Terms are listed below for reference.",
    );
  } else {
    showBanner(null);
  }

  const missing = data.lexemes.filter((l) => l.synthText && !l.available).length;
  genAllBtn.disabled = !data.voiceConfigured || missing === 0 || busy;
  genAllBtn.textContent = missing > 0 ? `Generate ${missing} missing` : "All generated";

  for (const lex of data.lexemes) {
    listEl.appendChild(renderRow(lex, data.voiceConfigured));
  }
}

function renderRow(lex: Lexeme, voiceConfigured: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "st-row";

  const left = document.createElement("div");
  left.className = "st-row-main";

  const graphemes = document.createElement("div");
  graphemes.className = "st-graphemes";
  for (const g of lex.graphemes) {
    const chip = document.createElement("code");
    chip.className = "st-chip";
    chip.textContent = g;
    graphemes.appendChild(chip);
  }
  left.appendChild(graphemes);

  const says = document.createElement("div");
  says.className = "st-says";
  if (lex.synthText) {
    says.innerHTML = `reads as <span class="st-say">${escapeHtml(lex.synthText)}</span>`;
  } else {
    says.innerHTML = `<span class="st-warn">no pronunciation (add an &lt;alias&gt;)</span>`;
  }
  left.appendChild(says);

  row.appendChild(left);

  const actions = document.createElement("div");
  actions.className = "st-actions";

  if (lex.available && lex.audioUrl) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    // Version query busts Chrome's sticky media cache when a re-roll produces
    // new bytes under the same content-hash filename.
    audio.src = `${lex.audioUrl}?v=${lex.version}`;
    actions.appendChild(audio);
  } else if (lex.synthText) {
    const tag = document.createElement("span");
    tag.className = "st-missing";
    tag.textContent = "not generated";
    actions.appendChild(tag);
  }

  if (voiceConfigured && lex.synthText) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "st-btn st-btn-small";
    btn.textContent = lex.available ? "Re-roll" : "Generate";
    btn.addEventListener("click", () => regenerate({ index: lex.index }));
    actions.appendChild(btn);
  }

  row.appendChild(actions);
  return row;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

// Start a regenerate job (one lexeme or all), then poll until it finishes and
// reload the list. Mirrors the per-segment regenerate flow in narrator.ts.
async function regenerate(opts: { index?: number; all?: boolean }) {
  if (busy) return;
  const qs = opts.all ? "all=1" : `index=${opts.index}`;
  setBusy(true);
  setStatus(opts.all ? "Loading model and rendering all missing…" : "Loading model and rendering…");
  try {
    const res = await fetch(`/dev/sound-test/regenerate?${qs}`, { method: "POST" });
    if (res.status === 401) {
      showBanner("You must be signed in to generate audio. Sign in on the blog (to comment), then retry.");
      setStatus("");
      setBusy(false);
      return;
    }
    if (res.status === 409) {
      setStatus("Another regeneration is already running; waiting for it…");
    } else if (!res.ok && res.status !== 202) {
      const text = await res.text();
      throw new Error(text || `regenerate failed: ${res.status}`);
    }
    await pollUntilDone();
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    setBusy(false);
    return;
  }
}

async function pollUntilDone() {
  // The MOSS model load alone exceeds a normal request timeout, so the endpoint
  // is start + poll. Keep polling GET until `running` clears.
  for (;;) {
    await sleep(1500);
    const res = await fetch("/dev/sound-test/regenerate");
    const job: JobStatus = await res.json();
    if (job.running) continue;
    const ok = job.ok !== false;
    if (ok) {
      setStatus("Done.");
    } else {
      setStatus(`Generation failed: ${job.error ?? "unknown error"}`);
    }
    // A MOSS render takes minutes — long enough to switch tabs — so chime when
    // it lands to call the author back. Distinct tones for done vs. failed.
    chime(ok);
    setBusy(false);
    await reload();
    return;
  }
}

// Short Web Audio chime (no asset, CSP-clean — generated, not an <audio src>).
// A rising two-note ding on success; a single low tone on failure. The page has
// always had a user gesture by now (the Generate click), so the AudioContext is
// allowed to start.
let audioCtx: AudioContext | null = null;
function chime(ok: boolean) {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const notes = ok ? [660, 880] : [330, 220];
    notes.forEach((freq, i) => {
      const start = audioCtx!.currentTime + i * 0.16;
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(start);
      osc.stop(start + 0.34);
    });
  } catch {
    // Audio is a nicety; never let it break the regenerate flow.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function reload() {
  try {
    const data = await fetchList();
    // If a job is somehow still running (e.g. started elsewhere), reflect it.
    if (data.job?.running) {
      setBusy(true);
      setStatus(`A regeneration is running (${data.job.target ?? "?"})…`);
      void pollUntilDone();
    }
    render(data);
  } catch (err) {
    showBanner(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
}

genAllBtn.addEventListener("click", () => regenerate({ all: true }));
refreshBtn.addEventListener("click", () => void reload());

void reload();
