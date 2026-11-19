/**
 * work-driver-explain-push-refusal — the handoff sentence for `push-refused:<step>`
 * (#1439): the forge refused the push.
 *
 * Split from work-driver-explain.ts for the AGENTS.md §12 500-line cap, and kept
 * separate from `explainVerifyFailed` on purpose: this park is NOT a verify failure.
 * The consolidated commit is committed locally and intact, the project's verify
 * command ran and passed before the push was attempted, and what stopped the cycle is
 * the remote's own policy on the content. Explaining it in verify vocabulary is
 * precisely the #1439 defect — the operator of that cycle read "the verify command
 * failed … fix the change" for a GitHub push-protection refusal.
 *
 * #2393 — a refusal because the branch MOVED (non-fast-forward, `fetch first`, a failed
 * lease) or because of a repository rule or branch protection gets its own sentence:
 * nothing was flagged, so it never says to allow content. The moved branch's steps are
 * the cause verdict's (`movedBranchSteps`).
 */

import { movedBranchSteps } from "./work-driver-cause-class-push-refusal.ts";
import { pushRefusalKind } from "./work-driver-push-refusal.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * The sentence. The refusal text is the cap's own evidence (written by
 * `runCommitPrLocked` from `integrate()`'s structured `failure: "push-refused"`), so
 * it is quoted rather than re-derived; the branch is named because the operator's next
 * command runs against it by hand.
 */
export function explainPushRefusal(state: WorkState): string {
  const hit = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkState["eventLog"][number], { kind: "cap-hit" }> =>
        e.kind === "cap-hit" && e.cap.startsWith("push-refused:"),
    );
  const branch = state.pipelineState.branchName ?? "(branch not captured)";
  const refusal = hit?.evidence ?? "(the refusal text was not recorded on the cap)";
  const kind = pushRefusalKind(hit?.evidence);
  if (kind === "moved") {
    return `the forge refused the push of \`${branch}\` because the remote branch moved, so nothing was published and no PR was opened. Nothing was flagged: the remote branch is not at the commit this push expected. An earlier push of this cycle, or someone else, changed it. The commit is consolidated and committed locally, and the gate passed before the push was attempted. The driver did NOT force-push over the remote branch, and a plain re-run is refused the same way. To go on, ${movedBranchSteps(state.issue, branch)}. Refusal as recorded:\n${refusal}`;
  }
  if (kind === "rule") {
    return `the forge refused the push of \`${branch}\` because of a repository rule or branch protection, so nothing was published and no PR was opened. No secret was flagged, and this is not the project's verify command: the commit is consolidated and committed locally, and the gate passed before the push was attempted. The refusal below names the rule. Have a repository admin change the rule or exempt the branch, or change the work so it meets the rule, then re-run. Refusal as recorded:\n${refusal}`;
  }
  return `the forge refused the push of \`${branch}\`, so nothing was published and no PR was opened. This is not the project's verify command and not a defect in the change: the commit is consolidated and committed locally, and the gate passed before the push was attempted. The remote refused the CONTENT — GitHub push protection (GH013) or repository rules usually flag secret-shaped strings, and a fixture that carries a realistic-looking key trips it even when the key is a published documentation example. The driver deliberately did NOT fall back to an ops dispatch (a child cannot lift a refusal the remote issued) and did NOT force-push. Two ways forward, both upstream of the code: allow the flagged content at the URLs in the evidence below, or change the issue/fixtures so the content is never committed (assemble test secrets from fragments at runtime), then re-run. Refusal as recorded:\n${refusal}`;
}
