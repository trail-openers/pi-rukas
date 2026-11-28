/**
 * specify-preserves-prompt — the sentences that tell the specify CHILD the declaration exists.
 *
 * Without prompt text naming the field no child ever sets it and the behaviour it unlocks is unreachable, so
 * this clause is a criterion of the feature rather than decoration: the panel-shaped test drives a fake child
 * through the real prompt and asserts the prompt names the field.
 *
 * One const for the same reason `RED_PROOF_CONTRACT` is one: the kickoff and both retries must tell the child
 * the same rule, and a clause re-worded at one call site is a rule the child reads two ways.
 */
import { leanSpecifyPreservesEnabled } from "./lean-specify-preserves-switch.ts";
import { PRESERVES_FIELD } from "./submit-tests-preserves.ts";

/**
 * The clause and its own blank line, as a pair: when the switch is on and the spec has test criteria, the
 * clause and the blank line are both emitted; when either is absent, both lines are empty, which is what the
 * prompt held before the field existed. Present or absent as ONE unit, so the off arm is the pre-field bytes
 * rather than that prompt with a line missing — which is what makes the field unreadable there, not unused.
 */
export function preservesPromptLines(testsAreSubmitted: boolean): string[] {
  return leanSpecifyPreservesEnabled() && testsAreSubmitted
    ? [preservesPromptClause(), ""]
    : ["", ""];
}

/**
 * The preservation clause, or `""` when the switch is off.
 */
export function preservesPromptClause(): string {
  if (!leanSpecifyPreservesEnabled()) return "";
  return `**A criterion whose behaviour must keep working — rather than be newly built — is a preservation criterion, and you say so when you submit it: pass \`${PRESERVES_FIELD}: true\` on its \`submit_tests\` call.** Its test PASSES on the base commit by design, because it asks existing behaviour to keep holding; that is not a failure to write a red test. A preserved file is frozen as part of the contract and MUST pass at head, so assert real behaviour in it: a preserved file that asserts nothing is indistinguishable from a guard, and it still has to stay green. \`false\`, or no \`${PRESERVES_FIELD}\` at all, is the ordinary red test. At least one criterion must still be red on the base: a spec whose every criterion is preserved has nothing to build.`;
}
