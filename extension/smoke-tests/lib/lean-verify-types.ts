/**
 * lib/lean-verify-types — what a `lean/verify` smoke case asks for, and what it gets back.
 *
 * The two shapes the exec stub in `lean-verify-exec.ts` and the fixture in
 * `lean-verify-fixture.ts` share: a case declares the tree, the tiers and the frozen
 * contract it wants the step to judge (`VerifyOpts`), and reads back what the step
 * did (`VerifyRun`). They live apart from the stub because the stub's own file is at
 * the size cap and every new shape a case needs would otherwise be a line that
 * cannot be written; they live together because an option with no matching result
 * field is one edit, not two.
 *
 * Prose in this file is read by the unscrubbed-spawn gate in
 * test-verify-loop-git-env.ts, which blanks quoted spans BEFORE it blanks comments.
 * Prose here keeps every quote pair on one line.
 */

import type { WorkConfig } from "../../src/lean/config.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import type { ProbeShapeOpts } from "./lean-verify-probe-shapes.ts";

export interface VerifyRun {
  outcome?: Outcome;
  threw?: Error;
  worktree: string;
  head: string;
  /**
   * Where the baseline probe's throwaway tree lives, for the removal cases: it is
   * derived from the fixture's own `repoRoot`, which the case never has to rebuild.
   */
  probeDir?: string;
  /** How many times the tier command ran, across HEAD and the probe. */
  tierRuns?: number;
  /**
   * How many times the BASE PROBE ran the tier in its throwaway checkout (0 = it never got there).
   */
  baseTierRuns?: number;
  /**
   * How many times the step ran a FROZEN file through the `verify.test` runner. The
   * cost-bound cases assert on this rather than on wall clock: a hang's whole cost IS
   * the bound, so counting invocations says "one bound" in milliseconds where timing it
   * would pay a second one to prove it was not paid.
   */
  frozenRuns?: number;
  /**
   * How many times the step ran the PROJECT's rostered suite, across the run's worktree and the
   * base probe. The roster cases assert on this: a run that graded green without ever running the
   * project's suite is the defect Part A exists to close, and the count is the evidence.
   */
  rosterRuns?: number;
  /** The run's repo root, for a case that wants to ask git about its worktrees. */
  repoRoot?: string;
  /** The commit the run branched from — what a roster's `baseSha` must name. */
  baseSha?: string;
}

