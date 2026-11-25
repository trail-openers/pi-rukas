/**
 * lean/verify-deps — what the verify gate reaches outside itself.
 *
 * `verifyOutcome` decides colours; this module is the seam through which it sees anything else.
 * Every one of these is a SEAM rather than a direct call because the production form reads
 * repository state at a particular commit, and a case that wants a tier to exit 1 must not have
 * to rewrite the commit its frozen records were hashed at in order to ask for one.
 *
 * It also holds the one bound a red reason carries out of the gate: the reason lands in the next
 * build child's prompt and in the PR body, so both the bound and the clip that applies it live
 * here, where the two readers can import one truth.
 */

import { execp } from "../exec.ts";
import { loadWorkConfig } from "./config.ts";
import { fetchIssueBody } from "./io.ts";
import type { VerifyExec, VerifyRosterConfig, VerifyTiers } from "./verify-types.ts";

/**
 * What `verify` reaches outside itself.
 *
 * `loadConfig` reads `.pi/work.json` at the run's base sha, never the working tree: doctrine a
 * cycle is judged by is read at the commit it started from, so a run cannot rewrite the rules it
 * is measured against mid-cycle. Its return is widened beyond `verify`'s own tiers to the fields
 * the PROJECT-TEST ROSTER reads (`roster`, `testDir`, `testGlob`): the roster's inventory is a
 * fact about the base commit, and a roster that read the pair off the working tree would let the
 * run choose the suite that judges it. A seam that returns only `verify` still satisfies the
 * interface, so the cases written before the roster are unchanged.
 */
export interface VerifyDeps {
  exec: VerifyExec;
  loadConfig: (
    repoRoot: string,
    baseSha: string,
  ) => Promise<{ verify: VerifyTiers & Partial<VerifyRosterConfig>; detection?: string }>;
  /** The committed `.pi/verify-cmd` at HEAD; `undefined` when there is none. */
  readVerifyCmd?: (wt: string, head: string) => Promise<string | undefined>;
  /** Bounds every tier and frozen-test run; a test shortens it to observe a hang. */
  timeoutMs?: number;
  /**
   * The issue body the run's contract lives in. `verifyDeps()` supplies the forge read; a test
   * injects the text its case needs. An unreadable body is INFRASTRUCTURE, never a verdict:
   * reporting a green over criteria the gate never saw would be the gate claiming a check it did
   * not make. Returning no criteria is correct only when the body parsed and simply holds none.
   */
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
}

/** The step log's newest red reason is pasted into a prompt; that bounds it. */
export const RED_REASON_CLIP = 4096;
/**
 * How much of the TAIL the clip keeps. The larger half because a runner prints what it is done
 * with last — pytest's warnings summary fills the head, and the `FAILED` block and its
 * `N failed` tally are what the builder has to read.
 */
export const RED_REASON_TAIL_CLIP = 3072;

/**
 * Clip a red reason to {@link RED_REASON_CLIP}, keeping its HEAD and its TAIL around an elision
 * marker. `build`'s re-entry prompt re-clips through this same function, so the record and the
 * prompt cannot disagree about what the gate said.
 */
export function clipReason(reason: string): string {
  if (reason.length <= RED_REASON_CLIP) return reason;
  const head = RED_REASON_CLIP - RED_REASON_TAIL_CLIP - 1;
  return `${reason.slice(0, head)}…${reason.slice(reason.length - RED_REASON_TAIL_CLIP)}`;
}

/** `verify`'s dependencies in production form: the real executor and config read. */
export function verifyDeps(): VerifyDeps {
  return {
    exec: (cmd, opts) => execp(cmd, opts ?? {}),
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    fetchIssueBody,
  };
}
