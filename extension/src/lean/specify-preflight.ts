/**
 * lean/specify-preflight — ask the project's own runner ONE question before any
 * adversary is paid: can it run a test file at all?
 *
 * The step's refusal vocabulary cannot answer this. A runner that dies before
 * collection — pytest's exit 4, an empty git submodule where a test imports
 * from one, a suite that needs an environment variable this tree does not have
 * — prints nothing that names the file, so the red proof classifies the run
 * `unclear` (`exited 4 without naming <base>`) and the step declines with
 * `criterion ACn has no red test`. That is a VERDICT about work the toolchain
 * never got to judge, and it blamed the adversary for the environment.
 *
 * So the step asks the runner directly, once, before the first dispatch:
 *
 *   - the configured `verify.test` template, rendered with the path of an
 *     EMPTY test file written under the worktree root and outside any
 *     configured `verify.testDir`, so the probe cannot be mistaken for an
 *     acceptance test by the boundary's location rule;
 *   - executed by `runTestFile` with its own process group, so a hang is a
 *     kill and a kill is infrastructure — the same classifier the red proof
 *     uses, never a second one, and the same `code` it read off the rejection;
 *   - exit 0, or pytest's "collected 0 items" (5), is healthy: the runner
 *     started, parsed the file and reached the point where it reports on
 *     tests. Any other status, a kill, an output flood, or a runner that never
 *     started is a `SpecifyInfraError` naming the rendered command and a
 *     bounded excerpt of what it printed — the same handback shape
 *     `verify`'s `VerifyInfraError` carries. There is deliberately no
 *     runner-specific detection and no per-runner exception table: the exit
 *     status alone decides, so a runner that reports "no tests" as an error is
 *     refused rather than guessed at.
 *
 * It costs one runner invocation and no model call, and the probe file is
 * removed on every path — including the throw — so the worktree at dispatch
 * holds exactly what it held before the probe. The retry does NOT re-probe: a
 * runner that broke between attempts is caught by the shared pipeline's own
 * per-file infra throw (`assertRan`), which stays the only infra rule for a
 * run already mid-step.
 *
 * Submodules are the other half of this module's answer, because the bench
 * shape that motivated it was an empty submodule directory: `git clean -fdx`
 * de-populates every submodule on every reset, and a test importing from one
 * then fails before collection. `initSubmodules` runs in the same
 * create-or-reset path both `specify` and `challenge` take, right after each
 * reset — including no-ops, since a de-populated submodule cannot be told
 * apart from a populated one without asking git — and a failure there,
 * network included, is the same infrastructure handback.
 */

import { existsSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import type { TestLocation } from "./config-test-location.ts";
import type { Proof, TestRunLimits } from "./specify-proof.ts";
import { runTestFile, trim } from "./specify-proof.ts";
import { NO_HOOKS, SpecifyInfraError } from "./specify-reset.ts";

/** Exit status 5 is pytest's "collected 0 items": a runner that ran and found nothing. */
const PYTEST_NO_TESTS = 5;

/**
 * The two statuses this probe accepts, and nothing else.
 *
 * Both say the same thing in a different dialect: the runner started, parsed the
 * file, and reported on it — 0 meaning "ran, nothing to say", 5 meaning pytest's
 * "collected 0 items". The status decides, NOT the proof's classification:
 * `runTestFile` calls a non-zero exit that named the file `red`, and a pytest
 * collection error prints the file it could not collect, so the very failure
 * this probe exists to catch arrives as a `red`. Reading classifications here
 * would grade that run healthy. It also says nothing about the runner's flavour
 * — no detection, no exception table — only which exit statuses mean "nothing
 * was judged".
 */
function probeHealthy(proof: Proof): boolean {
  if (proof.kind === "green") return true;
  return proof.kind !== "infra" && (proof.code === 0 || proof.code === PYTEST_NO_TESTS);
}

/** How long one probe run gets; the same bound one red proof gets. */
const PROBE_TIMEOUT_MS = 120_000;

/** The wall clock on `git submodule update --init --recursive`, which may reach the network. */
const SUBMODULE_TIMEOUT_MS = 5 * 60_000;

/**
 * The submodule calls' own `-c` flags, added to {@link NO_HOOKS} at the call.
 *
 * `protocol.file.allow=always` is what lets a clone from a LOCAL path through.
 * git refuses the `file` transport for submodules by default (the CVE fix that
 * made it `user`-only), and a step that could not populate a submodule whose
 * remote is another directory on this machine would hand back on a perfectly
 * good base. It is not a licence for anything a stranger supplies: `submodule
 * update --init` clones only URLs the base commit's own `.gitmodules` names, that
 * file is tracked content reviewed as code, and `file` is the narrowest transport
 * there is — the step never clones an arbitrary URL, only what this repository
 * already committed. Hooks stay refused, whatever the repository carries.
 */
function submoduleArgv(...argv: string[]): string[] {
  return [...NO_HOOKS, "-c", "protocol.file.allow=always", ...argv];
}

/** How much of the runner's output the handback quotes. */
const EXCERPT_MAX = 400;

/** The probe file's name — hidden, so no `testGlob` (none may start with `.`) matches it. */
const PROBE_BASENAME = ".lean-runner-probe.test";

/** A probe file the runner can parse and collect nothing from, in any language. */
const PROBE_CONTENT = "";

/**
 * The probe's worktree-relative path, and why it sits there.
 *
 * Two facts have to hold at once: the probe must not be mistaken for an
 * acceptance test (so it is hidden, and no `testGlob` may start with `.`), and
 * writing it must not change the tree — no directory created, nothing left
 * behind for the reset's clean-tree assertion or the acceptance-test commit to
 * explain. The worktree root satisfies both whatever the config says: it always
 * exists, and a probe inside a configured `verify.testDir` is exactly the byte
 * the boundary's location rule is built to refuse.
 *
 * A project that keeps its tests in a SUBDIRECTORY (`testDir` deeper than the
 * root) has a directory free of that constraint already — `testDir`'s parent —
 * and the config vouches that it exists, since every acceptance test the run
 * freezes has to sit under it. That is where the probe goes, and the preflight
 * confirms it on the tree rather than trusting the config: no `mkdir`, because
 * an uncreated directory would be an untracked byte the step then has to
 * account for.
 */
function probeRelative(wt: string, testLocation?: TestLocation): string | undefined {
  if (testLocation === undefined) return PROBE_BASENAME;
  const parent = path.posix.dirname(testLocation.testDir);
  if (parent === ".") return PROBE_BASENAME;
  return existsSync(path.join(wt, parent)) ? `${parent}/${PROBE_BASENAME}` : PROBE_BASENAME;
}

/** Is `abs` an ordinary file this probe may claim (rather than a link, dir or fifo)? */
function isPlainProbe(abs: string): boolean {
  try {
    return lstatSync(abs).isFile();
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
  const rel = probeRelative(opts.wt, opts.testLocation);
  if (rel === undefined) {
    throw new SpecifyInfraError(
      `the runner preflight could not place its probe file: the configured test directory's parent does not exist in ${opts.wt}`,
    );
  }
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
    // ONE rule, no per-runner table: an empty file must not be what the runner
    // dies on. Exit 0 is a runner that ran the file and found nothing to say;
    // exit 5 is pytest's `collected 0 items`, the same fact in its own dialect.
    // Any other outcome — the collection error that exits 4, the kill of a hung
    // runner, the flood, the runner that never started — observed nothing, and
    // the step must not spend an adversary on a toolchain that cannot answer.
    if (probeHealthy(proof)) return;
    throw new SpecifyInfraError(
      `the test runner could not run a test file: ${proof.cmd} — ${trim(proof.detail).slice(0, EXCERPT_MAX)}`,
    );
  } finally {
    // Every path, throw included: a probe left in the tree is an untracked
    // byte the reset's clean-tree assertion and the acceptance-test commit both
    // have to explain, and the runner's own status would report it.
    if (existsSync(abs)) {
      try {
        unlinkSync(abs);
      } catch {
        /* the reset's `clean -fdx` removes it whatever happens here */
      }
    }
  }
}
/**
 * Populate the worktree's submodules, when its commit has any.
 *
 * The question "does this base have submodules" is answered by git rather than
 * by a heuristic: `git config --file .gitmodules --get-regexp path` exits 1 on
 * a file that lists nothing and non-zero-but-1 on a file it could not read, so
 * "could not tell" refuses the run instead of skipping the initialisation it
 * was asked for. A base with no `.gitmodules` is the normal case and costs one
 * read.
 *
 * `git submodule update --init --recursive` is bounded, because it may reach
 * the network — and a clone with no network, or a submodule whose remote is
 * gone, is the same infrastructure handback as a runner that cannot collect:
 * nothing downstream can judge the work without those files.
 */
export async function initSubmodules(
  exec: ExecFn,
  wt: string,
  /**
   * Called with the tree in the state the reset left it — a submodule the base
   * carries present as a gitlink, nothing fetched — before the step asks git to
   * populate it. Product code never supplies it; it is how a smoke test sabotage
   * a submodule between the reset and the command that has to recover it, which
   * is the only way to watch git fail that command rather than assert what it
   * would have done.
   */
  beforeInit?: (wt: string) => void | Promise<void>,
): Promise<void> {
  await beforeInit?.(wt);
  const listed = await exec("git", {
    argv: submoduleArgv("config", "--file", ".gitmodules", "--get-regexp", "path"),
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (listed as { __err?: unknown })?.__err;
  if (err !== undefined) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number" && code <= 1) return;
    throw new SpecifyInfraError(
      `could not tell whether ${wt} has submodules: git config --file .gitmodules --get-regexp path exited ${String(code)}`,
    );
  }
  const ran = await exec("git", {
    argv: submoduleArgv("submodule", "update", "--init", "--recursive"),
    cwd: wt,
    timeout: SUBMODULE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  const failed = (ran as { __err?: unknown })?.__err;
  if (failed === undefined) return;
  const e = failed as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const out = [e.stdout, e.stderr, e.message]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
  throw new SpecifyInfraError(
    `the worktree's submodules could not be initialised in ${wt}: git submodule update --init --recursive — ${trim(out).slice(0, EXCERPT_MAX)}`,
  );
}
