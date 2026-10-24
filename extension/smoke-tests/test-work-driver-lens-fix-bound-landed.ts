#!/usr/bin/env bun
/**
 * A lens-fix killed AT its review bound must not strand its commits (#1779).
 *
 * The field shape (seen on two field cycles, v0.14.5+): the #1742/#1774 review budget arms every
 * fixer with a bound, so a fixer that runs to it is now common. When it had
 * already committed in the lens worktree, the kill produced `dispatch-failed`
 * with a bound kill cause; `lens-fix` is HALT and a bound kill is not
 * retryable, so `integrateLensFix` — which only runs from the adversarial step
 * after a lens-fix COMPLETED — never ran. The commits stayed in the worktree
 * until `repositionLensFixWorktree` found a tree ahead of the branch, backed it
 * up and parked `lens-fix-reposition`.
 *
 * This file runs the scenario: a killed fixer WITH commits converts to a
 * partial fix, routes to the adversarial gate, and its commit reaches
 * `origin/<branch>` through the normal integration path — after which the lens
 * worktree itself sits AT the branch tip, so the next round's reposition gate
 * answers `already-at-tip` (the root fix, #1789 round 2: the tree is moved
 * where the kill is classified, instead of a landing arm added to the gate). The canaries (a kill
 * with no commits, a diverged tree, both knob-off shapes, and every kill cause
 * that is not the fixer's bound) are in
 * `test-work-driver-lens-fix-bound-landed-canaries.ts`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState, writeState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";
import {
  assert,
  boundLandRun,
  driverCtx,
  killedFixer,
  mkFixture,
  mkLensFixState,
  withTrace,
} from "./lib/lens-fix-bound-land-fixture.ts";

// ── 1. killed at its bound WITH commits → adversarial, landed, no park ──────
{
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-land-"));
  const branch = "feature/lens-bound-land";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const issue = 1801;
  const st = mkLensFixState(issue, branch, baseSha, wt);
  await writeState(root, st);
  const { result: _r, traced } = await withTrace(() =>
    runWorkDriver(driverCtx(root, issue, killedFixer(wt, 2, "timeout") as never)).catch(() => {}),
  );
  const state = await readState(root, issue);
  const events = state?.eventLog ?? [];

  // A later step can park for reasons this scenario is not about (the merge
  // gate has no `gh` here), so assertions that mean "the fix loop did not fail"
  // look at the loop's own steps, not at every cap in the log.
  const fixLoopCap = events.find(
    (e) => e.kind === "cap-hit" && (e.step === "lens-fix" || e.step === "adversarial"),
  );
  assert(
    fixLoopCap === undefined,
    `the fix loop recorded no cap-hit of its own — the killed fixer was accepted, not capped (got ${fixLoopCap?.kind === "cap-hit" ? `${fixLoopCap.cap} on ${fixLoopCap.step}` : "none"})`,
  );
  const repositionCap = events.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-reposition");
  assert(repositionCap === undefined, "no lens-fix-reposition park was recorded");
  // #1789 round 2 — THE CONVERSION KEEPS THE EVIDENCE. The completion is what
  // the router reads (it is the tail); the kill it converted from stays in the
  // log one event earlier, with its exit code and error tail. A conversion that
  // deleted the failure would leave a cycle that cannot be audited: no reader
  // could tell a killed child from one that finished.
  const failedIdx = events.findIndex(
    (e) => e.kind === "dispatch-failed" && e.step === "lens-fix",
  );
  const completedIdx = events.findIndex(
    (e) => e.kind === "dispatch-completed" && e.step === "lens-fix" && e.ok === true,
  );
  assert(
    failedIdx >= 0,
    "the killed lens-fix dispatch still leaves its dispatch-failed record — the conversion keeps the evidence",
  );
  assert(
    completedIdx >= 0,
    "a completed lens-fix stands in the log where the kill was",
  );
  assert(
    completedIdx === failedIdx + 1,
    `the completion was appended immediately after the failure it converted (failed ${failedIdx}, completed ${completedIdx})`,
  );
  assert(
    // What the router reads is the step's TAIL: the last event the lens-fix
    // step itself appended. A `dispatch-slow` watch event folded in after the
    // conversion is display, not a verdict, so the scan accepts it and rejects
    // anything that would have routed the step elsewhere (another failure, a
    // cap-hit).
    (() => {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e?.kind === "dispatch-completed" && e.step === "lens-fix" && e.ok === true) return true;
        if (e?.kind === "dispatch-slow" || e?.kind === "dispatch-started") continue;
        return false;
      }
      return false;
    })(),
    "the completion is the TAIL of the lens-fix step the router routes on, so the retained failure behind it cannot re-HALT the step",
  );
  const adv = events.find((e) => e.kind === "adversarial-approved");
  assert(adv !== undefined, "the killed fixer routed to the ADVERSARIAL path, not handoff");
  // (a) The conversion is machine-readable on the event, and (b) it is
  // disclosed to the operator through plumbReports with the cause and the SHAs.
  const completed = events[completedIdx];
  assert(
    completed?.kind === "dispatch-completed" && completed.partialAfterKill !== undefined,
    "the completed event carries the partialAfterKill disclosure field",
  );
  assert(
    completed?.kind === "dispatch-completed" &&
      completed.partialAfterKill?.killCause === "timeout" &&
      (completed.partialAfterKill?.commitShas.length ?? 0) === 2,
    "...naming the kill cause and both commit SHAs the fixer made",
  );
  // The kill's own evidence rode across with the conversion: exit code and a
  // bounded excerpt of the error tail that names the bound.
  assert(
    events[failedIdx]?.kind === "dispatch-failed" &&
      completed?.kind === "dispatch-completed" &&
      completed.partialAfterKill?.errorTail !== undefined &&
      completed.partialAfterKill.errorTail.length > 0,
    "the converted event carries an excerpt of the kill's error tail alongside the retained failure",
  );
  const plumbs = (state?.pipelineState.plumbReports ?? []).filter(
    (r) => r.step === "lens-fix" && r.role === "driver",
  );
  assert(
    plumbs.length === 1 &&
      plumbs[0].body.includes("killCause=timeout") &&
      plumbs[0].body.includes(
        completed?.kind === "dispatch-completed"
          ? (completed.partialAfterKill?.commitShas[0] ?? "")
          : "",
      ),
    "one plumbReport discloses the conversion with the kill cause and the commit SHAs",
  );
  assert(
    events.some((e) => e.kind === "adversarial-approved" && e.rounds === undefined) === false &&
      events.filter((e) => e.kind === "adversarial-approved").length === 1,
    "the step appended no adversarial-approved of its own — the gate is what approved",
  );

  // The ground truth is the remote, not the event log.
  const { stdout: remoteLog } = await realExec(
    `git ls-remote ${JSON.stringify(path.join(dir, "origin.git"))} ${JSON.stringify(`refs/heads/${branch}`)}`,
    { cwd: root },
  );
  assert(remoteLog.trim().length > 0, "the branch exists on origin");
  let landed = false;
  try {
    const { stdout } = await realExec(
      `git fetch -q origin ${JSON.stringify(branch)} && git show FETCH_HEAD:fix-0.txt`,
      { cwd: root },
    );
    landed = stdout.trim() === "fix 0";
  } catch {
    landed = false;
  }
  assert(landed, "the fixer's commit reached origin/<branch> after the adversarial approval");

  // The root fix: after a converted kill the lens worktree is MOVED onto what
  // the branch carries, so the next round's reposition gate reads
  // `already-at-tip` instead of a tree holding commits the branch lacks (which
  // parks). A tree still `diverged` here means the work moved but the tree did
  // not, and the next round parks on it — the exact shape this closes.
  const rep = await repositionLensFixWorktree(realExec, wt, branch, [issue], "bound landed");
  assert(
    rep.kind === "already-at-tip",
    `the next reposition sees the tree already at the tip — the conversion moved it (got ${rep.kind})`,
  );
  const { stdout: wtHead } = await realExec("git rev-parse HEAD", { cwd: wt });
  const { stdout: remoteTip } = await realExec(
    `git rev-parse ${JSON.stringify(`origin/${branch}`)}`,
    { cwd: root },
  );
  assert(
    wtHead.trim() === remoteTip.trim(),
    "the lens worktree HEAD equals the branch tip the remote carries",
  );

  assert(
    /\S+ fixer armed — bound \d+m \(ceiling \d+m, reserve \d+m, budget left \d+m\)/.test(traced),
    "the armed-fixer trace line was emitted with bound, ceiling, reserve and budget left",
  );
  // The kill is attributable from the log: the conversion line names the cause
  // and the SHAs, and the arming line (asserted above) named the bound that
  // produced the kill. The conversion does not re-state the bound — there is
  // one bound line per fixer dispatch, emitted when the bound was resolved.
  assert(
    traced.includes("lens-fix killed at its bound (killCause=timeout)") &&
      traced.includes("routing to the adversarial gate"),
    "the kill trace names the step, the kill cause and where the work goes",
  );
  assert(
    traced.includes(
      "lens-fix killed at its bound (timeout) after committing 2 commit(s); treated as a partial fix",
    ),
    "the conversion is recorded as a partial fix with the kill cause and the commit count",
  );
}

console.log(`\nexit ${boundLandRun.failed ? 1 : 0}`);
process.exit(boundLandRun.failed ? 1 : 0);
