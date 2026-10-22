/**
 * work-driver-fix-pass-park-reason — the DISCLOSURE half of the fix-pass scope
 * fence, split out of `work-driver-adversarial-fix-scope.ts` for the AGENTS.md
 * §12 size limit. Nothing here decides anything: it renders a refusal the fence
 * already reached.
 *
 * It lives apart from the fence for the reason #1522 was filed. The park used to
 * be one clause — "default changed lib/config.sh — outside its declared paths and
 * the files the findings name" — which named neither the rule that fired nor the
 * way out, and the operator had to rebuild both from the state file. So the
 * rendering is part of the fence's contract, not prose attached to it: for each
 * refused file it says WHO named it (a finding, the corrective round, nobody),
 * WHICH rule refused it (the `WHY` table below is the one source of that text),
 * where the change sits, and how to clear it. One module, one renderer, read by
 * the fence, the handoff, and the tests that assert on the text — a second
 * renderer would be a second answer to "why was this file not mine to change".
 */

import type { PassPlan } from "./work-driver-adversarial-fix-scope.ts";
import { pathTokenIn } from "./work-driver-declared-path.ts";
import type { AdmissionRefusal } from "./work-driver-spec-slot-admission.ts";
import { SPEC_SLOT_MAX_FILES } from "./work-driver-spec-slot-admission.ts";

/** What one stray file's refusal actually said, beyond the shared `WHY` table. */
export interface Stray {
  file: string;
  refused: AdmissionRefusal;
  /**
   * Set when a corrective round named the file but the admission did not hold
   * (#1698(b)) — its own reason is more specific than the slot's, so it reads
   * first. Absent means the corrective route was never in play for this file, and
   * the shared `WHY` clause carries the whole explanation.
   */
  correctiveNote?: string;
}

/** A short list for a park reason; "none" beats an empty backtick run. */
export const listed = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(", ") : "none");

/**
 * #1522 — the scope-fence park names the fence it checked (both sets), what
 * the findings said about each stray, where the change sits and how to clear
 * it. The bare clause left the operator to rebuild all of that from the state.
 */
export function strayReason(plan: PassPlan, strays: readonly Stray[], basis: string): string {
  const fence =
    plan.declared.length > 0
      ? `declared paths: ${listed(plan.declared)}`
      : `files it already changed: ${listed(plan.before.names)}`;
  // #1522 — the park names every fence it checked, so the spec slots the pass
  // also honoured belong in the disclosure: without them an operator reading a
  // refusal for a *different* file cannot tell what the spec authorised.
  const spec = `spec pattern slots it admits: ${listed(plan.specSlots.map((s) => s.glob))}`;
  // #1725 round 3 — the refusal KIND rides the park reason: "why is this file
  // outside?" must be answerable from the handoff alone. `slot-full` tells the
  // operator the slot spent its file budget (re-split under another declared
  // location, or re-plan), instead of leaving the file's fate a mystery.
  const WHY: Record<AdmissionRefusal, string> = {
    fenced: "it sits behind this workstream's outOfScope fence, which the spec does not lift",
    protected: "it is a protected path — the protected-path gate owns that decision",
    "no-slot": "no spec pattern slot matches it",
    "slot-full": `the matching slot has already admitted its ${SPEC_SLOT_MAX_FILES} files — one slot is a bounded authorisation, not a skeleton key`,
  };
  const naming = strays
    .map((s) => {
      // #1698(b) — a corrective round named the file but the admission did not
      // hold. The shared `WHY` clause stays (it is the refusal the fence itself
      // reached) and the route's own reason is APPENDED: an operator reading the
      // handoff needs both answers — why the spec-slot route refused, and why
      // the driver-ordered route could not admit it.
      const why = s.correctiveNote
        ? `${WHY[s.refused]}; and the corrective route refused it: ${s.correctiveNote}`
        : WHY[s.refused];
      return pathTokenIn(plan.findings, s.file)
        ? `A finding names ${s.file}, but it does not widen the fence (a named file widens only when it is tracked at base or already changed by this cycle, unprotected, and in the directory of a declared or already-changed non-root path); ${why}`
        : `No finding names ${s.file} — ${why}`;
    })
    .join("; ");
  const files = strays.map((s) => s.file).join(", ");
  return `${plan.id} changed ${files} — outside ${basis} (${fence}; ${spec}; finding-named files it admits: ${listed(plan.named)}). ${naming}. The change is still in ${plan.worktree}. To clear it: if a finding's fix needs ${files}, the declared scope is what is wrong — name ${files} in the issue's scope and re-run \`/work <issue> --restart\`; otherwise the pass overreached — revert ${files} in that worktree and land the rest by hand, or re-run \`/work <issue> --restart\``;
}
