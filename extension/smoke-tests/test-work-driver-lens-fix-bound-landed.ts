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
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import { landLensFixAfterBoundKill } from "../src/work-driver-lens-fix-bound-land.ts";
import { lensFixRevertAlreadyUsed } from "../src/work-driver-lens-fix-fence-gate.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState, writeState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";
import {
  assert,
  boundLandRun,
  driverCtx,
  fixerDeclaredPaths,
  killTail,
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
  const st = mkLensFixState(issue, branch, baseSha, wt, fixerDeclaredPaths(2));
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
  const failedIdx = events.findIndex((e) => e.kind === "dispatch-failed" && e.step === "lens-fix");
  const completedIdx = events.findIndex(
    (e) => e.kind === "dispatch-completed" && e.step === "lens-fix" && e.ok === true,
  );
  assert(
    failedIdx >= 0,
    "the killed lens-fix dispatch still leaves its dispatch-failed record — the conversion keeps the evidence",
  );
  assert(completedIdx >= 0, "a completed lens-fix stands in the log where the kill was");
  assert(
    completedIdx === failedIdx + 1,
    `the completion was appended immediately after the failure it converted (failed ${failedIdx}, completed ${completedIdx})`,
  );
  assert(
    // What the router reads is the step's TAIL. `failureEventOf` answers from
    // the FINAL event of a single-dispatch step, so the check is scoped to the
    // lens-fix step's own events (everything after its `step-started`, minus the
    // write-ahead marker): the last of those must be the converted completion.
    (() => {
      const own = events.slice(
        events.findIndex((e) => e.kind === "step-started" && e.step === "lens-fix") + 1,
        events.findIndex((e, i) => i > completedIdx && e.kind === "step-started") === -1
          ? events.length
          : events.findIndex((e, i) => i > completedIdx && e.kind === "step-started"),
      );
      const last = own.filter((e) => e.kind !== "dispatch-started").at(-1);
      return last?.kind === "dispatch-completed" && last.step === "lens-fix" && last.ok === true;
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
      `git fetch -q origin ${JSON.stringify(branch)} && git show FETCH_HEAD:src/fix-0.txt`,
      { cwd: root },
    );
    landed = stdout.trim() === "fix 0";
  } catch {
    landed = false;
  }
  assert(landed, "the fixer's commit reached origin/<branch> after the adversarial approval");

  // The root fix, asserted at its own seam: when the conversion succeeds the
  // lens worktree is moved onto the commit the branch carries, so the NEXT
  // round's reposition gate answers `already-at-tip` instead of parking on a
  // tree holding commits the branch lacks. Asserted on a tree a converted kill
  // actually leaves behind — the whole-cycle tree below has since been written
  // to by a later round's fixer, so comparing it to the final tip would be
  // comparing the wrong thing.
  const moveDir = mkdtempSync(path.join(tmpdir(), "lens-bound-move-"));
  const moveBranch = "feature/lens-bound-move";
  const mv = await mkFixture(moveDir, moveBranch);
  const fsMove = await import("node:fs/promises");
  await fsMove.mkdir(path.join(mv.wt, "src"), { recursive: true });
  await fsMove.writeFile(path.join(mv.wt, "src/fix-0.txt"), "fix 0\n");
  await realExec("git add src/fix-0.txt && git commit -q -m 'fix(lens): part 0'", {
    cwd: mv.wt,
    shell: "/bin/bash",
  });
  const moveTip = (await realExec("git rev-parse HEAD~1", { cwd: mv.wt })).stdout.trim();
  const moveHead = (await realExec("git rev-parse HEAD", { cwd: mv.wt })).stdout.trim();
  // The branch carries the fixer's commit: in the driver this is what the
  // adversarial step's `integrateLensFix` does with the converted kill's work.
  await realExec(
    `git push -q ${JSON.stringify(path.join(moveDir, "origin.git"))} ${JSON.stringify(`${moveHead}:refs/heads/${moveBranch}`)}`,
    { cwd: mv.wt },
  );
  const moveJobId = "lens-fix:developer:lens-fix-1:1:1";
  const moved = await landLensFixAfterBoundKill(
    killTail(
      mkLensFixState(1806, moveBranch, mv.baseSha, mv.wt, fixerDeclaredPaths(1)),
      moveJobId,
      "timeout",
    ),
    { tree: mv.wt, tipSha: moveTip, jobId: moveJobId },
    realExec,
  );
  assert(
    moved.eventLog[moved.eventLog.length - 1]?.kind === "dispatch-completed",
    "the killed fixer converted at the classifier's own seam",
  );
  const headAfterMove = (await realExec("git rev-parse HEAD", { cwd: mv.wt })).stdout.trim();
  assert(
    headAfterMove === moveHead,
    `the conversion moved the lens worktree onto the fixer's commit (started ${moveTip.slice(0, 8)}, fix ${moveHead.slice(0, 8)}, now ${headAfterMove.slice(0, 8)})`,
  );
  const rep = await repositionLensFixWorktree(realExec, mv.wt, moveBranch, [1806], "bound landed");
  assert(
    rep.kind === "already-at-tip",
    `the next reposition sees the tree already at the tip — the conversion moved it (got ${rep.kind})`,
  );
  assert(
    rep.kind === "already-at-tip" && rep.tipSha === moveHead,
    "...at the SHA the fixer committed, which is what the branch now carries",
  );
  const { stdout: remoteTip } = await realExec(
    `git rev-parse ${JSON.stringify(`origin/${branch}`)}`,
    { cwd: root },
  );
  assert(
    /^[0-9a-f]{40}$/i.test(remoteTip.trim()),
    "the branch on origin resolves to a commit (the landed work is on the remote)",
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

// ── 2. PM decision #1852-4: a bound kill does not exempt the fixer's strays ──
{
  // The conversion is the arm most tempting to treat as "the driver already
  // decided this work is landable": the kill is classified, the commits are
  // enumerated, and the round is routed to the adversarial gate. It is not. A
  // bound-killed fixer is judged by the SAME fence, on the SAME delta, through
  // the fix pass's own ladder — the gate runs in `runAdversarial` before any
  // landing arm, and the bound-kill conversion routes straight back through that
  // step. So the fence is what must refuse here, and this is the case that says
  // so.
  //
  // WHY ONE ROUND WITH THE REVERT ALREADY SPENT, rather than two fixer
  // dispatches. A single stray set is REVERTED and the round lands — the fence
  // doing its job, not refusing — so a fixture that ends after one stray set
  // cannot distinguish "the fence ran and allowed it" from "there was no fence".
  // The refusal that must not be pushable is a SECOND set in one round, and the
  // one-revert allowance is per round: the honest fixture is a round that has
  // ALREADY reverted once and now shows a fresh stray. Driving that as two
  // end-to-end fixer dispatches does not work for a reason worth naming: after
  // round 1's fix lands, the next lens-fix dispatch goes through the reposition
  // gate, whose `unlanded`/`diverged` kinds are about a tree holding commits the
  // branch does not have — and a scripted fixer that writes commits the driver
  // reverted is exactly that shape. The reposition gate then parks the cycle
  // before the fence is ever reached, so the driver-side test would be a test of
  // the reposition gate. What this asserts is the fence's own decision on a
  // killed fixer's commits, which is the assertion #1852-4 asks for.
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-stray-"));
  const branch = "feature/lens-bound-stray";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const issue = 18070;
  const st = mkLensFixState(issue, branch, baseSha, wt, fixerDeclaredPaths(1));
  await writeState(root, st);
  // The tip the fixer STARTED at. This is the measurement the fence judges:
  // `roundTip` is what `runLensFix` read from the tree before the dispatch and
  // recorded beside the fence, and the round's delta is everything after it —
  // which is why the branch's own commits (base.txt, feature.txt, src/keep.txt)
  // are not strays and only what the fixer wrote is.
  const roundTip = (await realExec("git rev-parse HEAD", { cwd: wt })).stdout.trim();
  // The killed fixer produced the fix the findings asked for (in the declared
  // `src/fix-0.txt`) AND a file outside the fence, in its own dispatch, before
  // the kill was reported — the ordering that makes this the bound-kill arm and
  // not a generic gate test: `landLensFixAfterBoundKill` classifies the kill and
  // routes to the adversarial step with those commits in the tree.
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.join(wt, "src"), { recursive: true });
  await fs.writeFile(path.join(wt, "src/fix-0.txt"), "the fix the finding asked for\n");
  await realExec("git add src/fix-0.txt && git commit -q -m 'fix(lens): the finding'", {
    cwd: wt,
    shell: "/bin/bash",
  });
  await fs.writeFile(path.join(wt, "stray-round2.txt"), "written past the fence again\n");
  await realExec("git add stray-round2.txt && git commit -q -m 'the widening again'", {
    cwd: wt,
    shell: "/bin/bash",
  });
  // The fence the fixer's own prompt printed, from the driver's planner.
  const { lensFixPassPlan } = await import("../src/work-driver-lens-fix-fence.ts");
  const planned = await lensFixPassPlan(defaultExec, root, st.pipelineState, {
    id: "default",
    worktree: wt,
    roundTip,
    findings: "[]",
  });
  assert(planned.ok, `the plan-time fence built (${planned.ok ? "ok" : planned.reason})`);
  if (!planned.ok) throw new Error("unreachable: asserted above");
  const snapshot = {
    round: 1,
    workstreamId: planned.value.id,
    roundTip,
    fence: { ...planned.value.fence, helperDirs: [...planned.value.fence.helperDirs] },
    declared: planned.value.declared,
    named: planned.value.named,
    candidates: [...planned.value.candidates],
    findings: planned.value.findings,
    worktree: wt,
  };
  // The round has already spent its one revert (PM decision #1852-5: the
  // counter is scoped to this round, this workstream, this source). With that
  // record on the log, the gate's answer to a fresh stray is a park — it may
  // not revert twice.
  const gated = {
    ...st,
    eventLog: [
      ...st.eventLog,
      {
        kind: "fix-pass-strays-reverted" as const,
        at: 2_500_000,
        workstreamId: "default",
        source: "lens-fix" as const,
        round: 1,
        paths: ["stray-round1.txt"],
        preservedRef: "refs/pi-rukas/lens-fix-strays/1",
        patchPath: "/tmp/strays-1.patch",
      },
    ],
  };
  const { lensFixFenceCheck } = await import("../src/work-driver-lens-fix-fence-gate.ts");
  const pushes: string[] = [];
  const verdict = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: { repoRoot: root, issue } as never,
    state: gated,
    snapshot,
    inWorktree: true,
    tree: wt,
    round: 1,
    // #1852 round 2 MEDIUM — both `fenceRecorded` and the revert allowance are
    // read inside the gate from `state.eventLog` and `round`: the fixture puts
    // this round's one revert ON THE LOG below, and asserts the gate saw it.
    onRevertible: async () => {
      // Reachable only if the gate ignored the already-spent revert — which is
      // the behaviour this case exists to rule out, so a call is a failure.
      pushes.push("REVERT-ATTEMPTED-AFTER-ALLOWANCE-SPENT");
      return undefined;
    },
  });
  assert(
    lensFixRevertAlreadyUsed(gated.eventLog, 1, "default"),
    "the fixture really put this round's one revert on the log",
  );
  assert(
    !verdict.ok,
    `a bound-killed fixer's second out-of-fence set does not land: the fence refuses it (${verdict.reason ?? "the gate PASSED — the bound kill skipped the fence"})`,
  );
  assert(
    (verdict.reason ?? "").includes("stray-round2.txt"),
    `the refusal names the file the killed fixer had no business writing (reason: ${(verdict.reason ?? "").slice(0, 180)})`,
  );
  assert(
    (verdict.reason ?? "").includes("ALREADY had one out-of-fence set reverted"),
    `the refusal says WHY it will not revert again — the one-revert allowance is what the second set exhausted (reason: ${(verdict.reason ?? "").slice(0, 180)})`,
  );
  assert(
    pushes.length === 0,
    `the driver attempted no second revert (attempts: ${JSON.stringify(pushes)})`,
  );
  // And the fix the findings DID ask for is still there, untouched: the fence
  // refuses the round, it does not clean up after the fixer.
  let inFence = true;
  try {
    await realExec("git show HEAD:src/fix-0.txt", { cwd: wt });
  } catch {
    inFence = false;
  }
  assert(inFence, "the fence refused the round without rewriting the fixer's in-fence work");
  let pushedStray = false;
  try {
    await realExec(
      `git fetch -q origin ${JSON.stringify(branch)} && git show FETCH_HEAD:stray-round2.txt`,
      { cwd: root },
    );
    pushedStray = true;
  } catch {
    pushedStray = false;
  }
  assert(!pushedStray, "the refused round's out-of-fence file is not on origin/<branch>");
}

console.log(`\nexit ${boundLandRun.failed ? 1 : 0}`);
process.exit(boundLandRun.failed ? 1 : 0);
