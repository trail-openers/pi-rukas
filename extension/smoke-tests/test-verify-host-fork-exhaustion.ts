#!/usr/bin/env bun
/**
 * A gate the host could not fork must not produce a verdict about the code.
 *
 * Three cycles parked with every git / verify command the develop gate ran
 * dying on `/bin/sh: 1: Cannot fork`. Two were reported as
 * `[needs-human-decision] … (no specific assertion could be extracted)`, and
 * one — a SINGLE-workstream cycle — as `consolidated-verify-conflict`, "Two
 * workstreams edited the same lines". Nothing had been executed in any of
 * them. The cases below replay both shapes through the real develop gate on
 * a live git fixture, with only the failing command swapped for the fork
 * error, and pin the controls: a real failure and a bare `EAGAIN` keep their
 * existing verdicts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  HOST_EXHAUSTION_RUNBOOK,
  hostExhaustionFailure,
  pidCeilingExhausted,
  pidLimitSnapshot,
} from "../src/work-driver-exec-error.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { formatExecError } from "../src/work-driver-verify-develop-helpers.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { parkReason } from "../src/work-queue-park-reason.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { commitIn, fixture, realExec } from "./test-work-driver-verify-consolidated.ts";

type Exec = NonNullable<DriverContext["verifyExecFn"]>;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const LABEL = "[host-resource-exhaustion]";
const CONFLICT_RE = /cherry-pick \/ apply conflict|could not combine the workstreams/;

/** What Node's `exec` rejects with when dash cannot fork the command. */
function forkError(cmd: string): Error & { stdout: string; stderr: string } {
  const stderr = "/bin/sh: 1: Cannot fork\n";
  return Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { stdout: "", stderr });
}

