/**
 * work-queue-cap — #1101: the two caps the queue itself raises.
 *
 * Every other cap in `WorkCapLiteral` is raised by a *cycle* — a gate that
 * judged work and refused it. These two are raised by the *scheduler*, about a
 * cycle that never started: a group that waited on a sibling past its bound.
 * They live apart from the cycle caps for a reason — a queue-level park has no
 * state file to explain it, no worktree to inspect and nothing to salvage, so
 * the advice the cycle caps give ("inspect the diff", "review the findings on
 * the PR") would send an operator looking for work that was never written.
 *
 * `cross-group-conflict` is deliberately shared with the reactive plan-time
 * check in `work-driver-path-claims.ts`: the same underlying condition — two
 * groups that cannot both own these files — seen from two places. Whichever
 * one sees it first, the operator reads one cap name. The queue-level one is
 * the cheap sighting (no dispatch burned), which is the whole point of #1101.
 *
 * #1101 fix-round — every one of these caps is a member of `WorkCapLiteral`
 * (`workflow-state-events-caps.ts`), of `CAP_HIT_FIXED_LITERALS` (the
 * state-file validator) and of `FIXED_CAPS` (the headless vocabulary, sorted —
 * `test-headless-host-contract.ts` asserts the sort). A queue-raised cap that
 * joins only this union fails the validator's exhaustiveness check the same
 * way a cycle-side one does; the queue is not a special case of the grammar.
 *
 * `dependency-timeout` has no cycle-side twin. There is no cycle-side analogue
 * of "your dependency never finished", because a cycle that never started
 * cannot observe anything.
 *
 * `dependency-parked` is the third shape and is NOT a cap family of its own —
 * see `recordQueuePark` in work-queue-outcome.ts, which writes it as
 * `cap dependency-parked:#N`. `queue-stranded` is the fourth: a group the
 * scheduler had taken into the wait list when a halt released every worker
 * (`sweepStranded` in work-queue.ts). None of the four is raised by a cycle.
 */

import { continueHumanAction, isContinueCap } from "./work-driver-continue-pr-explain.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import {
  type EvidenceFailureKind,
  mergeHoldAction,
  mergeHoldGrantAction,
} from "./work-driver-merge-authority.ts";
import { HOST_EXHAUSTION_SUFFIX } from "./work-queue-park-reason.ts";
import { crossGroupAction } from "./work-queue-parks-claims.ts";
import { deferredLeftoverAction } from "./work-queue-parks.ts";
import type { BlockReason } from "./work-queue-scheduler.ts";

/** The caps a waiting group can end on. */
export type QueueWaitCap = "dependency-timeout" | "cross-group-conflict";

/**
 * The two names, as one list. `humanActionFor` builds its matcher from this
 * rather than repeating the alternation, so a cap added to `QueueWaitCap` and
 * `queueWaitAction` cannot be invisible to the router — `tsc` names the switch
 * it is missing from, and there is no second regex to update.
 */
const QUEUE_WAIT_CAPS: readonly QueueWaitCap[] = ["dependency-timeout", "cross-group-conflict"];

/** The cap family and the reason string a capped wait reports. */
export function waitCapFor(reason: Exclude<BlockReason, null>): {
  cap: QueueWaitCap;
  detail: string;
} {
  return reason.kind === "ordering"
    ? {
        cap: "dependency-timeout",
        detail: `dependency group(s) ${reason.waitingOn.join(", ")} never reached a terminal state`,
      }
    : {
        cap: "cross-group-conflict",
        detail: `in-flight sibling(s) ${reason.heldBy.join(", ")} held the overlapping claim`,
      };
}

/**
 * Operator action for a queue-level park.
 *
 * The SRE rule from work-queue.ts applies unchanged: a notification must name
 * what a human does that the system cannot. For these two the answer is the
 * same shape — the group never ran, so there is nothing to salvage and the
 * recovery is a re-run once the blocker is gone. Naming the state file is what
 * distinguishes it from the generic fallback, which recommends reviewing a
 * diff that does not exist.
 */
export function queueWaitAction(primary: number, cap: QueueWaitCap): string {
  const rerun = `\`/work ${primary} --restart\``;
  return cap === "dependency-timeout"
    ? `check whether the dependency cycle is still running (/work-status) — it never reached a terminal state, so this group was never dispatched. Resolve it, then re-run ${rerun}; nothing was built here to salvage`
    : `the sibling cycle holding the overlapping paths never released its claim (/work-status names it). Let it finish or stop it, then re-run ${rerun}; nothing was built here to salvage`;
}

