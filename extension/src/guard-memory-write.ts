/**
 * guard-memory-write — write invariant-removal memories from type-widening findings.
 *
 * Issue #280 — when the widening scan fires, write ONE vipune candidate memory
 * per (file, symbol) so future cycles know what invariant just died. Typed
 * `observation` since #1103 — see `defaultVipuneWrite`.
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
import { type ExecFn, vipuneAdd } from "./vipune.ts";

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
 * A function that writes an invariant-removal memory.
 *
 * Default: `vipune add … --memory-type observation --status candidate` through
 * the `vipune.ts` seam. Injected in tests to assert on argv without forking
 * the binary.
 *
 * Returns an opaque string so the caller cannot assume a particular CLI
 * output format; the outcome is determined by whether the call succeeded.
 */
export type VipuneWriteFn = (
  /** Full memory content (≤1000 chars). */
  text: string,
  opts: { cwd: string; issue: number },
) => Promise<{ id?: string }>;

/**
 * Default vipune-write implementation.
 *
 * The "candidate" tier means invisible to a default read, so a wrong write
 * influences nothing until an operator promotes it. Typed `observation`, not
 * `guard`, for the same reason as every driver write (#1103): `vipune prune`
 * never demotes a guard, so an unpromoted guard candidate could never age out.
 *
 * Never throws: vipune absent or erroring returns `{}`. The caller already
 * holds the widening findings; the memory is additive value, not structural.
 */
export async function defaultVipuneWrite(
  text: string,
  opts: { cwd: string; issue: number; execFn?: ExecFn },
): Promise<{ id?: string }> {
  try {
    const r = await vipuneAdd(text, {
      cwd: opts.cwd,
      timeoutMs: 15000,
      execFn: opts.execFn,
      memoryType: "observation",
      status: "candidate",
    });
    return r.kind === "added" ? { id: r.id } : {};
  } catch {
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
