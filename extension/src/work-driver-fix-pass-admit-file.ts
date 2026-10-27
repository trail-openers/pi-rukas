/**
 * work-driver-fix-pass-admit-file — #1846: the per-file admission DECISION of
 * the adversarial fix pass, in one function with one precedence order.
 *
 * `postPassFault` (work-driver-adversarial-fix-scope.ts) used to inline the
 * whole route ladder — direct set, spec pattern slot, corrective round, and the
 * two #1846 rules — across two loops. The ladder is the module's most
 * safety-relevant code and the part #1846 changed, so it lives here where its
 * precedence can be read and tested in one place, and the fence keeps the loops
 * and the fan-out ceiling.
 *
 * THE PRECEDENCE IS THE CONTRACT, and every step exists because a weaker proof
 * once admitted something a stronger one was about to refuse:
 *
 *   1. the DIRECT set (`fence.admits`: declared, or already-changed when nothing
 *      is declared, plus the finding-named widening) — the pass's own scope, so
 *      no route below is asked and no route's budget is spent on it;
 *   2. the SPEC PATTERN SLOT admitter, whose `fenced` / `protected` refusals are
 *      FINAL — a fence the plan wrote and the protected-path gate's decision
 *      outrank any widening a round or a name-based rule could offer;
 *   3. the CORRECTIVE ROUND — asked whenever its refusals are not outranked, for
 *      EVERY such file, whether or not a round exists (#1698(b)'s "no round, no
 *      route": with no record there is nothing to ask, and the park says nothing
 *      about a route that never ran);
 *   4. only then the pass's OWN rules (`admitFixPassFile`), and only for a file
 *      this pass itself changed.
 *
 * Step 3's refusal ENDS the question: when the round said no, step 4 is not
 * asked and the park carries the round's bound as the reason.
 * `CORRECTIVE_ADMIT_MAX` bounds one driver-dispatched round, and a rule derived
 * from a file's NAME that admitted the file after that refusal would spend none
 * of the budget, multiply the round's reach, and name the wrong gate.
 *
 * Step 4's `changedByPass` gate is PM decision #1846-2: a file the pass did not
 * change is judged by the pre-#1846 rules only, so a pre-existing file is never
 * "an anchored helper" and the fan-out numerator cannot be widened by it.
 *
 * Split from work-driver-adversarial-fix-scope.ts for the AGENTS.md §12 limit.
 */

import { type CorrectiveVerdict, outranksCorrective } from "./work-driver-corrective-admission.ts";
import { fenceMatches } from "./work-driver-declared-path.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";
import {
  type FixPassAdmission,
  type FixPassFence,
  admitFixPassFile,
  admitsEntry,
} from "./work-driver-fix-pass-admission.ts";
import type { Stray } from "./work-driver-fix-pass-park-reason.ts";
import type {
  Admission,
  AdmissionRefusal,
  SpecAdmitter,
} from "./work-driver-spec-slot-admission.ts";

/** What the decision reads: the fence view plus the two shared admitters. */
export interface FixPassFileGate {
  /** The workstream's id, for the slot admitter's per-workstream scope check. */
  id: string;
  /** Its declared paths — the reading the slot admitter reaches the slot by. */
  declared: readonly string[];
  /** The fence view, with this pass's own delta filled into `passChanged`. */
  fence: FixPassFence;
  /** The shared spec-slot admitter, built once per workstream. */
  admitter: SpecAdmitter;
  /**
   * The corrective round's admission, or `undefined` when this workstream ran no
   * round — #1698(b): no record, nothing to ask.
   */
  corrective?: { tryAdmit(file: string): Promise<CorrectiveVerdict> };
}

/** One file's verdict: admitted (with its disclosure note) or a stray record. */
export type FixPassFileVerdict =
  | { admitted: true; note?: string }
  | { admitted: false; stray: Stray };

/**
 * The refusal no route may speak over, for one file: the workstream's own
 * `outOfScope` fence (`fenceMatches`, the ONE fence predicate the develop gate
 * and the spec-slot admitter also run) and the protected-path gate. `undefined`
 * means neither applies.
 *
 * ONE predicate for the whole ladder, so step 1 and step 4 cannot disagree: the
 * pre-#1846 shape asked the fence only inside step 4, which meant a file in the
 * declared set was admitted on a path the fence would have refused it on.
 */
