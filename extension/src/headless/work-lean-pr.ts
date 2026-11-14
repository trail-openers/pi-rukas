/**
 * headless/work-lean-pr — the PR-side readings of a lean run's record: whether it opened
 * a PR, what head that PR stands on, and whether the run's own gate cleared that exact
 * head.
 *
 * Split from `work-lean-result.ts` along the seam the fields already had: the status and
 * failure readers ask what the run DID, these ask what the run SHIPPED and who certified
 * it. They are also the readers `headless/work-lean-gates.ts` borrows rather than
 * restating — the two head fields on `gates.handback` and `prState` are one answer read
 * through these functions, which is the only reason two surfaces cannot tell two stories
 * about the same commit.
 *
 * The load-bearing rule is in `gateClearedPublishedHead`: a green is worth nothing unless
 * it is about the head that shipped, and a newest step with no outcome is a crash, not a
 * verdict. Wherever evidence is missing the answer is `draft`, the safe side — a host
 * told `ready` merges, a host told `draft` goes and looks.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { validPrUrl } from "../lean/state-outcome.ts";
import type { Step } from "../lean/state.ts";
import { newestDecided } from "../lean/state.ts";
import type { IssueResult } from "./result.ts";

/**
 * The newest DECIDED `publish` step's URL, if the run got that far.
 *
 * `newestDecided` is the log's own rule (an outcome-less step is a crash
 * mid-step and has said nothing), so a newer `publish` that decided without a
 * URL reports no URL — reading one from an earlier publish would hand the host
 * the address of a PR this run replaced. The value is then re-checked with the
 * load-time rule `handback` applies rather than trusted: the log this projection
 * reads is a `Step[]`, and the loader is not the only thing that hands one over.
 * A URL that breaks the shape is not a link a host should open, and it is not a
 * PR either — which is why `prState` asks THIS function, not the raw field.
 */
export function prUrlOf(steps: Step[]): string | undefined {
  return validPrUrl(newestDecided(steps, "publish")?.outcome?.prUrl);
}

/**
 * The full head the publish step says it shipped: its typed `publishedHead`,
 * re-checked with the SAME shape rule the loader enforces — the loader is not the
 * only thing that hands a `Step[]` over (an in-memory log from a run that just
 * finished never passed through it), exactly as `prUrlOf` revalidates the URL.
 * A publish that recorded no head, or one that is not an oid, returns
 * `undefined`, and that is what makes `prState` refuse `ready`. The reason line's
 * `at <sha>` is NOT read: prose is what this field exists to replace.
 */
export function publishedHeadOf(publish: Step | undefined): string | undefined {
  const head = publish?.outcome?.publishedHead;
  return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
}

/**
 * The newest step in the WHOLE log whose `state` matches, decided or not. Log
 * POSITION is what makes a verdict the run's current one — `newestDecided` would
 * skip an outcome-less step and let an older verdict speak for a gate that died.
 */
export function newestAttempt(steps: Step[], state: Step["state"]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.state === state) return steps[i];
  }
  return undefined;
}

/**
 * Did the gate clear the exact tree this publish step shipped? One reader: the
 * NEWEST `verify`, the same record `lean/engine.ts`'s `landEarned` reads, plus the
 * rule that the green is about the head `publish` pushed. The `startedAt` filter
 * this used to carry was wrong: a re-run leaves a verdict NEWER than the publish,
 * and reading an older green over it told a host to merge work its gate had since
 * called red. A `ci` is read by position too, and only ever REJECTS — an absent
 * `ci` is unjudged, not refused (lean has no `ci` step built), while a newest `ci`
 * that is not green is the pipeline's verdict against the head the PR stands on.
 *
 * An outcome-less newest `verify` or `ci` is a crash mid-step, so the gate is
 * UNOBSERVED; a publish with no head, or a green with none, the same. Every one of
 * these goes to `draft`.
 */
export function gateClearedPublishedHead(steps: Step[], head: string | undefined): boolean {
  if (head === undefined) return false;
  // Absent `ci` is unjudged, not refused; but when a `ci` exists its NEWEST step
  // must be green — an outcome-less one is a crash mid-pipeline, not a green.
  const ci = newestAttempt(steps, "ci");
  if (ci !== undefined && ci.outcome?.kind !== "green") return false;
  const gate = newestAttempt(steps, "verify");
  if (gate?.outcome?.kind !== "green") return false;
  const verified = gate.outcome.verifiedHead;
  return typeof verified === "string" && isFullCommitSha(verified) && verified === head;
}

/**
 * Was the PR ready, a draft, or was there no PR at all? The typed answer to the
 * question exit 10 cannot ask.
 *
 * - `ready` — `counters.draft` is false, publish recorded `draft === false`, and
 *   the NEWEST `verify` is green about the very head publish says it shipped
 *   (an outcome-less newest `verify` is a crash, not a green), with no newest
 *   `ci` that is not green; a run with no `ci` step is unjudged, not refused;
 * - `draft` — `counters.draft` is true, or publish recorded `draft === true`, or
 *   anything about the claim is missing;
 * - `none` — no publish step left a PR URL.
 *
 * AN UNOBSERVED DRAFT STATE GOES TO `draft`, THE SAFE SIDE. `publish` records
 * the state the forge REPORTED rather than the one it asked for (that is
 * #1920 slice A's rule, and why the field is optional), so a publish outcome
 * with no `draft` is the one case where nobody knows. Guessing `ready` tells a
 * host to merge bytes its own gate never cleared; guessing `draft` costs a
 * person one look at the PR. The asymmetry decides it, and it decides every
 * missing half of the `ready` evidence the same way — `run.counters.draft`
 * included, which is the engine's own refusal (`landEarned` reads it FIRST).
 */
export function prStateOf(steps: Step[], draftCounter: boolean): IssueResult["prState"] {
  const publish = newestDecided(steps, "publish");
  if (publish === undefined || prUrlOf(steps) === undefined) return "none";
  // The forge's own answer, or the run's own counter: either needs no second opinion.
  if (draftCounter || publish.outcome?.draft === true) return "draft";
  // `ready` is the only claim needing every half of its evidence: the forge said
  // the PR is not a draft, the gate went green, and that green was about the head
  // publish pushed. Anything else is `draft`, the safe side: a host told `ready`
  // merges, a host told `draft` goes and looks.
  if (publish.outcome?.draft !== false) return "draft";
  return gateClearedPublishedHead(steps, publishedHeadOf(publish)) ? "ready" : "draft";
}
