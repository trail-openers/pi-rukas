/**
 * work-driver-path-claims-siblings — #1101: which path claims the queue is
 * already waiting down, so the reactive plan-time check stops parking a cycle
 * whose sibling the same queue is coordinating.
 *
 * Split from `work-driver-path-claims.ts` for the 500-line gate (AGENTS.md §12).
 * It is a seam of its own rather than a further slice of the registry because
 * it holds the module-level state the registry consults — the sibling set — and
 * the one `PID` comparison that decides sibling-vs-foreign. The registry reads
 * it; nothing else does.
 *
 * #1101 — `claimWaitsForIssues` is the boundary between the two kinds of
 * sibling the registry sees, and `setSiblingClaimWait` is what opens that
 * boundary: the queue declares the issue set it coordinates before any group
 * starts (see `runGroupedIssues` in work-entry-queue.ts) and clears it on every
 * exit path. A claim held by ANOTHER process is a genuinely uncoordinated second
 * opinion: nothing in this invocation can wait it down, so the immediate
 * `cross-group-conflict` park is correct and unchanged. A claim held by THIS
 * process belongs to a sibling group of the same queue, which the queue can
 * hold back until that sibling settles — parking it here is the bug, because the
 * loss arrives after explore+plan have already been paid for.
 */

/** The process that owns this queue. A claim from any other pid is never a sibling. */
const PID = process.pid;

/**
 * #1101 — issues whose cycle is a sibling of this one IN THE SAME PROCESS, and
 * whose path claims therefore must not park this cycle at plan.
 *
 * The queue registers a sibling's claim before it dispatches the group, and
 * drops it once the group settles. `readClaims` filters those entries out, so
 * `checkAndRegisterClaims` sees only claims this invocation cannot wait down:
 * another process's. That keeps the out-of-scope contract — cross-process
 * claim semantics are untouched — while the in-invocation case becomes a wait
 * in `work-queue.ts` instead of a park here.
 *
 * A `Set`, not an array: the membership test runs once per claim per plan step,
 * and an array read as "scan the sibling list" invites a `.includes` on a
 * growing queue. `null` (the default) disables the filter entirely, which is
 * the pre-#1101 behaviour and what every caller that does not know about this
 * gets.
 */
let siblingWaitIssues: Set<number> | null = null;

/**
 * Declare (or with `null`, clear) which issues are same-process siblings.
 *
 * #1101 fix-round — until this had no caller the whole sibling filter was
 * inert: `siblingWaitIssues` stayed `null`, so `claimWaitsForIssues` answered
 * `false` for every claim and an in-invocation sibling's plan-time claim parked
 * the dependent at plan with `cross-group-conflict`, which is precisely the
 * dispatch the queue's ordering edge exists to prevent. Its caller is
 * `runGroupedIssues`, which sets the full invocation issue set before workers
 * start and clears it in a `finally`.
 *
 * Module-level state, like the registry file it filters: one /work queue per
 * process is the assumption the rest of the claims registry already makes, and
 * a second concurrent queue would see the other queue's groups as siblings of
 * its own — which is the same answer, not a wrong one.
 */
export function setSiblingClaimWait(issues: Iterable<number> | null): void {
  siblingWaitIssues = issues === null ? null : new Set(issues);
}

/** Whether a claim on `issue` is a same-process sibling the queue can wait on. */
export function claimWaitsForIssues(issue: number, pid: number): boolean {
  // Same-process only. A claim from another pid is never a sibling, whatever
  // the set says — that is the boundary the out-of-scope rule draws.
  if (pid !== PID || siblingWaitIssues === null) return false;
  return siblingWaitIssues.has(issue);
}

/**
 * The sibling set currently in force, for the tests that have to prove the
 * filter is LIVE rather than merely installed.
 *
 * `readClaims` is the production reader and it is what the wiring must fool, so
 * asserting through it is right — but a filter that always answered "sibling"
 * would satisfy that too. This is the negative half: `null` outside a queue,
 * the invocation's issues inside one. Test-only; no production caller reads
 * what a caller just wrote.
 */
export function siblingClaimWaitSnapshot(): number[] {
  return siblingWaitIssues === null ? [] : [...siblingWaitIssues];
}
