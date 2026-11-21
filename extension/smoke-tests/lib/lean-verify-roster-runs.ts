/**
 * lib/lean-verify-roster-runs — the roster's project-suite RUNS, as a case declares and counts them.
 *
 * Split from `lean-verify-exec.ts`, which sits at the 500-line cap: everything the roster's two
 * suite runs need lives here, and the executor asks one question — "is this call the roster running
 * the project's suite?" — and hands the call over.
 *
 * The two counters are the reason for the split. `rosterRuns` counted head and base together, so a
 * case could not tell "the base leg was skipped because head failed nothing" apart from "the base
 * run was lost": both read as one run. R4 asks for a head-red case to show 1 head + 1 base and a
 * head-green case to show 1 head + 0 base, which is only answerable when the two sides are counted
 * apart.
 *
 * The suite itself is a real child: what it does is the configured command's own doing. The one
 * thing the stub adds is the per-side choice of WHICH tests the report names, because "the base
 * carried this test and it passed there, and at head it fails" is the fact a case is asserting and
 * cannot be deduced from bytes both trees share. Absent that override, the configured command's
 * real output is what the gate reads back.
 */

import { execp } from "../../src/exec.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import type { VerifyOpts } from "./lean-verify-types.ts";
import { writeDeclaredReport } from "./lean-verify-roster.ts";

/** One roster run's side: the run's worktree, or the probe's throwaway checkout of the base. */
export type RosterSide = "head" | "base";

export interface RosterRuns {
  /** Whether argv-carrying `cmd` is the roster running the project's suite in one of its trees. */
  isRosterSuiteRun: (cmd: string, o2: Parameters<VerifyExec>[1] | undefined) => boolean;
  /** Run the roster's suite in one tree, counting that side. */
  runRosterSuite: (
    command: string,
    o2: Parameters<VerifyExec>[1],
    side: RosterSide,
  ) => Promise<{ code?: number; stdout: string; stderr: string }>;
  /** How many times the roster ran the suite in the run's own worktree. */
  headRuns: () => number;
  /** How many times it ran the suite in the base checkout — 0 when the leg was skipped. */
  baseRuns: () => number;
}

/**
 * Build the roster's run vocabulary for one case.
 *
 * `rosterCmd` is the command the gate renders for the project, and its binary is the identity the
 * stub matches: a frozen run of the SAME runner template is argv form too, so only "the configured
 * roster binary" plus "the argv asks for a machine-readable report" separates the two. The roster's
 * own report read is recognised earlier still, by `isRosterReportRead`.
 */
export function makeRosterRuns(opts: {
  rosterCmd?: { bin: string };
  rosterNames?: {
    head?: { passed: string[]; failed: string[] };
    base?: { passed: string[]; failed: string[] };
  };
  roster?: VerifyOpts["roster"];
  /** The tree a run of this side belongs to, when the call carries no cwd of its own. */
  treeOf: (side: RosterSide) => string;
  /** The env a real child of this case gets. */
  childEnv: () => NodeJS.ProcessEnv;
}): RosterRuns {
  const { rosterCmd, rosterNames, roster: o } = opts;
  let headSuiteRuns = 0;
  let baseSuiteRuns = 0;

  const isRosterSuiteRun = (cmd: string, o2: Parameters<VerifyExec>[1] | undefined): boolean => {
    if (rosterCmd === undefined || cmd !== rosterCmd.bin) return false;
    if (!Array.isArray(o2?.argv)) return false;
    // The report flag is what separates the roster's run from a FROZEN run of the same runner
    // template: `sh <file>` and `sh --junitxml=… <tree>` are the same binary and the same shape,
    // and only one of them is being asked for a machine-readable report.
    if (!o2.argv.some((a) => a.startsWith("--junitxml="))) return false;
    // Any cwd: the base run happens in the roster's OWN throwaway checkout of the base commit, whose
    // path the step derives and the fixture does not know. Requiring the fixture's baseline dir would
    // silently miss every base run, and a base run the stub misses is a run whose report nobody wrote.
    return true;
  };

  const runRosterSuite = (
    command: string,
    o2: Parameters<VerifyExec>[1],
    side: RosterSide,
  ) => {
    if (side === "head") headSuiteRuns++;
    else baseSuiteRuns++;
    const killed = side === "head" ? o?.headRunKilled : o?.baseRunKilled;
    if (killed === true) {
      // The executor's OWN kill shape: no numeric code, `killed` and `timedOutKill` stamped. A run
      // with no exit status has no per-test verdicts, whatever its report might have said.
      return Promise.reject(
        Object.assign(new Error(`Command failed: ${command}`), {
          code: null,
          killed: true,
          timedOutKill: true,
          stdout: "",
          stderr: "",
        }),
      );
    }
    const declared = side === "head" ? rosterNames?.head : rosterNames?.base;
    // The tree is the run's OWN cwd, which is the probe's throwaway checkout rather than the
    // fixture's baseline dir: writing the report where the gate will look for it is the whole point.
    if (declared !== undefined)
      return writeDeclaredReport(String(o2?.cwd ?? opts.treeOf(side)), declared, side);
    return execp(command, { ...o2, env: o2?.env ?? opts.childEnv() });
  };

  return {
    isRosterSuiteRun,
    runRosterSuite,
    headRuns: () => headSuiteRuns,
    baseRuns: () => baseSuiteRuns,
  };
}
