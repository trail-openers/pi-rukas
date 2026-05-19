/**
 * Diagnostic stderr writer, gated on the `PI_ENSEMBLE_DEBUG` env var.
 *
 * Off by default in v0.1.0 (alpha). Set `PI_ENSEMBLE_DEBUG=1` to enable per-
 * command and per-spawn trace lines like `[pi-ensemble] /work fired (args: …)`.
 *
 * Stderr is safe in both Pi's TUI (mirrored to a side panel) and `-p` mode
 * (stdout-only for the JSON stream); doesn't pollute either.
 */

const DEBUG_ENABLED = process.env.PI_ENSEMBLE_DEBUG === "1";

export function trace(msg: string): void {
  if (!DEBUG_ENABLED) return;
  process.stderr.write(`[pi-ensemble] ${msg}\n`);
}

export function isTraceEnabled(): boolean {
  return DEBUG_ENABLED;
}