/**
 * Operator action for the fourth queue-raised park: a group the scheduler had
 * taken into the wait list when a halt released every worker (`sweepStranded`
 * in work-queue.ts).
 *
 * Separate from `queueWaitAction` because the blocker is different in kind. A
 * wait cap names ONE sibling the group was holding its place behind; a
 * stranded group was abandoned by the queue itself, so the operator resolves
 * the halt first and only then re-runs. It lives here rather than inline at
 * the call site for the reason #1101's contract is the same everywhere: one
 * writer of queue-park action text, so the renderers and `/work-status` cannot
 * disagree about what a `cap queue-stranded:` group asks for.
 */
export function queueStrandedAction(issues: number[], blocker: string): string {
  const slug = issues.join(" ");
  return `the queue halted while #${slug} was still waiting on ${blocker} — resolve the halt /work-status reports, then re-run \`/work ${slug} --restart\`; this group never started, so nothing was built`;
}

/**
 * Human action for a parked group. Moved out of work-queue.ts (#1101) to keep
 * that module under AGENTS.md §12's 500-line cap; the matching rules are
 * unchanged and this is their single source of truth.
 *
 * The SRE rule is that a notification must name what the human should do that
 * the system cannot do itself; "it failed" is not that. If we cannot name an
 * action, we say so plainly rather than inventing one.
 */
