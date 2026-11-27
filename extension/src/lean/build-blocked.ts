/**
 * lean/build-blocked — the anti-forgery gate for the build child's "these frozen tests cannot all pass
 * together" report.
 *
 * The child's report is narration, not executed evidence. A builder that could end a run by naming a conflict
 * would end runs whose contract it never read, or one that is satisfiable. The driver honours it only when
 * BOTH hold:
 *
 *   1. **every named path is in the run's frozen map** — read off the same `frozenFromLog` every other reader
 *      of the contract uses;
 *   2. **at least one named frozen test comes back red on the child's tree**, run with the project's own
 *      `verify.test` template through the runner `verify` and `specify` use.
 *
 * A runner that could not start or was killed is NOT a red — it observed nothing — and a green named test is
 * not a conflict either.
 *
 * The entry and reason bounds are the DURABLE record's, so an entry that could not be persisted is refused
 * before anything is spent running it.
 */

import { trace, traceWarn } from "../trace.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { extractBlockedReport } from "./build-blocked-extract.ts";
import { blobAt } from "./build-git.ts";
import { normaliseBuild } from "./build-normalise.ts";
import type { BuildExec, NormaliseReport } from "./build-types.ts";
import { CaptureBudget } from "./specify-capture.ts";
import {
  type Proof,
  TEST_TIMEOUT_MS,
  renderTestCommand,
  runTestFile,
  sha256,
} from "./specify-proof.ts";
import {
  BLOCKED_PATH_CAP,
  BLOCKED_REASON_CAP,
  RECORD_MAX_ENTRIES,
  RECORD_REASON_MAX_CHARS,
} from "./state-outcome-maps.ts";
import { frozenKeyProblem } from "./state-outcome.ts";
import { oneLine } from "./text-fence.ts";

/** The cause LINE's ceiling: the renderer caps plus the sentence around them. */
const BLOCKED_CAUSE_CAP = BLOCKED_PATH_CAP + BLOCKED_REASON_CAP + 44;

/**
 * The child's conflicts, filtered to entries the record could hold, in the child's order — load-bearing,
 * because `blockedProved` runs them in it and stops at the first red. Illegal frozen keys drop before any
 * `git`/runner call.
 */
function usableConflicts(rows: Array<{ path: string; reason: string }>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= RECORD_MAX_ENTRIES) break;
    if (typeof row.reason !== "string" || row.reason.length > RECORD_REASON_MAX_CHARS) continue;
    if (frozenKeyProblem(row.path) !== undefined) continue;
    seen.add(row.path);
  }
  return [...seen];
}

/** What the gate decided, and the sentence the caller traces when it refused. */
export type BlockedVerdict =
  /** `ran` is every file the driver executed, up to and including the `red`. */
  | { honoured: true; red: string; ran: string[] }
  /** `why` is the reason the report was ignored, for the trace line. */
  | { honoured: false; why: string };

/**
 * Did the driver itself prove the named tests disagree?
 *
 * `wt` is the child's tree before any reset, so the red is a fact about its work. Each named file is hashed
 * before its runner starts: a builder that rewrote a frozen file into one that fails would otherwise be handed
 * a red the driver watched.
 *
 * One wall clock bounds the WHOLE loop, not each runner — 32 named files would otherwise cost 32 ceilings. An
 * un-startable or killed runner is skipped, not fatal.
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
      return { honoured: true, red: file, ran };
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

/**
 * A loop's ONE budget, read on two clocks: a `setTimeout` race every runner loses to, and a wall-clock deadline.
 * Node's timers fire early or late against `Date.now()`, so a start needs BOTH to say time is left.
 */
class LoopBudget {
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

/**
 * One frozen file's verdict under the loop's ONE budget. A runner that swallows the SIGKILL, or one a grandchild
 * holds open, is ABANDONED when the budget expires and counts `infra` — the step refuses at its bound.
 */
async function runFrozen(
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

/**
 * Fold a budget-stopped builder's work into its attempt's commit, then say what is still red on the tree that
 * commit made — one function because the probe must read the RESET tree the fold produced. The sweep shares
 * {@link runFrozen}.
 */
export async function foldStoppedBuild(opts: {
  exec: BuildExec;
  wt: string;
  repoRoot: string;
  branch: string;
  headBefore: string;
  frozen: Record<string, string>;
  attempt: number;
  issue: number;
  template: string | undefined;
  ceiling?: number;
  /** The project's configured protected globs, from the run's base-commit config — the
   *  same list `build`'s own fold gets, so one arm of this step cannot keep what the other
   *  reverts. */
  protected?: readonly string[];
  /** Bounds the whole sweep of frozen tests; a test shortens it to watch a hang. */
  timeoutMs?: number;
}): Promise<{ kept: NormaliseReport; failing: string[] }> {
  const { exec, wt, frozen, template } = opts;
  // `protected` rides the spread into `normaliseBuild` untouched.
  const kept = await normaliseBuild({ ...opts, budget: new CaptureBudget(opts.ceiling) });
  // Only a runner that ANSWERED counts, and only bytes the freeze hashed — the tree is whatever the killed
  // child left, so each file comes out of HEAD.
  const failing: string[] = [];
  if (!template?.trim()) return { kept, failing };
  const budget = new LoopBudget(opts.timeoutMs ?? TEST_TIMEOUT_MS);
  try {
    for (const file of Object.keys(frozen)) {
      // ONE budget for the sweep: once spent, no later file starts at all.
      if (budget.over()) break;
      const bytes = await blobAt(exec, wt, "HEAD", file);
      if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== frozen[file]) continue;
      if ((await runFrozen(exec, { wt, template, file }, budget)).kind === "red")
        failing.push(file);
    }
  } finally {
    budget.dispose();
  }
  return { kept, failing };
}

/** The child's report judged end to end. `undefined` says "not honoured". */
export async function judgeBlockedReport(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  toolUses: unknown[];
  issue: number;
  timeoutMs?: number;
}): Promise<{ reason: string; blockedBy: Record<string, string> } | undefined> {
  const extracted = extractBlockedReport(opts.toolUses);
  if (extracted.rows.length === 0) {
    if (extracted.skipped > 0)
      trace(
        `lean build #${String(opts.issue)}: ignored ${String(extracted.skipped)} unreadable report_blocked call(s)`,
      );
    return undefined;
  }
  const paths = usableConflicts(extracted.rows);
  const proved = await blockedProved({
    exec: opts.exec,
    wt: opts.wt,
    template: opts.template,
    frozen: opts.frozen,
    paths,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (!proved.honoured) {
    traceWarn(`lean build #${String(opts.issue)}: blocked report ignored — ${proved.why}`);
    return undefined;
  }
  // Only files the driver ACTUALLY RAN enter the record (`proved.ran` stops at the red), sanitised here
  // rather than at each reader since this durable record prints the child's prose. The first reason a path was
  // given wins.
  const ran = new Set(proved.ran);
  const blockedBy: Record<string, string> = {};
  for (const row of extracted.rows) {
    if (!ran.has(row.path) || row.path in blockedBy) continue;
    blockedBy[oneLine(row.path, BLOCKED_PATH_CAP)] = oneLine(row.reason, BLOCKED_REASON_CAP);
  }
  const red = proved.red;
  if (!(red in blockedBy)) return undefined;
  // The cause line leads with the file the driver watched fail; the map carries all.
  return {
    reason: oneLine(
      `frozen tests cannot all pass together: ${red} — ${blockedBy[red] ?? ""}`,
      BLOCKED_CAUSE_CAP,
    ),
    blockedBy,
  };
}