export interface VerifyOpts extends ProbeShapeOpts {
  issue: number;
  /** What the project configured; `fast` defaults to a passing tier. */
  config?: Partial<WorkConfig["verify"]>;
  /**
   * Freeze extra acceptance-test files besides the fixture's own, as path -> bytes.
   * They are committed on top of the freeze and hashed into the record, so the step
   * judges them as genuine frozen tests — the shape a hanging frozen file needs.
   */
  extraFrozen?: Record<string, string>;
  /**
   * The `verify.test` runner template verbatim, for the case that wants a runner it
   * cannot start (`no-such-test-runner {file}`) rather than `sh {file}` or the
   * silent helper.
   */
  frozenRunner?: string;
  /**
   * The run's frozen contract is one that fails whatever the tree holds, so the
   * runner must name it — see `NAMING_RUNNER_TEMPLATE`. Used with `frozenText:
   * RED_ACCEPTANCE_TEST`; without it the helper goes untracked-or-unused and an
   * unconditional-red contract reads `unclear` rather than red.
   */
  alwaysRedFrozen?: boolean;
  /** Nothing configured at all: the frozen tests alone decide. */
  noCommand?: boolean;
  /** Bounds every tier and frozen-test run, so a hang is observable in seconds. */
  timeoutMs?: number;
  /** Make the worktree dirty before the step looks at it. */
  dirty?: boolean;
  /** Rewrite the frozen file ON DISK, uncommitted, before the step looks. */
  editDisk?: string;
  /** Commit a rewrite of the frozen file at HEAD before the step looks. */
  editAtHead?: string;
  /** Commit the implementation, so the frozen test's own red goes away. */
  implement?: boolean;
  /**
   * A second tier, run after `fast`: the re-check cases use it to rewrite a
   * frozen file, drop an untracked file, or commit, once the tree has already
   * been read clean. The command runs through a shell in the worktree.
   */
  full?: string;
  /**
   * Run the frozen tests through the silent helper runner instead of `sh {file}`:
   * it exits non-zero without naming the file, so the proof arrives `unclear`.
   * What the step is allowed to make of an unclear proof is what the case asks.
   */
  silentRunner?: boolean;
  /**
   * Reject the post-tier BRANCH read with exit 1 AND a message on stderr. git's
   * own detached answer is exit 1 with NOTHING printed, so a noisy exit 1 is a
   * git that could not reply and must not be read as "detached".
   */
  recheckBranchNoisyExit1?: boolean;
  /**
   * Make the HEAD read that happens AFTER the tiers reject, while every earlier
   * git call still goes to the real git. That read is the post-tier re-check: a
   * step that cannot re-read HEAD once the tiers have run has not observed a
   * tier moving it — it has failed to read the tree, which is infrastructure.
   */
  recheckHeadFails?: boolean;
  /**
   * Reject the post-tier BRANCH read (`symbolic-ref --short -q HEAD`) while
   * every earlier git call still goes to the real git — the shape a detached
   * HEAD gives, since `-q` exits 1 without printing anything. A read that
   * REJECTS rather than exiting 1 is covered by `recheckHeadFails` for the HEAD
   * read; this one proves the branch read treats git's "detached" exit as an
   * answer and not as a machine that could not reply.
   */
  recheckBranchDetached?: boolean;
  /**
   * The issue body the verify gate reads for its `command` criteria. Absent means
   * an issue with no `pi-spec` block, which is the "the spec asked for no command
   * criteria" shape — the ordinary case these cases are not about.
   */
  specBody?: string;
  /**
   * How many times the tier command may fail before it goes green, counted over
   * EVERY tree it runs in (HEAD's first run, HEAD's re-run, the base probe, in that
   * order): `1` is the flake — red at HEAD, green on the re-run; `2` is a tier red at
   * HEAD twice and green at the base, which is the real failure that still earns a
   * build round; `3` adds a base that is red too, which is the baseline hand-back.
   */
  headTierRedRuns?: number;
  /**
   * Make the BASE commit itself fail the run's frozen contract, with a real committed
   * test that exits non-zero whatever the tree holds.
   *
   * This is the only honest way to make a baseline-red case: the probe re-runs the run's
   * own acceptance tests inside the base checkout and reads their colour from the real
   * runner, so a base that is red is red because git says so, not because the case said
   * so. `false` is the boundary — a base with no red of its own, over which a tier may
   * not be excused.
   */
  baseRedContract?: boolean;
  /**
   * Make the probe's `git worktree add` reject. The base then cannot be judged at
   * all, which is infrastructure rather than a colour, and the probe tree must still
   * be gone afterwards — which is what the removal case drives.
   */
  baseAddFails?: boolean;
  /**
   * Reject the probe's tier run. A base run that throws is the case where a cleanup
   * that only ran on the happy path would leak its checkout, so the tree has to be
   * gone from `git worktree list` afterwards even though the probe itself failed.
   */
  baseTierThrows?: boolean;
  /**
   * Make the step's RE-RUN at HEAD reject with the executor's own kill shape
   * (`killed`, `timedOutKill`, `code: null`, no numeric exit code) — the shape a tier
   * that hung on its second attempt really produces, and the one a numeric `code`
   * cannot fake. The tier's OWN script is what hangs (see `killOnSecondTier`), so this
   * only makes the hang observable in seconds by shortening the bound the step gives a
   * tier: the SIGKILL, the `code: null`, and the `killed` stamp all come from the real
   * executor, not from a stub. A re-run that observed nothing may not excuse the tier:
   * the run must stay red, and a gate that read "no numeric code" as "exited 0" would
   * call it a flake and report a green nobody observed.
   */
  headRerunKilled?: boolean;
  /**
   * Make the step's RE-RUN at HEAD reject with NOTHING on it: no exit `code`, no
   * `killed`, no `overflow`, no `ENOENT`. This is the shape a harness speaks with rather
   * than a gate, and it is the one an "absence of an exit code means green" test gets
   * wrong — the rejection arrives as an object with no `stdout`, so the only honest
   * reading is "nobody told us anything" and the first red must stand.
   */
  headRerunSilentReject?: boolean;
  /**
   * Reject the step's RE-RUN at HEAD with a value the case names — the executor's own
   * kill, `overflow` or `ENOENT` shape, each of which `tierObserved` says `false` for.
   * These shapes still carry a `stdout`, so the re-run is the one place a tier that
   * nobody saw fail twice can print the very names the base printed, and an excuse
   * built from it grades a green on an unobserved run.
   */
  headRerunRejects?: unknown;
  /**
   * What the BASE PROBE's tier run printed (combined stdout+stderr), for the cases
   * that decide what the base NAMED rather than only what it exited. The base runs
   * at a commit the case built, so only the case can say what that run printed —
   * the same reason `baseBlobBytes` answers the base's bytes.
   */
  baseTierOutput?: string;
  /**
   * What the tier prints when the run's OWN worktree runs it red, for the cases
   * whose head tier must name failing tests. Absent means the tier's own script
   * output, which is every case that came before the baseline-excuse cases.
   */
  headTierOutput?: string;
  /**
   * The project roster, as the case declares it: which pre-existing test files the base carries,
   * and which tests each roster run's report named.
   *
   * The two roster runs happen in trees the case built — the run's worktree and the probe's
   * throwaway checkout — so only the case can say what a runner there reported. That is the same
   * reason `baseTierOutput` answers for the base tier's stream and `baseBlobBytes` for the base's
   * bytes: the stub answers the gate's report READ from these declarations, so the roster a case
   * reads back is the one it asked for rather than one the harness invented.
   *
   * Absent means the case declares no roster, and the rosterless hand-back is what the step must
   * then raise.
   */
  roster?: {
    /** The pre-existing test files the base commit carries under `testDir`/`testGlob`. */
    files?: string[];
    /** Test names the HEAD run's report says passed. */
    headPassed?: string[];
    /** Test names the HEAD run's report says failed. */
    headFailed?: string[];
    /** Test names the BASE run's report says passed. */
    basePassed?: string[];
    /** Test names the BASE run's report says failed. */
    baseFailed?: string[];
    /**
     * Make the HEAD roster run produce no exit status at all — the executor's kill shape. A run
     * nobody watched has no per-test verdicts, and the gate must hand back rather than read a
     * missing report as "nothing failed".
     */
    headRunKilled?: boolean;
    /** Make the BASE roster run reject the same way.
     */
    baseRunKilled?: boolean;
    /**
     * Make the report unreadable after a run that exited 0 — a suite that collected nothing, or a
     * report the runner never wrote. Either way there is no roster and no green: the stub refuses
     * the gate's own `cat` with git's missing-file shape rather than answering it, so the gate sees
     * the same answer a real missing report gives.
     */
    headReportMissing?: boolean;
    /** Make the base report unreadable after a run that exited 0. */
    baseReportMissing?: boolean;
    /**
     * The names the HEAD run's report names, verbatim. Given, the stub writes that report itself
     * rather than running the configured command, because "this test passed at head" is a fact about
     * one tree's verdicts that no shared bytes can carry. Absent, the configured command really runs.
     */
    headNames?: string[];
    /** The names the BASE run's report names. Same mechanism, base tree. */
    baseNames?: string[];
  };
  /**
   * Pre-existing test files whose HEAD bytes the case rewrites (committed on top of the
   * implementation), so the run EDITS them and the roster must run their BASE versions against
   * the head code. The replacement is the case's text; the base keeps the file's original bytes.
   */
  editProjectTests?: Record<string, string>;
  /** Where the case's declared pre-existing tests live; defaults to `tests` / `test-*.sh`. */
  testDir?: string;
  testGlob?: string;
  /**
   * Take the config's `testDir` + `testGlob` pair away, which is the shape of a project that never
   * said where its tests live: the roster cannot enumerate anything, and the step must hand back
   * naming the roster rather than grading a green on the frozen tests alone.
   */
  noTestLocation?: boolean;
  /**
   * The `verify.roster` report command the case configures, verbatim. Absent means the fixture's
   * own derived runner (`sh {file} --junitxml={report} {dir}`), whose script writes the JUnit report
   * the gate reads back.
   */
  rosterTemplate?: string;
  /**
   * Make the base commit's copy of each declared pre-existing test EXIT NON-ZERO. The roster's
   * base-version run executes the base's own bytes through `verify.test`, so this is how a case asks
   * "what if the file as the mainline wrote it fails against the head code" — bench cell 2.
   */
  baseProjectTestFails?: boolean;
  /**
   * The bytes to freeze as the run's acceptance test, for the case that fixes the
   * ACCEPTANCE half of the verdict rather than deriving it (`GREEN_TEST` and
   * `RED_ACCEPTANCE_TEST` in `lib/lean-verify-fixture.ts`). Absent means the
   * fixture's own red-until-implemented test.
   */
  frozenText?: string;
  /** Log lines to add after the fixture's own. */
  extraSteps?: Step[];
}
