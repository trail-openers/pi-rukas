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
 * applyOpenPointGate lives in work-driver-intent-finalise.ts; this module only reads the points.
 */

/**
 * Single responsibility: classify contradictions and CRITICAL open points, and
 * apply them to a resolver's spec verdict. It parses CRITICAL open points from
 * the filed body the caller passes in (it never fetches the issue) and never
 * decides what the spec says. work-driver-intent-finalise.ts fixes the order.
 */
import { CRITICAL_SEVERITY, OPEN_POINTS_HEADING } from "./open-points-contract.ts";
import { matchSecurityTerm } from "./security-class.ts";
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

// Uppercase only: `[critical]` and `[Critical]` are unparsed, so they cap rather than vanish.
/** A `[CRITICAL]` bullet tag, optionally emphasised; captures the point text. */
const CRITICAL_BULLET = new RegExp(`^[*_\`\\s]*\\[${CRITICAL_SEVERITY}\\][*_\`\\s:]*(.*)$`);

/** A `[RESOLVED]` marker directly after the severity tag (#1151, open-points-contract.ts). */
const RESOLVED_MARKER = /^\[RESOLVED\]/i;

/** A bullet tagged with a non-CRITICAL severity: its text is not a CRITICAL line. */
const OTHER_SEVERITY_BULLET = /^[*_`\s]*\[(?:HIGH|MEDIUM|LOW)\]/i;

// One CRITICAL open point. A bare `- [CRITICAL]` bullet is still a point (it must not vanish
// from the gate), so it is a variant of its own rather than an empty string. openPointText
// renders the `empty` variant as a placeholder.
/** Stands in for a bare `- [CRITICAL]` bullet: still a point, just without text. */
export type OpenPoint = { kind: "text"; text: string } | { kind: "empty" };

/** Text of an open point for display; the placeholder is produced only here. */
export function openPointText(point: OpenPoint): string {
  return point.kind === "text" ? point.text : "(empty CRITICAL open point)";
}

/** What the gate read from an issue's "Open points" section (#1151). */
export interface OpenPointReading {
  /** Unresolved CRITICAL points; each one gates. */
  points: OpenPoint[];
  // A marker with no answer text is unparsed instead: nothing was answered, so nothing is cleared.
  /** Bullets the author marked `[RESOLVED]`, with the marker removed. */
  resolved: OpenPoint[];
  /** Lines that mention CRITICAL but parse as neither a point nor a resolved bullet. */
  unparsed: string[];
}

const LIST_ITEM_LINE = /^\s*(?:[-*]|\d+[.)])\s+/;
const HEADING_LINE = /^\s*#{1,6}\s/;
/** A line that begins with a severity tag starts its own item; it never joins one (#1171). */
const SEVERITY_TAG_LINE = /^\s*(?:[-*+]|\d+[.)])?\s*\[(?:CRITICAL|HIGH|MEDIUM|LOW)\]/i;

/** One logical line: trimmed text, whether its first physical line was indented, and whether continuations were joined onto it. */
interface LogicalLine {
  text: string;
  indented: boolean;
  joined: boolean;
}

/**
 * The body's lines, with indented continuation lines joined onto the list item
 * above them (#1171): `- [CRITICAL] Which timeout wins` followed by an indented
 * `authentication for the endpoint is undecided` is one point. A continuation is
 * refused only when the line itself begins with a severity tag, so a wrapped HIGH
 * item cannot swallow a CRITICAL line, while a continuation that merely mentions
 * "critical" still joins. A blank line or a heading ends the item.
 */
function logicalLines(issueBody: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  let openItem = false;
  for (const raw of issueBody.split("\n")) {
    const line = raw.trim();
    const indented = /^\s+\S/.test(raw);
    if (line === "") {
      openItem = false;
      out.push({ text: "", indented: false, joined: false });
      continue;
    }
    const continues =
      openItem &&
      indented &&
      !LIST_ITEM_LINE.test(raw) &&
      !HEADING_LINE.test(raw) &&
      !SEVERITY_TAG_LINE.test(line);
    if (continues) {
      const prev = out.pop();
      out.push({
        text: `${prev?.text ?? ""} ${line}`,
        indented: prev?.indented ?? false,
        joined: true,
      });
      continue;
    }
    out.push({ text: line, indented, joined: false });
    openItem = LIST_ITEM_LINE.test(raw);
  }
  return out;
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
  for (const entry of logicalLines(issueBody)) {
    const line = entry.text;
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
        const answered = rest.replace(RESOLVED_MARKER, "").trim();
        if (answered) reading.resolved.push({ kind: "text", text: answered });
        else reading.unparsed.push(line);
      } else {
        // A bare tag is still a CRITICAL point: dropping it would let an empty
        // gate finding stop gating.
        reading.points.push(rest ? { kind: "text", text: rest } : { kind: "empty" });
      }
      continue;
    }
    if (item !== undefined && OTHER_SEVERITY_BULLET.test(item)) continue;
    // A list item that mentions CRITICAL, or a line leading with it, is a malformed
    // point. Other prose (e.g. the gap gate's own intro line) is not.
    // The item match is case-insensitive, so lowercase and titlecase tags land here.
    // `non-critical` is ordinary prose, not a severity tag, so it is not malformed.
    const malformed =
      item !== undefined ? /(?<!non-)\bcritical\b/i.test(line) : /^\W*critical\b/i.test(line);
    if (malformed) {
      reading.unparsed.push(line);
      continue;
    }
    // #1171: an indented line that was not joined onto an item and is not a parsed item
    // (e.g. a nested `  - authentication is undecided`) must not vanish. It parks only
    // when it names the security class; other indented prose stays unread.
    if (entry.indented && !entry.joined && matchSecurityTerm(line) !== undefined) {
      reading.unparsed.push(line);
    }
  }
  return reading;
}

/** The CRITICAL points of a filed issue's "Open points" section (#1151). */
export function criticalOpenPoints(issueBody: string): OpenPoint[] {
  return readOpenPoints(issueBody).points;
}
