/**
 * decision-compose — the one place a model answer is combined with a rule
 * answer (#1308). Every seam's composition policy is applied here, and the
 * fail-closed invariant is checked here after it, so a policy bug cannot
 * leak a pass:
 *
 *   A model answer never turns a non-passing rule outcome into a pass, except
 *   under `replace` WITH a passing evidence check.
 *
 * An abstained model (no valid answer) always yields the rule's answer, and
 * so does every mode other than `enforce` — `shadow` logs the model only.
 */

import {
  type DecisionMode,
  type SeamSpec,
  isFailClosed,
  isPassing,
} from "./decision-seam-registry.ts";

export interface Composed {
  answer: string;
  fromModel: boolean;
  /** Why the outcome is what it is — goes into the decision log. */
  result: string;
}

/**
 * @param rule the rule's answer, already resolved (`UNDECIDED` → the seam's default)
 * @param undecided whether the rule actually returned `UNDECIDED`
 * @param model the model's validated label, or undefined when it abstained
 */
export function compose(
  spec: SeamSpec,
  mode: DecisionMode,
  rule: string,
  undecided: boolean,
  model: string | undefined,
  evidencePassed: boolean,
): Composed {
  const keep = (result: string): Composed => ({ answer: rule, fromModel: false, result });
  if (mode !== "enforce") return keep(`${mode}: the rule's answer stands`);
  if (model === undefined) return keep("model abstained: the rule's answer stands");

  let picked: Composed;
  switch (spec.composition) {
    case "advisory":
      picked = keep("advisory: logged only");
      break;
    case "may-add-only":
      picked =
        isPassing(spec, rule) && !isPassing(spec, model)
          ? { answer: model, fromModel: true, result: "may-add-only: the model added a flag" }
          : keep("may-add-only: the model can only add a flag");
      break;
    case "tie-break":
      // The contract forbids tie-break on a fail-closed seam; refuse it here too.
      picked =
        undecided && !isFailClosed(spec)
          ? { answer: model, fromModel: true, result: "tie-break: the rule was undecided" }
          : keep("tie-break: the rule decided");
      break;
    case "replace":
      picked =
        spec.evidence === "quote" && evidencePassed
          ? { answer: model, fromModel: true, result: "replace: evidence verified" }
          : keep("replace: no verified evidence, so the rule's answer stands");
      break;
    default:
      picked = keep("unknown composition: the rule's answer stands");
  }

  // The invariant, checked independently of the switch above.
  const loosened = !isPassing(spec, rule) && isPassing(spec, picked.answer);
  if (loosened && !(spec.composition === "replace" && evidencePassed)) {
    return keep("refused: a model answer cannot turn a fail into a pass");
  }
  return picked;
}
