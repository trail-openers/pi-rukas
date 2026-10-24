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
 * `origin/<branch>` through the normal integration path. The canaries (a kill
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
  assert(
    events.some((e) => e.kind === "dispatch-failed" && e.step === "lens-fix") === false,
    "the killed lens-fix dispatch left no dispatch-failed tail — it was converted, not left to HALT",
  );
  assert(
    events.some((e) => e.kind === "dispatch-completed" && e.step === "lens-fix" && e.ok === true),
    "a completed lens-fix stands in the log where the kill was",
  );
  const adv = events.find((e) => e.kind === "adversarial-approved");
  assert(adv !== undefined, "the killed fixer routed to the ADVERSARIAL path, not handoff");
  // (a) The conversion is machine-readable on the event, and (b) it is
  // disclosed to the operator through plumbReports with the cause and the SHAs.
  const completed = events.find(
    (e) => e.kind === "dispatch-completed" && e.step === "lens-fix" && e.ok === true,
  );
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

  // The tree the fixer was killed in is left exactly as it stood: the landing
  // moved the REF, not the worktree, and repositioning a tree that still holds
  // commits the branch lacks would destroy work. `diverged` + a backup ref is
  // therefore the correct answer here — and the origin check above is what
  // proves the work was not stranded.
  const rep = await repositionLensFixWorktree(realExec, wt, branch, [issue], "bound landed");
  assert(
    rep.kind === "diverged" && rep.backupRef !== undefined,
    `a worktree still holding commits the branch lacks reports diverged with a backup ref (got ${rep.kind})`,
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
