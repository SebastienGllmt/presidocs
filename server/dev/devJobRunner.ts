// Shared scaffold for the dev-only, author-only endpoints that shell out to the
// offline `bun` generate pipeline (regenerate.dev.ts and soundTest.dev.ts). Both
// spawn a `generate.ts` / `sound-test.ts` child, capture its full stdout/stderr
// + exit code, and — on failure — surface the tail of its output to the author.
// That spawn-collect-tail block was copy-pasted three times; this is its single
// owner. Dev-only (imported only via createDevServer.ts), so `Bun.spawn` here
// never reaches the prod Worker bundle.

export type DevJobResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The last 8 lines of stderr (falling back to stdout), trimmed — the
   *  author-facing failure summary both endpoints record onto their job. */
  tail: string;
};

/** Spawn `cmd` (a `bun …` invocation of the offline generate pipeline) in
 *  `cwd`, inheriting the current process env, and await its full output.
 *  Returns the exit code, captured streams, and the failure `tail`. */
export async function runDevJob(cmd: string[], cwd: string): Promise<DevJobResult> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const tail = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
  return { exitCode, stdout, stderr, tail };
}
