/**
 * /work workflow state — the commit-pr fallback-cause vocabulary (#539, M1).
 *
 * Split out of `workflow-state-events.ts` for the same reason the memory
 * fragments live in `workflow-state-events-memory.ts` (AGENTS.md §12
 * file-size limit): a pure event-type fragment the composed union
 * references. It lives in the event-layer module tree — NOT in
 * work-driver-commit.ts — because this pure type module is imported by
 * almost everything (including the driver's runtime modules); the
 * dependency points one way only.
 *
 * The SINGLE definition of the vocabulary. The writer
 * (`mechanizedCommitPr` / `runCommitPrLocked` in work-driver-commit.ts)
 * imports it, and the `plumb-report` event field references it — the two
 * sites must never re-declare the union inline, or they drift the way the
 * adversarial verdict vocabulary did. `apply-conflict` remains for
 * pre-#539 state; the writer now labels apply failures `other` because
 * integrate()'s structured `failure` names only dirty-repoRoot.
 *
 * #1439 — `push-refused` names the forge's server-side refusal of the push (GitHub
 * push protection / repository rules / a non-fast-forward). It is in this vocabulary
 * as well as in `IntegrateResult.failure` because a push refusal never reaches the ops
 * fallback (the caller parks terminally); the label is what the plumb-report and the
 * handoff render for it, and what distinguishes it from an ordinary `other` fallback
 * in an old state file.
 */
export type CommitPrFallbackCause = "dirty-repoRoot" | "apply-conflict" | "push-refused" | "other";
