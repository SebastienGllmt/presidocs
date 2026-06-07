// One spec-consistent argv parser for the engine's flag-bearing CLI scripts.
//
// Wraps Node's built-in `node:util` `parseArgs` (stable since Node 20, and
// verified working under Bun) with the one thing every CLI here expressed
// differently by hand: catch a bad-input error (unknown flag, missing value),
// print the script's own usage line, and exit. Each script still declares its
// own `options`/usage — this only centralizes the "print usage and exit on bad
// input" tail, so the three flag CLIs (generate.ts, exportAnnotations.ts,
// align-check.ts) share one parser instead of three divergent loops.
//
// `parseArgs` is strict by default, so an undeclared flag (`--forcemark`) is a
// hard error here rather than a silently-ignored typo. Build-time/CLI only —
// never the client bundle or a Worker. Zero dependency (a Node builtin).

import { parseArgs, type ParseArgsConfig } from "node:util";

export interface CliUsage {
  /** Printed to stderr above the parser's own message on bad input. */
  usage: string;
  /** Process exit code on a parse error (default 1). align-check uses 2. */
  exitCode?: number;
}

/**
 * `parseArgs` with usage-and-exit error handling. Returns the parsed result
 * with full per-option type inference (the generic flows straight through to
 * `parseArgs`). On an `ERR_PARSE_ARGS_*` error it prints the parser's message,
 * the script's `usage`, and exits — anything else rethrows.
 */
export function parseCliArgs<const T extends ParseArgsConfig>(
  config: T,
  meta: CliUsage,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      if (err instanceof Error) console.error(err.message);
      console.error(meta.usage);
      process.exit(meta.exitCode ?? 1);
    }
    throw err;
  }
}