export function humanActionFor(
  reason: string,
  primary: number,
  /** The group's full issue list, for a park whose recovery re-runs the whole
   * group. Defaults to `primary` — a cycle park's `--restart` must re-run every
   * member, not only the one issue the call happened to name. */
  issues: number[] = [primary],
): string {
  // #1101 — a group the queue never dispatched, because a dependency settled
  // non-merged, an ordering cycle has no valid order, or a wait outlasted its
  // bound. Checked first: the generic fallback below recommends inspecting a
  // diff, and there is no diff.
  const dependencyParked = reason.match(/cap dependency-parked:(\S+)/);
  if (dependencyParked) {
    return `get #${primary}'s dependency ${dependencyParked[1]} merged (or drop the declared dependency from its body), then re-run \`/work ${primary} --restart\` — this group never started, so nothing was built`;
  }
  if (/^cap dependency-cycle\b/.test(reason)) {
    const loop = reason.match(/waits on ([^)]+)\)/);
    return `break the declared dependency cycle${loop ? ` (${loop[1]})` : ""} — remove or reverse one \`Depends-on\` / \`blocked by\` statement, then re-run \`/work ${issues.join(" ")} --restart\`; nothing was built, so there is nothing to salvage`;
  }
  // #1101 — the two caps `waitCapFor` can raise, derived from the same const
  // the switch in `queueWaitAction` branches on. A hand-written alternation
  // here was a second list of the same two names, and a third cap added to
  // that switch fell through this one to "inspect a diff that does not exist".
  //
  // #1454 — `cross-group-conflict` is the ONE name this router sees from two
  // producers, so the two rules are split by provenance, not by the bare word:
  //
  //   - `^cap cross-group-conflict` + `in-flight sibling(s)` — the QUEUE's
  //     sighting (`waitCapFor`'s detail is the only thing that writes that
  //     clause). The group never dispatched: `queueWaitAction`.
  //   - a bare `cross-group-conflict` — the REACTIVE plan-time check in
  //     work-driver-path-claims.ts, raised from inside a cycle that DID
  //     dispatch, has a state file, and is parked against somebody else's
  //     claim: `crossGroupAction`, which names the CLAIMANT.
  //
  // The generic fallback both used to get is the shape that sent six operators
  // to re-run an unchanged issue into the same park.
  if (/^cap cross-group-conflict\b.*in-flight sibling\(s\)/.test(reason)) {
    return queueWaitAction(primary, "cross-group-conflict");
  }
  if (/cross-group-conflict/.test(reason)) return crossGroupAction(reason, primary);
  const waitCap = reason.match(new RegExp(`^cap (${QUEUE_WAIT_CAPS.join("|")})\\b`));
  if (waitCap) return queueWaitAction(primary, waitCap[1] as QueueWaitCap);
  // #753 — a dirty-leftover park (deferred worktree creation refused):
  // salvage the leftover BEFORE any re-run — --restart would hit the same
  // refusal.
  //
  // NOT anchored to the `cap ` prefix, unlike the queue rules above and the
  // `intent-park` / `deadline` rules below. `cap deferred-creation:develop` is
  // itself a template-shaped literal — the colon is part of the name, not the
  // reason/detail separator `recordQueuePark` writes — and a queue park whose
  // free-text detail MENTIONED a leftover path would be the misclassification
  // the anchoring exists to stop, not this one. The path suffix the action
  // reads is only ever produced by `parkReason`.
  if (/cap deferred-creation:develop/.test(reason)) {
    return deferredLeftoverAction(reason, primary);
  }
  // #378 — intent parks carry their own specific action; the generic
  // "inspect the state file and --restart" fallback is useless here, because
  // re-running an unresolvable issue unchanged produces the same park.
  // Anchored to the `cap ` prefix, for the same reason as the wait-cap rule
  // above: a queue-raised park's free-text detail can *mention* an intent
  // park's reason word without being one, and the intent advice would then
  // replace the true one.
  const intentPark = reason.match(/^cap intent-park(?::([a-z-]+))?/);
  if (intentPark) {
    return parkAction((intentPark[1] ?? "underspecified") as ParkReason, primary);
  }
  // #380 — the PR is open, green and pushed; the only thing missing is a
  // human decision. Telling the operator to `--restart` here would rebuild
  // work that is already done and open a duplicate PR.
  const heldMerge = reason.match(
    /awaiting-human-merge:(granted|no-authority):pr(\d+)(?::tooling)?/,
  );
  if (heldMerge) {
    const granted = heldMerge[1] === "granted";
    const pr = Number(heldMerge[2]) > 0 ? `#${heldMerge[2]}` : `the PR for #${primary}`;
    // The tag is carried by the reason string itself (`:tooling` suffix in
    // `parkReason` above), so the queue cannot drift from the state file:
    // untagged reasons keep the CI-flavoured action, as do pre-#745 files.
    const failureKind: EvidenceFailureKind = heldMerge[3] === "tooling" ? "tooling" : "ci";
    return granted
      ? mergeHoldAction(
          { granted, source: "doctrine" },
          Number(heldMerge[2]) || undefined,
          failureKind,
        )
      : mergeHoldGrantAction(pr);
  }
  // #380 — `--restart` after a failed merge wipes the state file but NOT the
  // open PR, so the re-run halts immediately on the pre-flight (#362).
  if (/step-failed:merged/.test(reason)) {
    return `review #${primary}'s PR and remove the cause of the merge hold — the grant in AGENTS.md, --merge for this run, or the failing gh evidence (do NOT --restart: the open PR would halt the re-run)`;
  }
  if (/lens-diff-unreadable/.test(reason)) {
    return `check that #${primary}'s branch is pushed and \`git fetch origin --prune\` is current — the review could not read the diff`;
  }
  // #1398 — the PR is mergeable while its review re-runs and the driver could
  // not put it back. `--restart` would rebuild the cycle and leave the PR
  // mergeable all the same; the one thing missing is the draft the forge
  // would not set, so the action names the command that sets it.
  if (/draft-rearm-failed/.test(reason)) {
    return `make #${primary}'s PR a draft by hand — \`gh pr ready <N> --undo\` (GitHub) or \`glab mr update <N> --draft\` (GitLab), N from the handoff — then re-run \`/work ${primary} --restart\` (do NOT skip the draft: the review re-runs on a mergeable PR)`;
  }
  const continueCap = reason.match(/\bcap (continue-pr-[a-z-]+)/)?.[1];
  if (continueCap && isContinueCap(continueCap)) return continueHumanAction(continueCap, primary);
  // #1743 — a third identical park was refused before any step ran. `--restart`
  // does NOT bypass this guard (the issue is the thing that is unchanged), so
  // the generic "inspect the state file and --restart" fallback would advise
  // the one invocation that cannot work.
  if (/\brepeat-park\b/.test(reason))
    return `revise the body of #${primary} — two cycles already parked it for this reason and a third report says nothing new (or run once with PI_ENSEMBLE_REPEAT_PARK=0; --restart alone does not clear this guard)`;
  if (/existing-pr-detected/.test(reason))
    return `decide whether to resume, retarget or close the open PR for #${primary}`;
  if (/explore-needs-clarification|step-back-revise-spec/.test(reason)) {
    return `revise the body of #${primary} — the spec is underspecified`;
  }
  if (/explore-already-complete/.test(reason)) return `confirm and close #${primary}`;
  // #1243 — the endpoint caused this park, not the work. The advice must match
  // explainCap AND the driver's actual re-entry behaviour: a provider park
  // terminalises as `interrupted` (reason `provider`), which the driver
  // re-enters, so a plain `/work N` resumes the halted step. `--restart` would
  // wipe the state file and rebuild a cycle whose steps are all still there to
  // resume from. Pre-fix this advice said "resumes where it stopped" while the
  // park terminalised as the terminal `handoff`, which REFUSES a plain re-run —
  // advice no invocation could follow.
  if (/provider-unavailable/.test(reason))
    return `re-run \`/work ${primary}\` once the model endpoint answers — this park stays resumable, so the halted step re-enters and finished steps are not rebuilt; do NOT pass --restart (nothing about this cycle's code was judged: there is no defect to inspect)`;
  if (/explore-bodies-empty/.test(reason))
    return "fix the gh setup (`gh auth status`), then re-run";
  if (/round-cap|adversarial-loop|wall-clock/.test(reason)) {
    return `review the findings on #${primary}'s PR — the fix loop did not converge`;
  }
  // Anchored like the two above: `deadline` is ordinary English and the
  // queue's park details are free text (`dependency group(s) … never reached
  // a terminal state`), so an unanchored match let a queue park take the
  // cycle-deadline action.
  if (/^cap deadline\b/.test(reason)) {
    return `the caller's cycle deadline was reached — raise or clear PI_ENSEMBLE_CYCLE_DEADLINE/PI_ENSEMBLE_CYCLE_BUDGET_MS and re-run \`/work ${primary} --restart\` (the handoff names the branch, PR and round the work reached)`;
  }
  // #1421 — checked BEFORE the `verify-env:` rule below: a build-residue park
  // shares that cap family with the fork failure, and the advice differs.
  // Anchored to the `:build-residue` suffix `parkReason` writes — the ONLY
  // carrier this match reads. A bare `[build-residue]` / substring match read
  // the same advice out of a failure string that merely MENTIONED the tag
  // (an operator path named `build/[build-residue].log`, a quoted line from
  // the log), which would send someone to the build for a park the gate
  // raised on the code.
  if (/:build-residue\b/.test(reason))
    return `#${primary}'s cycle was declined by git-ignored build output in the repo root — keep the project's build out of the checkout (CARGO_TARGET_DIR or a .gitignore entry), clear what is there, then re-run \`/work ${primary} --restart\` (the diff was never judged)`;
  if (reason.includes(HOST_EXHAUSTION_SUFFIX) || /verify-env:/.test(reason)) {
    return `free processes on the host (it could not fork — the gate never ran on #${primary}), then re-run \`/work ${primary} --restart\``;
  }
  if (/verify-timeout/.test(reason))
    return `the verify command timed out on #${primary} — raise PI_ENSEMBLE_VERIFY_TIMEOUT_MS or reduce concurrency, then re-run \`/work ${primary} --restart\``;
  // #1349 — parks the gate raised without judging the change.
  if (/verify-baseline-red/.test(reason))
    return `the verify command already fails at #${primary}'s base commit — fix the gate on the mainline, then re-run \`/work ${primary} --restart\``;
  if (/pr-not-open/.test(reason))
    return `#${primary}'s PR is no longer open — decide whether the work belongs in a new PR`;
  // #1472 — a person closed the issue; the driver stopped and merged nothing.
  if (/issue-closed/.test(reason))
    return `#${primary} is CLOSED — a person ended it mid-cycle. If the work is still wanted, reopen it (\`gh issue reopen ${primary}\`) and re-run \`/work ${primary} --restart\``;
  if (/fix-pass-park/.test(reason))
    return `read the fix pass's reason in #${primary}'s handoff — the adversarial fix pass parked on its own check`;
  if (/verify-failed/.test(reason))
    return `inspect #${primary}'s diff — the outcome gate rejected it`;
  return `inspect .pi/work-state/${primary}.json and re-run \`/work ${primary} --restart\``;
}
