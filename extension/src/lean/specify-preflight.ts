/**
 * lean/specify-preflight — ask the project's own runner ONE question before any
 * adversary is paid: can it run a test file at all?
 *
 * The step's refusal vocabulary cannot answer this. A runner that dies before collection — an empty git
 * submodule a test imports from, a suite needing an env var this tree lacks — prints nothing naming the
 * file, so the red proof classifies the run `unclear` and the step declines with `criterion ACn has no red
 * test`: a VERDICT about work the toolchain never judged, blaming the adversary for the environment.
 *
 * So the step asks the runner directly, once, before the first dispatch:
 *
 *   - the configured `verify.test` template, rendered with the path of an EMPTY probe under the worktree;
 *   - executed by `runTestFile` in its own process group, so a hang is a kill and a kill is infrastructure —
 *     the classifier the red proof uses;
 *   - exit 0, or pytest's "collected 0 items" (5), is healthy: the runner started, parsed the file and
 *     reached the point where it reports on tests. Any other status, a kill, a flood, or a runner that never
 *     started is a `SpecifyInfraError` naming the rendered command and a bounded excerpt. Deliberately no
 *     per-runner detection or exception table: the exit status alone decides.
 *
 * TWO shapes, one per language family, because the probe's NAME is part of whether a runner can read it at
 * all:
 *
 *   - the original: `.lean-runner-probe.test` at the worktree root, or just outside a configured
 *     `verify.testDir`. Hidden, so no `testGlob` (none may start with `.`) mistakes it for an acceptance
 *     test; extensionless, so extension-keyed runners ignore it. Right for every family except Python.
 *   - Python's: `_lean_runner_probe.py` INSIDE the configured `verify.testDir`, or at the root where none is
 *     on the tree. A hidden file cannot be IMPORTED — pytest's default prepend import mode dies on the dot.
 *     The stem is dot-free, visible, and checked against the project's OWN `testGlob` with the boundary's
 *     matcher, so it can never be collected as one of the project's tests.
 *
 * The two shape switches sit apart from `runner-preflight-switch.ts`, which decides whether a probe runs.
 *
 * It costs one runner invocation and no model call, and the probe is removed on every path — including the
 * throw. The retry does NOT re-probe: a runner that broke between attempts is caught by the shared
 * pipeline's per-file infra throw (`assertRan`).
 *
 * `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` returns before any of it; the whole check lives here so the switch
 * has one gate to close. An empty git submodule is one shape this catches, fixed where caused:
 * `initSubmodules`, behind the same switch.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import type { TestLocation } from "./config-test-location.ts";
import { globMatches, globNamesPythonFiles } from "./config-test-location.ts";
import { leanPreflightProbeContainEnabled } from "./preflight-probe-switch.ts";
import { leanRunnerPreflightEnabled } from "./runner-preflight-switch.ts";
import { probeRejected, probeWrite, removeProbe } from "./specify-preflight-write.ts";
import type { Proof, TestRunLimits } from "./specify-proof.ts";
import { runTestFile, trim } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";

/** Exit status 5 is pytest's "collected 0 items": a runner that ran and found nothing. */
const PYTEST_NO_TESTS = 5;

/**
 * pytest's "no collector for this file / no such file". It says nothing about the BENCH and, about the
 * PROBE, that the runner refused the name it was handed — see {@link PROBE_REJECTED}.
 */
const PYTEST_NO_COLLECTOR = 4;

/**
 * What this probe accepts, and nothing else. Both say the runner started, parsed the file and reported on it
 * — 0 is "ran, nothing to say", 5 is pytest's "collected 0 items". The status decides, NOT the proof's
 * classification: `runTestFile` calls a non-zero exit that named the file `red`, and a pytest collection error
 * prints the file it could not collect, so the very failure this probe exists to catch would arrive classified
 * red. Nothing here speaks of the runner's flavour — only which exit statuses mean "nothing was judged".
 */
function probeHealthy(proof: Proof): boolean {
  return proof.kind === "green" || (proof.kind !== "infra" && proof.code === PYTEST_NO_TESTS);
}

/** How long one probe run gets; the same bound one red proof gets. */
const PROBE_TIMEOUT_MS = 120_000;

/** The probe file's name — hidden, so no `testGlob` (none may start with `.`) matches it. */
const PROBE_BASENAME = ".lean-runner-probe.test";

