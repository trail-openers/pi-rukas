/**
 * work-driver-explain-claims — the operator sentences for path-claim caps:
 * a claims-lock refusal and a cross-group path conflict.
 *
 * Split from `work-driver-explain.ts` for the 500-line cap (AGENTS.md §12),
 * the same seam `work-driver-explain-other.ts` / `-lens.ts` / `-verify.ts`
 * use. Both caps explain the path-claim registry: the lock refusing a
 * registration (`work-driver-path-claims-lock.ts`) or a live sibling's claim.
 *
 * #1454 r3 — before this case existed the refusal escaped `checkAndRegisterClaims`
 * and the driver recorded `driver-crash:plan`, whose sentence says "an
 * unhandled error in the step handler". That is the wrong diagnosis by an
 * order of magnitude: the driver is fine, `.pi/work-state` is not, and an
 * operator told their driver crashed will re-run the cycle instead of fixing
 * the directory.
 */

import { NO_ID_FIELD, type OwnerIdentity, selfIdentity } from "./process-liveness.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * Why the claims lock refused, read off the refusal text the cap recorded.
 *
 * The two refusals carry distinct texts on purpose (a live sibling holding the
 * lock vs. a lockfile that cannot be created), and the operator's action for
 * them is opposite — wait it out versus chmod — so they are told apart here
 * rather than merged into one "the lock is busy" sentence.
 */
export function explainClaimsLock(cap: string, state: WorkState): string {
  const hit = lastCapHit(state, cap);
  const detail = (hit?.evidence ?? "").slice(0, 200);
  const cause =
    /cannot be created/.test(detail) || /writable/.test(detail)
      ? "the lockfile could not be CREATED — check that `.pi/work-state` exists and is writable by the driver's user (a read-only checkout, a root-owned `.pi`, or a full disk all look like this)"
      : "another cycle held the claims lock past the wait window — check for a leftover `.pi/work-state/path-claims.lock` whose holder pid has exited";
  return `the cycle parked at plan because the path-claim registry could not be written: ${cause}. No claim was registered and nothing was written unserialised — a claim written outside the lock is exactly the lost update that lets two workstreams edit one file, so the driver refuses rather than proceeding. The cycle's own work is intact; fix the directory or clear the stale lock and re-run /work`;
}

/**
 * Does this claim entry carry a FULL identity (host, pidns and pid with a
 * start time), the shape that means the holder lives where this process cannot
 * probe it?
 *
 * #1871 — a `"-"` pidns is the `NO_ID_FIELD` sentinel `selfIdentity()` writes on
 * a host with no `/proc` (macOS), and there the pid IS on this host and IS
 * checkable: `judgeOwner` treats two `"-"` namespaces as matching precisely so
 * the probe keeps working. So a `"-"` pidns gets the full-identity WORDING only
 * when the holder's host differs from ours — on our own host the legacy "check
 * the pid" sentence is the true one, and telling an operator to go looking in
 * another namespace would send them away from the one place the answer is.
 */
function hasFullIdentity(ev: string, self: OwnerIdentity): boolean {
  // `describeClaimHolder` renders a full identity as `<host> <pidns> <pid>
  // <startTime>` in the evidence; a pre-#1871 holder renders as
  // `pid <n> (identity unknown — written before #1871)`.
  const m = /holder: (\S+) (\d+|-) (\d+) (\d+|-)/.exec(ev);
  if (!m) return false;
  if (m[2] === NO_ID_FIELD && m[1] === self.host) return false;
  return true;
}

/** Why two cycles' declared paths collided, and when the claim is stale. */
export function explainCrossGroupConflict(state: WorkState): string {
  const hit = lastCapHit(state, "cross-group-conflict");
  const ev = hit?.evidence ?? "";
  const siblingMatch = ev.match(/claimant(\d+)/) ?? ev.match(/issue #(\d+)/);
  const siblingIssue = siblingMatch ? siblingMatch[1] : "(see evidence)";
  // #1871 F8 — a full identity means the holder is in another pid namespace (or
  // another host), so the operator CANNOT check its pid here and the age rules
  // are the only thing that will clear it. The sentence says so, names both
  // bounds, and points at the troubleshooting entry instead.
  if (hasFullIdentity(ev, selfIdentity())) {
    return `this cycle's declared paths overlap with issue #${siblingIssue}'s path claim — two cycles cannot edit the same files in parallel. The overlapping paths are in the event log evidence field. The holder's identity is a full one (host, pid namespace, pid, start time), so its process lives in ANOTHER pid namespace or on another host: this machine's pid table cannot confirm or clear it, and there is nothing to check on this host. The claim stops counting for a cycle on this host once it is older than the claim stale bound (PI_ENSEMBLE_CLAIM_STALE_MS, 1 h by default) and the next writer deletes it after 24 × that. To clear it now, follow "A slot or a path claim is held by another container" in docs/troubleshooting.md and remove that one entry from the claims file the evidence names. Only when #${siblingIssue} is genuinely still running on its own host is this a real conflict; then re-plan with disjoint file sets.`;
  }
  // #1454 — the old sentence said "active claim" and told the operator to
  // "coordinate with the other cycle's owner". In every park we measured
  // the other cycle had already exited or parked, so the advice was
  // unreachable and the re-run re-parked. A claim is honoured only while
  // its owner is alive AND its state file is non-terminal; a stale one is
  // pruned on the next read. This is the wording for a legacy entry, whose
  // pid IS on this host and therefore IS checkable.
  return `this cycle's declared paths overlap with issue #${siblingIssue}'s path claim — two cycles cannot edit the same files in parallel. The overlapping paths are in the event log evidence field. A claim is honoured only while #${siblingIssue}'s cycle is still running: if that pid has exited, or its state file reads merged/handoff/aborted, the claim is stale and the next /work prunes it — check the pid and .pi/work-state/${siblingIssue}.json before anything else. Only when #${siblingIssue} is genuinely still running is this a real conflict; then re-plan with disjoint file sets.`;
}
