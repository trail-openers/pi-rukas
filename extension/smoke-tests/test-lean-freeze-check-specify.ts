#!/usr/bin/env bun
/**
 * lean/freeze-check, `specify` side — a candidate test is admitted only if the
 * project's own content checks pass over it.
 *
 * The freeze proves a candidate RED and nothing else. A repository also runs
 * commands that read test-file CONTENT (the env-clear gate in this repo's
 * `verify.fast` is one), and `build` may not edit a frozen file: a candidate
 * that trips such a check freezes into an unwinnable contract, and every build
 * round the run has left burns on a file nobody may touch.
 *
 * `verify.freezeCheck` is the key that closes it, and these are the four arms
 * that make it mean something:
 *
 *   (f1) a red candidate the check NAMES, on a base the check passes → the file
 *        is not frozen, the reason names the check command, nothing is committed,
 *        and the adversary gets the drop back through `refused` so the retry's
 *        prompt can carry it;
 *   (f2) the control — a clean red candidate on the same config freezes exactly
 *        as it did before the key existed. Without it (f1) could be "refuse all";
 *   (f3) a base the check is ALREADY red on → candidates still freeze: a red the
 *        mainline authored is not this run's defect and never blocks;
 *   (f4) a check that cannot run (a kill, a command that never started) → the
 *        candidate still freezes and the step reason says the check could not be
 *        judged. Silence would read as a pass.
 *
 * Real temp git repo, real `sh`, real git; only the model is stubbed
 * (lib/lean-specify-fixture.ts).
 */

import {
  ROOTS,
  RUNNER,
  configWith,
  git,
  makeRepo,
  put,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";
import { assert, testLocationExit } from "./lib/lean-test-location-fixture.ts";

const MARKER = "FORBIDDEN_MARKER";
/**
 * The candidate a project's content gate exists to refuse.
 *
 * The offending line is BUILT from fragments rather than written out: this repo's
 * own env-clear ratchet (`test-env-clear-gate.ts`) refuses the dot form of that
 * assignment in any `.ts`, and a fixture that tripped the gate it imitates would
 * be caught by it rather than proving anything about the step.
 */
function markedScript(): string {
  const offending = `process.env.${["X", "_OFFENDER"].join("")} = undefined`;
  return redScript().replace(
    "exit 1",
    `echo "${MARKER}" 1>&2\n# offending form: ${offending}\nexit 1`,
  );
}

/**
 * The project's freeze check: one `sh` line over the whole tree. It is green
 * unless a test file carries the marker, which is exactly the shape of this
 * repo's own env-clear gate — a check that reads content, not exit codes. The
 * marker is grepped for, never spelled, so the check's own text stays clean too.
 */
function gate(): string {
  return `sh -c 'if grep -rl ${MARKER} tests >/dev/null 2>&1; then grep -rn ${MARKER} tests; exit 1; fi'`;
}

const CONFIG = configWith({ fast: "true", test: RUNNER, freezeCheck: gate() });
const CLEAN = "tests/AC1-clean.test.sh";
const MARKED = "tests/AC1-marked.test.sh";

const FILES = { "src/retry.ts": "export const retry = () => {};\n" };

// ── (f1) a marked red candidate is refused, named, and costs the run nothing ──
{
  const repo = makeRepo(FILES);
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 2401,
    config: CONFIG,
    prompts,
    writes: (wt) => {
      put(wt, CLEAN, redScript(), 0o755);
      put(wt, MARKED, markedScript(), 0o755);
    },
    toolUses: [submit("AC1", [CLEAN]), submit("AC1", [MARKED])],
  });
  assert(r.threw === undefined, `(f1) no throw — a check drop is a verdict (${r.threw?.message})`);
  assert(
    r.outcome?.kind === "ok",
    `(f1) the clean red file still freezes, so the run is ok (got ${r.outcome?.kind})`,
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === CLEAN,
    `(f1) ONLY the clean file is frozen — the marked one never joins the contract (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("verify.freezeCheck"),
    `(f1) the reason names the check that refused it (got ${r.outcome?.reason})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(gate()),
    `(f1) the reason names the check COMMAND, so an operator can run it (got ${r.outcome?.reason})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(MARKED),
    `(f1) the reason names the dropped file (got ${r.outcome?.reason})`,
  );
  let inCommit = true;
  try {
    git(r.worktree, "show", `HEAD:${MARKED}`);
  } catch {
    inCommit = false;
  }
  assert(!inCommit, "(f1) the marked file is NOT in the frozen commit");
  assert(
    !git(r.worktree, "ls-files", "--others", "--exclude-standard").includes(MARKED),
    "(f1) the marked file is not left in the tree either",
  );
  assert(
    git(r.worktree, "status", "--porcelain", "-uall").trim() === "",
    "(f1) the tree is clean after the freeze — the refused file left nothing behind",
  );
}

// ── (f2) the control: a clean red candidate freezes exactly as before ─────────
{
  const repo = makeRepo(FILES);
  const r = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 2402,
    config: CONFIG,
    writes: (wt) => put(wt, CLEAN, redScript(), 0o755),
    toolUses: [submit("AC1", [CLEAN])],
  });
  assert(r.threw === undefined, `(f2) no throw (${r.threw?.message})`);
  assert(r.outcome?.kind === "ok", `(f2) ok, got ${r.outcome?.kind}`);
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === CLEAN,
    `(f2) the clean candidate freezes unchanged (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    git(r.worktree, "rev-list", "--count", "HEAD").trim() === "2",
    `(f2) the freeze commit is there (got ${git(r.worktree, "rev-list", "--count", "HEAD")} commits)`,
  );
}

// ── (f3) a base the check is already red on never blocks ────────────────────
{
  // The mainline itself carries a marked file: the gate is red whatever this
  // run does, so the check has no standing to refuse anything.
  const repo = makeRepo({ ...FILES, "tests/mainline-red.test.sh": markedScript() });
  const r = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 2403,
    config: CONFIG,
    writes: (wt) => put(wt, CLEAN, redScript(), 0o755),
    toolUses: [submit("AC1", [CLEAN])],
  });
  assert(r.threw === undefined, `(f3) no throw (${r.threw?.message})`);
  assert(
    r.outcome?.kind === "ok" && Object.keys(r.outcome?.frozen ?? {}).join() === CLEAN,
    `(f3) a gate red at base never blocks the freeze (got ${r.outcome?.kind} / ${JSON.stringify(r.outcome?.frozen)})`,
  );
}

// ── (f4) a check that cannot run blocks nothing, and says so ────────────────
{
  const repo = makeRepo(FILES);
  const r = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 2404,
    config: configWith({ fast: "true", test: RUNNER, freezeCheck: "definitely-not-a-real-binary" }),
    writes: (wt) => put(wt, CLEAN, redScript(), 0o755),
    toolUses: [submit("AC1", [CLEAN])],
  });
  assert(r.threw === undefined, `(f4) an un-runnable check is not infra (${r.threw?.message})`);
  assert(
    r.outcome?.kind === "ok" && Object.keys(r.outcome?.frozen ?? {}).join() === CLEAN,
    `(f4) the candidate still freezes when the check could not run (got ${r.outcome?.kind})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("could not be judged"),
    `(f4) the reason discloses that the check never answered (got ${r.outcome?.reason})`,
  );
}

for (const dir of ROOTS) void dir;
process.exit(testLocationExit());
