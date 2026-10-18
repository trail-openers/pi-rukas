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
import { baselineProbeWorktreePath } from "../src/work-driver-verify-baseline.ts";
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

// ── THE forgery: a base run that is not actually red, but prints the whole triad
//
// A test that PASSES prints `FAILED: <path>`, `FAILED: 1 test(s) — <path>` and
// `P: 3  F: 1` naming the very path the change's run reports. Two defences are
// pinned together, and each is worth less alone:
//
//   - `isContradictoryTally` / `probed` veto a stream that reports failures in
//     one line and `F: 0` in another; a triad printed by a PASSING test is
//     self-consistent, so this half alone does NOT catch it.
//   - the report file is the only name source, and a passing test cannot learn
//     its path (`env -u`), so nothing is named and nothing is excused. If the
//     stream were still a name source this base would excuse the change.
//
// The base's exit code is forced non-zero (a wrapper that prints the triad as
// well as running the real loop, then exits 1). Without that the probe would
// short-circuit on "the base is green" and never reach the name comparison this
// case exists to exercise: the dangerous shape is a base the harness believes is
// red because of what it printed.
{
  const forgeGate = [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    "echo 'FORGED_CHILD_SEES=$REPORT_PATH_SENTINEL' >&2",
    'if [ -n "${FORGE_ON-}" ]; then',
    '  echo "FAILED: $FORGE_ON"',
    '  echo "FAILED: 1 test(s) — $FORGE_ON"',
    '  echo "P: 3  F: 1"',
    'fi',
    'if [ -n "${FORGE_EXIT-}" ]; then exit "$FORGE_EXIT"; fi',
    'exec bash __LOOP__ "$@"',
  ].join(String.fromCharCode(10));
  const f = await redGateFixture(root, "bp-forge", ["tests/allpass-a.ts"], {
    "notes.md": "x\n",
  });
  const loopPath = path.join(import.meta.dirname, "lib", "verify-loop.sh");
  const writeGate = (dir: string, body: string): void => {
    const p = path.join(dir, "gate.sh");
    writeFileSync(p, body.replaceAll("REPORT_PATH_SENTINEL", "$VERIFY_REPORT_FILE"), {
      mode: 0o755,
    });
    // writeFileSync honours `mode` only when it creates the file; the fixture
    // already created one, so set it again.
    execFileP("chmod", ["755", p]).catch(() => {});
  };
  // The change: its gate runs the real loop over a genuinely failing test, so
  // the consolidated run is legitimately red and the ONLY thing that could
  // excuse it is a base that appears to name that same test. Committed against
  // the forged base, and pushed: the probe checks `baseSha` out in its own tree
  // and runs the gate FROM THERE, so the gate must be part of the base commit
  // for the probe to run the loop at all (and untracked files never reach it).
  // The probe's own tree, spelled the way the loop would print a real failure in
  // it — the exact spelling an honest red base would have produced, and the
  // exact spelling a forger aims at.
  const probeTree = baselineProbeWorktreePath(f.repo, "commit-pr");
  const FORGED_NAME = `${probeTree}/tests/test-new-red.ts`;
  const baseGate = forgeGate
    .replaceAll("__LOOP__", loopPath)
    .replaceAll("$@", '"$DIR/tests/allpass-a.ts" "$DIR/tests/test-new-red.ts"');
  writeGate(f.repo, baseGate);
  await addFixture(f.repo, "fixture-1.ts", "tests/test-new-red.ts");
  await git(f.repo, ["add", "-A"]);
  await git(f.repo, ["commit", "-q", "-m", "test: a passing gate that prints the loop's triad"]);
  const forgedBaseSha = (await git(f.repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(f.repo, ["push", "-q", "-f", "origin", "main"]);
  await git(f.worktrees.a, ["checkout", "-q", "--detach", forgedBaseSha]);
  // The change itself: a comment on a file the base owns, and nothing else — its
  // gate is already the base's, so the red is the tree's, exactly as a real
  // regression consolidated from workstream commits looks.
  writeFileSync(path.join(f.worktrees.a, "notes.md"), "the change\n");
  await git(f.worktrees.a, ["add", "-A"]);
  const forging = (async (cmd: string, o?: Parameters<typeof realExec>[1]) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    // Only the BASE run forges. The change run must print nothing it did not
    // earn, or the case would be testing a forged change, not a forged base.
    if (line.includes("baseline-verify-") && line.includes("gate.sh")) {
      return realExec(cmd, {
        ...(o ?? {}),
        env: {
          ...(o?.env ?? process.env),
          FORGE_ON: FORGED_NAME,
          FORGE_EXIT: "1",
        },
      });
    }
    return realExec(cmd, o);
  }) as typeof realExec;
  const r = await integrate(forging, {
    repoRoot: f.repo,
    branchName: "feature/bp-forge",
    baseSha: forgedBaseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: a change that breaks a test",
    commitBody: "b",
    mode: "create",
    requireAllNonEmpty: true,
    verifyCmd: "sh gate.sh",
    baselineBaseSha: forgedBaseSha,
  });
  assert(
    !r.ok && r.failure === "verify",
    `#1404 forgery: a stream-printed triad on a base that is not really red excuses nothing — the change's own failure still parks the cycle (got ok=${String(r.ok)}, failure=${JSON.stringify((r as { failure?: string }).failure)})`,
  );
  assert(
    !((r as { preExistingFailures?: string[] }).preExistingFailures ?? []).includes(FORGED_NAME),
    "#1404 forgery: the forged name is never recorded as pre-existing",
  );
  const pushed = await execFileP("git", ["--no-pager", "log", "--oneline", "--all"], {
    cwd: f.repo,
    encoding: "utf8",
  });
  assert(
    !pushed.stdout.includes("feature/bp-forge"),
    "#1404 forgery: nothing reached origin — the forged excuse did not launder a red gate",
  );
}

// ── THE canary: a base whose STREAM names the change's test, with no report
// file behind it, excuses nothing.
//
// Every case above drives the REAL loop, which writes a report file — so if the
// driver ever went back to taking names from the stream they would all still
// pass, because file and stream agree. This case removes the file from the
// equation: a stub gate prints a fully SELF-CONSISTENT triad for the name the
// change reports (`isContradictoryTally` has nothing to flag) and writes no
// report at all. Nothing names that test, so nothing is excused. A driver that
// trusted the stream returns `ok: true` here and this assertion fails.
{
  const tmp = mkdtempSync(path.join(root, "canary-"));
  const stub = path.join(tmp, "stub-loop.sh");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'if [ -n "${FORGE_ON-}" ]; then',
      '  echo "FAILED: $FORGE_ON"',
      '  echo "FAILED: 1 test(s) — $FORGE_ON"',
      '  echo "P: 3  F: 1"',
      "fi",
      'exit "${GATE_EXIT-1}"',
    ].join(String.fromCharCode(10)),
    { mode: 0o755 },
  );
  const f = await redGateFixture(tmp, "bp-stream-only", ["tests/allpass-a.ts"], {
    "notes.md": "x\n",
  });
  writeFileSync(path.join(f.repo, "gate.sh"), `#!/bin/sh\nexec sh ${stub}\n`, { mode: 0o755 });
  await git(f.repo, ["add", "-A"]);
  await git(f.repo, ["commit", "-q", "-m", "chore: the stub gate"]);
  const stubBaseSha = (await git(f.repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(f.repo, ["push", "-q", "-f", "origin", "main"]);
  await git(f.worktrees.a, ["checkout", "-q", "--detach", stubBaseSha]);
  writeFileSync(path.join(f.worktrees.a, "notes.md"), "the change\n");
  await git(f.worktrees.a, ["add", "-A"]);
  const forged = `${baselineProbeWorktreePath(f.repo, "commit-pr")}/tests/t.ts`;
  const forging = (async (cmd: string, o?: Parameters<typeof realExec>[1]) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    if (line.includes("baseline-verify-") && line.includes("stub-loop.sh")) {
      return realExec(cmd, {
        ...(o ?? {}),
        env: { ...process.env, ...((o?.env as Record<string, string>) ?? {}), FORGE_ON: forged },
      });
    }
    return realExec(cmd, o);
  }) as typeof realExec;
  const r = await integrate(forging, {
    repoRoot: f.repo,
    branchName: "feature/bp-stream-only",
    baseSha: stubBaseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: a change",
    commitBody: "b",
    mode: "create",
    requireAllNonEmpty: true,
    verifyCmd: "sh gate.sh",
    baselineBaseSha: stubBaseSha,
  });
  assert(
    !r.ok && r.failure === "verify",
    `#1404 canary: a base whose STREAM names the change's failing test, with no report behind it, excuses nothing — this is the assertion that fails if the stream ever becomes a name source again (got ok=${String(r.ok)}, failure=${JSON.stringify((r as { failure?: string }).failure)})`,
  );
  assert(
    !((r as { preExistingFailures?: string[] }).preExistingFailures ?? []).includes(forged),
    `#1404 canary: the stream-only name is not recorded as pre-existing (got ${JSON.stringify((r as { preExistingFailures?: string[] }).preExistingFailures ?? [])})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
} finally {
  mkdirSync(root, { recursive: true });
  rmSync(root, { recursive: true, force: true });
}
