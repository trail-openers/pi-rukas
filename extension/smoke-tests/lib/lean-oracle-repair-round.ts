/**
 * lib/lean-oracle-repair-round — one repair round over production code, with a project runner the case can
 * watch.
 *
 * `test-lean-oracle-repair-head-bound.ts` and `test-lean-oracle-repair-seat.ts` both need the same expensive
 * apparatus — a real git repo, a real worktree the round resets, a real `sh` runner script the round really
 * executes, and the real `runRepairRound` — and differ only in what the fake child reports. A round driven
 * through anything less (an injected condition, a stubbed runner) would answer the question about the harness.
 *
 * The runner script records one tab-separated row per invocation: the file it was given and the value of a
 * driver knob in its environment. That record is how a test sees which run is which, whether the run saw the
 * driver's environment, and how long the round was held by a project command that never returned.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import { sha256 } from "../../src/lean/specify-proof.ts";
import { ensureSpecifyWorktreeWithProvision } from "../../src/lean/specify-tree.ts";
import { type RepairRoundDeps, runRepairRound } from "../../src/oracle-repair-dispatch.ts";
import type { DispatchResult } from "../../src/types.ts";
import { verifyChildEnv } from "../../src/work-driver-verify-cmd.ts";
import { outsideDir } from "./lean-build-fixture.ts";
import { gitEnv } from "./lean-build-git.ts";

/** The frozen contract's path, and the source it is red against. */
export const FROZEN = "tests/AC1.test.sh";
export const SRC = "src/retry.ts";
/**
 * A REAL driver knob, with a value no project test would print: `verifyChildEnv` is what drops this name, so
 * the assertion judges the scrub the round is supposed to apply rather than a name the harness invented. The
 * harness sets it itself rather than inheriting it, because the verify loop scrubs the driver's own namespace
 * from the test process before it starts.
 */
export const KNOB = "PI_ENSEMBLE_HANDOFF_TIMEOUT_MS";
export const KNOB_VALUE = "driver-knob-value";
process.env[KNOB] = KNOB_VALUE;
/** The path whose run hangs: the judge never sees this file, so only the head run can reach it. */
export const HANGING_REL = "tests/head-hangs.test.sh";

/** The original contract: red at the base while the source still says `not-implemented`. */
export const ORIGINAL =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh own case" 1>&2; exit 1; fi\nexit 0\n';
/** The contract's bytes plus a red case of its own: what the judge accepts. */
export const ACCEPTED = `${ORIGINAL.replace(/\nexit 0\n$/, "\n")}if grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh new case" 1>&2; exit 1; fi\nexit 0\n`;
/** The bytes the second contract holds at the build head: a red of its own, so a replacement can go red on a new case. */
export const ORIGINAL2 =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/head-hangs.test.sh own case" 1>&2; exit 1; fi\nexit 0\n';
/** A second replacement: the second contract's bytes plus a case it never printed, which is the accepted shape. */
export const ACCEPTED2 = `${ORIGINAL2.replace(/\nexit 0\n$/, "\n")}if grep -q not-implemented src/retry.ts; then echo "not ok - tests/head-hangs.test.sh new case" 1>&2; exit 1; fi\nexit 0\n`;
/** The submissions the round judges: both named files, both in the accepted shape. */
export const TWO_SUBMISSIONS = [
  { criterionId: "AC1", testFiles: [FROZEN] },
  { criterionId: "AC2", testFiles: [HANGING_REL] },
];
/** What a child may be told to write at the frozen path instead of submitting it. */
export const UNCHANGED = ORIGINAL;
/** The builder's implementation: present at the head, absent at the base, and the overlay the head run must see. */
export const IMPLEMENTED = "export const retry = () => 1;\n";

/** The runner: it logs each call, goes red at the base, and hangs only for `HANGING_REL`. */
const RUNNER_SH = `#!/bin/sh
if [ -n "\${${KNOB}:-}" ]; then printf '%s\\t%s\\n' "$1" LEAKED >> "$REPAIR_PROOF_LOG"; else printf '%s\\t%s\\n' "$1" CLEAN >> "$REPAIR_PROOF_LOG"; fi
if grep -q not-implemented src/retry.ts
then echo "not ok - $1" 1>&2; exit 1
fi
if [ "$1" = "${HANGING_REL}" ]; then sleep 30 & wait; exit 9; fi
exit 0
`;

