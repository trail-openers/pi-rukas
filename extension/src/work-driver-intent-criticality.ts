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
 *
 * #1151: it also reads the CRITICAL open points from the filed issue body and
 * applies them to the verdict (`applyOpenPointGate`): an authorization point
 * parks, any other caps a proceed at proceed-with-assumptions.
 */

/**
 * Single responsibility: classify contradictions and CRITICAL open points, and
 * apply them to a resolver's spec verdict. It parses CRITICAL open points from
 * the filed body the caller passes in (it never fetches the issue) and never
 * decides what the spec says. work-driver-intent-finalise.ts fixes the order.
 */
import { CRITICAL_SEVERITY, OPEN_POINTS_HEADING } from "./open-points-contract.ts";
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

/** A `[CRITICAL]` bullet tag, optionally emphasised; captures the point text. */
const CRITICAL_BULLET = new RegExp(`^[*_\`\\s]*\\[${CRITICAL_SEVERITY}\\][*_\`\\s:]*(.*)$`, "i");

/** A `[RESOLVED]` marker directly after the severity tag (#1151, open-points-contract.ts). */
const RESOLVED_MARKER = /^\[RESOLVED\]/i;

/** A bullet tagged with a non-CRITICAL severity: its text is not a CRITICAL line. */
const OTHER_SEVERITY_BULLET = /^[*_`\s]*\[(?:HIGH|MEDIUM|LOW)\]/i;

/** Stands in for a bare `- [CRITICAL]` bullet: still a point, just without text. */
const EMPTY_CRITICAL_POINT = "(empty CRITICAL open point)";

/** What the gate read from an issue's "Open points" section (#1151). */
export interface OpenPointReading {
  /** Unresolved CRITICAL points; each one gates. */
  points: string[];
  /** Bullets the author marked `[RESOLVED]`, with the marker removed. */
  resolved: string[];
  /** Lines that mention CRITICAL but parse as neither a point nor a resolved bullet. */
  unparsed: string[];
}

/**
 * The CRITICAL bullets of a filed issue's "Open points" section (#1151).
 *
 * The gap gate files unresolved CRITICAL points under that heading, one
 * `- [CRITICAL] <point> — <proposal>` bullet each. Only that section is read.
 * HIGH/MEDIUM/LOW bullets never gate; a line that mentions CRITICAL but is
 * not a recognised bullet is reported as `unparsed` rather than ignored.
 */
export function readOpenPoints(issueBody: string): OpenPointReading {
  const reading: OpenPointReading = { points: [], resolved: [], unparsed: [] };
  let inSection = false;
  for (const raw of issueBody.split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/)?.[1];
    if (heading !== undefined) {
      inSection = heading.trim().toLowerCase() === OPEN_POINTS_HEADING.toLowerCase();
      continue;
    }
    if (!inSection || line === "") continue;
    const item = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)?.[1];
    const tagged = item?.match(CRITICAL_BULLET);
    if (item !== undefined && tagged) {
      const rest = tagged[1]?.trim() ?? "";
      if (RESOLVED_MARKER.test(rest)) {
        reading.resolved.push(rest.replace(RESOLVED_MARKER, "").trim() || EMPTY_CRITICAL_POINT);
      } else {
        // A bare tag is still a CRITICAL point: dropping it would let an empty
        // gate finding stop gating.
        reading.points.push(rest || EMPTY_CRITICAL_POINT);
      }
      continue;
    }
    if (item !== undefined && OTHER_SEVERITY_BULLET.test(item)) continue;
    // A list item that mentions CRITICAL, or a line leading with it, is a malformed
    // point. Other prose (e.g. the gap gate's own intro line) is not.
    const malformed = item !== undefined ? /\bCRITICAL\b/.test(line) : /^\W*CRITICAL\b/i.test(line);
    if (malformed) reading.unparsed.push(line);
  }
  return reading;
}

/** The CRITICAL points of a filed issue's "Open points" section (#1151). */
export function criticalOpenPoints(issueBody: string): string[] {
  return readOpenPoints(issueBody).points;
}

/**
 * Words that name a decision the driver must not make on the resolver's behalf.
 * An unresolved CRITICAL point touching one of these parks rather than proceeds.
 */
const AUTHORIZATION_CLASS =
  /\b(?:(?:un|pre|re|non)?auth(?:n|z|s)?(?:_\w*)?\b|(?:un|pre|re|non)?authenticat\w*|(?:un|pre|re|non)?authori[sz](?:e|ed|es|ing|ation|ations)?(?:_\w*)?\b|oauth2?\b|jwt|acl|rbac|roles?|sessions?|login|signing[ _-]?keys?|private[ _-]?keys?|secret\w*|permissions?|credential\w*|token\w*|api[ _-]?keys?\w*|password\w*|(?:un|pre|re|non)?(?:en|de)crypt\w*|tls|certificates?|certs?|crypto\w*|(?:un|pre|re|non)?(?:sanitiz\w*|validat\w*)|inject\w*|sandbox\w*|privilege\w*|access[ _-]control|delet\w*|data[ _-]loss)\b/i;

/** #1151: the assumption text for one CRITICAL point is capped at this many characters. */
const OPEN_POINT_ASSUMPTION_MAX = 300;

/** Clip by code point, so a surrogate pair is never split into a lone half. */
function clipTo(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * The verdict cap shared by the open-point gate and its unread-body branch: a
 * park is final and passes through unchanged; anything else becomes
 * proceed-with-assumptions with `assumptions` appended.
 */
export function capToAssumptions(
  spec: NormalisedSpec,
  assumptions: SpecAssumption[],
): NormalisedSpec {
  if (spec.verdict === "park") return spec;
  return {
    ...spec,
    verdict: "proceed-with-assumptions",
    assumptions: [...spec.assumptions, ...assumptions],
  };
}

/** Code-span quoting for untrusted issue text: keeps it inert in the PR body. */
function quotedIssueText(text: string): string {
  return `\`${clipTo(text.replace(/`/g, "'"), OPEN_POINT_ASSUMPTION_MAX)}\``;
}

