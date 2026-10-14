/**
 * work-driver-intent-criticality — #574 mechanical criticality classifier.
 *
 * The intent resolver's verdict used to be overridden by ANY contradicted
 * evidence row, regardless of whether the contradiction was load-bearing. In
 * every documented incident (#356, #451, #489, #546) the contradicted row was
 * peripheral — a named-but-already-compliant symbol, a stale detail about a
 * deliverable's starting state, an already-fixed docstring. None referenced
 * an unbuildable premise. This module classifies each contradicted row
 * mechanically: load-bearing rows still park fail-closed; supporting rows
 * become visible assumptions and do not overturn the resolver's actionable
 * decision.
 */

import { trace } from "./trace.ts";
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
  const deliverableBasenames = spec.deliverables
    .flatMap((deliverable) => deliverable.paths)
    .map(normaliseDeclaredPath)
    .filter(Boolean)
    .map((path) => path.split("/").pop()?.toLowerCase() ?? "")
    .filter(Boolean);
  const claimTokens = criticalityTokens(evidence.claim);
  const referencesDeliverable = deliverableBasenames.some((basename) => {
    const escaped = basename.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
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
  return evidence.map((e) => ({
    text: `issue detail is stale: ${e.claim}`,
    basis: e.source ? `supporting contradiction — ${e.source}` : "supporting contradiction",
  }));
}

/**
 * CRITICAL bullets of a filed issue's "Open points" section (#1151).
 *
 * The gap gate files unresolved CRITICAL points under that heading, one
 * `- [CRITICAL] <point> — <proposal>` bullet each. Only that section is read,
 * and only bullets tagged CRITICAL: HIGH/MEDIUM/LOW residuals never gate.
 */
export function criticalOpenPoints(issueBody: string): string[] {
  const points: string[] = [];
  let inSection = false;
  for (const raw of issueBody.split("\n")) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s*open points\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const item = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)?.[1];
    if (item === undefined) continue;
    const tagged = item.match(/^[*_`\s]*\[CRITICAL\][*_`\s:]*(.*)$/i)?.[1]?.trim();
    if (tagged) points.push(tagged);
  }
  return points;
}

/**
 * Words that name a decision the driver must not make on the resolver's behalf.
 * An unresolved CRITICAL point touching one of these parks rather than proceeds.
 */
const AUTHORIZATION_CLASS = /\b(?:authenticat\w*|authori[sz]\w*|secrets?|permissions?)\b/i;

/**
 * Apply the filed issue's unresolved CRITICAL open points to the spec (#1151).
 *
 * - No open points: the spec is unchanged.
 * - An authentication/authorization/secrets/permissions point: park as
 *   `underspecified` — the driver will not choose who may do what.
 * - Any other CRITICAL point: a `proceed` is capped at
 *   `proceed-with-assumptions`, with each point named as an assumption so it
 *   reaches the PR body. An existing park is never rewritten here.
 */
export function applyOpenPointGate(spec: NormalisedSpec, openPoints: string[]): NormalisedSpec {
  if (openPoints.length === 0 || spec.verdict === "park") return spec;
  if (openPoints.some((point) => AUTHORIZATION_CLASS.test(point))) {
    trace("work-driver: intent — unresolved CRITICAL open point concerns authorization, parking");
    return { ...spec, verdict: "park", parkReason: "underspecified", parkReasonSource: "default" };
  }
  trace(
    `work-driver: intent — ${openPoints.length} unresolved CRITICAL open point(s) carried as assumptions`,
  );
  return {
    ...spec,
    verdict: "proceed-with-assumptions",
    assumptions: [
      ...spec.assumptions,
      ...openPoints.map((point) => ({
        text: `unresolved CRITICAL open point in the filed issue: ${point}`,
        basis: "named by the intent gate; proceeding on it as an assumption",
      })),
    ],
  };
}