export function absoluteRefusal(
  file: string,
  fence: FixPassFence,
): "fenced" | "protected" | undefined {
  if (fence.outOfScope.some((entry) => fenceMatches(entry, file))) return "fenced";
  if (protectedPathsIn([file]).length > 0) return "protected";
  return undefined;
}

/**
 * The admission decision for one file the pass changed.
 *
 * `changedByPass` is `true` for a file in the pass's own delta
 * (`treeChanges(worktree, headBefore)`) and `false` for a file the post-pass
 * tree reports that the pass did not itself change. See the module header for
 * what that distinction costs the pass.
 */
export async function admitFixPassEntry(
  file: string,
  gate: FixPassFileGate,
  changedByPass: boolean,
): Promise<FixPassFileVerdict> {
  const { fence } = gate;
  // The two ABSOLUTE refusals are asked before EVERY route, the direct set
  // included (#1846 review, B5). Step 1 used to answer "this is the pass's own
  // scope" and return before the fence was consulted, so a declared path that
  // the plan ALSO put in `outOfScope` was admitted by this gate — and the
  // develop gate's own outOfScope check, which runs the same `fenceMatches`
  // predicate, then refused the very file this fence had blessed. A protected
  // path named in the plan had the same shape: the protected-path gate owns
  // that decision, and a workstream's own path list is not a grant.
  const absolute = absoluteRefusal(file, fence);
  if (absolute !== undefined)
    return {
      admitted: false,
      // `refused` carries the SPEC-SLOT route's answer, which for a file the
      // slot never matched is `no-slot`; the `admissionRefusal` field is what
      // tells the park reason that the ABSOLUTE gate — not the absence of a
      // slot — is what stopped this file.
      stray: { file, refused: "no-slot", admissionRefusal: absolute },
    };
  // 1 — the pass's own scope, asked first so no route below spends its budget.
  if (fence.admits.some((a) => admitsEntry(a, file))) return { admitted: true };
  // 2 — the spec slot; its `fenced` / `protected` refusals are final.
  const decision: Admission = gate.admitter.admit(gate.id, file, [...gate.declared]);
  if (decision.admitted) return { admitted: true };
  // 3 — the corrective round, asked for every file its refusals do not outrank.
  // When it ADMITS, its disclosure note is returned: an authorisation the
  // operator never sees is a fence that widened invisibly (#1522).
  const verdict = await correctiveVerdict(gate, file, decision.refused);
  if (verdict === "not-asked") {
    // no round, or a refusal that outranks it
  } else if (verdict.admitted) {
    return { admitted: true, note: verdict.note };
  } else {
    // Its refusal is the last word (see the header): a rule derived from the
    // file's NAME does not overrule the round's bound.
    return {
      admitted: false,
      stray: { file, refused: decision.refused, correctiveNote: verdict.note },
    };
  }
  // 4 — the pass's own rules, for a file this pass changed.
  if (!changedByPass) return { admitted: false, stray: { file, refused: decision.refused } };
  const extra: FixPassAdmission = admitFixPassFile(file, fence, fence.passChanged.length);
  return extra.admitted
    ? { admitted: true, note: extra.note }
    : {
        admitted: false,
        stray: { file, refused: decision.refused, admissionRefusal: extra.refused },
      };
}

/**
 * The round's answer, or `"not-asked"` when the route was not in play: no
 * record, or a refusal that outranks the round (#1698(b)'s "no round, no
 * route" — with nothing to ask, the budget is untouched and the park says
 * nothing about a route that never ran).
 *
 * Takes the REFUSAL kind rather than the whole `Admission`: the caller has
 * already returned on the admitted branch, and narrowing a union the caller
 * narrowed does not cross a function boundary.
 */
async function correctiveVerdict(
  gate: FixPassFileGate,
  file: string,
  refused: AdmissionRefusal,
): Promise<"not-asked" | CorrectiveVerdict> {
  if (gate.corrective === undefined || outranksCorrective(refused)) return "not-asked";
  return gate.corrective.tryAdmit(file);
}
