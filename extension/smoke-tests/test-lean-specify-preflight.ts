#!/usr/bin/env bun
/**
 * lean/specify — the runner preflight (#2172).
 *
 * A runner that cannot collect a test — pytest's exit 4, an empty submodule
 * directory, a suite needing an environment variable this tree lacks — printed
 * nothing naming the file, so the red proof graded it `unclear` and `specify`
 * declined with `criterion ACn has no red test`: a VERDICT about work no
 * toolchain judged, blamed on the issue. The step now asks the project's own
 * runner one question before the first dispatch, and a runner that fails it is
 * infrastructure.
 *
 * Driven through the real fixture (real temp repo, real `execp`), with the
 * runner itself a stubbed `#!/bin/sh` script — the shape that reproduces a
 * collection error without a real pytest:
 *
 *   (a) a runner that exits 4 on the empty probe -> infrastructure handback
 *       NAMING the rendered command, dispatched 0 times and costing no rows;
 *   (a2) the same exit 4 whose output DOES name the probe — what a real pytest
 *       collection error prints — is still infrastructure: the STATUS decides,
 *       not the proof's classification;
 *   (b) a healthy runner (exit 0, and pytest's exit 5) proceeds to specify
 *       exactly as before, freezing the red test;
 *   (c) the probe leaves nothing in the worktree — not on the pass path, not on
 *       the throw path, and not under a configured `verify.testDir`;
 *   (d) a hanging probe ends as infrastructure under the injected bound, so the
 *       bound is observable and a preflight cannot wedge the cycle;
 *   (e) no `verify.test` at all keeps its old verdict and its old wording, and
 *       still dispatches nobody.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ROOTS,
  RUNNER,
  type RunResult,
  SpecifyInfraError,
  configWith,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The probe's name at the worktree root — the byte every case below must not leave. */
const PROBE = ".lean-runner-probe.test";
const TEST_REL = "tests/AC1-retry.test.sh";

/**
 * The runner stub committed to the base: it reports on the file it is handed and
 * exits 0, which is the preflight's "healthy" answer for an empty probe.
 *
 * It must report, not merely exit. The SAME template the preflight judges is what
 * the red proof runs over the child's submitted test, and the proof only counts a
 * non-zero exit whose output named that file: a stub that printed nothing would
 * have every submitted test graded `unclear` and dropped, and the
 * "healthy runner proceeds" cases below would then be about the stub rather than
 * about the step. The child's file is what fails — `redScript()` exits 1 and
 * echoes its own basename — so the runner stays what it is in a working project:
 * a reporter, not a verdict.
 */
function runnerScript(): string {
  // The verdict belongs to the FILE, so the runner propagates it: exit 0 for the
  // empty probe (the preflight's healthy answer, and pytest's `no tests collected`
  // exit is the other one the case below feeds by hand), and the file's own status
  // for everything else — which is how the child's red stays red under a runner
  // that reports rather than decides.
  return [
    "#!/bin/sh",
    'echo "runner: $1" 1>&2',
    '[ -s "$1" ] || exit 0',
    "exit 1",
    "",
  ].join("\n");
}

/** A runner that dies before collection the way pytest does: names nothing, exits 4. */
const BROKEN_RUNNER = '#!/bin/sh\necho "ImportError: no module named pytest" 1>&2\nexit 4\n';

/** The child's ordinary good work: one red test for AC1, declared. */
function writeRed(wt: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, TEST_REL), redScript(), { mode: 0o755 });
}

/** One case: a repo with `rel` committed, run through specify with `extra`. */
async function runWithProbe(
  issue: number,
  rel: string,
  script: string,
  extra: Record<string, unknown> = {},
): Promise<RunResult> {
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    [rel]: script,
  });
  return runSpecify({
    repoRoot,
    baseSha,
    issue,
    config: configWith({ fast: "true", test: `sh ${rel} {file}` }),
    writes: (wt) => {
      writeRed(wt);
    },
    toolUses: [submit("AC1", [TEST_REL])],
    ...extra,
  });
}