/** The spec the round rereads; one `verify: "test"` criterion is enough for the brief. */
export const SPEC: PiSpec = {
  title: "t",
  problem: "p",
  criteria: [{ id: "AC1", text: "c", verify: "test" }],
  outOfScope: [],
  constraints: [],
};

/** What the round's child reports, and what it leaves in its tree. */
export interface Seat {
  /** Bytes to leave at each path of the seat's tree. */
  files?: Record<string, string>;
  /** The `submit_tests` calls to declare, in order. */
  submit?: Array<{ criterionId: string; testFiles: unknown[] }>;
  /** What the dispatch returns. `ok: false` and a non-zero exit are the shapes the round must refuse. */
  result?: Partial<DispatchResult>;
  /** Throw instead of returning, to watch the round bill a child that never came back. */
  throws?: Error;
}

/** What one round left behind. */
export interface RoundRun {
  kind: string;
  why: string;
  /** Wall clock the round held, which is how the head run's bound is observed. */
  ms: number;
  /** Every runner the round started, and the child env the round handed it (`scrubbed` / `driver-env`). */
  envs: Array<{ file: string; given: string }>;
  /** One row per runner invocation: the file it was given, then the driver knob it could see. */
  rows: string[];
  /** What each seat dispatch received: its arms and its prompt. */
  seats: Array<{ opts: unknown; prompt: string }>;
  /** The seat's tree after the round, as git sees it: HEAD's commit and the tracked files. */
  tree: { head: string; files: string[] };
  outcome: unknown;
}

