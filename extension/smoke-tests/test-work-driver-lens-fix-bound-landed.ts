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
import {
  landLensFixAfterBoundKill,
} from "../src/work-driver-lens-fix-bound-land.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState, writeState } from "../src/workflow-state.ts";
import { mkLensSummary } from "./test-helpers.ts";
import { realExec } from "./lib/exec-fake.ts";
import {
  assert,
  boundLandRun,
  driverCtx,
  killTail,
  killedFixer,
  mkFixture,
  fixerDeclaredPaths,
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
    killTail(mkLensFixState(1806, moveBranch, mv.baseSha, mv.wt, fixerDeclaredPaths(1)), moveJobId, "timeout"),
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
  // bound-killed fixer is judged by the same fence, on the same delta, through
  // the fix pass's own ladder.
  //
  // THE SHAPE THAT PROVES IT, and why it takes two rounds. A single stray set is
  // REVERTED and the round lands — the fence doing its job, not refusing; on a
  // one-round fixture the assertions below could not tell "the fence ran and
  // allowed it" from "there was no fence". The refusal that must not be pushable
  // is the SECOND set in one round, so: round 1's killed fixer writes one
  // out-of-fence file, the driver reverts it and lands the fix; round 2's fixer
  // writes another, that round's one revert is already spent, and the gate parks
  // with the branch unmoved.
  //
  // The second set is committed INSIDE the round-2 fixer's own dispatch. The
  // driver's revert commits to HEAD, so anything a harness wrote after the
  // dispatch returned would sit on top of that revert commit, outside the
  // round's `roundTip..HEAD` delta — and the fence would correctly never see it.
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-stray-"));
  const branch = "feature/lens-bound-stray";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const issue = 18070;
  await writeState(root, mkLensFixState(issue, branch, baseSha, wt, fixerDeclaredPaths(2)));
  const written: string[] = [];
  const strayFixer = async (
    pi: unknown,
    spec: { role?: string; prompt?: string; runId?: string },
    opts?: { label?: string },
  ): Promise<DispatchResult> => {
    if (opts?.label?.startsWith("developer:lens-fix")) {
      const fs = await import("node:fs/promises");
      if (written.length === 0) {
        // Round 1: the fix the findings asked for, plus one file outside the
        // declared fence — the set the driver is allowed to revert.
        for (let i = 0; i < 2; i++) {
          await fs.writeFile(path.join(wt, `src/fix-${i}.txt`), `fix ${i}\n`);
          await realExec(`git add src/fix-${i}.txt && git commit -q -m 'fix(lens): part ${i}'`, {
            cwd: wt,
            shell: "/bin/bash",
          });
        }
        written.push("stray-round1.txt");
        await fs.writeFile(path.join(wt, written[0]), "written past the fence\n");
        await realExec(`git add ${written[0]} && git commit -q -m 'the widening'`, {
          cwd: wt,
          shell: "/bin/bash",
        });
      } else {
        // Round 2: a SECOND out-of-fence set, in a round whose one revert has
        // already been spent.
        written.push("stray-round2.txt");
        await fs.writeFile(path.join(wt, written[1]), "written past the fence again\n");
        await realExec(`git add ${written[1]} && git commit -q -m 'the widening again'`, {
          cwd: wt,
          shell: "/bin/bash",
        });
      }
    }
    // The kill is reported only AFTER the commits exist — what a child stopped at
    // its bound does, and what `landLensFixAfterBoundKill` classifies.
    return killedFixer(wt, 0, "timeout")(pi, spec, opts);
  };
  const pushes: string[] = [];
  const lensReviewFn = async () =>
    written.length === 0
      ? mkLensSummary({ verdict: "APPROVED" })
      : mkLensSummary({
          // Round 2 does NOT approve, so the cycle comes back to lens-fix a
          // second time and that round's fixer is the one the fence must catch.
          verdict: "ISSUES_FOUND",
          totalFindings: 1,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
          findings: [
            {
              lens: "SIMPLICITY",
              severity: "MEDIUM",
              path: "src/fix-0.txt",
              line: 1,
              title: "still stale",
              description: "the comment still contradicts the code",
              suggestion: "fix it",
            },
          ],
        });
  const { traced } = await withTrace(() =>
    runWorkDriver(
      driverCtx(root, issue, strayFixer as never, {
        netGitFn: async (args: string[]) => {
          pushes.push(args.join(" "));
          return { stdout: "", stderr: "" };
        },
        lensReviewFn,
      }) as never,
    ).catch(() => {}),
  );
  const events = (await readState(root, issue))?.eventLog ?? [];
  const caps = events.filter((e) => e.kind === "cap-hit").map((e) => (e as { cap: string }).cap);
  assert(
    written.length === 2,
    `the fixture really reached a second lens-fix round (fixer dispatches: ${written.length})`,
  );
  assert(
    caps.includes("lens-fix-scope"),
    `the round whose killed fixer would not stay inside its fence parks on the fence (caps: ${JSON.stringify(caps)})`,
  );
  const cap = events.find(
    (e) => e.kind === "cap-hit" && e.cap === "lens-fix-scope",
  ) as { evidence?: string } | undefined;
  assert(
    (cap?.evidence ?? "").includes("stray-round2.txt"),
    `the park names the second set the killed fixer had no business writing (evidence: ${(cap?.evidence ?? "").slice(0, 160)})`,
  );
  assert(
    events.some(
      (e) =>
        e.kind === "fix-pass-strays-reverted" && (e as { source?: string }).source === "lens-fix",
    ),
    "the first stray set was reverted by the driver — the fence ran, it did not skip",
  );
  assert(
    !pushes.some((p) => p.includes("push")),
    `nothing was pushed for the round the fence refused (attempts: ${JSON.stringify(pushes)})`,
  );
  let landed = true;
  try {
    await realExec(
      `git fetch -q origin ${JSON.stringify(branch)} && git show FETCH_HEAD:stray-round2.txt`,
      { cwd: root },
    );
  } catch {
    landed = false;
  }
  assert(!landed, "the refused round's out-of-fence file did not reach origin/<branch>");
  // The conversion itself still happened — the park is the FENCE's decision, not
  // a lost dispatch. Without this, the assertions above would also hold for a
  // round that never got as far as classifying the kill.
  assert(
    traced.includes("treated as a partial fix"),
    "the bound kill was still converted to a partial fix — the fence, not the kill, is what parked",
  );
}
console.log(`\nexit ${boundLandRun.failed ? 1 : 0}`);
process.exit(boundLandRun.failed ? 1 : 0);
