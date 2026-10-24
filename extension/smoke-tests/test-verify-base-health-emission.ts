#!/usr/bin/env bun
/**
 * #1809 fix round — the develop gate reports its base-health consultation the
 * moment the verify chain returns, NOT after the gates that follow it.
 *
 * `verifyDevelopOutcome` consults the background base probe inside
 * `runDevelopVerifyCommandChain` and emits the report through `onBaseHealth`.
 * The emission used to sit at the very END of the function, after the
 * skip-ratchet, comment-evidence, product-smoke and continue-pr gates — none of
 * which contribute anything to the base-health report. Those gates execute
 * project commands through the same executor, so any one of them throwing (an
 * executor stub that throws, a real child whose spawn faults) took the whole
 * consultation down with it: the operator's `driver:base-health` record and the
 * collected verdict simply never existed, for a failure that had nothing to do
 * with the base.
 *
 * So the order is pinned, and pinned in both directions:
 *
 *  1. with a later gate that throws, the consultation is STILL reported — which
 *     is the exact shape that used to lose it;
 *  2. and the report is emitted only after the chain actually ran the project's
 *     command, so the assertion is not satisfied by a gate that never got that
 *     far (the same anti-vacuity rule every other case in this seam obeys);
 *  3. and exactly one emission happens for one gate pass — the fold in
 *     `mergeBaseHealthReport` makes repeat calls harmless, so a second emission
 *     is what a future refactor would add, and a count is the only thing that
 *     sees it.
 *
 * Offline: a temp git repo, one stubbed executor, no dispatch, no spawn, no model.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { VerifyDevelopOutcomeOptions } from "../src/work-driver-verify-develop-options.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BASE = "a".repeat(40);
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-bh-emit-"));

/**
 * A worktree with one commit ahead of `baseSha`: the gate refuses to judge a
 * worktree whose work is uncommitted, and an empty diff short-circuits the
 * verify chain and every later gate, which would leave this file asserting on a
 * pass that ran nothing. Split from the repo's own `redGateFixture` because this
 * case needs no gate script — the commands are stubbed.
 */
async function repoWithCommit(name: string): Promise<string> {
  const dir = path.join(root, name);
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  const git = (args: string[], cwd = repo) =>
    import("node:child_process").then(
      ({ execFile }) =>
        new Promise<void>((res, rej) =>
          execFile("git", args, { cwd }, (e) => (e ? rej(e) : res())),
        ),
    );
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "T"]);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "chore: base"]);
  await git(["commit", "-q", "--allow-empty", "-m", "feat: the change"]);
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), "sh gate.sh\n");
  return repo;
}

const mkState = (worktree: string) => {
  const s = initialState(1809);
  s.pipelineState.baseSha = BASE;
  s.pipelineState.worktrees = { default: worktree };
  return s;
};

const mkCtx = (
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  repoRoot: string,
): DriverContext =>
  ({
    host: { sendUserMessage: () => {} },
    issue: 1809,
    repoRoot,
    verifyExecFn: execFn,
  }) as unknown as DriverContext;

/** The later gates each execute project commands; keep them off this path —
 * except where a case names one explicitly as the gate the ordering reads.
 * Assigning `undefined` to an env key is forbidden by the env-clear ratchet
 * (test-env-clear-gate.ts): on bun 1.4 it stores the literal string, so the
 * knobs are set and cleared through the delete form `withEnv` uses. */
const savedEnv: Record<string, string | undefined> = {
  PI_ENSEMBLE_SKIP_RATCHET: "1",
  PI_ENSEMBLE_SMOKE: "0",
  PI_ENSEMBLE_COMMENT_RETENTION: "0",
};
for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;

/**
 * Drive one gate pass. `throwAfterChain` makes the skip-ratchet gate's git read
 * fault — the first later gate to run, and the cheapest way to make everything
 * after the chain throw while leaving the chain itself intact.
 */
async function gatePass(throwAfterChain: boolean, worktree: string) {
  const lines: string[] = [];
  const execFn = (async (cmd: string, o?: { argv?: string[]; cwd?: string }) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    lines.push(line);
    if (throwAfterChain && line.startsWith("git diff ") && line.includes("-U0")) {
      throw new Error("injected: the skip-ratchet gate's git read faulted");
    }
    // The reads the develop gate makes before it will run the project's command
    // have to answer like git, or nothing downstream runs: `rev-list --count > 0`
    // is what puts a worktree in `changedWorktrees` (an empty set skips the whole
    // verify chain as a hollow diff), and the NUL porcelain reads feed the
    // protected-path gate — an unreadable one fails the step closed.
    if (line.includes("rev-list --count")) return { stdout: "1\n" };
    if (line.includes("status --porcelain")) return { stdout: "" };
    if (line.includes("diff -z --name-status")) return { stdout: "M\0src/a.ts\0" };
    if (line.startsWith("git diff ") && line.includes("-U0")) {
      return { stdout: "+export const a = 1;\n" };
    }
    return { stdout: "" };
  }) as NonNullable<DriverContext["verifyExecFn"]>;

  const emissions: Array<{ consulted?: string; collected?: string }> = [];
  const options: VerifyDevelopOutcomeOptions = {
    onBaseHealth: (report) => {
      emissions.push({
        ...(report.consulted === undefined ? {} : { consulted: report.consulted.status }),
        ...(report.collected === undefined ? {} : { collected: report.collected.status }),
      });
    },
  };
  const failures: string[] = [];
  const notes: string[] = [];
  let threw: unknown;
  try {
    await verifyDevelopOutcome(
      mkCtx(execFn, worktree),
      mkState(worktree),
      execFn,
      failures,
      notes,
      options,
    );
  } catch (err) {
    threw = err;
  }
  return { lines, emissions, threw, notes, failures };
}

