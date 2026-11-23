/**
 * lean/derive-guards — regression guards: the ticket sentences that only ask existing behaviour to
 * keep working ("the existing checks still pass", "no regressions", "nothing else changes").
 *
 * Such a sentence is green on the base by construction, so as a criterion it is one `specify` can
 * never prove red, and coverage `all-criteria` refuses the whole run over it. A guard is therefore
 * NOT a criterion: `derive` keeps it beside the contract (`DerivedSpec.guards`), it never enters
 * `testCriteria`, and the run's full verify tier — which `ci` requires before a run can land — is
 * what enforces it. No guard is ever executable text: derive authors no command.
 *
 * The deriving child is asked to sort guards out itself; {@link isRegressionGuard} is the
 * deterministic arm that moves a bullet whose WHOLE text is such a demand, so the guard/criterion
 * split does not depend on model wording. The behaviour has no knob. It is deliberately narrow,
 * because a bullet it moves loses its red test: the subject must be named as existing ("the
 * existing …", "all pre-existing …"), so "the other tabs still work" — which may be the bug
 * itself — is left to the child, which sees the ticket; and a mixed sentence ("X returns 3 and
 * the build still passes") stays a criterion.
 */

import { criterionText } from "../pi-spec-map.ts";

/** The most guards a derived record carries. */
export const GUARD_MAX = 8;

/** One regression guard, as the derived record persists it. */
export interface Guard {
  text: string;
}

/** The not-ready reason for a ticket whose every bullet is a guard. */
export const GUARDS_ONLY_RULE =
  "the ticket asks only that existing checks keep passing — there is no new behaviour to build";

const KEEPS =
  /^(?:(?:the|all|every|any)\s+)?(?:existing|pre-existing)\b[^,;:!?]*?\s(?:still|continues? to|keeps?)\s+(?:pass|passes|passing|work|works|working|succeeds?|succeeding|builds?|building)(?:\s+as before)?\s*\.?$/i;
const NOTHING_ELSE =
  /^(?:there (?:are|is)\s+)?(?:no regressions?|nothing else (?:changes|breaks))\s*\.?$/i;

/** Whether a bullet's whole text only demands that existing behaviour keeps working. */
export function isRegressionGuard(text: string): boolean {
  const t = text.trim();
  return (KEEPS.test(t) && !/\bnew\b/i.test(t)) || NOTHING_ELSE.test(t);
}

/** Why a persisted `guards` field is not one derive could have written, or `undefined`. */
export function guardsProblem(guards: unknown): string | undefined {
  if (!Array.isArray(guards) || guards.length === 0 || guards.length > GUARD_MAX)
    return `derivedSpec.guards must be 1 to ${String(GUARD_MAX)} guards`;
  for (const g of guards) {
    const text = (g as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text === "" || criterionText(text) !== text)
      return "derivedSpec.guards carries a guard that is not one bounded line of text";
  }
  return undefined;
}
