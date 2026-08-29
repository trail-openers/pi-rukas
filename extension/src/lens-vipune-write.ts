/**
 * lens-vipune-write — wire guard-memory writes into runLens's widening scan.
 *
 * Also exports `appendGuardWriteEvents` — the event-append logic that
 * work-driver-lens.ts delegates to keep that file ≤500 lines.
 *
 * Issue #280 — when the widening scan fires (C. Invariant-removal guard
 * memories), write ONE vipune guard memory per (file, symbol). Dedupe:
 * no duplicate write for the same (file, symbol) within a cycle.
 *
 * This module is the thin integration: it receives the widening findings
 * (produced by scanTypeWidening in the lens step), calls through to
 * guard-memory-write's writeGuardMemories, and returns outcomes + dedup
 * keys so the caller can record plumb-reports.
 *
 * The injectable vipuneWriteFn defaults to shelling out to `vipune add`.
 * The default silently returns empty on failure — a missing vipune is not
 * a structural failure, and the widening findings themselves are the
 * source of truth; the guard memories are additive value.
 *
 * Escape hatch: `PI_ENSEMBLE_INVARIANT_MEMORY=0` restores today's behaviour
 * (no guard writes).
 */

import {
  type VipuneWriteFn,
  defaultVipuneWrite,
  writeGuardMemories,
} from "./guard-memory-write.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * A guard memory was written with a dedup key.
 *
 * Used to build the plumb-report the driver records on pipelineState.
 */
export interface GuardMemoryWrite {
  content: string;
  dedupKey: string;
  outcome: "written" | "error" | "skipped-dedup";
  id?: string;
}

/**
 * Run the guard-memory write path against widening findings.
 *
 * Returns an array of guard writes (one per finding), with outcomes and
 * the (file, symbol) dedup keys. The caller (runLens in work-driver-lens.ts)
 * is responsible for:
 *   - passing only unique (file, symbol) findings (dedup happens here)
 *   - recording a plumb-report on success (appendEvent with kind="plumb-report")
 *   - recording memory-write events per the existing memory-write pattern
 *
 * Pure: does not mutate state or touch the event log.
 */
export async function runGuardMemoryWrites(
  wideningFindings: { file: string; before?: string; after?: string; kind: string }[],
  issue: number,
  cwd: string,
  vipuneWrite: VipuneWriteFn | undefined,
): Promise<GuardMemoryWrite[]> {
  // PI_ENSEMBLE_INVARIANT_MEMORY=0 restores today's behaviour (no writes).
  if (process.env.PI_ENSEMBLE_INVARIANT_MEMORY === "0") {
    return wideningFindings.map((f) => ({
      content: "",
      dedupKey: `${f.file}:${f.kind}`,
      outcome: "skipped-dedup",
    }));
  }

  const writeFn = vipuneWrite ?? defaultVipuneWrite;

  // Shape findings for writeGuardMemories — the WideningFinding interface
  // uses kind strings that map directly to the scan output.
  const findings = wideningFindings.map((f): import("./invariant-scan.ts").WideningFinding => ({
    file: f.file,
    kind: f.kind as import("./invariant-scan.ts").WideningFinding["kind"],
    before: f.before,
    after: f.after,
  }));

  const results = await writeGuardMemories(findings, issue, cwd, writeFn);
  return results.map((r) => ({
    content: r.content ?? "",
    dedupKey: r.dedupKey,
    outcome: r.outcome,
    id: r.id,
  }));
}

/**
 * Append memory-write and plumb-report events for guard memory writes.
 *
 * Delegates the event-appending loop from work-driver-lens.ts to keep that
 * file under the 500-line cap.
 */
export function appendGuardWriteEvents(writes: GuardMemoryWrite[]): WorkEvent[] {
  const events: WorkEvent[] = [];
  for (const w of writes) {
    events.push({
      kind: "memory-write",
      at: Date.now(),
      outcome: w.outcome === "skipped-dedup" ? ("error" as const) : w.outcome,
      id: w.id,
      memoryType: "guard",
      detail: w.content ?? undefined,
    });
    if (w.outcome === "written" && w.content) {
      events.push({
        kind: "plumb-report",
        at: Date.now(),
        step: "lens-review",
        role: "work-driver",
        body: w.content,
      });
    }
  }
  return events;
}