/**
 * A Python project's probe: visible, dot-free, ending in the extension pytest collects. Underscore-prefixed
 * because pytest's defaults collect `test_*.py` and `*_test.py` and this names neither — the glob check below
 * is what makes that a check rather than a hope.
 */
const PY_PROBE_BASENAME = "_lean_runner_probe.py";

/**
 * The probe's worktree-relative path, the placement it chose, and why it sits there.
 *
 * Two facts must hold at once: the probe is not mistaken for an acceptance test, and writing it does not
 * change the tree — no directory created, nothing left for the clean-tree assertion or the acceptance-test
 * commit to explain.
 *
 * The root satisfies both whatever the config says, and the hidden name needs no further check because
 * `validateTestGlob` refuses a pattern starting with `.`. A project whose tests live in a SUBDIRECTORY
 * already has a directory free of the constraint — `testDir`'s parent — and the config vouches it exists;
 * the preflight confirms it on the tree, since an uncreated directory is an untracked byte the step must
 * then account for. A parent not on the tree falls back to the root.
 *
 * A Python probe sits INSIDE `testDir` instead, since a runner that must import the file must be pointed at
 * a real one. It is checked against the project's own pattern: a repo whose `testGlob` matches
 * `_lean_runner_probe.py` would collect the probe as one of its tests, so this refuses rather than writing
 * a probe the CI would grade.
 *
 * `py` is reported here and read nowhere else: the reading of exit 4 is a fact about the NAME the probe ends
 * up carrying, so it is decided once, at placement — see {@link runProbeAt}.
 */
function probeRelative(wt: string, testLocation?: TestLocation): { rel: string; py: boolean } {
  // The boundary's own matcher, so "would this project's CI collect the probe?" is answered by the same
  // predicate that refuses a submitted test for it. It names the placement ACTUALLY chosen — "to the root"
  // and "inside the folder" are different diagnoses for an operator reading the refusal.
  const refuses = (loc: TestLocation, dir: string): void => {
    if (!globMatches(loc.testGlob, PY_PROBE_BASENAME)) return;
    throw new SpecifyInfraError(
      `the runner preflight has no probe name this project's CI would collect: ${PY_PROBE_BASENAME} ` +
        `matches .pi/work.json verify.testGlob (${loc.testGlob}) in ${dir}/`,
    );
  };
  if (testLocation !== undefined) {
    if (globNamesPythonFiles(testLocation.testGlob)) {
      // A Python probe has to be a file the runner can IMPORT, so it goes INSIDE the folder —
      // at the root only when that folder is not on the tree at all.
      const inside = existsSync(path.join(wt, testLocation.testDir));
      const dir = inside ? testLocation.testDir : ".";
      refuses(testLocation, dir);
      return {
        rel: inside ? `${testLocation.testDir}/${PY_PROBE_BASENAME}` : PY_PROBE_BASENAME,
        py: true,
      };
    }
    const parent = path.posix.dirname(testLocation.testDir);
    if (parent !== "." && !existsSync(path.join(wt, parent))) refuses(testLocation, ".");
  }
  if (testLocation === undefined) return { rel: PROBE_BASENAME, py: false };
  const parent = path.posix.dirname(testLocation.testDir);
  if (parent === ".") return { rel: PROBE_BASENAME, py: false };
  return existsSync(path.join(wt, parent))
    ? { rel: `${parent}/${PROBE_BASENAME}`, py: false }
    : { rel: PROBE_BASENAME, py: false };
}

/**
 * The probe's parent directory, only if it is really a directory OF THIS WORKTREE.
 *
 * `verify.testDir` is validated as a shape and trusted as a location, and a shape cannot say whether the
 * directory the base committed is a symlink outside the checkout. `realpath` can: both sides resolve, so a
 * link landing outside `realpath(worktree)` is refused and the probe goes to the root, which is
 * containment-checked the same way. The worktree root is the one thing this step created, so an unresolvable
 * root is infrastructure, not a question for the runner.
 *
 * The probe's NAME is part of what this returns, not just its directory: a configured folder that fails the
 * check falls back to the root's hidden extensionless probe whatever the config asked for.
 */
