import { escapeRegExpLiteral } from "./open-points-contract.ts";
/**
 * work-driver-intent-criticality — the #574 mechanical contradiction classifier.
 *
 * The intent resolver's verdict used to be overridden by ANY contradicted evidence row,
 * whether or not the contradiction was load-bearing. In every documented incident (#356,
 * #451, #489, #546) the contradicted row was peripheral — a named-but-already-compliant
 * symbol, a stale detail about a deliverable's starting state, an already-fixed docstring.
 * None referenced an unbuildable premise. This module classifies each contradicted row
 * mechanically: load-bearing rows still park fail-closed; supporting rows become visible
 * assumptions and do not overturn the resolver's actionable decision.
 *
 * It does NOT read the issue's Open points: that rule lives in open-points-reader.ts, and
 * `applyOpenPointGate` in work-driver-intent-finalise.ts is what turns a reading into a
 * park. This module never fetches the issue and never decides what the spec says.
 */
import type { NormalisedSpec, SpecAssumption, SpecEvidence } from "./work-driver-intent.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/** #574 escape hatch: restore the pre-criticality unconditional park rule. */
export function intentCriticalityEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_INTENT_CRITICALITY;
  return v !== "0" && v !== "false";
}

const CRITICALITY_STOP_WORDS = new Set([
  "a",
  "about",
  "against",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "does",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

/** Words substantial enough to be a quoted intent token. */
function criticalityTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter(
      (token) => !CRITICALITY_STOP_WORDS.has(token),
    ),
  );
}

/**
 * Is this row about the memory store rather than about the issue?
 *
 * `contradicted` is meant to say "the ISSUE's claim is false against the code".
 * A resolver that finds a stale vipune row writes the same token for a
 * different subject: the MEMORY is what the code contradicts. On orchard #97 the
 * row read "vipune rows claiming issue 97 already moved the meter into
 * `header.topbar`, and one describing a `test/app_test.sh` that does not
 * exist" — rows the resolver had just superseded, under a `proceed` it argued
 * with file:line evidence. It named a deliverable file and said "does not
 * exist", so the classifier below read the resolver's own correction as proof
 * that the issue was stale, and parked.
 *
 * Deliberately narrow, because a miss here builds on a false premise: the
 * source is `memory`/`vipune` (what the prompt asks for), or the claim OPENS
 * with memory rows as its subject. A claim that merely mentions memory — this
 * repo has issues about `vipune.ts` — is still a claim about the code.
 */
export function isMemoryClaim(evidence: Pick<SpecEvidence, "claim" | "source">): boolean {
  return (
    /^[`'"\s]*(?:memory|vipune)(?:[`'"\s]|$)/i.test(evidence.source) ||
    /^\W*(?:\w+\s+)?(?:vipune|memory)\s+(?:rows?|entr(?:y|ies)|records?)\b/i.test(evidence.claim)
  );
}

/**
 * Whether a contradiction describes an absence or relocation that would make
 * one of this spec's deliverables impossible to build.
 *
 * The first conjunct is deliberately narrow: a generic statement such as
 * "the function does not exist" is not enough to overturn a proceed verdict.
 * It must identify either a declared deliverable file or a meaningful token
 * from the intent sentence. Missing detail fails closed as load-bearing —
 * a contradiction the classifier cannot read is treated as the stronger
 * signal, because parking an ambiguous spec is cheaper than building from it.
 */
function assertsLoadBearingContradiction(spec: NormalisedSpec, evidence: SpecEvidence): boolean {
  // An unreadable claim cannot be classified, and the classifier must not
  // invent a classification: absence of criticality data is the fail-closed
  // default, not a vote for the weaker reading.
  if (evidence.claim.trim() === "") return true;
  // A stale memory row contradicts the memory, not the issue.
  if (isMemoryClaim(evidence)) return false;
  const deliverableBasenames = spec.deliverables
    .flatMap((deliverable) => deliverable.paths)
    .map(normaliseDeclaredPath)
    .filter(Boolean)
    .map((path) => path.split("/").pop()?.toLowerCase() ?? "")
    .filter(Boolean);
  const claimTokens = criticalityTokens(evidence.claim);
  const referencesDeliverable = deliverableBasenames.some((basename) => {
    const escaped = escapeRegExpLiteral(basename);
    return new RegExp(`(?:^|[^a-z0-9_./-])${escaped}(?:$|[^a-z0-9_./-])`, "i").test(evidence.claim);
  });
  const intentTokens = criticalityTokens(spec.intent);
  const referencesIntent = [...claimTokens].some((token) => intentTokens.has(token));
  if (!referencesDeliverable && !referencesIntent) return false;

  // Keep these patterns explicit. In particular, a plain "not confirmed"
  // must remain unverifiable rather than becoming a reason to park.
  return (
    /\b(?:no longer exists|does not exist|doesn't exist|not present|not found|missing)\b/i.test(
      evidence.claim,
    ) ||
    /\b(?:moved|relocated|renamed)\b(?:\s+to\b|\s+from\b|\s+into\b|\s+out of\b)?/i.test(
      evidence.claim,
    ) ||
    /\b(?:now )?lives in\b/i.test(evidence.claim) ||
    /\b(?:already implemented|already explicit|already checked|already exists)\b/i.test(
      evidence.claim,
    )
  );
}

/**
 * Contradictions that are strong enough to override a proceed verdict.
 *
 * With criticality enabled, peripheral stale details become assumptions and
 * do not park the cycle. The disabled path is intentionally identical to the
 * old unconditional predicate for operators that need the previous policy.
 */
export function loadBearingContradictions(spec: NormalisedSpec): SpecEvidence[] {
  const contradicted = spec.evidence.filter((e) => e.verdict === "contradicted");
  if (!intentCriticalityEnabled()) return contradicted;
  return contradicted.filter((e) => assertsLoadBearingContradiction(spec, e));
}

export function supportingContradictions(spec: NormalisedSpec): SpecEvidence[] {
  if (!intentCriticalityEnabled()) return [];
  const contradicted = spec.evidence.filter((e) => e.verdict === "contradicted");
  const loadBearing = new Set(loadBearingContradictions(spec));
  return contradicted.filter((e) => !loadBearing.has(e));
}

export function contradictionAssumptions(evidence: SpecEvidence[]): SpecAssumption[] {
  return evidence.map((e) =>
    isMemoryClaim(e)
      ? {
          text: `prior memory is stale, not the issue: ${e.claim}`,
          basis: "the resolver checked the memory row against the code and the code won",
        }
      : {
          text: `issue detail is stale: ${e.claim}`,
          basis: e.source ? `supporting contradiction — ${e.source}` : "supporting contradiction",
        },
  );
}
