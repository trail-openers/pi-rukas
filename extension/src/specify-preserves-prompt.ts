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
 * The preservation clause, or `""` when the switch is off — off, the prompt is the bytes from before the
 * field existed, which is what makes the field unreadable on that arm rather than merely unused.
 */
export function preservesPromptClause(): string {
  if (!leanSpecifyPreservesEnabled()) return "";
  return `**A criterion whose behaviour must keep working — rather than be newly built — is a preservation criterion, and you say so when you submit it: pass \`${PRESERVES_FIELD}: true\` on its \`submit_tests\` call.** Its test PASSES on the base commit by design, because it asks existing behaviour to keep holding; that is not a failure to write a red test. A preserved file is frozen as part of the contract and MUST pass at head, so assert real behaviour in it: a preserved file that asserts nothing is indistinguishable from a guard, and it still has to stay green. \`false\`, or no \`${PRESERVES_FIELD}\` at all, is the ordinary red test. At least one criterion must still be red on the base: a spec whose every criterion is preserved has nothing to build.`;
}
