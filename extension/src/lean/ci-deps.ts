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
  /** The executor seam (`execp` in production): argv form when `argv` is given. */
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
   * The full tier's wall clock. Defaults to the shipped `ci` budget's minutes
   * (`DEFAULT_BUDGETS.ci`), so a hung suite is an observed timeout rather than
   * a wedged run.
   */
  tierTimeoutMs?: number;
}

/** Production dependencies: the real executor and the real config read. */
export function ciDeps(): CiDeps {
  return {
    exec: (cmd, opts) => execp(cmd, opts ?? {}),
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}

/** The two `gh` reads the CI verdict is made of, in their pinned argv form. */
export function ghReads(prNumber: number): { view: string; checks: string } {
  return {
    view: mergeEvidenceViewCmd(prNumber),
    checks: prChecksCmd("github", prNumber),
  };
}