// ── (a) the runner exits 4 before collection: infrastructure, and no dispatch ─
{
  const r = await runWithProbe(31, "broken-runner.sh", BROKEN_RUNNER);
  assert(
    r.threw instanceof SpecifyInfraError,
    `(a) an exit-4 runner ends as infrastructure, not a verdict (got ${
      r.threw?.constructor.name ?? r.outcome?.kind
    })`,
  );
  assert(
    r.threw === undefined || r.threw.message.includes("sh broken-runner.sh"),
    `(a) the handback NAMES the rendered runner command (got ${r.threw?.message})`,
  );
  assert(
    r.threw === undefined || r.threw.message.includes("could not run a test file"),
    `(a) and says the runner could not run a test file (got ${r.threw?.message})`,
  );
  assert(
    r.threw === undefined || /exited 4/.test(r.threw.message),
    `(a) the excerpt carries the exit status the runner gave (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, `(a) the adversary was never dispatched (got ${r.dispatched})`);
  assert(
    r.deadDispatches === undefined,
    `(a) a preflight throw records no dispatch rows at all (got ${JSON.stringify(r.deadDispatches)})`,
  );
  assert(
    r.sawBaseHealthy === true,
    "(a) the base health check still ran — the preflight is its sibling, not its replacement",
  );
}

// ── (a2) exit 4 that NAMES the file: still infrastructure, because the status decides
{
  // A real pytest collection error echoes the path it could not collect, which
  // is exactly what `runTestFile` reads as a `red`. A preflight that asked the
  // classification instead of the status would call the bench's failure healthy.
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    "runner.sh": '#!/bin/sh\necho "ERROR collecting $1" 1>&2\nexit 4\n',
  });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 32,
    config: configWith({ fast: "true", test: "sh runner.sh {file}" }),
    writes: (wt) => {
      writeRed(wt);
    },
    toolUses: [submit("AC1", [TEST_REL])],
  });
  assert(
    r.threw instanceof SpecifyInfraError && /exited 4/.test(r.threw.message),
    `(a2) a naming exit 4 is infrastructure too (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(r.dispatched === 0, `(a2) and no adversary was paid (got ${r.dispatched})`);
}

// ── (b) a healthy runner proceeds to specify unchanged, at 0 and at pytest's 5
for (const status of [0, 5] as const) {
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    // The runner is healthy on whatever it is handed; the child's own file is a
    // real red because `redScript()` exits 1 and echoes its own basename.
    "runner.sh": runnerScript(),
  });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 33 + status,
    config: configWith({ fast: "true", test: "sh runner.sh {file}" }),
    writes: (wt) => {
      writeRed(wt);
    },
    toolUses: [submit("AC1", [TEST_REL])],
  });
  assert(
    r.threw === undefined,
    `(b/exit ${status}) a healthy runner does not hand back (${r.threw?.message})`,
  );
  assert(
    r.outcome?.kind === "ok",
    `(b/exit ${status}) the run proceeds to specify and freezes (got ${r.outcome?.kind})`,
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === TEST_REL,
    `(b/exit ${status}) the frozen set is the child's red test (got ${Object.keys(r.outcome?.frozen ?? {}).join()})`,
  );
  assert(r.dispatched === 1, `(b/exit ${status}) one dispatch (got ${r.dispatched})`);
}

// ── (c) the probe leaves no byte behind, on the pass path and on the throw path
{
  const ok = await runWithProbe(40, "runner.sh", runnerScript());
  assert(
    ok.threw === undefined && !existsSync(path.join(ok.worktree, PROBE)),
    `(c) the probe is gone after a healthy run (${ok.threw?.message ?? "clean"})`,
  );
  const bad = await runWithProbe(41, "broken-runner.sh", BROKEN_RUNNER);
  assert(
    bad.threw !== undefined && !existsSync(path.join(bad.worktree, PROBE)),
    "(c) and gone after the throw path too",
  );
  assert(
    bad.threw?.message.includes("could not run a test file") === true &&
      !existsSync(path.join(bad.worktree, PROBE)),
    "(c) the throw removed it from the tree it is describing",
  );
}

