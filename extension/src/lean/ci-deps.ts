/**
 * lean/ci-deps — the outside world `lean/ci` reaches, in production form.
 *
 * Same seam as `publish-deps.ts`: the step body is the algorithm and its
 * preconditions, this file is the wiring to the forge CLI and the project's
 * verify tier. A test drives the step by injecting a recorder here and stays
 * offline — no PR is created and nothing is merged by the suite.
 */

import { execp } from "../exec.ts";
import { mergeEvidenceViewCmd, prChecksCmd } from "../forge-commands.ts";
import { loadWorkConfig } from "./config.ts";
import type { WorkConfig } from "./config.ts";
import type { VerifyExec } from "./verify-types.ts";

/** What `ci` reaches outside itself. Everything is argv-or-CLI, never a model. */
export interface CiDeps {
  /**
   * The executor seam (`execp` in production): argv form when `argv` is given.
   * A `killGroup` run is the one form that does not reach a shell, so a test can
   * answer a kill-group command while every other command still runs for real.
   */
  exec: VerifyExec;
  /**
   * The project's config, read at the run's base sha — the #406 rule
   * `config.ts` enforces. Injected so a case can name a full tier without
   * rewriting the commit the frozen tests were hashed at.
   */
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  /**
   * The committed `.pi/verify-cmd` at the head CI observes, or `undefined` when
   * the project keeps its command there rather than in `.pi/work.json`. The
   * production reader is `verify.ts`'s own `verifyCmdAtHead`; a test injects the
   * line its case needs.
   */
  readVerifyCmd?: (wt: string, head: string) => Promise<string | undefined>;
  /** The head the run's gate certified — the commit `readVerifyCmd` reads at. */
  head?: string;
  /**
   * The full tier's wall clock, in ms. Production leaves it unset and the step
   * takes the `ci` budget's minutes (the one `ciMinutes` it loads from the
   * config), so a hung suite is an observed timeout rather than a wedged run.
   * It bounds the TIER alone — the forge wait has its own bound of the same
   * size ({@link CiDeps.waitTimeoutMs}) and the two run in sequence, so waiting
   * out 18 minutes of CI cannot leave the tier no time to run.
   */
  tierTimeoutMs?: number;
  /**
   * The wait between two forge reads. Defaults to a REAL timer — a poll loop
   * whose sleep degenerates to a no-op hammers `gh` for the whole budget, and
   * every offline test injects an advancing no-op, so only the production
   * default can be wrong in that direction. Same shape as `ciWatch`'s `sleep`.
   */
  sleep: (ms: number) => Promise<void>;
  /**
   * The poll's clock, in epoch ms, advanced only by {@link CiDeps.sleep} in a
   * test. The wait bound is `now() - start`, so a clock that never moves can
   * never exhaust the budget: the injected pair must move together.
   */
  now: () => number;
  /**
   * Override for the wait bound, in ms. Production leaves it unset and the
   * step reads `budgets.ci.minutes` through `budgetFor`; a test sets it so a
   * 30-minute budget does not take 30 minutes of injected sleeps.
   */
  waitTimeoutMs?: number;
}

/** The real timer: the poll's default sleep, never a zero-delay loop. */
function realSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Production dependencies: the real executor, config read, timer and clock. */
export function ciDeps(): CiDeps {
  return {
    exec: (cmd, opts) => execp(cmd, opts ?? {}),
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    sleep: realSleep,
    now: Date.now,
  };
}

/**
 * The two `gh` reads the CI verdict is made of, in their pinned argv form.
 *
 * ONE read carries both `mergeStateStatus` and `headRefOid` (and `mergeable`,
 * the field `gh pr view --json` actually exposes — `isMergeable` is not a field
 * of that subcommand), because the head and the verdict must come from the same
 * moment: two reads of a moving PR are two moments, and a green about another
 * head is no evidence about this one. That is `mergeEvidenceViewCmd`, the same
 * read the driver's merge-evidence gate runs.
 *
 * The check rows are a SEPARATE read, and `--json` is load-bearing on it:
 * `gh pr checks` without `--json` prints a human table, which is not parseable,
 * so every row would be discarded and the `skipped`/`neutral` treatment would be
 * unreachable through production code. `prChecksCmd` requests the fields `gh`
 * supports (`name,state,bucket` — `conclusion` is not one of them, and the
 * field list is pinned by `test-gh-argv.ts` alongside the #745 rule that
 * `isRequired` must never come back).
 */
export function ghReads(prNumber: number): { view: string; checks: string } {
  return {
    view: mergeEvidenceViewCmd(prNumber),
    checks: prChecksCmd("github", prNumber),
  };
}
