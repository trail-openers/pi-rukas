#!/usr/bin/env bun
/**
 * lean/specify — the runner preflight's OFF arm, `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0`.
 *
 * `test-lean-specify-preflight.ts` pins the probe itself: what it asks, what it
 * accepts, what it hands back. This file pins the switch that removes it, which is
 * #2212's actual promise — that with the variable at `0` none of
 * `specify-preflight.ts`'s three throw sites can be reached, and the run is judged by
 * the red proof alone exactly as v0.14.71 judged it.
 *
 * Split from that file for the 500-line gate (AGENTS §12): same fixture, same stubbed
 * `#!/bin/sh` runner, and the same three repos the on arm hands back on.
 *
 *   (h1) the exit-4 runner (a)/(f)'s hand-back -> no throw, no probe byte, and the
 *        run DECLINES on v0.14.71's rule rather than handing back at 10;
 *   (h2) a symlink at the probe path (g)'s refusal -> no throw, and the link's target
 *        outside the worktree still holds its own bytes;
 *   (h3) a hanging probe (d)'s hand-back -> no throw, no sleep, and the run freezes
 *        the red test the probe would have blocked, with the switch-on control below
 *        proving the same runner does block it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import {
  ROOTS,
  SpecifyInfraError,
  configWith,
  git,
  makeRepo,
  outsideDir,
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

/** The probe's name at the worktree root — the byte no case here may leave. */
const PROBE = ".lean-runner-probe.test";
const TEST_REL = "tests/AC1-retry.test.sh";

/** A runner that dies before collection the way pytest does: names nothing, exits 4. */
const BROKEN_RUNNER = '#!/bin/sh\necho "ImportError: no module named pytest" 1>&2\nexit 4\n';

/**
 * A runner that hangs on the probe's EMPTY file and reports properly on any other.
 *
 * The hang is keyed on the probe's own basename, not on the runner being broken: a
 * real test prints the naming red the proof requires and exits with the file's own
 * status. Keying on emptiness would not do — the probe is empty AND so is every
 * child's test before it is written to disk — and a runner that hung on EVERY file
 * would have hung the red proof too, making the off arm a hand-back from the
 * pipeline's own `assertRan`: a case asserting the switch removed something it does
 * not remove.
 */
const HANGING_ON_PROBE_RUNNER =
  '#!/bin/sh\necho "runner: $1" 1>&2\ncase "$1" in *lean-runner-probe*) sleep 30;; esac\nexit 1\n';

/** A repo carrying `HANGING_ON_PROBE_RUNNER` at `runner.sh`, plus the subject. */
function makeHangingRunnerRepo(): { repoRoot: string; baseSha: string } {
  return makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    "runner.sh": HANGING_ON_PROBE_RUNNER,
  });
}

/** The child's ordinary good work: one red test for AC1, declared. */
function writeRed(wt: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, TEST_REL), redScript(), { mode: 0o755 });
}

