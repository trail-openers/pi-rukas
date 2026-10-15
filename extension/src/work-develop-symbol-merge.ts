/**
 * work-develop-symbol-merge — #1323: merge and retry once when a
 * workstream's verify failure names a symbol a sibling workstream adds.
 *
 * A coupled split that slips through planning (#1322 is the planning side)
 * shows up after develop as a per-workstream verify failure: the consumer
 * half fails to compile because the symbol it uses lives in a sibling's
 * commit, which its worktree never saw (#1297: an export added in one
 * workstream, consumed in another). Re-running the same split fails the
 * same way, so the recovery is the fence merge-and-retry's shape (#1005):
 *
 *   1. Attribute each per-worktree verify failure to its workstream, and
 *      read the identifiers it says are missing (work-develop-symbol-scan.ts).
 *   2. For every sibling, the symbols it adds: its declared `introduces`
 *      (#1322) first, then the declarations its own diff adds. A sibling
 *      that adds a missing symbol is the producer; the failing one the
 *      consumer.
 *   3. Fold the consumer into the producer with the fence merge
 *      (runMergePrep: the shared fold, the consumer's worktree reset to the
 *      producer's tip, one re-dispatch), recording a
 *      `fence-recovery-started` event with `cause: "sibling-symbol"` that
 *      names both workstreams and the symbols.
 *   4. Re-run the develop gate once. A pass continues to the converge gate;
 *      a failure parks as `verify-failed:develop` exactly as before, and the
 *      handoff explanation says the split was merged and still failed
 *      (`mergedSplitNote` in work-driver-explain-verify.ts).
 *
 * Bounded: one merge-and-retry per cycle (any earlier merge event in the
 * cycle's log — fence or symbol — disables it), only on a multi-workstream
 * develop, and pairs are disjoint (a workstream is in at most one merge per
 * round). `PI_ENSEMBLE_SYMBOL_MERGE_RETRY=0` turns it off.
 */

import { recordCommentEvidence } from "./comment-evidence.ts";
import { type MergePrepPlan, runMergePrep } from "./work-develop-fence-merge.ts";
import { replaceDevelopConvergedVerdicts } from "./work-develop-fence-verdicts.ts";
import { addedSymbolsInDiff, missingSymbolsIn } from "./work-develop-symbol-scan.ts";
import { appendDevelopVerifyFailure } from "./work-develop-verify-failure.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { symbolKey } from "./work-driver-plan-contract.ts";
import { applySafetyNet } from "./work-driver-safety-net.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";

type DevelopVerifyGate = Awaited<ReturnType<typeof verifyStepOutcome>>;
type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;

/** #1323 — kill switch (default on). */
export function symbolMergeRetryEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_SYMBOL_MERGE_RETRY;
  return v !== "0" && v !== "false";
}

/** One coupling: `consumer`'s failure names `symbols`, which `producer` adds. */
export interface SymbolCoupling {
  consumer: string;
  producer: string;
  symbols: string[];
}

const VALID_SHA = /^[0-9a-f]{40}$/;

/**
 * The workstream a per-worktree failure string belongs to. The gate writes
 * `… failed in <cwd>: <output>` (work-driver-verify-verify-cmd.ts); the
 * longest matching worktree path wins, so `/wt/ws-1` never claims a failure
 * from `/wt/ws-10`.
 */
function failureOwner(failure: string, worktrees: Record<string, string>): string | undefined {
  let best: { id: string; len: number } | undefined;
  for (const [id, cwd] of Object.entries(worktrees)) {
    const at = failure.indexOf(` in ${cwd}`);
    if (at < 0) continue;
    const after = failure.charAt(at + 4 + cwd.length);
    if (after !== "" && after !== ":" && after !== " " && after !== "\n") continue;
    if (!best || cwd.length > best.len) best = { id, len: cwd.length };
  }
  return best?.id;
}

/**
 * #1323 — the consumer → producer couplings in a failed develop gate. Pure
 * apart from `diffOf`, which is called at most once per sibling and only
 * when a failure needs a symbol its declared `introduces` does not cover.
 * The result is disjoint: once a workstream is in a coupling it is not
 * paired again this round.
 */
export async function findSymbolCouplings(
  failures: string[],
  worktrees: Record<string, string>,
  introducesOf: (id: string) => string[] | undefined,
  diffOf: (id: string) => Promise<string>,
): Promise<SymbolCoupling[]> {
  const missingBy = new Map<string, Set<string>>();
  for (const f of failures) {
    const id = failureOwner(f, worktrees);
    if (id === undefined) continue;
    const syms = missingSymbolsIn(f);
    if (syms.length === 0) continue;
    const set = missingBy.get(id) ?? new Set<string>();
    for (const s of syms) set.add(s);
    missingBy.set(id, set);
  }
  if (missingBy.size === 0) return [];
  const diffCache = new Map<string, Set<string>>();
  const diffAdds = async (id: string): Promise<Set<string>> => {
    const cached = diffCache.get(id);
    if (cached) return cached;
    let added = new Set<string>();
    try {
      added = new Set(addedSymbolsInDiff(await diffOf(id)));
    } catch {
      // An unreadable diff is no evidence: this sibling just never matches.
    }
    diffCache.set(id, added);
    return added;
  };
  const used = new Set<string>();
  const out: SymbolCoupling[] = [];
  for (const [consumer, missing] of missingBy) {
    if (used.has(consumer)) continue;
    for (const producer of Object.keys(worktrees)) {
      if (producer === consumer || used.has(producer)) continue;
      const declared = new Set(
        (introducesOf(producer) ?? []).map(symbolKey).filter((k): k is string => !!k),
      );
      let hits = [...missing].filter((s) => declared.has(s));
      if (hits.length === 0) {
        const added = await diffAdds(producer);
        hits = [...missing].filter((s) => added.has(s));
      }
      if (hits.length === 0) continue;
      out.push({ consumer, producer, symbols: hits });
      used.add(consumer);
      used.add(producer);
      break;
    }
  }
  return out;
}

