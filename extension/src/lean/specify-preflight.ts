/**
 * lean/specify-preflight — ask the project's own runner ONE question before any
 * adversary is paid: can it run a test file at all?
 *
 * The step's refusal vocabulary cannot answer this. A runner that dies before
 * collection — an empty git submodule a test imports from, a suite needing an
 * environment variable this tree lacks — prints nothing that names the file, so the
 * red proof classifies the run `unclear` and the step declines with `criterion ACn
 * has no red test`: a VERDICT about work the toolchain never judged, blaming the
 * adversary for the environment.
 *
 * So the step asks the runner directly, once, before the first dispatch:
 *
 *   - the configured `verify.test` template, rendered with the path of an EMPTY
 *     probe file written under the worktree;
 *   - executed by `runTestFile` with its own process group, so a hang is a kill and
 *     a kill is infrastructure — the same classifier the red proof uses;
 *   - exit 0, or pytest's "collected 0 items" (5), is healthy: the runner started,
 *     parsed the file and reached the point where it reports on tests. Any other
 *     status, a kill, an output flood, or a runner that never started is a
 *     `SpecifyInfraError` naming the rendered command and a bounded excerpt. There
 *     is deliberately no per-runner detection or exception table: the exit status
 *     alone decides.
 *
 * TWO shapes, one per language family, because the probe's NAME is part of whether
 * a runner can read it at all (`PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_COLLECTABLE`):
 *
 *   - the original: `.lean-runner-probe.test` at the worktree root, or just outside
 *     a configured `verify.testDir`. Hidden, so no `testGlob` (none may start with
 *     `.`) can mistake it for an acceptance test; extensionless, so a runner that
 *     keys off extension ignores it. Right for every family except Python.
 *   - a Python project's: `_lean_runner_probe.py` INSIDE the configured
 *     `verify.testDir`, or at the root where no such directory is on the tree. A
 *     hidden file cannot be IMPORTED — pytest's default prepend import mode dies on
 *     the leading dot — so the dotfile probe was refused by every pytest repo for a
 *     reason that was the probe's own name, not the project's toolchain. The stem is
 *     dot-free and visible, and is checked against the project's OWN `testGlob` with
 *     the boundary's matcher, so the probe can never be collected as one of the
 *     project's tests.
 *
 * The two switches that govern the shapes (`preflight-probe-switch.ts`) sit apart
 * from `runner-preflight-switch.ts`, which decides whether a probe runs at all:
 * these change what it looks like and what one answer means, and each `0` restores
 * the shipped behaviour without losing the preflight.
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

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import type { TestLocation } from "./config-test-location.ts";
import { globMatches, globNamesPythonFiles } from "./config-test-location.ts";
import {
  leanPreflightProbeCollectableEnabled,
  leanPreflightProbeContainEnabled,
} from "./preflight-probe-switch.ts";
import { leanRunnerPreflightEnabled } from "./runner-preflight-switch.ts";
import { probeRejected, probeWrite, removeProbe } from "./specify-preflight-write.ts";
import type { Proof, TestRunLimits } from "./specify-proof.ts";
import { runTestFile, trim } from "./specify-proof.ts";
import { SpecifyInfraError } from "./specify-reset.ts";

/** Exit status 5 is pytest's "collected 0 items": a runner that ran and found nothing. */
const PYTEST_NO_TESTS = 5;

/**
 * pytest's "no collector for this file / no such file". What it says about the
 * BENCH is nothing; what it says about the PROBE is that the runner refused the
 * name it was handed — see {@link PROBE_REJECTED}.
 */
const PYTEST_NO_COLLECTOR = 4;

/**
 * What this probe accepts, and nothing else.
 *
 * Both say the runner started, parsed the file and reported on it — 0 meaning "ran,
 * nothing to say", 5 meaning pytest's "collected 0 items". The status decides, NOT
 * the proof's classification: `runTestFile` calls a non-zero exit that named the
 * file `red`, and a pytest collection error prints the file it could not collect, so
 * the very failure this probe exists to catch arrives as a `red`. Nothing here
 * speaks of the runner's flavour — only which exit statuses mean "nothing was
 * judged".
 */
