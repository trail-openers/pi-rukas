/**
 * lean/verified-handback-switch — the ONE reader of the switch that decides
 * whether a handback ships the last verified head.
 *
 * A handback whose newest work step is a `fixed` review leaves origin holding
 * bytes no `verify` ever certified. With the switch on the step moves origin's
 * branch back to the newest decided green before it reports, and records which
 * head shipped; with it off the step reports and moves nothing, exactly as it
 * did before the rule. Only the literal `"0"` turns it off; unset and any other
 * value leave it on.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file
 * runs in one bun process and pins off/on arms with `withEnv`, so a load-time
 * read would let one file's pin silently disable the rule in the next.
 */

/** Whether a handback rewinds origin to the last verified head. */
export function leanVerifiedHandbackEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK !== "0";
}

/**
 * Whether a handback that had NO verified head records what it shipped anyway.

 * The rewind rule has a second arm the first one leaves unsaid: the rule fired,
 * found no green `verify` to take a head from, and moved nothing — so origin still
 * holds the head the fix wave pushed, and the handback ships it. The step already
 * knows this (it is the `NO_HEAD` shape `handback-rewind.ts` names), but until now
 * it kept the knowledge to itself: with no head to move there was no head to name,
 * and the four head fields stayed absent. That made "the rule fired and had no
 * head" indistinguishable in the record from "the rule never spoke", which is the
 * one confusion the recording exists to remove — an operator reading the handed-back
 * run could not tell a certified head that was moved back from an uncertified one
 * that was left in place.
 *
 * With the switch on, that handback records the head origin really holds, calls it
 * NOT verified, and carries the rule's own reason. With it off the step reports as
 * it did before the recording existed: no head fields at all. Only the literal
 * `"0"` turns it off; unset and any other value leave it on.
 */
export function leanHandbackNoHeadRecordEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_HANDBACK_NOHEAD_RECORD !== "0";
}
