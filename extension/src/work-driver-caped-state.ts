/**
 * work-driver-caped-state — the #543 F5 caped-partial-state block, shared
 * by BOTH handoff renderers (markdown + in-chat). Split out of
 * work-driver-handoff-markdown.ts (AGENTS.md §12 file-size limit).
 *
 * A dispatch-cap kill (loop-detected / token-budget) never leaves only a
 * failure message: the driver stage+commits the worktree (when it can),
 * authors `status-<role>.md` in the scratch dir, and records the result on
 * `pipelineState.capedPartialState`. This block renders that record:
 *
 *   - committed + remaining list  — when the checkpoint commit exists and
 *     `remainingFiles` was verified empty after it ("everything that was
 *     on disk is now in this commit"), or with the leftover paths named
 *     when something could not be saved;
 *   - "unverified partial state"  — when the tree was dirty and nothing
 *     recoverable was committed; the operator must inspect before trusting
 *     anything in the tree;
 *   - report-only                 — for structurally write-gated roles
 *     (lens / adversarial / explore children cannot commit); the killed
 *     child's FINAL TEXT is never the sole report — the driver-authored
 *     status file is what counts.
 *
 * The killed child's raw final text is NOT inlined here: that is the
 * dispatch report's summary, and presenting it as "the step report" would
 * be the exact F5(4) violation — the driver's composed state is the report.
 *
 * Returns `[]` when no caped-partial-state was recorded (pre-#543 state
 * files, or a cap other than loop/token-budget). Pure function — no I/O.
 */

import { CHECKPOINT_TYPECHECK_CMD } from "./work-driver-cap-checkpoint-typecheck.ts";
import type { WorkState } from "./workflow-state.ts";

