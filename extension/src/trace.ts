/**
 * Diagnostic stderr writer, gated on the `PI_ENSEMBLE_DEBUG` env var.
 *
 * Off by default in v0.1.0 (alpha). Set `PI_ENSEMBLE_DEBUG=1` to enable per-
 * command and per-spawn trace lines like `[pi-rukas] /work fired (args: …)`.
 *
 * Stderr is safe in both Pi's TUI (mirrored to a side panel) and `-p` mode
 * (stdout-only for the JSON stream); doesn't pollute either.
 *
 * The switch is read on every call, not latched at module load: an earlier `const`
 * made "set `PI_ENSEMBLE_DEBUG` before importing" an invisible precondition of every
 * trace assertion, and `test-adversarial-reread-failure.ts` carried a `bun:test`
 * `mock.module` workaround purely to satisfy it. Reading it live costs one env lookup on
 * a path that already writes to stderr, and removes a class of test that silently passes
 * on an empty capture.
 */

function debugEnabled(): boolean {
  return process.env.PI_ENSEMBLE_DEBUG === "1";
}

export function trace(msg: string): void {
  if (!debugEnabled()) return;
  process.stderr.write(`[pi-rukas] ${msg}\n`);
}

/**
 * A warning that is NOT gated on `PI_ENSEMBLE_DEBUG`: the operator needs to
 * see a fault that changes an outcome (e.g. a review round left unrecorded).
 */
export function traceWarn(msg: string): void {
  process.stderr.write(`[pi-rukas] WARN ${msg}\n`);
}

export function isTraceEnabled(): boolean {
  return debugEnabled();
}
