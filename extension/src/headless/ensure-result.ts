/**
 * headless/ensure-result — the runner cannot exit without a result document
 * (#1863, AC5).
 *
 * `cli.ts` wrote its stdout result in two places only: the `--json` branch
 * inside `main()`, and the `.catch` for a rejected `main()`. If `main()` never
 * settled — the field shape, where the adversarial round-review child was
 * killed at its run bound and the driver's await on the child's `exit` event
 * stayed pending — the loop drained and the runner exited 0 with an empty
 * stdout. The supervisor then printed `error: crash — the runner process exited
 * 0 without a result` and its own exit 30, and the host had nothing to act on
 * for a cycle that had written a state file.
 *
 * The fix has two halves. The real one is in `spawn-exit-await.ts`: the exit
 * await is bounded, so the dispatch resolves. This module is the guarantee that
 * the CONTRACT holds regardless — the runner's stdout carries exactly one
 * result document on every path on which it terminates, including a wedged
 * driver whose promise never settles. It is a backstop, not a substitute: a run
 * that reports through it is a run whose driver never answered, and the
 * document says so (`error.code: "driver-wedged"`) and exits 30, which is the
 * honest code for that. The supervisor's crash/30 classification is untouched.
 */

import { resourceReport } from "../resource-budget.ts";
import { isTerminalState, readState, workStateFile } from "../workflow-state.ts";
import { readBuildCommit, readBuildVersion } from "./build.ts";
import { EXIT, exitCodeForState } from "./exit-code.ts";
import { type IssueResult, notStartedResult, projectIssue } from "./result.ts";

/** How long the runner waits for its own driver before calling it wedged. */
const DEFAULT_WEDGE_MS = 6 * 60 * 60_000;

/** Override: PI_ENSEMBLE_HEADLESS_DRIVER_WEDGE_MS. 0 disables the backstop. */
export function driverWedgeMs(): number {
  const n = Number(process.env.PI_ENSEMBLE_HEADLESS_DRIVER_WEDGE_MS);
  if (Number.isFinite(n) && n >= 0) return n;
  return DEFAULT_WEDGE_MS;
}

export interface RunOutcome {
  exitCode: number;
  results: IssueResult[];
  error?: { code: string; message: string };
}

/** Each issue as its state file shows it; a non-terminal state exits 30. */
export async function projectFromStateFiles(
  repoRoot: string,
  issues: number[],
): Promise<IssueResult[]> {
  const out: IssueResult[] = [];
  for (const issue of issues) {
    const file = workStateFile(repoRoot, issue);
    const state = await readState(repoRoot, issue).catch(() => undefined);
    if (!state) {
      out.push(notStartedResult(issue, file, EXIT.crash));
      continue;
    }
    const code = isTerminalState(state) ? exitCodeForState(state) : EXIT.crash;
    out.push({ ...projectIssue(state, file), exitCode: code });
  }
  return out;
}

/**
 * The projection of a run whose driver never answered: every issue read back
 * from its own state file, exit 30, and an error that names the driver as the
 * thing that stopped — never a bare "exited 0 without a result".
 */
export async function wedgedRun(
  repoRoot: string,
  issues: number[],
  reason: string,
): Promise<RunOutcome> {
  const results = await projectFromStateFiles(repoRoot, issues);
  return {
    exitCode: EXIT.crash,
    results,
    error: {
      code: "driver-wedged",
      message: `the run produced no result (${reason}); each issue is projected from its state file`,
    },
  };
}

/** One result document, in the shape `cli.ts` writes for `work`. */
export function formatResultDocument(run: RunOutcome, json: boolean): string {
  if (json) {
    const doc = {
      schemaVersion: 5 as const,
      buildCommit: readBuildCommit(),
      buildVersion: readBuildVersion(),
      exitCode: run.exitCode,
      issues: run.results,
      ...(run.error ? { error: run.error } : {}),
      resources: resourceReport(),
    };
    return `${JSON.stringify(doc)}\n`;
  }
  const parts = run.results.map((r) => `#${r.issue} ${r.status} (exit ${r.exitCode})`);
  const head = `pi-rukas-headless: ${parts.join(", ") || "nothing ran"}\n`;
  return run.error ? `${head}error: ${run.error.code} — ${run.error.message}\n` : head;
}

export interface ResultGuaranteeOpts {
  /** The run itself. If it never settles, the guarantee prints the wedge. */
  work: () => Promise<RunOutcome>;
  json: boolean;
  repoRoot: string;
  issues: number[];
  /** stdout sink; injectable so the offline test observes the stream. */
  write: (s: string) => void;
  wedgeMs?: number;
}

/**
 * Run `work` and write EXACTLY ONE result document, whichever way it settles.
 *
 * `work`'s own printing is suppressed (it returns a value; this renders it), so
 * the single-writer property is structural rather than a count of who got
 * there first. If `work` never settles within `wedgeMs`, the projection from
 * the state files is written instead and the exit code is 30.
 */
export async function withResultGuarantee(opts: ResultGuaranteeOpts): Promise<number> {
  const wedgeMs = opts.wedgeMs ?? driverWedgeMs();
  const work = opts.work();
  if (wedgeMs <= 0) {
    const run = await work;
    opts.write(formatResultDocument(run, opts.json));
    return run.exitCode;
  }
  const wedged = new Promise<"wedged">((resolve) => {
    const t = setTimeout(() => resolve("wedged"), wedgeMs);
    t.unref?.();
  });
  const winner = await Promise.race([work, wedged]);
  if (winner !== "wedged") {
    opts.write(formatResultDocument(winner, opts.json));
    return winner.exitCode;
  }
  const reason = `no driver result within ${wedgeMs}ms — the run was still awaiting a child when the runner stopped waiting`;
  const run = await wedgedRun(opts.repoRoot, opts.issues, reason);
  opts.write(formatResultDocument(run, opts.json));
  // A driver that settles later is abandoned: nothing it returns can be printed
  // now, and its locks / groups are released by cli.ts's exit path.
  work.catch(() => undefined);
  return run.exitCode;
}