export function capedPartialStateLines(state: WorkState, indent: string): string[] {
  const cps = state.pipelineState.capedPartialState;
  if (!cps) return [];
  const lines: string[] = [
    `${indent}### Cap-hit checkpoint (cap: \`${cps.cap}\`, role: \`${cps.role}\`)`,
    "",
  ];
  const statusPath = cps.statusFile ?? "(status file path not recorded)";
  if (cps.tree === "committed" && cps.commitSha) {
    lines.push(
      `${indent}- **committed work** — the driver committed the worktree at \`${cps.commitSha}\` before handoff.`,
    );
    const remaining = cps.remainingFiles ?? [];
    if (remaining.length > 0) {
      lines.push(
        `${indent}- **remaining** — ${remaining.length} path(s) were still dirty after the checkpoint commit:`,
        ...remaining.slice(0, 10).map((f) => `${indent}    - \`${f}\``),
        ...(remaining.length > 10 ? [`${indent}    … and ${remaining.length - 10} more`] : []),
      );
    } else {
      lines.push(
        `${indent}- **remaining** — the tree was verified clean after the checkpoint commit; everything that was on disk is in the commit.`,
      );
    }
  } else if (cps.tree === "dirty-uncommitted") {
    lines.push(
      `${indent}- **UNVERIFIED PARTIAL STATE** — the tree was dirty at kill time and nothing was committed. The work below is driver-authored, not the child's own words; verify each file before trusting it.`,
    );
    const remaining = cps.remainingFiles ?? [];
    if (remaining.length > 0) {
      lines.push(
        `${indent}- **uncommitted paths** (first ${Math.min(remaining.length, 10)} of ${remaining.length}):`,
        ...remaining.slice(0, 10).map((f) => `${indent}    - \`${f}\``),
      );
    }
  } else {
    lines.push(
      `${indent}- **clean tree** — nothing was on disk at kill time; the checkpoint commit was not needed.`,
    );
  }
  if (cps.reportOnly) {
    lines.push(
      `${indent}- **report-only** — this role is structurally write-gated; no commit was expected or made. The driver-authored status file below is the report, not the killed child's final text.`,
    );
  }
  if (cps.typechecked === false) {
    lines.push(
      `${indent}- **typecheck FAILED at checkpoint** — the driver's \`${CHECKPOINT_TYPECHECK_CMD}\` in the worktree failed before the checkpoint commit: the code is broken as-is. Fix the typecheck before pushing.`,
    );
  }
  // #1414 round 2 — the absence of `typechecked` is NOT a passing check. The
  // field is omitted when the checkpoint's typecheck reached no verdict (could
  // not run, killed at its bound, or no `extension/` to check) and pre-fix that
  // same shape reached here as `false` and got the broken-code bullet. The
  // status file carries the specific reason; the handoff says plainly that no
  // verdict was reached and claims NEITHER way about the code.
  //
  // The `typechecked === undefined` guard is load-bearing, not tidiness: this
  // branch is an `else` on the `false` test, so without it a tree that
  // typechecked cleanly (typechecked: true) would also be told "no verdict",
  // contradicting the record two lines above it. `test-handoff-caped-state.ts`
  // case (f) is that assertion.
  //
  // #1414 round 3 — "absent" is TWO states and only one of them has a reason
  // to report. The checkpoint skips the typecheck entirely for a report-only
  // kill and for a tree that was clean at kill time, so an absent field there
  // means "there was nothing to check", not "the check could not run" — and a
  // dirty-uncommitted checkpoint whose commit attempt failed after the check
  // never ran at all (the pre-round-3 shape) got a bullet asserting a check
  // that never happened, with `not recorded` where the reason should be.
  // `typecheckAttempted` is the record's own word that the check was run, and
  // the bullet is gated on it: when it is absent the handoff says so in one
  // plain line instead of describing a verdict-shaped absence.
  else if (cps.typechecked === undefined && cps.tree !== "clean" && !cps.reportOnly) {
    // A recorded `typecheckReason` is itself evidence of an attempt: the field
    // is written only when the check ran and returned no verdict, so a state
    // file from round 2 (which predates `typecheckAttempted`) still renders the
    // bullet it was written for. The absence of BOTH is the never-attempted
    // case — there is no reason to print and no attempt to describe.
    if (cps.typecheckAttempted === true || cps.typecheckReason !== undefined) {
      lines.push(
        `${indent}- **typecheck: no verdict** — the driver's \`${CHECKPOINT_TYPECHECK_CMD}\` did not reach a verdict at the checkpoint (it could not run, was killed at its bound, or there was no \`extension/\` to check). No claim is made about whether this code typechecks; the checkpoint committed partial work and the full gate runs on the integrated branch.\n${indent}  — reason: ${cps.typecheckReason ?? "not recorded; see the status file below"}`,
      );
    } else {
      // #1414 round 3 — plain statement, no verdict-shaped language: the
      // driver does not know whether this code typechecks and does not imply
      // it looked. Omitting the bullet entirely was the other option and was
      // rejected: this is the dirty-uncommitted case, the one where the
      // operator most needs to know the tree was never compiled.
      lines.push(
        `${indent}- **typecheck: not attempted** — the driver did not run \`${CHECKPOINT_TYPECHECK_CMD}\` at this checkpoint, so nothing here indicates whether the code typechecks. Run it before pushing; the full gate runs on the integrated branch.`,
      );
    }
  }
  // #543 (M7) — on a REVIEW_INCOMPLETE cap (one lens cap-killed, the rest
  // completed), the handoff's "verdicts shown above" promise is FALSE:
  // there is no lens-issues-found event for a killed-lens round. Render the
  // surviving lenses' verdicts from `pipelineState.lensReviewSummary` so
  // the operator sees the 5-of-6 that DID run. Shared by both renderers.
  const lrs = state.pipelineState.lensReviewSummary;
  const capHitEvt = state.eventLog
    .slice()
    .reverse()
    .find(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "cap-hit" }> =>
        e.kind === "cap-hit",
    );
  if (
    lrs &&
    capHitEvt &&
    (capHitEvt.cap === "review-incomplete" ||
      capHitEvt.cap === "loop-detected" ||
      capHitEvt.cap === "token-budget")
  ) {
    const completed = lrs.lenses.filter((l) => !l.blocked);
    if (completed.length > 0) {
      lines.push(
        `${indent}### Completed lenses (round ${lrs.round}, verdict: ${lrs.verdict})`,
        ...completed.map(
          (l) => `${indent}- ${l.lens}: ${l.ok ? "clean" : "issues"} (${l.findings} finding(s))`,
        ),
        "",
      );
    }
  }
  lines.push(
    `${indent}- **status file** (driver-authored — done / remaining / current state): \`${statusPath}\``,
    "",
  );
  return lines;
}
