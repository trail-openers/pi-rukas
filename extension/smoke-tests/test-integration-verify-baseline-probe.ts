#!/usr/bin/env bun
/**
 * #1404 — the baseline probe on the commit-pr consolidated verify seam.
 *
 * Four /work cycles on this host died at `integration-verify-failed` with
 * nothing wrong in the diff: the project gate was ALREADY red at the cycle's
 * base commit, and this seam — unlike the develop step after #1349 — had no
 * probe, so the park blamed the change and was terminal (queue census
 * 2026-10-16: #1043, #1111, #1114, #1105; zero code defects).
 *
 * These cases run `integrate()` end to end against a REAL repo whose gate IS
 * the shared smoke loop over this suite's own fixtures, so the `FAILED:`
 * markers the attribution parser reads are the ones verify-loop.sh really
 * emits — never a hand-written imitation of them. The four shapes that decide
 * the feature are all here: everything pre-existing (continue), a mix (park,
 * naming only the change's own), an unreadable base (park — absence is never
 * innocence), and no base threaded (the pre-#1404 seam, unchanged).
 *
 * The green case is the cost assertion: a passing gate must never pay for a
 * probe, or the fix would make every healthy cycle slower than the bug.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { integrate } from "../src/work-driver-integrate.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import {
  addFixture,
  execFileP,
  git,
  redGateFixture,
} from "./lib/verify-baseline-probe-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-baseline-"));

try {
// ── all failures pre-existing → the cycle continues, pushes, names them
{
  const f = await redGateFixture(root, "bp-all-pre", ["tests/test-red.ts"], {
    "notes.md": "a change with nothing to do with the gate\n",
  });
  const r = await integrate(realExec, {
    repoRoot: f.repo,
    branchName: "feature/bp-all-pre",
    baseSha: f.baseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: unrelated change",
    commitBody: "b",
    mode: "create",
    requireAllNonEmpty: true,
    verifyCmd: "sh gate.sh",
    baselineBaseSha: f.baseSha,
  });
  assert(
    r.ok === true && r.preExistingOnly === true,
    `#1404 all-pre-existing: the failure is attributed to the base, not the change (got ${JSON.stringify(r.ok ? r.preExistingOnly : r.reason).slice(0, 140)})`,
  );
  assert(
    r.ok && (r.preExistingFailures ?? []).some((n) => n.endsWith("tests/test-red.ts")),
    `#1404 all-pre-existing: the names ride on the result for the PR body and the handoff (got ${JSON.stringify(r.ok ? r.preExistingFailures : null)})`,
  );
  const pushed = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
  assert(
    pushed.stdout.includes("feature/bp-all-pre"),
    "#1404 all-pre-existing: the branch reached origin — a gate red at base no longer parks the cycle",
  );
  const listed = (await git(f.repo, ["worktree", "list"])).stdout;
  assert(
    !/baseline-verify-/.test(listed),
    `#1404 all-pre-existing: the probe worktree is torn down — a leak would wedge the next cycle's dirty preflight (${listed.trim().replace(/\n/g, " | ")})`,
  );
}

// ── a mix → park, naming ONLY the tests that pass at base
{
  // The BASE owns both listed tests and both pass there; the change makes the
  // second one red (a regression it introduced) while test-red is red on both
  // sides. So one name is pre-existing and one is change-caused, and the two
  // runs differ only in what the change did to a file the base also has.
  const f = await redGateFixture(
    root,
    "bp-mixed",
    ["tests/test-red.ts", "tests/test-regressed.ts"],
    { "notes.md": "x\n" },
    ["tests/test-red.ts", "tests/test-regressed.ts"],
    // Both files exist at base; test-red is red there too.
    {},
  );
  // Base: test-red red (fixture-1), test-regressed GREEN (fixture-2). The
  // change then edits test-regressed to the always-failing fixture — the
  // change caused that one, and only that one.
  await addFixture(f.worktrees.a as string, "fixture-3.ts", "tests/test-regressed.ts");
  await git(f.worktrees.a as string, ["add", "-A"]);
  await git(f.worktrees.a as string, [
    "commit",
    "--amend",
    "-q",
    "-m",
    "feat: breaks a passing test",
  ]);
  const r = await integrate(realExec, {
    repoRoot: f.repo,
    branchName: "feature/bp-mixed",
    baseSha: f.baseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: adds a red test",
    commitBody: "b",
    mode: "create",
    requireAllNonEmpty: true,
    verifyCmd: "sh gate.sh",
    baselineBaseSha: f.baseSha,
  });
  assert(
    !r.ok && r.failure === "verify",
    `#1404 mixed: still tagged verify — a probe excuses names, it never launders the verdict (got ${JSON.stringify(r.ok ? "ok" : r.failure)})`,
  );
  assert(
    !r.ok && /test-regressed\.ts/.test(r.reason),
    `#1404 mixed: the park names the test that passes at base (got "${r.ok ? "" : r.reason.slice(0, 240)}")`,
  );
  assert(
    !r.ok &&
      /commit \([^)]*\/test-red\.ts\) and are pre-existing/.test(r.reason) &&
      /CAUSED are: [^—]*\/test-regressed\.ts/.test(r.reason) &&
      !/CAUSED are: [^—]*\/test-red\.ts/.test(r.reason),
    `#1404 mixed: the base-red test is named as pre-existing, never in the caused-by list (got "${r.ok ? "" : r.reason.slice(0, 320)}")`,
  );
  const pushed = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
  assert(
    !pushed.stdout.includes("feature/bp-mixed"),
    "#1404 mixed: a change-caused failure still stops the push",
  );
}

// ── the base cannot be read → park (fail closed), never read as pre-existing
{
  const f = await redGateFixture(root, "bp-unreadable", ["tests/test-red.ts"], {
    "notes.md": "x\n",
  });
  // Sabotage ONLY the commit the probe checks out: its gate exits non-zero
  // having named no test at all. That is the shape that must not read as
  // "green base, therefore everything here is pre-existing".
  const baseWt = path.join(root, "bp-unreadable", "base-wt");
  await git(f.repo, ["worktree", "add", "--detach", baseWt, f.baseSha]);
  rmSync(path.join(baseWt, "tests", "test-red.ts"));
  writeFileSync(path.join(baseWt, "gate.sh"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  await git(baseWt, ["add", "-A"]);
  await git(baseWt, ["commit", "-q", "-m", "base with an unreadable gate"]);
  const brokenBase = (await git(baseWt, ["rev-parse", "HEAD"])).stdout.trim();
  await git(f.repo, ["worktree", "remove", "--force", baseWt]);
  const r = await integrate(realExec, {
    repoRoot: f.repo,
    branchName: "feature/bp-unreadable",
    baseSha: f.baseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: a change",
    commitBody: "b",
    mode: "create",
    requireAllNonEmpty: true,
    verifyCmd: "sh gate.sh",
    baselineBaseSha: brokenBase,
  });
  assert(
    !r.ok && r.failure === "verify",
    `#1404 baseline unreadable: the cycle still parks (got ${JSON.stringify(r.ok ? "ok" : r.failure)})`,
  );
  assert(
    r.ok || r.preExistingOnly !== true,
    "#1404 baseline unreadable: a probe that established nothing never reads as pre-existing",
  );
  const pushed = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
  assert(
    !pushed.stdout.includes("feature/bp-unreadable"),
    "#1404 baseline unreadable: nothing was pushed on an unreadable base",
  );
}

// ── no base threaded → the pre-#1404 seam, unchanged
{
  const f = await redGateFixture(root, "bp-no-probe", ["tests/test-red.ts"], { "notes.md": "x\n" });
  const r = await integrate(realExec, {
    repoRoot: f.repo,
    branchName: "feature/bp-no-probe",
    baseSha: f.baseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: a change",
    commitBody: "b",
    mode: "create",
    requireAllNonEmpty: true,
    verifyCmd: "sh gate.sh",
    // baselineBaseSha omitted: a caller that does not thread a base is the
    // pre-#1404 seam exactly — no probe, every consolidated failure parks.
  });
  assert(
    !r.ok && r.failure === "verify" && !("preExistingOnly" in r),
    "#1404 no base threaded: no probe runs and the failure parks as before",
  );
  const listed = (await git(f.repo, ["worktree", "list"])).stdout;
  assert(
    !/baseline-verify-/.test(listed),
    "#1404 no base threaded: not even a probe worktree is created",
  );
}

// ── a green gate stays green: the happy path never pays for a probe
{
  const f = await redGateFixture(root, "bp-green", ["tests/allpass-a.ts"], { "notes.md": "x\n" });
  const gateRuns: string[] = [];
  const counting = (async (cmd: string, o?: Parameters<typeof realExec>[1]) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    // The probe's signature is its throwaway tree; the gate itself runs
    // "sh gate.sh" in the integration tree, which never mentions one.
    if (line.includes("baseline-verify-")) gateRuns.push(line);
    return realExec(cmd, o);
  }) as typeof realExec;
  const r = await integrate(counting, {
    repoRoot: f.repo,
    branchName: "feature/bp-green",
    baseSha: f.baseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: a change",
    commitBody: "b",
    mode: "create",
    requireAllNonEmpty: true,
    verifyCmd: "sh gate.sh",
    baselineBaseSha: f.baseSha,
  });
  assert(r.ok, "#1404 green gate: a passing consolidated tree still integrates");
  assert(
    gateRuns.length === 0,
    `#1404 green gate: the probe never ran on a green gate — the happy path pays nothing extra (probe execs: ${gateRuns.length})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
} finally {
  mkdirSync(root, { recursive: true });
  rmSync(root, { recursive: true, force: true });
}
