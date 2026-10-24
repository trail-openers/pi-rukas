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
import { runWorkDriver } from "../src/work-driver.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
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
    await realExec(`git fetch -q origin ${JSON.stringify(branch)} && git show FETCH_HEAD:fix-0.txt`, {
      cwd: root,
    });
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
  const { stdout: oldBase } = await realExec(`git rev-parse ${JSON.stringify(`${baseSha}^{commit}`)}`, { cwd: root });
  await realExec(`git checkout -q --detach ${JSON.stringify(oldBase.trim())}`, { cwd: wt });
  await fs.writeFile(path.join(wt, "diverge.txt"), "diverged\n");
  await realExec("git add diverge.txt && git commit -q -m 'diverged fixer work'", {
    cwd: wt,
    shell: "/bin/bash",
  });
  await fs.writeFile(path.join(root, "feature.txt"), "branch moved\n");
  await realExec("git add feature.txt && git commit -q -m 'branch advance' && git push -q origin HEAD", {
    cwd: root,
    shell: "/bin/bash",
  });
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
    const rep = await repositionLensFixWorktree(realExec, wt, branch, [1804], "knob canary", undefined, {
      repoRoot: root,
      issue: 1804,
      state: mkLensFixState(1804, branch, baseSha, wt),
    });
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
// The conversion is for a child the BOUND ended. An aborted, wedged, looping or
// out-of-budget child is a different diagnosis, and each already owns a
// fixed-literal cap the conversion would delete.
for (const cause of ["abort", "inactivity", "loop", "token-budget"] as const) {
  const dir = mkdtempSync(path.join(tmpdir(), `lens-bound-cause-${cause}-`));
  const branch = `feature/lens-bound-cause-${cause}`;
  const { root, wt, baseSha } = await mkFixture(dir, branch);
  const issue = 1810;
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
    events.some((e) => e.kind === "cap-hit" && e.step === "lens-fix") === false &&
      events.some(
        (e) => e.kind === "dispatch-completed" && e.step === "lens-fix" && e.ok === true,
      ) === false,
    `...and a ${cause} kill is never converted into a completed lens-fix`,
  );
  assert(
    (state?.pipelineState.plumbReports ?? []).length === 0,
    `...and a ${cause} kill discloses nothing (nothing was converted)`,
  );
}


console.log(`\nexit ${boundLandRun.failed ? 1 : 0}`);
process.exit(boundLandRun.failed ? 1 : 0);