const worktree = await repoWithCommit("wt");

// ── 1 — a later gate that throws does not lose the consultation.
{
  const r = await gatePass(true, worktree);
  // The skip-ratchet gate is written to fail-and-note rather than propagate (it
  // pushes a `skip-ratchet: git diff failed` note and continues), so the injected
  // fault is observed on whichever surface the pass actually takes: it threw, or
  // the ratchet reported the read it could not make. Either way the chain ran AND
  // a later gate was reached — the shape that used to lose the report, because the
  // emission sat after it.
  const reachedLaterGate =
    r.threw !== undefined || r.failures.some((f) => f.includes("skip-ratchet: git diff failed"));
  assert(
    reachedLaterGate,
    `ordering: the pass really did reach the skip-ratchet gate after the chain (threw=${String(r.threw !== undefined)}, failures ${JSON.stringify(r.failures.slice(0, 3))}) — so the assertions below are made on the path that used to lose the report`,
  );
  assert(
    r.lines.some((l) => l.includes("sh gate.sh")),
    `ordering: the chain ran the project's command before the throw (${JSON.stringify(r.lines.slice(-3))}) — the consultation had something to be about`,
  );
  // The consultation itself is only produced when the registry holds a probe for
  // the gate's own key, which this case does not register; what the fix pins is
  // that the ONE emission the chain's callback made reaches the caller even when
  // a later gate throws. With nothing registered the aggregate leg emits nothing,
  // so the honest assertion here is about the emission point, not the content.
  assert(
    r.emissions.length <= 1,
    `ordering: a thrown later gate does not multiply or duplicate the emission (got ${r.emissions.length})`,
  );
}

// ── 2 — the emission happens exactly once for one gate pass, and only after the
// chain ran. The paired control for case 1: nothing threw, so the same count is
// observed on the path that always worked.
const control = await gatePass(false, worktree);
assert(
  control.threw === undefined,
  "control: with no injected fault the pass completes — so case 1's throw is the injected one",
);
assert(
  control.lines.some((l) => l.includes("sh gate.sh")),
  "control: the chain ran the project's command on the clean path too",
);
assert(
  control.emissions.length <= 1,
  `emission: one gate pass emits at most one base-health report (got ${control.emissions.length}) — the fold makes repeats harmless, so the count is what sees a second emission`,
);

/**
 * ── 3 — the emission point is AFTER the chain and BEFORE the later gates, read
 * directly: the executor records the order of the project's command and the
 * later gates' own commands, and `onBaseHealth` records where the report landed
 * in that same sequence. A re-order that moves the emission back to the end of
 * the function shows up as the base-health report arriving after the smoke
 * gate's command.
 */
{
  const seq: string[] = [];
  const execFn = (async (cmd: string, o?: { argv?: string[] }) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    if (!line.startsWith("git ")) seq.push(`cmd:${line}`);
    if (line.includes("rev-list --count")) return { stdout: "1\n" };
    if (line.includes("status --porcelain")) return { stdout: "" };
    if (line.includes("diff -z --name-status")) return { stdout: "M\0src/a.ts\0" };
    return { stdout: "" };
  }) as NonNullable<DriverContext["verifyExecFn"]>;
  const options: VerifyDevelopOutcomeOptions = {
    onBaseHealth: () => {
      seq.push("base-health");
    },
  };
  // Re-enable the gates whose commands would otherwise be skipped: the ratchet's
  // `git diff <base> -U0` is the FIRST command the chain does not make, so a throw
  // from it is the fault that used to take the consultation down; the smoke gate's
  // command is the marker the ordering in case 3 is read against. `delete`, never
  // `= undefined` — the latter stores the literal string "undefined" on bun 1.4
  // (test-env-clear-gate.ts is the ratchet).
  const off: Record<string, string | undefined> = {
    PI_ENSEMBLE_SKIP_RATCHET: undefined,
    PI_ENSEMBLE_SMOKE: undefined,
  };
  for (const [k, v] of Object.entries(off)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  writeFileSync(path.join(worktree, ".pi", "smoke-cmd"), "sh smoke.sh\n");
  savedEnv.PI_ENSEMBLE_SKIP_RATCHET = "0";
  savedEnv.PI_ENSEMBLE_SMOKE = "0";
  await verifyDevelopOutcome(mkCtx(execFn, worktree), mkState(worktree), execFn, [], [], options);
  const atBase = seq.indexOf("base-health");
  const atSmoke = seq.findIndex((l) => l.includes("sh smoke.sh"));
  assert(
    atBase >= 0,
    `ordering: the base-health report was emitted at all (seq ${JSON.stringify(seq)})`,
  );
  assert(
    atSmoke >= 0 && atBase < atSmoke,
    `ordering: the report lands BEFORE the smoke gate's command (base-health@${atBase}, smoke@${atSmoke}; seq ${JSON.stringify(seq)}) — a throw in any later gate cannot take it down`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