/** The re-dispatch prompt for a sibling-symbol merge. */
export function symbolMergePrompt(
  mergedId: string,
  halves: string[],
  couplings: SymbolCoupling[],
): string {
  const named = couplings
    .filter((c) => c.producer === mergedId)
    .map(
      (c) =>
        `${c.consumer} failed its verify on ${c.symbols.map((s) => `\`${s}\``).join(", ")}, which ${c.producer} adds`,
    )
    .join("; ");
  return [
    `SIBLING-SYMBOL MERGE-AND-RETRY — workstream ${mergedId} (merged from: ${halves.join(", ")}).`,
    "",
    `Your first attempt was split across ${halves.length} workstreams that each started from the same base commit, so neither saw the other's symbols: ${named}. The halves are COUPLED, so the driver MERGED them into a single workstream: ${mergedId}.`,
    "",
    `This is your ONLY re-dispatch. The merged scope is the UNION of both halves' declared paths. The worktree now contains ${mergedId}'s commit, so the symbols above exist — build the consuming half's work ON TOP of it, use those symbols as ${mergedId} defined them, do NOT re-implement them, and do NOT touch any file outside the merged scope. Then run the project's verify command and commit.`,
  ].join("\n");
}

/** One merge-and-retry per cycle: any earlier merge event disables it. */
function alreadyMerged(state: WorkState): boolean {
  return state.eventLog.some((e) => e.kind === "fence-recovery-started");
}

/**
 * #1323 — the entry point, called by the develop step when its gate failed
 * without a recoverable fence violation. Returns `undefined` when no
 * sibling-symbol coupling applies (the caller then parks as today), else
 * the state after the merge, the single re-dispatch and the gate re-run.
 */
export async function runSymbolMergeRetry(
  ctx: CycleContext,
  stateIn: WorkState,
  stateRef: { current: WorkState },
  ids: string[],
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>,
  gate: DevelopVerifyGate,
  execFn: ExecFn,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
): Promise<WorkState | undefined> {
  if (!symbolMergeRetryEnabled() || ids.length < 2 || alreadyMerged(stateIn)) return undefined;
  const worktrees = stateIn.pipelineState.worktrees ?? {};
  const workstreams = stateIn.pipelineState.workstreams ?? {};
  const baseShas = stateIn.pipelineState.workstreamBaseShas ?? {};
  const couplings = await findSymbolCouplings(
    gate.failures,
    worktrees,
    (id) => workstreams[id]?.introduces,
    async (id) => {
      const base = baseShas[id] ?? stateIn.pipelineState.baseSha;
      const cwd = worktrees[id];
      if (!base || !VALID_SHA.test(base) || typeof cwd !== "string") return "";
      const { stdout } = await execFn(`git diff ${base}..HEAD`, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    },
  );
  if (couplings.length === 0) return undefined;
  // The first attempt's failures stay on verifyEvidence, so a park inside
  // the merge (a git failure) still shows what the gate found.
  let next: WorkState = {
    ...stateIn,
    pipelineState: {
      ...stateIn.pipelineState,
      verifyEvidence: {
        step: "develop",
        failures: gate.failures,
        at: Date.now(),
        origin: "outcome-gate",
      },
    },
  };
  stateRef.current = next;
  const plan: MergePrepPlan = {
    pairs: couplings.map((c) => ({
      violator: c.consumer,
      owner: c.producer,
      symbols: c.symbols,
    })),
    prompt: (mergedId, halves) => symbolMergePrompt(mergedId, halves, couplings),
    cap: "verify-failed:develop",
  };
  const prep = await runMergePrep(ctx, next, stateRef, ids, execFn, dispatch, plan);
  next = prep.state;
  if (prep.outcome.parked) return next;
  const { mergedIds, merges } = prep.outcome;
  next = await applySafetyNet(ctx, next);
  const gate2 = await verifyStepOutcome(ctx, next, "develop");
  next = recordCommentEvidence(next, gate2.commentEvidence);
  // The surviving (producer) id carries the re-run's verdict; the absorbed
  // consumer id is no longer a workstream.
  const absorbed = new Set(merges.map((m) => m.from));
  next = replaceDevelopConvergedVerdicts(
    next,
    verdicts
      .filter((v) => !absorbed.has(v.id))
      .map((v) => (mergedIds.includes(v.id) ? { id: v.id, ok: gate2.ok } : { ...v })),
  );
  stateRef.current = next;
  if (gate2.ok) return runConvergeGateHandler(ctx, next, dispatch);
  return appendDevelopVerifyFailure(next, gate2);
}