function probeHealthy(proof: Proof): boolean {
  return proof.kind === "green" || (proof.kind !== "infra" && proof.code === PYTEST_NO_TESTS);
}

/** How long one probe run gets; the same bound one red proof gets. */
const PROBE_TIMEOUT_MS = 120_000;

/** The probe file's name — hidden, so no `testGlob` (none may start with `.`) matches it. */
const PROBE_BASENAME = ".lean-runner-probe.test";

/**
 * A Python project's probe: visible, dot-free, and ending in the extension pytest
 * collects. Underscore-prefixed because pytest's own defaults collect `test_*.py`
 * and `*_test.py` and this names neither; the glob check below is what makes that
 * argument a check rather than a hope.
 */
const PY_PROBE_BASENAME = "_lean_runner_probe.py";

/** A probe file the runner can parse and collect nothing from, in any language. */
const PROBE_CONTENT = "";

/**
 * The probe's worktree-relative path, and why it sits there.
 *
 * Two facts must hold at once: the probe must not be mistaken for an acceptance
 * test, and writing it must not change the tree — no directory created, nothing
 * left behind for the clean-tree assertion or the acceptance-test commit to explain.
 *
 * The root satisfies both whatever the config says, and the hidden name needs no
 * further check because `validateTestGlob` refuses a pattern that starts with `.`.
 * A project whose tests live in a SUBDIRECTORY has a directory free of the
 * constraint already — `testDir`'s parent — and the config vouches it exists, since
 * every frozen acceptance test sits under it; the preflight confirms it on the tree
 * rather than trusting the config, because an uncreated directory would be an
 * untracked byte the step then has to account for. A parent not on the tree falls
 * back to the root.
 *
 * A Python project's probe sits INSIDE `testDir` instead, since a runner that has
 * to import the file has to be pointed at a real one. It is therefore checked
 * against the project's own pattern: a repo whose `testGlob` matches
 * `_lean_runner_probe.py` would have the runner collect the probe as one of its
 * tests, so this refuses rather than writing a probe the CI would grade.
 */