/**
 * Apply the filed issue's CRITICAL open points to the spec (#1151).
 *
 * - Resolved bullets (`[RESOLVED]` after the tag) are traced and recorded as
 *   assumptions, so the answer reaches the PR body. They never gate.
 * - No unresolved or unparsed CRITICAL lines: the spec is otherwise unchanged.
 * - A security-class point, parsed or unparsed (authentication/authorization, credentials and keys,
 *   secrets, input validation/injection, sandboxing, data deletion): park as
 *   `security-open-point` — the driver will not choose that policy. The #397
 *   complete-spec override lifts only `underspecified`, so this park stands.
 * - Any other unresolved point, or a CRITICAL line that did not parse: a
 *   `proceed` is capped at `proceed-with-assumptions`, each named as an
 *   assumption. An existing park is never rewritten here.
 */
export function applyOpenPointGate(
  spec: NormalisedSpec,
  openPoints: string[],
  extra: Partial<Omit<OpenPointReading, "points">> = {},
): NormalisedSpec {
  const resolved = extra.resolved ?? [];
  const unparsed = extra.unparsed ?? [];
  for (const text of resolved) {
    trace(
      `work-driver: intent — resolved open point skipped: ${clipTo(text, OPEN_POINT_ASSUMPTION_MAX)}`,
    );
  }
  const base: NormalisedSpec =
    resolved.length === 0
      ? spec
      : {
          ...spec,
          assumptions: [
            ...spec.assumptions,
            ...resolved.map((text) => ({
              text: `Resolved open point (marked [RESOLVED] in the issue body): ${quotedIssueText(text)}`,
              basis: "the filed issue marks this CRITICAL point resolved",
            })),
          ],
        };
  if (unparsed.length > 0) {
    trace(
      `open-point-unparsed: ${unparsed.length} CRITICAL line(s) in the Open points section did not parse`,
    );
  }
  if (openPoints.length === 0 && unparsed.length === 0) return base;
  if (base.verdict === "park") {
    const security = openPoints.filter((point) => AUTHORIZATION_CLASS.test(point)).length;
    trace(
      `work-driver: intent — open-point gate skipped: spec already parked (${openPoints.length} CRITICAL point(s), ${security} security-class)`,
    );
    return base;
  }
  if ([...openPoints, ...unparsed].some((line) => AUTHORIZATION_CLASS.test(line))) {
    trace("work-driver: intent — unresolved CRITICAL open point concerns authorization, parking");
    return {
      ...base,
      verdict: "park",
      parkReason: "security-open-point",
      parkReasonSource: "default",
    };
  }
  trace(
    `work-driver: intent — ${openPoints.length} unresolved CRITICAL open point(s), ${unparsed.length} unparsed line(s) carried as assumptions`,
  );
  return capToAssumptions(base, [
    ...openPoints.map((point) => ({
      text: `unresolved CRITICAL open point in the filed issue: ${quotedIssueText(point)}`,
      basis: "named by the intent gate; proceeding on it as an assumption",
    })),
    ...unparsed.map((line) => ({
      text: `Open-point gate could not parse a CRITICAL line: ${quotedIssueText(line)}`,
      basis:
        "open-point-unparsed — the gate could not read this line; proceeding on it as an assumption",
    })),
  ]);
}
