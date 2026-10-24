#!/usr/bin/env bun
/**
 * The #1779 canaries: what a bound-killed lens-fix must NOT do.
 *
 * Companion to `test-work-driver-lens-fix-bound-landed.ts` (which runs the
 * conversion itself). These are the shapes that keep today's HALT or park, and
 * the reason each is deliberate:
 *
 *   1. killed with NO commits — nothing to land, so the step still HALTs.
 *   2. a genuinely diverged tree — its commits are not a fast-forward of
 *      anything, so landing them would be guessing; it backs up and parks.
 *   3. `PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0` — the operator asked for every
 *      unlanded tree to be surfaced: a strictly-ahead tree parks.
 *   4. the SAME knob also disables the conversion — one escape hatch, both
 *      halves (#1779 c).
 *   5. a kill whose cause is NOT the fixer's bound (abort, inactivity, loop,
 *      token-budget) is a different diagnosis with its own cap, and converts
 *      nothing (#1779 a).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import {
  FIXER_BOUND_KILL_CAUSES,
  isFixerBoundKill,
  landLensFixAfterBoundKill,
} from "../src/work-driver-lens-fix-bound-land.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { readState, writeState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";
import {
  assert,
  boundLandRun,
  driverCtx,
  killTail,
  killedFixer,
  mkFixture,
  mkLensFixState,
  withTrace,
} from "./lib/lens-fix-bound-land-fixture.ts";

// ── 2. canary: killed at its bound with NO commits still HALTs ───────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-nocommit-"));
  const branch = "feature/lens-bound-nocommit";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const issue = 1802;
  await writeState(root, mkLensFixState(issue, branch, baseSha, wt));
  const { traced } = await withTrace(() =>
    runWorkDriver(driverCtx(root, issue, killedFixer(wt, 0, "timeout") as never)).catch(() => {}),
  );
  const events = (await readState(root, issue))?.eventLog ?? [];
  assert(
    events.some((e) => e.kind === "dispatch-failed" && e.step === "lens-fix"),
    "a killed fixer with no commits still leaves the dispatch-failed tail",
  );
  const cap = events.find((e) => e.kind === "cap-hit");
  assert(cap !== undefined, "...and the step still HALTs with a cap-hit");
  assert(
    traced.includes("killed at its bound with no commits"),
    "the no-commits branch says so rather than converting",
  );
  let landed = true;
  try {
    await realExec(
      `git fetch -q origin ${JSON.stringify(branch)} && git show FETCH_HEAD:fix-0.txt`,
      {
        cwd: root,
      },
    );
  } catch {
    landed = false;
  }
  assert(!landed, "nothing was pushed for a fixer that committed nothing");
}

// ── 3. canary: a genuinely diverged tree still backs up and parks ────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-diverged-"));
  const branch = "feature/lens-bound-diverged";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const fs = await import("node:fs/promises");
  // The tree holds a commit the branch does not, AND the branch moved to a
  // commit that is not its ancestor: neither is an ancestor of the other.
  const { stdout: oldBase } = await realExec(
    `git rev-parse ${JSON.stringify(`${baseSha}^{commit}`)}`,
    { cwd: root },
  );
  await realExec(`git checkout -q --detach ${JSON.stringify(oldBase.trim())}`, { cwd: wt });
  await fs.writeFile(path.join(wt, "diverge.txt"), "diverged\n");
  await realExec("git add diverge.txt && git commit -q -m 'diverged fixer work'", {
    cwd: wt,
    shell: "/bin/bash",
  });
  await fs.writeFile(path.join(root, "feature.txt"), "branch moved\n");
  await realExec(
    "git add feature.txt && git commit -q -m 'branch advance' && git push -q origin HEAD",
    {
      cwd: root,
      shell: "/bin/bash",
    },
  );
  const rep = await repositionLensFixWorktree(realExec, wt, branch, [1803], "diverged canary");
  assert(
    rep.kind === "diverged" || rep.kind === "unlanded",
    `a tree the branch cannot fast-forward to is still refused (got ${rep.kind})`,
  );
  assert(
    rep.kind === "diverged" || rep.kind === "unlanded" ? rep.backupRef !== undefined : false,
    "a diverged tree still has a backup ref",
  );
  const wtHead = (await realExec("git log --oneline -1", { cwd: wt })).stdout.trim();
  assert(
    wtHead.includes("diverged fixer work"),
    "the diverged tree was not moved or reset by the landing attempt",
  );
}

// ── 4. canary: PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0 still parks an unlanded tree ─
{
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-knob-"));
  const branch = "feature/lens-bound-knob";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const fs = await import("node:fs/promises");
  // Strictly ahead: the tree holds the branch tip plus one commit of its own.
  await fs.writeFile(path.join(wt, "unlanded.txt"), "unlanded\n");
  await realExec("git add unlanded.txt && git commit -q -m 'unlanded fix'", {
    cwd: wt,
    shell: "/bin/bash",
  });
  process.env.PI_ENSEMBLE_LENS_FIX_LAND_AHEAD = "0";
  try {
    const rep = await repositionLensFixWorktree(
      realExec,
      wt,
      branch,
      [1804],
      "knob canary",
      undefined,
      {
        repoRoot: root,
        issue: 1804,
        state: mkLensFixState(1804, branch, baseSha, wt),
      },
    );
    assert(
      rep.kind === "unlanded",
      `with PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0 a strictly-ahead tree still parks (got ${rep.kind})`,
    );
    assert(
      rep.kind === "unlanded" && rep.backupRef !== undefined,
      "...and is still backed up to a ref",
    );
  } finally {
    process.env.PI_ENSEMBLE_LENS_FIX_LAND_AHEAD = "";
  }
}

// ── 5. canary: the ONE knob (PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0) HALTs a kill ─
// #1779 (c): the same flag disables the conversion here and the strictly-ahead
// landing in the reposition gate, so an operator has one thing to remember.
{
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-land-off-"));
  const branch = "feature/lens-bound-land-off";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const issue = 1805;
  await writeState(root, mkLensFixState(issue, branch, baseSha, wt));
  process.env.PI_ENSEMBLE_LENS_FIX_LAND_AHEAD = "0";
  let traced = "";
  try {
    traced = (
      await withTrace(() =>
        runWorkDriver(driverCtx(root, issue, killedFixer(wt, 1, "child-bound") as never)).catch(
          () => {},
        ),
      )
    ).traced;
  } finally {
    process.env.PI_ENSEMBLE_LENS_FIX_LAND_AHEAD = "";
  }
  const events = (await readState(root, issue))?.eventLog ?? [];
  assert(
    events.some((e) => e.kind === "dispatch-failed" && e.step === "lens-fix"),
    "with the escape hatch off a killed fixer keeps today's dispatch-failed tail",
  );
  assert(
    events.some((e) => e.kind === "cap-hit"),
    "...and the step HALTs instead of routing to the adversarial gate",
  );
  assert(
    traced.includes("PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0"),
    "the disabled conversion says which knob disabled it",
  );
}

// ── 6. a kill that is NOT the fixer's bound keeps today's HALT (#1779 a) ────
// The conversion is for a child the BOUND ended. #1789 (7) states the rule as
// ONE list — only `timeout` and `child-bound` convert, every other kill cause
// parks — so this walks the whole union rather than four examples. An aborted,
// wedged, looping or out-of-budget child is a different diagnosis, and each
// already owns a fixed-literal cap the conversion would delete.
// #1789 (8): one issue number PER cause, and every lookup scoped to the
// lens-fix step. With a shared issue each iteration reads the previous one's
// state file back, so a cap found in it is attributed to the wrong cause.
// The cap each kill cause produces at a HALT step (`work-driver-step-router.ts`
// — `capKilledString` gives the self-kills their fixed literals, everything
// else gets `step-failed:lens-fix`). A cap-hit carries no `step`, so naming the
// cap literal IS the per-step scoping #1789 (8) asks for: any other step's cap
// fails the lookup instead of passing it.
const HALT_CAPS: Record<string, string[]> = {
  abort: ["step-failed:lens-fix"],
  inactivity: ["step-failed:lens-fix"],
  loop: ["loop-detected", "step-failed:lens-fix"],
  "token-budget": ["token-budget", "step-failed:lens-fix"],
  "plan-timeout": ["step-failed:lens-fix"],
  "tool-inactivity": ["step-failed:lens-fix"],
  "no-progress": ["step-failed:lens-fix"],
  "stuck-tool": ["step-failed:lens-fix"],
};

for (const [i, cause] of (
  [
    "abort",
    "inactivity",
    "loop",
    "token-budget",
    "plan-timeout",
    "tool-inactivity",
    "no-progress",
    "stuck-tool",
  ] as const
).entries()) {
  const dir = mkdtempSync(path.join(tmpdir(), `lens-bound-cause-${cause}-`));
  const branch = `feature/lens-bound-cause-${cause}`;
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const issue = 1810 + i;
  await writeState(root, mkLensFixState(issue, branch, baseSha, wt));
  // The fixer commits — so the ONLY thing that must stop the conversion is the
  // kill cause, not the absence of work.
  await runWorkDriver(driverCtx(root, issue, killedFixer(wt, 2, cause) as never)).catch(() => {});
  const state = await readState(root, issue);
  const events = state?.eventLog ?? [];
  assert(
    events.some((e) => e.kind === "dispatch-failed" && e.step === "lens-fix"),
    `a ${cause} kill leaves the dispatch-failed tail — it is not a bound kill`,
  );
  assert(
    events.some(
      (e) => e.kind === "dispatch-completed" && e.step === "lens-fix" && e.ok === true,
    ) === false,
    `...and a ${cause} kill is never converted into a completed lens-fix`,
  );
  // The step HALTs on the cap its own kill produces (#1789 8: scoped to this
  // round — the tail of the log is what the router capped on, and a cap from an
  // earlier step says nothing about whether THIS round converted). The literal
  // depends on the cause: `loop-detected` / `token-budget` are the fixed
  // literals a self-kill gets, every other cause gets `step-failed:lens-fix`.
  const cap = events.find(
    (e): e is Extract<WorkEvent, { kind: "cap-hit" }> =>
      e.kind === "cap-hit" && HALT_CAPS[cause].includes(e.cap),
  );
  assert(
    cap !== undefined,
    `...and the ${cause} kill HALTs with its own cap-hit rather than a conversion (expected one of ${HALT_CAPS[cause].join("/")})`,
  );
  assert(
    (state?.pipelineState.plumbReports ?? []).length === 0,
    `...and a ${cause} kill discloses nothing (nothing was converted)`,
  );
}

// ── 7. the tail must be THIS round's dispatch (#1789 1) ───────────────────
// The conversion reads the LAST event of the log. A `dispatch-failed` left
// there by a DIFFERENT dispatch is not this fixer's kill: converting it would
// delete a failure this round never caused. Asserted directly on the
// classifier — the driver path cannot fabricate a foreign tail — with a tree
// that really holds a commit past the round's tip, so the jobId is the only
// thing left that can refuse.
{
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-jobid-"));
  const branch = "feature/lens-bound-jobid";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const fs = await import("node:fs/promises");
  await fs.writeFile(path.join(wt, "fix-0.txt"), "fix 0\n");
  await realExec("git add fix-0.txt && git commit -q -m 'fix(lens): part 0'", {
    cwd: wt,
    shell: "/bin/bash",
  });
  const tip = (await realExec("git rev-parse HEAD~1", { cwd: wt })).stdout.trim();
  const state = mkLensFixState(1830, branch, baseSha, wt);
  const jobId = "lens-fix:developer:lens-fix-1:1:1";

  // (a) a tail from ANOTHER job is refused, and the trace names both ids.
  const foreign = killTail(state, "lens-fix:developer:lens-fix-9:9", "timeout");
  const refused = await withTrace(() =>
    landLensFixAfterBoundKill(foreign, { tree: wt, tipSha: tip, jobId }, realExec),
  );
  assert(
    refused.traced.includes("conversion refused") &&
      refused.traced.includes("lens-fix:developer:lens-fix-9:9") &&
      refused.traced.includes(jobId),
    "a tail belonging to another jobId is refused, and the trace names both ids",
  );
  assert(
    refused.result.eventLog[refused.result.eventLog.length - 1]?.kind === "dispatch-failed",
    "...and the foreign tail is left in place — nothing was deleted",
  );
  assert(
    (refused.result.pipelineState.plumbReports ?? []).length === 0,
    "...and a refused conversion discloses nothing",
  );

  // (b) the SAME tail converts when the jobId is the round's own dispatch —
  // proof that (a) refused on the id and not on an earlier guard.
  const own = killTail(state, jobId, "timeout");
  const converted = await landLensFixAfterBoundKill(
    own,
    { tree: wt, tipSha: tip, jobId },
    realExec,
  );
  const tail = converted.eventLog[converted.eventLog.length - 1];
  assert(
    tail.kind === "dispatch-completed" && tail.partialAfterKill?.killCause === "timeout",
    "the same tail DOES convert when the jobId matches this round's dispatch",
  );
  // #1789 (3): the cause is in the summary the operator reads, not only in the
  // structured field.
  assert(
    tail.kind === "dispatch-completed" &&
      (tail.summary ?? "").includes("killed at its bound (timeout)"),
    "the summary names the kill cause alongside the commit count",
  );
}

// ── 8. a kill the caller's cycle deadline produced never converts (#1789 2) ─
// `killedAtCycleDeadline` means the CYCLE ran out of time (#1593), not that the
// fixer outlived its own bound. Letting it through would advance a cycle past
// the deadline that ended it, so this parks even with commits in the tree.
{
  const dir = mkdtempSync(path.join(tmpdir(), "lens-bound-deadline-"));
  const branch = "feature/lens-bound-deadline";
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const fs = await import("node:fs/promises");
  await fs.writeFile(path.join(wt, "fix-0.txt"), "fix 0\n");
  await realExec("git add fix-0.txt && git commit -q -m 'fix(lens): part 0'", {
    cwd: wt,
    shell: "/bin/bash",
  });
  const tip = (await realExec("git rev-parse HEAD~1", { cwd: wt })).stdout.trim();
  const jobId = "lens-fix:developer:lens-fix-1:1:1";
  const atDeadline = killTail(mkLensFixState(1831, branch, baseSha, wt), jobId, "timeout", true);
  const { result, traced } = await withTrace(() =>
    landLensFixAfterBoundKill(atDeadline, { tree: wt, tipSha: tip, jobId }, realExec),
  );
  assert(traced.includes("cycle deadline"), "a deadline kill traces why it is not converted");
  assert(
    result.eventLog[result.eventLog.length - 1]?.kind === "dispatch-failed",
    "...and the tail stays a dispatch-failed — the cycle parks",
  );
  assert(
    (result.pipelineState.plumbReports ?? []).length === 0,
    "...and a deadline kill discloses no conversion",
  );
}

// ── 9. isFixerBoundKill over EVERY kill cause (#1789 6) ───────────────────
// The rule the docs state, as a table: exactly two causes convert and every
// other parks. Walking the whole union means a cause added to
// `DispatchResult.killCause` is a failing assertion here rather than a silent
// default inside the conversion.
{
  const all: DispatchResult["killCause"][] = [
    "timeout",
    "inactivity",
    "abort",
    "loop",
    "token-budget",
    "plan-timeout",
    "tool-inactivity",
    "child-bound",
    "no-progress",
    "stuck-tool",
  ];
  for (const c of all) {
    const expected = c === "timeout" || c === "child-bound";
    assert(
      isFixerBoundKill(c) === expected,
      `isFixerBoundKill(${JSON.stringify(c)}) === ${expected}`,
    );
  }
  assert(
    isFixerBoundKill(undefined) === false,
    "...and an unstructured failure is not a bound kill",
  );
  assert(
    FIXER_BOUND_KILL_CAUSES.length === 2 &&
      FIXER_BOUND_KILL_CAUSES.includes("timeout") &&
      FIXER_BOUND_KILL_CAUSES.includes("child-bound"),
    "the list the guard tests is the list the docs state (only timeout and child-bound convert)",
  );
}

console.log(`\nexit ${boundLandRun.failed ? 1 : 0}`);
process.exit(boundLandRun.failed ? 1 : 0);
