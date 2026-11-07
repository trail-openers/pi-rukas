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
  /** The run's repo root, for a case that wants to ask git about its worktrees. */
  repoRoot?: string;
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
   * The bytes to freeze as the run's acceptance test, for the case that fixes the
   * ACCEPTANCE half of the verdict rather than deriving it (`GREEN_TEST` and
   * `RED_ACCEPTANCE_TEST` in `lib/lean-verify-fixture.ts`). Absent means the
   * fixture's own red-until-implemented test.
   */
  frozenText?: string;
  /** Log lines to add after the fixture's own. */
  extraSteps?: Step[];
}