/** One case: a repo with `rel` committed, run through specify with `extra`. */
async function runWithRunner(
  issue: number,
  rel: string,
  script: string,
  extra: Record<string, unknown> = {},
) {
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

// ── none of this module's three throws can be reached with the switch at 0
{
  // The off arm of every throw site in `specify-preflight.ts`, not one of them. The
  // three are the shapes the on arm's cases (a), (d) and (g) hand back on; with
  // `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` the same three repos must run to a freeze,
  // because v0.14.71 had nothing between the base health check and the red proof.
  // The red proof is NOT switched, so a run whose submitted file is un-judgeable
  // still ends as infra here — the off arm removes a check, it does not add a
  // verdict. That is why these children submit a naming, exiting script rather than
  // the broken runner: under v0.14.71's rules THAT is the red.
  //
  // `withEnv` deletes the variable again rather than setting "", and pins it for the
  // whole block so no case below (or above) can be run under a leaked "0".
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    // (h1) the exit-4 runner the on arm hands back on. Off, the probe is never
    // WRITTEN — so the only runner invocation this step makes is the red proof's, on
    // the child's own file, and that one exits 0 because `redScript()` is empty at the
    // base. That is the honest v0.14.71 outcome for this repo: the step DECLINES
    // (`criterion AC1 has no red test`), it does not hand back and it does not bill an
    // adversary beyond the one the release billed.
    const broken = await runWithRunner(147, "broken-runner.sh", BROKEN_RUNNER);
    assert(
      broken.threw === undefined,
      `(h1) an exit-4 runner is nobody's hand-back with the switch at 0 (${broken.threw?.message ?? "clean"})`,
    );
    assert(
      broken.outcome?.kind === "no-red-test",
      `(h1) the run is judged by the red proof alone, as v0.14.71 judged it (got ${broken.outcome?.kind ?? broken.threw?.message})`,
    );
    assert(
      (broken.outcome?.failedRules ?? []).some((x) => x.includes("criterion AC1 has no red test")),
      `(h1) and declines with v0.14.71's rule (got ${JSON.stringify(broken.outcome?.failedRules)})`,
    );
    assert(
      broken.dispatched === 1,
      `(h1) and it dispatched the adversary v0.14.71 would have dispatched (got ${broken.dispatched})`,
    );
    assert(!existsSync(path.join(broken.worktree, PROBE)), "(h1) no probe file was ever written");

    // (h2) a probe path the base carries as a symlink: (g)'s throw site.
    const outside = outsideDir();
    const victim = path.join(outside, "victim-off.txt");
    writeFileSync(victim, "bytes the step must never write through\n");
    const linked = (() => {
      const dir = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" }).repoRoot;
      rmSync(path.join(dir, PROBE), { force: true });
      symlinkSync(victim, path.join(dir, PROBE));
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base carrying the probe path as a symlink");
      return { repoRoot: dir, baseSha: git(dir, "rev-parse", "HEAD") };
    })();
    const link = await runSpecify({
      repoRoot: linked.repoRoot,
      baseSha: linked.baseSha,
      issue: 148,
      config: configWith({ fast: "true", test: "sh runner.sh {file}" }),
      writes: (wt) => {
        writeRed(wt);
      },
      toolUses: [submit("AC1", [TEST_REL])],
    });
    assert(
      link.threw === undefined,
      `(h2) a symlink at the probe path is not a refusal with the switch at 0 (${link.threw?.message ?? "clean"})`,
    );
    assert(
      readFileSync(victim, "utf8") === "bytes the step must never write through\n",
      "(h2) and the link's target outside the worktree still holds its own bytes",
    );

    // (h3) a runner that hangs: (d)'s throw site, under the same injected bound. With
    // the switch at 0 nothing sleeps at all: the probe is never written nor run, so
    // the step's only runner call is the red proof's and the run freezes.
    const hanging = makeHangingRunnerRepo();
    const hung = await runSpecify({
      repoRoot: hanging.repoRoot,
      baseSha: hanging.baseSha,
      issue: 149,
      config: configWith({ fast: "true", test: "sh runner.sh {file}" }),
      preflightLimits: { timeoutMs: 300 },
      writes: (wt) => {
        writeRed(wt);
      },
      toolUses: [submit("AC1", [TEST_REL])],
    });
    assert(
      hung.threw === undefined,
      `(h3) a hanging probe is nobody's hand-back with the switch at 0 (${hung.threw?.message ?? "clean"})`,
    );
    assert(
      hung.outcome?.kind === "ok",
      `(h3) and the run freezes the red test the probe would have blocked (got ${hung.outcome?.kind ?? hung.threw?.message})`,
    );
    assert(
      hung.dispatched === 1,
      `(h3) the adversary ran without ever being probed (got ${hung.dispatched})`,
    );
  });

  // The control for (h3), OUTSIDE the block above: the same runner, switch on, so
  // that arm is about the switch and not about a runner that never hangs. Deleting
  // the gate's `return` makes (h3) red and leaves this one green; moving (h3) out of
  // its `withEnv` makes this green and (h3) red, which is why the two are separated.
  const hangingOn = makeHangingRunnerRepo();
  const on = await runSpecify({
    repoRoot: hangingOn.repoRoot,
    baseSha: hangingOn.baseSha,
    issue: 150,
    config: configWith({ fast: "true", test: "sh runner.sh {file}" }),
    preflightLimits: { timeoutMs: 300 },
    writes: (wt) => {
      writeRed(wt);
    },
    toolUses: [submit("AC1", [TEST_REL])],
  });
  assert(
    on.threw instanceof SpecifyInfraError && /killed or timed out/.test(on.threw.message),
    `(h3/ON) the same runner does hand back with the switch on (${on.threw?.constructor.name ?? on.outcome?.kind})`,
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
