/**
 * work-driver-integrate-result — the result contract of `integrate()`, kept
 * apart from its implementation so the shape callers switch on stays readable.
 *
 * `IntegrateResult` is what `runCommitPr` and the driver's commit-pr step
 * branch on, so its field documentation is the load-bearing part: an operator
 * reading a handoff, or a reviewer asking "who is allowed to push after a red
 * gate", is reading THIS file, not the 300-line consolidate routine.
 */

import type { ConsolidationCompleteness } from "./work-driver-completeness.ts";
import type { NoDiff } from "./work-driver-integrate.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";

export type IntegrateResult =
  | {
      ok: true;
      workstreams: string[];
      empty: false;
      /** #492 — worktrees that were clean at stage time (the fixer/developer
       *  produced no diff there). Set only when at least one worktree was
       *  clean, so a caller can tell "this one wrote nothing" apart from the
       *  workstreams that did ship. */
      noDiff?: NoDiff;
      commitShas?: Record<string, string>;
      completeness?: ConsolidationCompleteness;
      /**
       * #1240 — the commit-pr consolidated verify did not run because the
       * committed integration tree is the tree the develop step already
       * verified green. The caller records the visible event from it; absent
       * on every run that executed the command.
       */
      verifySkipped?: AlreadyVerifiedTree;
      /**
       * #1404 — step 4's consolidated verify FAILED, but every failing test
       * also fails at the cycle's base commit, so the push proceeded. Set
       * only by that verdict: a verify that passed never sets it, and neither
       * does a probe that failed to establish a red base.
       */
      preExistingOnly?: boolean;
      /**
       * #1404 — the failing test names the base run produced too. The caller
       * renders them into the PR body and records them for the handoff, so a
       * continued-with-a-red-gate cycle is visible rather than silent.
       */
      preExistingFailures?: string[];
    }
  /** Nothing to integrate — every worktree was clean. Not an error. #492. */
  | {
      ok: true;
      workstreams: [];
      empty: true;
      noDiff: NoDiff;
      /** #749 — empty because every workstream's work was already on the
       *  branch (tree-hash dedup skip), not because nothing was produced. */
      skippedAlreadyOnBranch?: string[];
    }
  | {
      ok: false;
      reason: string;
      conflictPatch?: string;
      /** #492 — worktrees that produced no diff (for handoff context). */
      noDiff?: NoDiff;
      /**
       * #539 — structured failure discriminator. Cause readers MUST read this, never re-parse `reason`.
       *
       * `push-refused` (#1439) is the forge's server-side refusal of the push itself — GitHub push
       * protection (`GH013`), repository rules, or a non-fast-forward the driver must not overwrite.
       * It is named structurally because it is TERMINAL by nature: nothing an ops child does locally
       * can lift a refusal the remote issued, so the fallback dispatch is 40 minutes of rediscovery
       * and the cause classifier must not call the change healthy.
       */
      failure?: "dirty-repoRoot" | "apply" | "verify" | "push-refused";
      /** #1324 — the `verify` failure was a run killed at its bound. */
      timedOut?: boolean;
      /**
       * #1404 — the commit-pr consolidated verify ran and FAILED, but every
       * failing test also fails at the cycle's base commit, so none of them
       * is caused by this change. The caller may push and open the PR: the
       * gate's verdict stands (`ok: false`, so nothing here can launder a
       * real failure into a pass) and the caller alone decides to continue —
       * which is also why the pre-existing names must travel with it as a
       * visible note (see `preExistingFailures`). A probe that could not
       * establish a red base NEVER sets this: absence is the park.
       */
      preExistingOnly?: boolean;
      /**
       * #1404 — the failing test names the base run also produced. Set
       * whenever the probe named them, including the mixed case where the
       * cycle still parks; the caller records them so the PR body and the
       * handoff say which red tests the gate has been blaming unfairly.
       */
      preExistingFailures?: string[];
      /** #654 task-c — dirty-preflight porcelain lines (the caller parks with these). */
      porcelain?: string[];
      /**
       * #1064 — the consolidated verify's OWN failure lines (the classified message,
       * the `FAILED: N test(s)` names, the `✗` assertions). Set on a `verify` failure so
       * the terminal cap can carry them: pre-fix the cap carried the cap NAME, the
       * handoff named no test, and everything the gate had extracted was discarded.
       */
      failures?: string[];
      /**
       * #1064 — the persisted raw-output logs behind this failure, on the same
       * structural channel #841 uses for the develop caps. Never parsed out of prose.
       */
      logPaths?: string[];
    };