/** `realExec`, except the commands `starved` selects die on the fork error. */
function starvedExec(starved: (cmd: string, cwd: string | undefined) => boolean): Exec {
  return async (cmd, o) => {
    if (starved(cmd, o?.cwd)) throw forkError(cmd);
    return realExec(cmd, o);
  };
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-fork-"));

/**
 * A single-workstream cycle (`default`) with one committed change. Returns the
 * worktree path resolved: it is the fixture's own map value, so neither caller
 * re-derives it with a cast of its own.
 */
async function singleWorkstream(name: string, verifyCmd: string) {
  const f = await fixture(root, name, ["default"], { "lib.sh": "echo lib\n" });
  const wt = f.worktrees.default as string;
  writeFileSync(path.join(wt, "feature.sh"), "echo feature\n");
  await commitIn(wt, "add feature");
  writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${verifyCmd}\n`);
  let s = initialState(6, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: "fix/issue-6",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
    },
  };
  const ctx = (exec: Exec): DriverContext => ({
    host: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
    repoRoot: f.repo,
    issue: 6,
    verifyExecFn: exec,
  });
  return { f, s, ctx, wt };
}

/** The cap the develop step records for a failed gate, and its renderings. */
function parked(s: WorkState, gate: Awaited<ReturnType<typeof verifyStepOutcome>>) {
  const next = appendDevelopVerifyFailure(s, gate);
  const hit = [...next.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const cap = hit?.kind === "cap-hit" ? hit.cap : undefined;
  return {
    cap,
    explain: explainCap(cap, next),
    action: humanActionFor(parkReason(next).reason, 6),
  };
}

try {
  // ------------------------------------------------------------------ 1
  // The cycle-56 shape: ONE workstream, and the consolidated verify's first
  // command (`git status --porcelain -uall` at the repo root) cannot fork.
  {
    const { f, s, ctx } = await singleWorkstream("preflight", "true");
    const exec = starvedExec(
      (cmd, cwd) => cwd === f.repo && cmd.startsWith("git status --porcelain -uall"),
    );
    const gate = await verifyStepOutcome(ctx(exec), s, "develop");
    const all = gate.failures.join(" | ");
    assert(!gate.ok, "preflight cannot fork: the gate still fails (an unrun gate is not a pass)");
    assert(
      !gate.failures.some((x) => CONFLICT_RE.test(x)),
      `preflight cannot fork: no failure claims a cherry-pick / apply conflict (got: ${all.slice(0, 300)})`,
    );
    assert(
      !/Two workstreams edited the same lines|decomposition is incoherent/.test(all),
      "preflight cannot fork: a single-workstream cycle is not told two workstreams collided",
    );
    assert(
      gate.failures.some((x) => x.includes(LABEL) && x.includes("Cannot fork")),
      `preflight cannot fork: the failure is labelled a host failure and keeps the evidence (got: ${all.slice(0, 300)})`,
    );
    const p = parked(s, gate);
    assert(
      p.cap === "verify-env:develop",
      `preflight cannot fork: the cap is verify-env, not consolidated-verify-conflict (#1349) (got: ${p.cap})`,
    );
    assert(
      /refused to start a process/.test(p.explain) && !/Inspect the worktree/.test(p.explain),
      `preflight cannot fork: explainCap points at the host, not the worktree (got: ${p.explain.slice(0, 200)})`,
    );
    assert(
      /host/.test(p.action) && !/inspect #6's diff/.test(p.action),
      `preflight cannot fork: the queue action points at the host (got: ${p.action})`,
    );
  }

  // ------------------------------------------------------------------ 2
  // The cycle-37 shape: git still works, but the verify command itself and
  // the smoke command die on the fork error on the consolidated tree.
  {
    const verifyCmd = "test -f feature.sh";
    const { f, s, ctx, wt } = await singleWorkstream("verify-cmd", verifyCmd);
    // `wt` is the one workstream's worktree, as the fixture built it (`wt-<id>`)
    // — returned by the fixture helper so neither case casts `f.worktrees`.
    writeFileSync(path.join(f.repo, ".pi", "smoke-cmd"), "sh ./feature.sh\n");
    // The #1240 duplicate-run skip must be OFF for this case: the fixture is
    // N=1 with a green per-worktree verify, so the consolidated probe is
    // provably the tree that just passed and its run would be skipped — which
    // would leave the `CONSOLIDATED tree` assertion below unassertable (the
    // smoke command alone still fails the gate, so without this pin the case
    // silently stops exercising the consolidated host-failure branch it exists
    // to pin). `0` is the only value that disables the skip.
    const prevSkip = process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP;
    process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP = "0";
    const exec = starvedExec(
      (cmd, cwd) => (cwd === f.repo && cmd === verifyCmd) || cmd === "sh ./feature.sh",
    );
    const gate = await verifyStepOutcome(ctx(exec), s, "develop");
    if (prevSkip === undefined) delete process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP;
    else process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP = prevSkip;
    const all = gate.failures.join(" | ");
    assert(!gate.ok, "verify cannot fork: the gate still fails");
    assert(
      !/\[needs-human-decision\]|\[per-workstream-defect\]/.test(all),
      `verify cannot fork: no classifier verdict about the change (got: ${all.slice(0, 300)})`,
    );
    assert(
      // #1064 — this fixture is ONE workstream, so the run that died on the fork
      // error verified that workstream's own tree: the label must stay a host
      // failure and the CLAUSE must name the tree, in its composed form. A bare
      // `includes("in")` would be satisfied by the host boilerplate itself, and
      // a bare path check by the evidence tail — both pass with the clause gone.
      // (The skip is pinned OFF above, so the probe really ran.)
      gate.failures.some(
        (x) =>
          x.includes(LABEL) && x.includes(`verify command \`${verifyCmd}\` in ${wt} could not run`),
      ),
      "verify cannot fork: the one-workstream run is labelled a host failure on its own tree",
    );
    assert(
      gate.failures.some((x) => x.includes(LABEL) && x.includes("smoke:")),
      `verify cannot fork: the smoke command is labelled a host failure too (got: ${all.slice(0, 400)})`,
    );
    assert(
      gate.failures.every((x) => x.includes(LABEL)),
      "verify cannot fork: every recorded failure is a host failure — none blames the diff",
    );
    const p = parked(s, gate);
    assert(p.cap === "verify-env:develop", `verify cannot fork: cap (#1349) (got: ${p.cap})`);
    assert(
      /environment failures, not defects in the change/.test(p.explain),
      "verify cannot fork: explainCap says the change was not judged",
    );
  }

  // ------------------------------------------------------------------ 3
  // Control: a verify command that really fails keeps its verdict. It passes
  // at the base commit, so the #1349 baseline probe does not excuse it.
  {
    const { s, ctx } = await singleWorkstream("real-failure", "test ! -f feature.sh");
    const gate = await verifyStepOutcome(ctx(realExec), s, "develop");
    const all = gate.failures.join(" | ");
    assert(!gate.ok, "real failure: the gate fails");
    assert(!all.includes(LABEL), "real failure: NOT relabelled as a host failure");
    const p = parked(s, gate);
    assert(
      /rejected the develop step's "done" claim/.test(p.explain),
      "real failure: explainCap keeps the outcome-gate wording",
    );
    assert(
      /inspect #6's diff/.test(p.action),
      "real failure: the queue action still names the diff",
    );
  }

  // ------------------------------------------------------------------ 4
  // The other spellings, and the bare-EAGAIN control, through formatExecError.
  {
    const fmt = (message: string, stderr = "") =>
      formatExecError(
        Object.assign(new Error(message), { stdout: "", stderr }),
        "timeout",
        "cmd failed in /wt",
      );
    for (const stderr of [
      "/bin/bash: fork: retry: Resource temporarily unavailable",
      "timeout: fork system call failed: Resource temporarily unavailable",
      "Script sandbox failed: Failed to start worker: EAGAIN",
    ]) {
      assert(fmt("Command failed: x", stderr).startsWith(LABEL), `labelled: ${stderr}`);
    }
    assert(fmt("spawn /bin/sh EAGAIN").startsWith(LABEL), "labelled: Node's own `spawn … EAGAIN`");
    assert(
      !fmt("Command failed: x", "✗ read returned EAGAIN on a non-blocking socket").includes(LABEL),
      "a bare EAGAIN in a test's own output is NOT a host failure",
    );
    const killed = Object.assign(new Error("x"), { stdout: "", stderr: "", killed: true });
    assert(
      formatExecError(killed, "timeout", "f") === "timeout",
      "a timeout keeps its own message",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// #1277 — the message names the ceiling that was actually hit
// (the driver's own cgroup pid limit), read without forking, and does not
// send the operator to the host's ulimits.
{
  const files: Record<string, string> = {
    "/sys/fs/cgroup/pids.current": "4095\n",
    "/sys/fs/cgroup/pids.max": "4096\n",
  };
  const snap = pidLimitSnapshot((f) => {
    const v = files[f];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  });
  assert(
    snap?.current === 4095 && snap.max === 4096,
    `#1277: counters are read as numbers (got: ${JSON.stringify(snap)})`,
  );
  assert(
    pidLimitSnapshot(() => {
      throw new Error("ENOENT");
    }) === undefined,
    "#1277: unreadable counters yield no snapshot (never a guess)",
  );
  const unl = pidLimitSnapshot((f) => (f.endsWith("pids.max") ? "max\n" : "17\n"));
  assert(
    unl?.current === 17 && unl.max === "max",
    "#1277: an unlimited cgroup is reported as it reads",
  );
  assert(
    pidLimitSnapshot((f) => (f.endsWith("pids.max") ? "4096abc\n" : "17\n")) === undefined,
    "#1277: a malformed pids.max yields no snapshot",
  );

  // Exhausted: numeric max, headroom under the margin → claims exhaustion.
  const exhausted = hostExhaustionFailure("consolidated verify", "detail", snap);
  assert(exhausted.startsWith(LABEL), "#1277: the label still leads the failure");
  assert(
    exhausted.includes("pids.current=4095 of pids.max=4096"),
    "#1277: the failure quotes the pid count and limit",
  );
  assert(
    /exhausted: cgroup pids\.current=4095/.test(exhausted),
    "#1277: a numeric ceiling with no headroom is claimed as exhausted",
  );
  assert(
    /CONTAINER's pid limit/.test(exhausted) && !/on the host/.test(exhausted),
    "#1277: it points at the container's limit, not the host",
  );
  assert(
    exhausted.includes(HOST_EXHAUSTION_RUNBOOK) && exhausted.includes("docs/troubleshooting.md"),
    "#1277: the failure points at the shared troubleshooting runbook",
  );
  assert(
    exhausted.includes("read just after the failure"),
    "#1277: the message says the counters were read just after the failure",
  );
  const named = /under "([^"]+)"/.exec(HOST_EXHAUSTION_RUNBOOK)?.[1];
  assert(
    named === `${LABEL}: the gate could not run`,
    "#1277: the runbook pointer names the troubleshooting heading",
  );
  const docs = readFileSync(new URL("../../docs/troubleshooting.md", import.meta.url), "utf8");
  assert(
    docs.includes(`#### \`${LABEL}\`: the gate could not run`),
    "#1277: docs/troubleshooting.md contains the heading the runbook pointer names",
  );

  // Unlimited: pids.max=max → the cgroup is NOT the ceiling; no exhaustion claim.
  const unlimited = hostExhaustionFailure("consolidated verify", "detail", {
    current: 17,
    max: "max",
  });
  assert(
    /NOT the ceiling here \(cgroup pids\.current=17 of pids\.max=max\)/.test(unlimited),
    "#1277: an unlimited cgroup is not claimed as the ceiling",
  );
  assert(
    !/is exhausted/.test(unlimited),
    "#1277: an unlimited cgroup is never reported as exhausted",
  );
  assert(
    /pid_max/.test(unlimited) && /RLIMIT_NPROC/.test(unlimited) && /memory/.test(unlimited),
    "#1277: the other candidate ceilings are listed",
  );

  // Numeric with plenty of headroom: the counters were read AFTER the failure,
  // so a transient burst may already have drained. Do not rule the limit out.
  const roomy = hostExhaustionFailure("consolidated verify", "detail", {
    current: 17,
    max: 4096,
  });
  assert(
    /show headroom \(cgroup pids\.current=17 of pids\.max=4096\)/.test(roomy),
    "#1277: a roomy numeric ceiling reports the counters as headroom",
  );
  assert(/transiently by a burst/.test(roomy), "#1277: a transient burst is named as possible");
  assert(!/NOT the ceiling/.test(roomy), "#1277: headroom is not ruled out as the ceiling");
  assert(!/will not help/.test(roomy), "#1277: raising the limit is not dismissed");

  // Margin boundary: 10 spare pids is the threshold (strictly under = exhausted).
  assert(
    pidCeilingExhausted({ current: 4087, max: 4096 }) &&
      !pidCeilingExhausted({ current: 4086, max: 4096 }),
    "#1277: exhaustion is headroom < 10 pids",
  );
  assert(!pidCeilingExhausted({ current: 4096, max: "max" }), "#1277: max is never exhausted");

  // Blind: counters unreadable → the message says so, and makes no claim.
  const blind = hostExhaustionFailure("consolidated verify", "detail", undefined);
  assert(/could not be read/.test(blind), "#1277: without counters the message says so");
  assert(!/exhausted:/.test(blind), "#1277: without counters no exhaustion is claimed");
}

process.exit(exit);