function probeRelative(
  wt: string,
  testLocation?: TestLocation,
): { rel: string; py: boolean } {
  // The boundary's own matcher, so "would this project's CI collect the probe?" is
  // answered by the same predicate that refuses a submitted test for it — and asked
  // wherever the probe would go, since a name the CI grades is refused whether it
  // sits in the folder or at the root.
  const refuses = (loc: TestLocation, dir: string): void => {
    if (!globMatches(loc.testGlob, PY_PROBE_BASENAME)) return;
    throw new SpecifyInfraError(
      `the runner preflight has no probe name this project's CI would collect: ${PY_PROBE_BASENAME} ` +
        `matches .pi/work.json verify.testGlob (${loc.testGlob}) in ${dir}/`,
    );
  };
  if (leanPreflightProbeCollectableEnabled() && testLocation !== undefined) {
    if (globNamesPythonFiles(testLocation.testGlob)) {
      // A Python probe has to be a file the runner can IMPORT, so it goes INSIDE
      // the folder — at the root only when that folder is not on the tree at all.
      const inside = existsSync(path.join(wt, testLocation.testDir));
      refuses(testLocation, inside ? testLocation.testDir : ".");
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
  return {
    rel: existsSync(path.join(wt, parent)) ? `${parent}/${PROBE_BASENAME}` : PROBE_BASENAME,
    py: false,
  };
}

/**
/**
 * The probe's parent directory, only if it is really a directory OF THIS WORKTREE.
 *
 * `verify.testDir` is validated as a shape and trusted as a location, and a shape
 * cannot say whether the directory the base committed is a symlink pointed outside
 * the checkout. `realpath` can: both sides are resolved, so a link — of the folder,
 * or of any ancestor — that lands outside `realpath(worktree)` is refused, and the
 * probe goes to the root instead, which is containment-checked the same way. The
 * worktree's own root is the one thing this step created, so a root that cannot be
 * resolved or cannot contain its own probe is infrastructure rather than a
 * question to ask the runner.
 *
 * Returns "" for "use the root": a configured parent that fails the check falls
 * back rather than handing back, because a project whose test folder is a link
 * outside the tree still has a root this step owns.
 */
function containedParent(wt: string, rel: string): string {
  if (!leanPreflightProbeContainEnabled()) return rel;
  const parent = path.posix.dirname(rel);
  const root = real(wt);
  // The directory the write would actually go into, resolved through every link of
  // its own. `realpath` on the parent NAME — not on a path rebuilt from the
  // configured string — because the link this check exists to catch sits exactly at
  // that name, and joining the name back onto a resolved root would resolve the
  // root and then trust the link.
  const dir = real(path.dirname(path.join(wt, rel)));
  if (root !== "" && dir !== "" && within(root, dir)) return rel;
  // Anywhere outside this worktree is no place for the probe. The worktree root is
  // the one directory the step made itself, so a probe whose folder fails the check
  // falls back to it — and a root that cannot even be resolved leaves nowhere to
  // fall back to, which is infrastructure naming the reason, not a write to guess at.
  const rootOk = root !== "" && within(root, real(path.dirname(path.join(wt, PROBE_BASENAME))));
  if (!rootOk)
    throw new SpecifyInfraError(
      `the runner preflight could not place its probe inside the worktree: ${wt} does not contain its own root`,
    );
  return PROBE_BASENAME;
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
 * THROWS `SpecifyInfraError` before any dispatch when it cannot, naming the
 * rendered command and what the runner printed. Returns the disclosure note when
 * the runner ran and REJECTED the probe file itself (pytest's exit 4, with the
 * collectable probe name on) — the bench is healthy, the probe is the thing that
 * was refused, and a run must not be billed an infrastructure failure for the
 * step's choice of filename. Returns nothing on the healthy path.
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
): Promise<string | undefined> {
  // The switch's ONE gate: off, the probe is never written and the runner is
  // never asked, so none of this file's throws can be reached. Read at call
  // time — see `runner-preflight-switch.ts`.
  if (!leanRunnerPreflightEnabled()) return;
  // One placement decision, then ONE sequence: write, run, classify, remove. The
  // placement and the READING of a 4 are decided together — both are facts about
  // the name the probe carries — so the decision is passed down, not re-derived.
  const placed = probeRelative(opts.wt, opts.testLocation);
  return runProbeAt(exec, opts, containedParent(opts.wt, placed.rel), placed.py);
}

/**
 * The whole probe sequence for one worktree-relative path: refuse a dirty name,
 * write empty, run the template, classify, and remove the file on every path.
 */
async function runProbeAt(
  exec: ExecFn,
  opts: { wt: string; template: string; limits?: TestRunLimits },
  rel: string,
  pyProbe: boolean,
): Promise<string | undefined> {
  probeWrite(opts.wt, rel);
  const proof = await runTestFile(exec, {
    wt: opts.wt,
    template: opts.template,
    file: rel,
    limits: opts.limits ?? { timeoutMs: PROBE_TIMEOUT_MS },
  });
  try {
    if (probeHealthy(proof)) return;
    // The reading is a fact about the PROBE's name, so it belongs to the probe that
    // carries the collectable name and not to the switch in the abstract: a
    // non-Python repo keeps today's exit-4 hand-back whatever the switch says.
    if (
      pyProbe &&
      leanPreflightProbeCollectableEnabled() &&
      proof.kind !== "infra" &&
      proof.code === PYTEST_NO_COLLECTOR
    )
      return probeRejected(proof);
    throw new SpecifyInfraError(
      `the test runner could not run a test file: ${proof.cmd} — ${trim(proof.detail)}`,
    );
  } finally {
    removeProbe(opts.wt, rel);
  }
}