function containedParent(
  wt: string,
  placed: { rel: string; py: boolean },
): {
  rel: string;
  py: boolean;
} {
  if (!leanPreflightProbeContainEnabled()) return placed;
  const root = real(wt);
  // The directory the write actually goes into, resolved through every link of its own — `realpath` on the
  // parent NAME, not a path rebuilt from the configured string, since the link this catches sits at that name.
  const dir = real(path.dirname(path.join(wt, placed.rel)));
  if (root !== "" && dir !== "" && within(root, dir)) return placed;
  // Anywhere outside this worktree is no place for the probe. The root is the one directory the step made,
  // so a probe whose folder fails falls back to it — and an unresolvable root leaves nowhere to fall back.
  const rootOk = root !== "" && within(root, real(path.dirname(path.join(wt, PROBE_BASENAME))));
  if (!rootOk)
    throw new SpecifyInfraError(
      `the runner preflight could not place its probe inside the worktree: ${wt} does not contain its own root`,
    );
  // The hidden root name and `py: false`: the file actually written carries no `.py`, so pytest's "no
  // collector" would be true about it.
  return { rel: PROBE_BASENAME, py: false };
}

/** `realpathSync`, "" when it cannot be resolved — the caller decides what absence means. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return "";
  }
}

/** Is `target` `root` itself or below it? Compares realpaths, so `..` cannot escape. */
function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Can the project's runner run a test file at all?
 *
 * THROWS `SpecifyInfraError` before any dispatch when it cannot, naming the rendered command and what the
 * runner printed. Returns the disclosure note when the runner ran and REJECTED the probe itself (pytest's
 * exit 4, collectable name on): the bench is healthy, the probe was the thing refused, and a run must not be
 * billed an infrastructure failure for the step's choice of filename.
 */
export async function assertRunnerCanRunTests(
  exec: ExecFn,
  opts: {
    wt: string;
    template: string;
    /** The configured test folder, so the probe is placed where it can be imported. */
    testLocation?: TestLocation;
    limits?: TestRunLimits;
  },
  /** Test-only override of the run call, so a case can make the RUN itself raise. */
  seams: { runFile?: RunProbeFile } = {},
): Promise<string | undefined> {
  // The switch's ONE gate: off, the probe is never written and the runner never asked, so none of this
  // file's throws are reachable. Read at call time.
  if (!leanRunnerPreflightEnabled()) return;
  // One placement decision, then ONE sequence: write, run, classify, remove. Placement and the READING of a
  // 4 are decided together — both are facts about the name the probe carries — so it is decided once here.
  const placed = probeRelative(opts.wt, opts.testLocation);
  return runProbeAt(exec, opts, containedParent(opts.wt, placed), seams);
}

/** The run call's shape, so a case can substitute one that raises. */
export type RunProbeFile = (file: string) => Promise<Proof>;

/**
 * The whole probe sequence for one worktree-relative path: refuse a dirty name, write empty,
 * run the template, classify, and remove the file on every path.
 *
 * The `try` opens as soon as the bytes exist. A `finally` that starts after the runner call
 * leaves a throw from the run itself with the probe sitting in the worktree, and "removed on
 * every path" is the claim this step makes about a tree it does not own. `seams.runFile` exists
 * so that claim is observable: {@link runTestFile} never throws by contract and folds every exec
 * rejection into a classified `Proof`, so no rejection an exec can produce reaches this `finally`.
 */
async function runProbeAt(
  exec: ExecFn,
  opts: { wt: string; template: string; limits?: TestRunLimits },
  placed: { rel: string; py: boolean },
  seams: { runFile?: RunProbeFile },
): Promise<string | undefined> {
  const { rel, py: pyProbe } = placed;
  probeWrite(opts.wt, rel);
  try {
    const proof = await (seams.runFile?.(rel) ??
      runTestFile(exec, {
        wt: opts.wt,
        template: opts.template,
        file: rel,
        limits: opts.limits ?? { timeoutMs: PROBE_TIMEOUT_MS },
      }));
    if (probeHealthy(proof)) return;
    // The reading is a fact about the PROBE's name, so it belongs to the probe that carries
    // the collectable name: `pyProbe` is the answer for the name actually written.
    if (pyProbe && proof.kind !== "infra" && proof.code === PYTEST_NO_COLLECTOR)
      return probeRejected(proof);
    throw new SpecifyInfraError(
      `the test runner could not run a test file: ${proof.cmd} — ${trim(proof.detail)}`,
    );
  } finally {
    removeProbe(opts.wt, rel);
  }
}
