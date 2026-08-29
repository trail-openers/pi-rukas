/**
 * guard-memory-write — write guard memories from type-widening findings.
 *
 * Issue #280 — when the widening scan fires, write ONE vipune guard memory
 * per (file, symbol) so future cycles know what invariant just died.
 *
 * The memory reads:
 *
 *   "constraint <before> → <after> removed in issue #N; verify what now
 *    guarantees the old invariant before writing code that exploits the
 *    widened type."
 *
 * Dedup: the caller tracks (file, symbol) pairs and skips duplicates within
 * a cycle. The write seam is injectable so tests can assert on argv without
 * forking vipune.
 */

import path from "node:path";
import type { WideningFinding } from "./invariant-scan.ts";

/**
 * A single guard-memory write result.
 *
 * Mirrors `WriteOutcome` but narrower — this module does not cap, so the
 * only outcomes are success and error.
 */
export interface GuardWriteOutcome {
  outcome: "written" | "error" | "skipped-dedup";
  id?: string;
  /**
   * The content written (or that would have been, if skipped/dedup).
   * Lets callers render a plumb-report without recomputing the body.
   */
  content?: string;
  /** (file, symbol) key for dedup — present even on error. */
  dedupKey: string;
}

/**
 * A function that writes a guard memory.
 *
 * Default: shells out to `vipune add … --memory-type guard --status candidate`.
 * Injected in tests to assert on argv without forking the binary.
 *
 * Returns an opaque string so the caller cannot assume a particular CLI
 * output format; the outcome is determined by whether the call succeeded.
 */
export type VipuneWriteFn = (
  /** Full guard-memory content (≤1000 chars). */
  text: string,
  opts: { cwd: string; issue: number },
) => Promise<{ id?: string }>;

/**
 * Default vipune-write implementation.
 *
 * Spawns `vipune add <text> --memory-type guard --status candidate`.
 * The "candidate" tier means invisible to a default read, so a wrong write
 * influences nothing until a human or a later rule acts on it.
 */
export async function defaultVipuneWrite(
  text: string,
  opts: { cwd: string; issue: number },
): Promise<{ id?: string }> {
  try {
    // The vipune binary may not be in PATH (e.g., inside the sandbox before
    // skills symlink). Return a no-op result rather than throwing — the
    // caller already captured the widening findings; the guard write is
    // additive value, not load-bearing.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const { stdout } = await execFileP(
      "vipune",
      ["add", text, "--memory-type", "guard", "--status", "candidate", "--json"],
      { cwd: opts.cwd, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { id?: string };
    return parsed.id ? { id: parsed.id } : {};
  } catch {
    // vipune absent or errored — return silently. The caller already has the
    // widening findings; this is additive value, not structural.
    return {};
  }
}

/**
 * Derive a human-readable symbol from a widening finding.
 *
 * Tries progressively: (a) the extracted `before`/`after` substring,
 * (b) the kind, (c) the line number. Ensures the dedup key is meaningful.
 */
function symbolFromFinding(f: WideningFinding): string {
  if (f.before && f.after) return `${f.before} → ${f.after}`;
  if (f.before) return `removed: ${f.before}`;
  if (f.after) return `widened to: ${f.after}`;
  return `kind: ${f.kind}`;
}

/**
 * Write one guard memory for each widening finding.
 *
 * Returns outcomes ordered by the input findings array. The caller (runLens)
 * is responsible for passing pre-deduped findings (unique file+symbol) and
 * for recording plumb-reports on success.
 *
 * Escape hatch: `PI_ENSEMBLE_INVARIANT_MEMORY=0` skips all writes and returns
 * `skipped-dedup` for every finding.
 */
export async function writeGuardMemories(
  findings: readonly WideningFinding[],
  issue: number,
  cwd: string,
  vipuneWrite: VipuneWriteFn,
): Promise<GuardWriteOutcome[]> {
  if (process.env.PI_ENSEMBLE_INVARIANT_MEMORY === "0") {
    return findings.map((f) => ({
      outcome: "skipped-dedup",
      dedupKey: `${f.file}:${symbolFromFinding(f)}`,
    }));
  }

  const out: GuardWriteOutcome[] = [];

  for (const f of findings) {
    const sym = symbolFromFinding(f);
    const dedupKey = `${f.file}:${sym}`;
    const base = path.basename(f.file);

    const content = `[invariant-removal] ${base}: constraint ${sym} removed in issue #${issue}; verify what now guarantees the old invariant before writing code that exploits the widened type.`;

    let r: { id?: string };
    try {
      r = await vipuneWrite(content, { cwd, issue });
      out.push({ outcome: "written", id: r.id, content, dedupKey });
    } catch (err) {
      out.push({
        outcome: "error",
        content,
        dedupKey,
      });
    }
  }

  return out;
}
