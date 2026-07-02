// Shared client for a long-lived Python worker that speaks newline-delimited
// JSON over stdio: the model loads ONCE in the child and we stream one request
// per line, pairing it with its single response line. Both the MOSS TTS
// provider (generate/tts-providers.ts) and the Qwen3 aligner (generate/aligner.ts)
// run this exact shape, and used to carry byte-near-identical copies of it.
//
// This is the extracted scaffold only — spawn + unref + exit-kill, lazy
// single-start, FIFO request serialization, and shutdown. Each caller keeps its
// own wire protocol: the spawn command/cwd/env, the ready-handshake validation,
// and every per-request payload/response transform stay caller-side, so the
// protocol the .py workers speak is unchanged.

type Handle<Res> = {
  proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  stdin: Bun.FileSink;
  readResponse: () => Promise<Res>;
};

// Reads a child's stdout as a stream of newline-delimited JSON objects, handing
// them out one-per-call in FIFO order so each request pairs with its single
// response line. If the stream closes (worker died), pending and future reads
// reject with a clear, named error.
function jsonLineReader<Res>(
  stream: ReadableStream<Uint8Array>,
  name: string,
): () => Promise<Res> {
  const queued: Res[] = [];
  const waiters: { resolve: (v: Res) => void; reject: (e: Error) => void }[] = [];
  let closed: Error | null = null;
  (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const obj = JSON.parse(line) as Res;
          const w = waiters.shift();
          if (w) w.resolve(obj);
          else queued.push(obj);
        }
      }
      closed = new Error(`${name} stdout closed (process exited)`);
    } catch (err) {
      closed = err instanceof Error ? err : new Error(String(err));
    }
    while (waiters.length) waiters.shift()!.reject(closed!);
  })();
  return () =>
    new Promise<Res>((resolve, reject) => {
      const q = queued.shift();
      if (q) resolve(q);
      else if (closed) reject(closed);
      else waiters.push({ resolve, reject });
    });
}

export class LongLivedJsonWorker<Req, Res> {
  #handle: Handle<Res> | null = null;
  #starting: Promise<Handle<Res>> | null = null;
  // Serialize requests: one model, one stdin/stdout channel, one in-flight
  // request at a time. Chaining onto a tail promise turns concurrent request()
  // calls into a FIFO queue (today's callers are serial, but this keeps us
  // correct if that changes).
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: {
      /** Names the "…stdout closed (process exited)" error for this worker. */
      readonly name: string;
      /**
       * Spawn the child (caller owns cmd/cwd/env — the wire protocol). Any
       * "loading model…" log belongs here so it prints once, right after spawn.
       */
      readonly spawn: () => Bun.Subprocess<"pipe", "pipe", "inherit">;
      /**
       * Validate the first (handshake) response line and capture any fields the
       * caller needs (e.g. the worker's native sample rate). Throw to fail
       * startup.
       */
      readonly onReady: (first: Res) => void;
    },
  ) {}

  async #start(): Promise<Handle<Res>> {
    const proc = this.opts.spawn();
    // Don't let the live worker keep the build process alive past its work, and
    // make sure it dies with us rather than leaking a loaded model.
    proc.unref();
    process.once("exit", () => proc.kill());
    const readResponse = jsonLineReader<Res>(proc.stdout, this.opts.name);
    const ready = await readResponse();
    this.opts.onReady(ready);
    return { proc, stdin: proc.stdin, readResponse };
  }

  // Lazily spawn the worker at most once. A fully-cached (or --mock) build that
  // never issues a request never loads the model.
  #ensure(): Promise<Handle<Res>> {
    if (this.#handle) return Promise.resolve(this.#handle);
    if (!this.#starting) this.#starting = this.#start().then((h) => (this.#handle = h));
    return this.#starting;
  }

  /** Write one request line and resolve with its paired response line. */
  request(req: Req): Promise<Res> {
    const result = this.#tail.then(async () => {
      const h = await this.#ensure();
      h.stdin.write(JSON.stringify(req) + "\n");
      await h.stdin.flush();
      return h.readResponse();
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  // Shut the worker down so the build process can exit. The never-ending stdout
  // read (jsonLineReader) keeps Bun's event loop alive, so without this the
  // build hangs after its last output. Closing stdin signals EOF to the
  // worker's read loop; the kill is a backstop. Idempotent and safe if the
  // worker never started.
  async close(): Promise<void> {
    const h = this.#handle;
    this.#handle = null;
    this.#starting = null;
    if (!h) return;
    try {
      h.stdin.end();
    } catch {}
    try {
      h.proc.kill();
    } catch {}
    try {
      await h.proc.exited;
    } catch {}
  }
}