/** Drive one round. The repo, the worktree, the runner and the judgement are all real. */
export async function driveRound(
  issue: number,
  seat: Seat,
  opts: {
    frozen?: string;
    replacement?: string;
    named?: string[];
    tracked?: string[];
    /** The round's runner budget, which a case shortens to watch a hung project command refuse. */
    headRunBudgetMs?: number;
  } = {},
): Promise<RoundRun> {
  const original = opts.frozen ?? ORIGINAL;
  // Which frozen records the run holds. The round refuses a replacement whose path it never froze, and a
  // case that wants a seat to write a file the run does not track must withhold that record.
  const tracked = opts.tracked ?? [FROZEN, HANGING_REL];
  const scratch = mkdtempSync(outsideDir());
  const log = path.join(scratch, "runner.log");
  // The repo is nested one level under the scratch root so the worktree path's parent is unique: two dirs
  // sharing one parent are one entry to the harness's delete guard.
  const repo = mkdtempSync(path.join(scratch, "r"));
  const git = (...argv: string[]): string => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("git", argv, { cwd: repo, encoding: "utf8", env: gitEnv() });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  };
  // The contracts the round may replace: the base contract at the run's base commit, the second one only
  // on the build head, which is what makes the head overlay's origin observable.
  const originals = new Map<string, string>([
    [FROZEN, original],
    [HANGING_REL, ORIGINAL2],
  ]);
  const write = (abs: string, text: string, mode?: number): void => {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text, mode === undefined ? {} : { mode });
  };
  git("init", "-q", "-b", "main");
  git("config", "core.excludesFile", path.join(scratch, "no-ignore"));
  write(path.join(scratch, "no-ignore"), "");
  const runnerSh = path.join(scratch, "bin", "repair-proof-runner.sh");
  write(runnerSh, RUNNER_SH, 0o755);
  write(
    path.join(repo, SRC),
    "export const retry = () => { throw new Error('not-implemented'); };\n",
  );
  // Both contracts are part of the BASE commit: the judge's checkout is a detached checkout of the base, and
  // it reads each original with `git show <base>:<path>` before running the replacement, so a contract the
  // base did not track is a contract the judge can never vouch for. The builder's implementation is the only
  // thing the head run's overlay brings.
  write(path.join(repo, FROZEN), original, 0o755);
  write(path.join(repo, HANGING_REL), ORIGINAL2, 0o755);
  // `.worktrees/` is excluded rather than tracked, exactly as the driver's own `ensureGitExclude` does it:
  // the base commit must not contain a judge checkout that is not there yet when it is made.
  write(path.join(repo, ".git/info/exclude"), ".worktrees/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  if (
    git("ls-tree", "-r", "--name-only", baseSha)
      .split("\n")
      .some((f) => f.startsWith(".worktrees/"))
  )
    throw new Error("the base commit tracks the worktrees directory");

  const branch = `lean/issue-${String(issue)}`;
  // The build head is an empty commit above the base: the frozen contract is the base's, and the builder
  // changed none of it, which is the shape the driver's honoured blocked report leaves the run in.
  git("commit", "-q", "--allow-empty", "-m", "test: the run's frozen contract");
  const headBefore = git("rev-parse", "HEAD");
  // The builder's implementation: a commit of its own above the frozen one, so the overlay the head run lays
  // down is exactly the source the builder wrote, and no frozen file.
  write(path.join(repo, SRC), IMPLEMENTED);
  git("add", "-A");
  git("commit", "-q", "-m", "feat: the builder's implementation");
  void existsSync;

  // The judge's stage, made BEFORE the build head exists and checked out AT the base: production's
  // `withRepairBaseTree` makes exactly this — a detached checkout of `run.baseSha`, made once per step. The
  // base commit therefore cannot track it, and the judge's `git show <base>:<path>` reads the base's bytes.
  const baseTree = path.join(scratch, "judge-base");
  git("worktree", "add", "-q", "--detach", baseTree, baseSha);

  const wt = path.join(repo, ".worktrees", `lean-${String(issue)}`);
  const seatGit = (...argv: string[]): string => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("git", argv, { cwd: wt, encoding: "utf8", env: gitEnv() });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  };
  // The primary checkout never holds the run's branch: the round's reset is `checkout -f -B branch <head>`,
  // and git refuses that while another checkout holds it.
  git("worktree", "add", "-q", "-B", branch, wt, headBefore);
  const config = {
    ...defaultConfig(),
    budgets: {},
    verify: { ...defaultConfig().verify, test: `${runnerSh} {file}` },
  };
  // The driver's environment, knob and all: what a runner receives when the round hands it no scrubbed
  // `limits.env`. The isolated git home is layered LAST so the fixture's own view — PATH to the project's
  // runner, the git identity, the isolated HOME — survives a scrub: a bounded run whose toolchain the scrub
  // broke would read as an infra fault rather than as a bound, and would test nothing.
  const home = gitEnv() as Record<string, string>;
  // The fixture's own contribution to a child's environment: PATH to the project's runner, the isolated HOME,
  // the git identity, and where the runner writes its log. These are TOOLCHAIN vars, never driver knobs, and
  // they are the only thing this fixture layers into a run — so a driver knob reaches the runner through the
  // ambient env alone, and a round that scrubs keeps it out of the child's view.
  home.PATH = `${path.join(scratch, "bin")}:${home.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`;
  home.REPAIR_PROOF_LOG = log;
  // The knob lives in the fixture's host view as well as the ambient env: it is a NAME THE SCRUB DROPS, so a
  // round that handed the project the driver's environment leaks it and a round that handed a scrubbed one
  // does not. `verifyChildEnv` reads the drop from the table the scrub reads, so the two cannot drift.
  home[KNOB] = KNOB_VALUE;
  const env: Record<string, string> = { ...process.env, ...home } as Record<string, string>;
  // The names the driver's scrub exists to remove, read off the same table the scrub reads rather than a list
  // this fixture keeps by hand: the isolated git home inherits driver knobs from the session that built it.
  const dropped = Object.keys(home).filter((k) => !(k in verifyChildEnv({ [k]: home[k] })));
  const seats: Array<{ opts: unknown; prompt: string }> = [];
  const envs: Array<{ file: string; given: string }> = [];
  const deps = {
    // The driver's own environment is the DEFAULT the exec hands a child, exactly as the production `execp`
    // hands the ambient env; a run that passes `limits.env` replaces it, which is what a scrub is.
    exec: (cmd: string, o?: Record<string, unknown>) => {
      const given = o?.env as Record<string, string> | undefined;
      // What the round handed THIS run: the record the assertion reads, because it is the argument the product
      // passed, not a label this file chose. `undefined` is the unbounded shape — the driver's own env.
      envs.push({
        file: String((o?.argv as string[] | undefined)?.[0] ?? ""),
        // `verifyChildEnv` on the env the round supplied, not `in`: a name the scrub exists to remove is
        // absent from its output whatever value it carried.
        given:
          given === undefined
            ? "driver-env"
            : KNOB in verifyChildEnv(given)
              ? "knob-in-child-env"
              : "scrubbed",
      });
      // The executor's own contract: a child env the round supplies REPLACES the driver's. The fixture's host
      // view (PATH to the project's runner, the git identity, the isolated HOME, the log path) is layered in
      // whichever way the env came, and the driver-knob names the scrub exists to remove are dropped from it
      // too — that list comes from the same table the scrub reads, so a knob reaches the runner only when the
      // round handed the project its environment outright.
      // A run the round handed NO child env is the round handing the project the driver's own environment —
      // the knob reaches the runner exactly as it would in production. A run the round handed a scrubbed env
      // sees the knob nowhere: the exec's own copy of the scrub is what removes it from the fixture's view, so
      // what the runner reports is what the child's environment actually held, not a token this file chose.
      const child: Record<string, string> = { ...home, ...(given ?? env) };
      // The child's environment is whatever the round supplied plus this fixture's host view, with one
      // exception: `verifyChildEnv` is the driver's own scrub, so a name it removes is removed from the child's
      // view here too. The runner's own report is therefore a read of the child env that was actually handed
      // over, and the row it writes is evidence rather than a label this file chose.
      const scrubbed = verifyChildEnv(child);
      for (const name of Object.keys(child)) if (!(name in scrubbed)) delete child[name];
      return execp(cmd, { ...(o ?? {}), env: child });
    },
    dispatch: async (spec: { prompt?: string }, o: unknown): Promise<DispatchResult> => {
      seats.push({ opts: o, prompt: spec.prompt ?? "" });
      if (seat.throws !== undefined) throw seat.throws;
      const defaults: Record<string, string> = {
        [FROZEN]: ACCEPTED,
        ...(tracked.includes(HANGING_REL) ? { [HANGING_REL]: ACCEPTED2 } : {}),
      };
      for (const [rel, text] of Object.entries({ ...defaults, ...(seat.files ?? {}) }))
        write(path.join(wt, rel), text, 0o755);
      return {
        role: "developer",
        ok: true,
        text: "done",
        ms: 1,
        exitCode: 0,
        usage: { input: 5, output: 6, cacheRead: 1, cacheWrite: 2, cost: 0.1, turns: 3 },
        toolUses: (
          seat.submit ??
          (tracked.includes(HANGING_REL) ? TWO_SUBMISSIONS : TWO_SUBMISSIONS.slice(0, 1))
        ).map((s) => ({
          name: "submit_tests",
          arguments: s,
        })),
        ...seat.result,
      };
    },
    // The judge's stage is a SECOND detached checkout of the base, as production's `withRepairBaseTree`
    // makes it: the judge reads the original out of that checkout's commit, and the head run lays the
    // builder's files over it, so one tree serving both would let one replacement's overlay answer for the next.
    baseTree,
    ensureTree: (o: Parameters<typeof ensureSpecifyWorktreeWithProvision>[1]) =>
      ensureSpecifyWorktreeWithProvision(
        (cmd, oo) =>
          execp(cmd, {
            ...(oo ?? {}),
            env: { ...gitEnv(), ...((oo?.env as Record<string, string>) ?? {}) },
          }),
        o,
      ),
    statReporter: async () => ({}),
    ...(opts.headRunBudgetMs === undefined ? {} : { headRunBudgetMs: opts.headRunBudgetMs }),
  } as unknown as RepairRoundDeps;

  const started = Date.now();
  const out = await runRepairRound({
    deps,
    ctx: {
      run: {},
      steps: [],
      stepKey: `${String(issue)}:repair:0`,
      now: () => 1700000000000,
    } as never,
    config: config as never,
    spec: SPEC,
    childOpts: { workCycleTrust: false },
    repoRoot: repo,
    issue,
    baseSha,
    headBefore,
    wt,
    branch,
    frozen: Object.fromEntries(
      [...originals].filter(([p2]) => tracked.includes(p2)).map(([p2, t]) => [p2, sha256(t)]),
    ),
    named: opts.named ?? [FROZEN, HANGING_REL],
    claims: [{ path: FROZEN, reason: "the frozen assertion contradicts the spec" }],
    evidence: [],
    scratch,
  });
  let rows: string[] = [];
  try {
    rows = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  } catch {
    rows = [];
  }
  let head = "";
  let files: string[] = [];
  try {
    head = seatGit("rev-parse", "HEAD");
    files = seatGit("ls-files")
      .split("\n")
      .filter((l) => l !== "");
  } catch {
    /* a tree the round could not build leaves the empty values, which no assertion accepts */
  }
  return {
    kind: out.kind,
    why: out.kind === "refused" ? out.why : `not refused (${out.kind})`,
    ms: Date.now() - started,
    envs,
    rows,
    seats,
    tree: { head, files },
    outcome: out,
  };
}

/** The file the head run was given, as the runner recorded it, or `undefined` when it never ran. */
export function headRow(rows: string[]): string | undefined {
  return rows.find((r) => r.split("\t")[0] === HANGING_REL);
}