// ── (c2) a configured testDir: the probe sits OUTSIDE it, and the tree is clean
{
  // The boundary's location rule refuses a test outside `verify.testDir`; a probe
  // written INSIDE it would be an untracked file that rule (and the clean-tree
  // assertion) has to explain, and a runner that globs its folder would collect
  // it as one of the project's tests.
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    "runner.sh": runnerScript(),
  });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 42,
    config: {
      ...configWith({ fast: "true", test: "sh runner.sh {file}" }),
      verify: {
        fast: "true",
        test: "sh runner.sh {file}",
        testDir: "extension/smoke-tests",
        testGlob: "test-*.ts",
      },
    },
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, "extension/smoke-tests/test-AC1-retry.ts"), redScript(), {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["extension/smoke-tests/test-AC1-retry.ts"])],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(c2) the configured-location run still freezes (${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    !existsSync(path.join(r.worktree, "extension/smoke-tests", PROBE)),
    "(c2) the probe was not written inside the configured test directory",
  );
  assert(
    !existsSync(path.join(r.worktree, "extension", PROBE)),
    "(c2) and the folder outside it holds nothing after the run",
  );
}

// ── (d) a hanging probe is infrastructure under the injected bound
{
  // Without the injectable bound this case would cost the real two minutes and
  // a hung preflight would be unobservable — the same reason the red proof has
  // `testLimits`.
  const r = await runWithProbe(43, "runner.sh", "#!/bin/sh\nsleep 30\n", {
    preflightLimits: { timeoutMs: 300 },
  });
  assert(
    r.threw instanceof SpecifyInfraError && /killed or timed out/.test(r.threw.message),
    `(d) a hanging runner is infrastructure, not a wedged cycle (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(r.dispatched === 0, `(d) and it cost no dispatch (got ${r.dispatched})`);
}

// ── (e) no runner configured: the OLD verdict, the OLD wording, no dispatch
{
  // The preflight covers a CONFIGURED runner that fails. A project with no
  // `verify.test` keeps the refusal it has always given, in the same words —
  // otherwise the absence of a setting becomes an environment handback.
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 44,
    config: configWith({ fast: "true" }),
    writes: () => {},
    toolUses: [],
  });
  assert(
    r.threw === undefined,
    `(e) a missing runner is still a VERDICT, not infra (${r.threw?.message})`,
  );
  assert(
    r.outcome?.kind === "no-red-test" &&
      (r.outcome.failedRules ?? []).some((x) => x.includes("no test runner configured")),
    `(e) with its own rule unchanged (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(r.dispatched === 0, `(e) and nobody was dispatched (got ${r.dispatched})`);
}

// ── (f) the preflight precedes the dispatch even when the child would have failed
{
  // A child whose every file the boundary drops used to be the only way the
  // broken runner became visible. Now the probe answers first, so the step
  // hands back rather than billing an adversary for a verdict it cannot make.
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    "broken-runner.sh": BROKEN_RUNNER,
  });
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 45,
    config: configWith({ fast: "true", test: "sh broken-runner.sh {file}" }),
    prompts,
    writes: (wt) => {
      writeRed(wt);
    },
    toolUses: [submit("AC1", [TEST_REL])],
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(f) infrastructure rather than a decline (got ${r.threw?.constructor.name ?? r.outcome?.kind})`,
  );
  assert(prompts.length === 0, `(f) no prompt was ever built (got ${prompts.length})`);
  assert(
    r.threw !== undefined && /exited 4/.test(r.threw.message),
    `(f) the handback carries the status the runner gave (got ${r.threw?.message})`,
  );
  assert(
    r.threw?.message.includes("broken-runner.sh") === true,
    `(f) and names the command, not the probe file alone (got ${r.threw?.message})`,
  );
  assert(
    existsSync(path.join(r.worktree, TEST_REL)) === false,
    "(f) the run wrote no test bytes into the tree",
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
