/**
 * lean/build-prove — did the driver watch a named frozen test fail? The re-run a blocked report is honoured on
 * and the answer a repair round is bought with. `build-blocked.ts` turns the child's calls into a durable
 * verdict; nothing here reads that prose — a red the driver ran is the only fact that leaves this file.
 */
import { trace, traceWarn } from "../trace.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { blobAt } from "./build-git.ts";
import type { BuildExec } from "./build-types.ts";
import {
  type Proof,
  TEST_TIMEOUT_MS,
  renderTestCommand,
  runTestFile,
  sha256,
} from "./specify-proof.ts";
import { RECORD_MAX_ENTRIES, RECORD_REASON_MAX_CHARS } from "./state-outcome-maps.ts";
import { frozenKeyProblem } from "./state-outcome.ts";

/** What the gate decided, and the sentence the caller traces when it refused. */
export type BlockedVerdict =
  /** `ran` is every file executed up to the `red`; `output` is what the runner printed on the red. */
  | { honoured: true; red: string; ran: string[]; output: string }
  /** Why the report was ignored, for the trace line. */
  | { honoured: false; why: string };

/**
 * Did the driver prove the named tests disagree? `wt` is the child's tree before any reset, so the red is a
 * fact about its work. Each file is hashed before its runner starts: a builder that rewrote a frozen test into
 * one that fails would otherwise be handed a red the driver watched. ONE wall clock bounds the whole loop, not
 * each runner; an un-startable or killed runner is skipped, not fatal.
 */
export async function blockedProved(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  paths: string[];
  /** Bounds the whole re-run loop; a test shortens it to observe a hang. */
  timeoutMs?: number;
}): Promise<BlockedVerdict> {
  const { exec, wt, template, frozen, paths } = opts;
  // The list's ceiling is applied where it is built (`usableConflicts`).
  if (paths.length === 0) return { honoured: false, why: "the report named no usable path" };
  if (template === undefined || template.trim() === "") {
    // No runner means no proof, so the report is ignored — and the silence is named, because `verify` calls
    // the same missing template an error.
    traceWarn(
      "lean build: no verify.test runner is configured, so a blocked report cannot be re-run — set verify.test to enable it",
    );
    return { honoured: false, why: "no verify.test runner is configured to re-check it with" };
  }
  const unvetted = paths.filter((p) => frozen[p] === undefined);
  if (unvetted.length > 0)
    return {
      honoured: false,
      why: `named ${unvetted.length} file(s) the run never froze: ${unvetted.slice(0, 4).join(", ")}`,
    };
  // ONE budget for the loop, enforced at both ends of a runner (`runFrozen`).
  const budget = new LoopBudget(opts.timeoutMs ?? TEST_TIMEOUT_MS);
  const ran: string[] = [];
  const skipped: string[] = [];
  try {
    for (const file of paths) {
      // Only an ANSWERED file is evidence and only a `red` honours the report; `unclear` and abandoned SKIP.
      const proof = await runFrozen(exec, { wt, template, file }, budget);
      if (proof.kind === "infra" || proof.kind === "unclear") {
        trace(`lean build: blocked report skipped one file — ${file}: ${proof.detail}`);
        skipped.push(file);
        continue;
      }
      // Every file the driver JUDGED reaches `ran`, greens included — the cause's map holds every file vetted
      // up to and including the red, and stops there.
      ran.push(file);
      if (proof.kind === "green") continue;
      // A red counts only while the bytes behind its name are those the freeze hashed. Refused by name.
      const bytes = await blobAt(exec, wt, "HEAD", file);
      if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== frozen[file])
        return {
          honoured: false,
          why: `${file} is no longer the bytes the run froze — the frozen test was edited`,
        };
      return { honoured: true, red: file, ran, output: proof.output ?? "" };
    }
  } finally {
    budget.dispose();
  }
  return {
    honoured: false,
    why:
      skipped.length === 0
        ? "every named frozen test passed, so nothing was proved unsatisfiable"
        : `no named test came back red (${String(skipped.length)} could not be judged: ${skipped.slice(0, 4).join(", ")})`,
  };
}

/** A loop's ONE budget, read on two clocks: a `setTimeout` race every runner loses to, and a wall clock. Node's
 * timers fire early or late against `Date.now()`, so a start needs BOTH to say time is left.
 */
export class LoopBudget {
  private spent = false;
  readonly expired: Promise<void>;
  private readonly deadline: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly ms: number) {
    this.deadline = Date.now() + ms;
    this.expired = new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.spent = true;
        resolve();
      }, ms);
    });
  }
  /** Whether the budget is spent on either clock: nothing starts once it is. */
  over(): boolean {
    return this.spent || Date.now() >= this.deadline;
  }
  /** A runner's own kill ceiling: the wall clock's remainder. */
  left(): number {
    return Math.max(1, this.deadline - Date.now());
  }
  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** One file's verdict under the loop's ONE budget: a runner that swallows the SIGKILL, or one a grandchild holds
 * open, is ABANDONED at the bound and counts `infra`.
 */
export async function runFrozen(
  exec: BuildExec,
  run: { wt: string; template: string; file: string },
  budget: LoopBudget,
): Promise<Proof> {
  if (budget.over()) return abandoned(run, budget.ms);
  return Promise.race([
    runTestFile(exec, {
      ...run,
      limits: { timeoutMs: Math.min(TEST_TIMEOUT_MS, budget.left()), env: verifyChildEnv() },
    }),
    budget.expired.then(() => abandoned(run, budget.ms)),
  ]);
}

/** The verdict of a run the budget took: nothing may be read into it, so it is `infra`. */
function abandoned(run: { template: string; file: string }, budgetMs: number): Proof {
  return {
    kind: "infra",
    // `killed`, not `never-started`: the budget took a started process, so no one blames the project's
    // toolchain for a budget the driver ran out of.
    infraShape: "killed",
    cmd: renderTestCommand(run.template, run.file),
    detail: `gave up at the ${String(budgetMs)}ms re-run budget`,
  };
}

/** The child's conflicts, filtered to entries the record could hold, in its order: `blockedProved` runs them in
 * it and stops at the first red, so illegal keys drop before any `git`/runner call.
 */
export function usableConflicts(rows: Array<{ path: string; reason: string }>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= RECORD_MAX_ENTRIES) break;
    if (typeof row.reason !== "string" || row.reason.length > RECORD_REASON_MAX_CHARS) continue;
    if (frozenKeyProblem(row.path) !== undefined) continue;
    seen.add(row.path);
  }
  return [...seen];
}

/** How many claimed paths a refused claim's trace line names before collapsing the rest into a count. */
const CLAIMED_PATHS_SHOWN = 8;

/** The refused-claim line's prefix: what was claimed, so a cell that spent its round on an unhonoured claim is
 *  attributable to the paths that bought it. */
export function blockedClaimKey(issue: number, paths: string[]): string {
  const shown = paths.slice(0, CLAIMED_PATHS_SHOWN).join(", ");
  const rest = paths.length - CLAIMED_PATHS_SHOWN;
  return `lean build #${String(issue)}: blocked report ignored (claimed ${shown}${rest > 0 ? ` (+${String(rest)} more)` : ""})`;
}
