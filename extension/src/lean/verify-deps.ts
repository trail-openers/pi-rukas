/**
 * lean/verify-deps — what the verify gate reaches outside itself.
 *
 * `verifyOutcome` decides colours; this module is the seam through which it sees
 * anything else. Every one of these is a SEAM rather than a direct call for the
 * same reason `build` injects its own: the production form reads repository state
 * at a particular commit, and a case that wants a tier to exit 1 must not have to
 * rewrite the commit its frozen records were hashed at in order to ask for one.
 *
 * It also holds the one bound a red reason carries out of the gate. The reason
 * lands in the next build child's prompt and in the PR body, and an unbounded
 * tail from a chatty tier would eat the prompt whole — so both the bound and the
 * clip that applies it live here, where the two readers can import one truth.
 */

import { execp } from "../exec.ts";
import { loadWorkConfig } from "./config.ts";
import { fetchIssueBody } from "./io.ts";
import type { Outcome, Step } from "./state.ts";
import type { VerifyExec, VerifyTiers } from "./verify-types.ts";

/**
 * What `verify` reaches outside itself.
 *
 * `loadConfig` reads `.pi/work.json` at the run's base sha, never the working
 * tree: doctrine a cycle is judged by is read at the commit it started from, so
 * a run cannot rewrite the rules it is measured against mid-cycle.
 */
export interface VerifyDeps {
  exec: VerifyExec;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<{ verify: VerifyTiers }>;
  /** The committed `.pi/verify-cmd` at HEAD; `undefined` when there is none. */
  readVerifyCmd?: (wt: string, head: string) => Promise<string | undefined>;
  /** Bounds every tier and frozen-test run; a test shortens it to observe a hang. */
  timeoutMs?: number;
  /**
   * The issue body the run's contract lives in. `verifyDeps()` supplies the
   * forge read (`io.ts`'s `fetchIssueBody`); a test injects the text its case
   * needs. An unreadable body is INFRASTRUCTURE, never a verdict: the gate
   * cannot tell which `command` criteria the spec asked for, and reporting a
   * green over criteria it never saw would be the gate claiming a check it did
   * not make. Returning no criteria is correct only when the body parsed and
   * simply holds none.
   */
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
}

/** The step log's newest red reason is pasted into a prompt; that bounds it. */
export const RED_REASON_CLIP = 4096;

/** Clip a red reason so `build`'s re-entry prompt stays a sane size. */
export function clipReason(reason: string): string {
  if (reason.length <= RED_REASON_CLIP) return reason;
  return `${reason.slice(0, RED_REASON_CLIP)}…`;
}

/** `verify`'s dependencies in production form: the real executor and config read. */
export function verifyDeps(): VerifyDeps {
  return {
    exec: (cmd, opts) => execp(cmd, opts ?? {}),
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    fetchIssueBody,
  };
}

/** The newest decided `verify:red` reason on the log, clipped, for a report. */
export function newestRedVerifyReason(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "verify" || step.outcome?.kind !== "red") continue;
    const reason = step.outcome.reason ?? step.outcome.message;
    if (typeof reason !== "string" || reason.trim() === "") continue;
    return clipReason(reason);
  }
  return undefined;
}
