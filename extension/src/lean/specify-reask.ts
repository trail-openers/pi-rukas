/**
 * lean/specify-reask — the one follow-up prompt a specify attempt sends the SAME child when it called
 * `submit_tests` for some of the spec's test criteria and never for the others.
 *
 * The shape this exists for: a child writes and proves red tests for every criterion, submits only some
 * of them, and reports the whole set done. Nothing in the attempt's retry gate covers it — the child is
 * not silent and the boundary refused nothing — so the unsubmitted criteria end the run although the
 * tests exist. The missing set is wanted ids minus the ids the child DECLARED: a criterion whose row the
 * boundary later drops is the refusal retry's to name, and a file is never guessed at from disk, because
 * only a `submit_tests` call counts as submitted.
 *
 * "The same child" is its session: `spawnSpecialist` closes a child's stdin at its first `agent_end`,
 * and it opens the session file its `runId` names. So the attempt mints the runId before its first
 * dispatch, and the re-ask is a dispatch on that same runId — a resumed conversation with the child's
 * own tool roster, the `submit_tests` companion, the same write fence and a budget armed from the same
 * ceiling, which a bespoke resumed child would each have to re-create. A session path that would not
 * match (the transcript's date directory rolled over between the two) skips the re-ask rather than
 * starting a stranger.
 *
 * Only the asked ids are taken from the reply, so a re-ask cannot rewrite a criterion the child already
 * submitted, and a reply the child could not complete — dead, killed, rejected — changes nothing: the
 * attempt ends as it would have without the re-ask. Its cost is billed either way.
 */

import path from "node:path";
import { transcriptPathFor } from "../spawn-support.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import type { Budget } from "./config.ts";
import type { Outcome } from "./state.ts";
import {
  type BudgetArms,
  type BudgetFired,
  type DispatchUsageRow,
  armBudget,
  dispatchUsageRow,
} from "./step-budget.ts";
import { type SubmitTestsRow, extractSubmitTests } from "./submit-tests-extract.ts";
import { SUBMIT_TESTS_REPORTER_PATH } from "./submit-tests-reporter.ts";
import { joinNotes } from "./text-fence.ts";

/**
 * The ONE reader of the switch. Default on; only the literal `"0"` takes the re-ask out, and then an
 * attempt dispatches exactly as before it existed. Read at CALL time, so a smoke file can pin an arm.
 */
export function leanSpecifyReaskEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_SPECIFY_REASK !== "0";
}

/** The options every specify dispatch — the adversary and its re-ask — is sent with. */
export function adversaryDispatchOpts(o: {
  wt: string;
  repoRoot: string;
  issue: number;
  budget: BudgetArms;
  runId?: string;
}): { writeFence: WriteFence; extraArgs: string[]; runId?: string } & BudgetArms["opts"] {
  return {
    writeFence: {
      root: o.wt,
      repo: o.repoRoot,
      // `<repoRoot>/tmp/lean-<issue>`: the worktree's parent is `.worktrees`, so one `..` from it is
      // the repo root — the scratch dir the hygiene convention names.
      scratch: path.join(path.dirname(o.wt), "..", "tmp", `lean-${o.issue}`),
    },
    extraArgs: ["--no-skills", "--extension", SUBMIT_TESTS_REPORTER_PATH],
    ...o.budget.opts,
    ...(o.runId === undefined ? {} : { runId: o.runId }),
  };
}

/** The test criteria the child declared no row for, in spec order. */
export function missingCriteria(wanted: string[], declared: SubmitTestsRow[]): string[] {
  const have = new Set(declared.map((r) => r.criterionId));
  return wanted.filter((id) => !have.has(id));
}

/** The follow-up prompt: the ids, the tool, and nothing the child already did. */
export function reaskPrompt(missing: string[]): string {
  return [
    "## Criteria you never submitted",
    "",
    `Your previous turn called submit_tests for some criteria but never for ${missing.join(", ")}.`,
    "Call submit_tests once for each of those criteria now, naming the red test files you wrote for it.",
    "If a file is no longer in the tree, write it again first. Do not resubmit any other criterion.",
  ].join("\n");
}

/** The step-log clause an attempt that re-asked carries on its reason. */
export function reaskNote(missing: string[]): string {
  return `re-asked the child once for ${missing.join(", ")}: it had not called submit_tests for them`;
}

/** The note on a recorded outcome; a budget stop keeps its canonical sentence. */
export function withReaskNote(outcome: Outcome, note: string | undefined): Outcome {
  if (note === undefined || outcome.kind === "budget") return outcome;
  return { ...outcome, reason: joinNotes([outcome.reason ?? "", note]) };
}

type ReaskDispatch = (
  spec: { role: string; prompt: string; cwd: string },
  opts: ReturnType<typeof adversaryDispatchOpts>,
) => Promise<DispatchResult>;

/** What a re-ask added: the asked rows it read, its own billed row, and the note — or a budget stop. */
export type ReaskResult =
  | { rows: SubmitTestsRow[]; skipped: number; row: DispatchUsageRow; note: string }
  | { stop: BudgetFired; row: DispatchUsageRow };

/**
 * Re-ask the child behind `first` for the `missing` ids, once. `undefined` when no re-ask ran: the
 * switch is off or this is the retry attempt (no `runId`), nothing is missing, the child declared
 * nothing at all (the silent retry's case), a call was unreadable or the boundary `refuses` a declared
 * row (the refusal retry's case: asking would nag about a file the boundary refuses again), or its
 * session cannot be named again.
 */
export async function reaskMissing(args: {
  dispatch: ReaskDispatch;
  first: DispatchResult;
  runId: string | undefined;
  missing: string[];
  declared: number;
  skipped: number;
  /** Whether the boundary drops any declared row — asked last, since it reads the tree. */
  refuses: () => Promise<boolean>;
  budget: Budget | undefined;
  wt: string;
  repoRoot: string;
  issue: number;
}): Promise<ReaskResult | undefined> {
  const { first, runId, missing } = args;
  if (runId === undefined || missing.length === 0 || args.declared === 0 || args.skipped > 0)
    return undefined;
  if (await args.refuses()) return undefined;
  if (
    first.transcriptPath !== undefined &&
    first.transcriptPath !== transcriptPathFor(first.role, runId)
  ) {
    traceWarn(`lean specify #${String(args.issue)}: the child's session moved; no re-ask`);
    return undefined;
  }
  const budget = armBudget(args.budget);
  let result: DispatchResult;
  try {
    result = await args.dispatch(
      { role: first.role, prompt: reaskPrompt(missing), cwd: args.wt },
      adversaryDispatchOpts({ ...args, budget, runId }),
    );
  } catch (err) {
    traceWarn(`lean specify #${String(args.issue)}: the re-ask failed: ${(err as Error).message}`);
    return undefined;
  }
  const row = dispatchUsageRow(result);
  const fired = budget.fired(result);
  if (fired !== undefined) return { stop: fired, row };
  const answered = row.ok ? extractSubmitTests(result.toolUses ?? []) : { rows: [], skipped: 0 };
  const asked = new Set(missing);
  return {
    rows: answered.rows.filter((r) => asked.has(r.criterionId)),
    skipped: answered.skipped,
    row,
    note: reaskNote(missing),
  };
}
