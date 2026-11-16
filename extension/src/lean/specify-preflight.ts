/**
 * lean/specify-preflight — ask the project's own runner ONE question before any
 * adversary is paid: can it run a test file at all?
 *
 * The step's refusal vocabulary cannot answer this. A runner that dies before
 * collection — pytest's exit 4, an empty git submodule a test imports from, a suite
 * needing an environment variable this tree lacks — prints nothing that names the
 * file, so the red proof classifies the run `unclear` and the step declines with
 * `criterion ACn has no red test`: a VERDICT about work the toolchain never judged,
 * blaming the adversary for the environment.
 *
 * So the step asks the runner directly, once, before the first dispatch:
 *
 *   - the configured `verify.test` template, rendered with the path of an EMPTY test
 *     file written under the worktree root and outside any configured
 *     `verify.testDir`, so the probe cannot be mistaken for an acceptance test;
 *   - executed by `runTestFile` with its own process group, so a hang is a kill and a
 *     kill is infrastructure — the same classifier the red proof uses;
 *   - exit 0, or pytest's "collected 0 items" (5), is healthy: the runner started,
 *     parsed the file and reached the point where it reports on tests. Any other
 *     status, a kill, an output flood, or a runner that never started is a
 *     `SpecifyInfraError` naming the rendered command and a bounded excerpt. There is
 *     deliberately no runner-specific detection or exception table: the exit status
 *     alone decides.
 *
 * It costs one runner invocation and no model call, and the probe file is removed on
 * every path — including the throw. The retry does NOT re-probe: a runner that broke
 * between attempts is caught by the shared pipeline's per-file infra throw
 * (`assertRan`).
 *
 * `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` returns before any of it. The whole check
 * lives here so the switch has exactly one gate to close. An empty git submodule is
 * one of the shapes this catches, fixed where it is caused: `initSubmodules` in
 * `specify-reset.ts`, behind the same switch.
 */

import { existsSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import type { TestLocation } from "./config-test-location.ts";
import { leanRunnerPreflightEnabled } from "./runner-preflight-switch.ts";
import type { Proof, TestRunLimits } from "./specify-proof.ts";
import { runTestFile, trim } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";

/** Exit status 5 is pytest's "collected 0 items": a runner that ran and found nothing. */
const PYTEST_NO_TESTS = 5;

/**
 * The two statuses this probe accepts, and nothing else.
 *
 * Both say the runner started, parsed the file and reported on it — 0 meaning "ran,
 * nothing to say", 5 meaning pytest's "collected 0 items". The status decides, NOT the
 * proof's classification: `runTestFile` calls a non-zero exit that named the file
 * `red`, and a pytest collection error prints the file it could not collect, so the
 * very failure this probe exists to catch arrives as a `red`. Nothing here speaks of
 * the runner's flavour — only which exit statuses mean "nothing was judged".
 */
function probeHealthy(proof: Proof): boolean {
  return proof.kind === "green" || (proof.kind !== "infra" && proof.code === PYTEST_NO_TESTS);
}

/** How long one probe run gets; the same bound one red proof gets. */
const PROBE_TIMEOUT_MS = 120_000;

/** The probe file's name — hidden, so no `testGlob` (none may start with `.`) matches it. */
const PROBE_BASENAME = ".lean-runner-probe.test";

/** A probe file the runner can parse and collect nothing from, in any language. */
const PROBE_CONTENT = "";

/**
 * The probe's worktree-relative path, and why it sits there.
 *
 * Two facts must hold at once: the probe must not be mistaken for an acceptance test
 * (so it is hidden, and no `testGlob` may start with `.`), and writing it must not
 * change the tree — no directory created, nothing left behind for the clean-tree
 * assertion or the acceptance-test commit to explain. The worktree root satisfies
 * both whatever the config says.
 *
 * A project whose tests live in a SUBDIRECTORY has a directory free of that
 * constraint already — `testDir`'s parent — and the config vouches it exists, since
 * every frozen acceptance test sits under it. The preflight confirms it on the tree
 * rather than trusting the config: no `mkdir`, because an uncreated directory would
 * be an untracked byte the step then accounts for. A parent not on the tree falls
 * back to the root.
 */
function probeRelative(wt: string, testLocation?: TestLocation): string {
  if (testLocation === undefined) return PROBE_BASENAME;
  const parent = path.posix.dirname(testLocation.testDir);
  if (parent === ".") return PROBE_BASENAME;
  return existsSync(path.join(wt, parent)) ? `${parent}/${PROBE_BASENAME}` : PROBE_BASENAME;
}

/**
 * Is `abs` an ordinary file this probe may claim (rather than a link, dir or fifo)?
 *
 * `lstat`, never `stat`: the question is what sits AT the name, not what the name
 * resolves to. The link is refused by name rather than by inference —
 * `isSymbolicLink()` before `isFile()` — because this is the step's own rule, not
 * the platform's: a base-carried symlink at the probe path is never written
 * through, whatever `open(2)` with `wx` would have happened to do with it.
 */
function isPlainProbe(abs: string): boolean {
  try {
    const st = lstatSync(abs);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

/**
 * Can the project's runner run a test file at all?
 *
 * THROWS `SpecifyInfraError` before any dispatch when it cannot, naming the
 * rendered command and what the runner printed. Returns nothing when the runner
 * exited 0 or 5.
 */
export async function assertRunnerCanRunTests(
  exec: ExecFn,
  opts: {
    wt: string;
    template: string;
    /** The configured test folder, so the probe is written outside it. */
    testLocation?: TestLocation;
    limits?: TestRunLimits;
  },
): Promise<void> {
  // The switch's ONE gate: off, the probe is never written and the runner is
  // never asked, so none of this file's three throws can be reached. Read at call
  // time — see `runner-preflight-switch.ts`.
  if (!leanRunnerPreflightEnabled()) return;
  const rel = probeRelative(opts.wt, opts.testLocation);
  const abs = path.join(opts.wt, rel);
  // Written and read by name, never followed: the step owns the worktree's
  // bytes, and a name the base already carries as a link or a directory is not
  // a place to put a probe — nor is it a probe the runner would run.
  if (existsSync(abs) && !isPlainProbe(abs)) {
    throw new SpecifyInfraError(
      `the runner preflight could not write its probe file: ${rel} already exists in ${opts.wt} and is not a plain file`,
    );
  }
  try {
    writeFileSync(abs, PROBE_CONTENT, { flag: "wx", mode: 0o644 });
  } catch (err) {
    throw new SpecifyInfraError(
      `the runner preflight could not write its probe file: ${(err as Error).message}`,
    );
  }
  const proof = await runTestFile(exec, {
    wt: opts.wt,
    template: opts.template,
    file: rel,
    limits: opts.limits ?? { timeoutMs: PROBE_TIMEOUT_MS },
  });
  try {
    // ONE rule, no per-runner table: an empty file must not be what the runner dies
    // on. Healthy is exit 0 — a runner that ran the file and found nothing to say — or
    // exit 5, pytest's "collected 0 items". Any other outcome — the collection error that
    // exits 4, the kill of a hung runner, the flood, the runner that never started —
    // observed nothing, and the step must not spend an adversary on a toolchain that
    // cannot answer.
    if (probeHealthy(proof)) return;
    throw new SpecifyInfraError(
      `the test runner could not run a test file: ${proof.cmd} — ${trim(proof.detail)}`,
    );
  } finally {
    // Every path, throw included: a probe left in the tree is an untracked byte the
    // reset's clean-tree assertion and the acceptance-test commit both have to explain.
    if (existsSync(abs)) {
      try {
        unlinkSync(abs);
      } catch {
        /* the reset's `clean -fdx` removes it whatever happens here */
      }
    }
  }
}
