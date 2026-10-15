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
import { flattenIssueText } from "./text-flatten.ts";
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
 * different subject: the MEMORY is what the code contradicts. On tehas #97 the
 * row read "vipune rows claiming issue 97 already moved the meter into
 * `header.topbar`, and one describing a `test/fun_test.sh` that does not
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

/** Severity words a bullet may lead with. Only CRITICAL gates; the others are read and set aside (#1187). */
const SEVERITY_WORDS: readonly string[] = [CRITICAL_SEVERITY, "HIGH", "MEDIUM", "LOW"];

/** Case-folded token without spaces or hyphens: `[CRIT ICAL]` and `[critical]` both fold to `critical`. */
function foldToken(token: string): string {
  return token.toLowerCase().replace(/[\s-]/g, "");
}

/** Tag-like: folds to a severity word without being that word exactly. Such a tag parks; it never passes. */
function isTagLike(token: string): boolean {
  return SEVERITY_WORDS.some((word) => word !== token && word.toLowerCase() === foldToken(token));
}

/** One list item or prose line of the section. `kind` is fixed when the item starts; `text` takes joined continuations. */
interface Entry {
  kind: "point" | "resolved" | "parked" | "plain";
  text: string;
}

/** An ATX heading: 1-6 hashes, then a space or the end of the line. */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
/** A list item, bullet or ordered, with content after the marker. */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
/** A setext underline. Inside the section it parks: it is a heading or a thematic break, never a point. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** A code fence opener: three or more backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Whether `line` closes a fence opened with `opener`: same character, at least as long. */
function closesFence(line: string, opener: string): boolean {
  const closer = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
  return closer !== undefined && closer[0] === opener[0] && closer.length >= opener.length;
}

/**
 * The disposition of one list item, from its flattened text with any task checkbox removed.
 * Severity is recognised only at the start of the text (#1187): a tag behind emphasis or
 * strikethrough is not read, and a CRITICAL-shaped tag anywhere else in the text parks.
 */
function classifyItem(text: string): Entry["kind"] {
  const lead = text.match(/^\[([^\]]*)\]/);
  if (lead) {
    const token = lead[1] ?? "";
    const after = text.slice(lead[0].length);
    if (token === CRITICAL_SEVERITY) {
      // `[RESOLVED]` must follow the tag on this line; an empty answer is not an answer.
      const answer = after.match(/^\s*\[RESOLVED\](.*)$/);
      if (answer === null) return "point";
      return (answer[1] ?? "").trim() ? "resolved" : "parked";
    }
    if (SEVERITY_WORDS.includes(token)) return "plain";
    if (isTagLike(token)) return "parked";
    // A markdown link is an ordinary bullet. Any other bracketed token is one we cannot read.
    return after.startsWith("(") ? "plain" : "parked";
  }
  if (/^\W*critical\b/i.test(text)) return "parked";
  const anywhere = [...text.matchAll(/\[([^\]]*)\]/g)];
  return anywhere.some((m) => foldToken(m[1] ?? "") === foldToken(CRITICAL_SEVERITY))
    ? "parked"
    : "plain";
}

/** What the gate read from an issue's Open points section (#1151, #1187). Every text is flattenIssueText output. */
export interface OpenPointReading {
  /** Unresolved CRITICAL points. Each one gates. */
  points: string[];
  /** CRITICAL points answered by an unemphasised `[RESOLVED]` right after the tag. */
  resolved: string[];
  /** Section lines that block the cycle: anything that is not a plain bullet, a checkbox, a link or a HIGH/MEDIUM/LOW tag. */
  unparsed: string[];
}

/**
 * Read the Open points section of a filed issue (#1151, #1187).
 *
 * The section starts at an exact OPEN_POINTS_HEADING and ends at the next heading of the
 * same or higher level outside a fenced block, or at the end of the body. Inside it:
 * blank lines never park; plain bullets, task checkboxes and link bullets do not park;
 * a CRITICAL point parks unless `[RESOLVED]` follows its tag on the same line; and any
 * other line that is not a plain item parks (non-bullet prose, unindented continuation,
 * a sub-heading, a setext underline, a fenced block, an unreadable leading token).
 * Indented lines continue the item above them, and only that item, with no blank line between.
 */
export function readOpenPoints(issueBody: string): OpenPointReading {
  const entries: Entry[] = [];
  const park = (raw: string): Entry => {
    const entry: Entry = { kind: "parked", text: flattenIssueText(raw) };
    entries.push(entry);
    return entry;
  };
  let level = 0; // heading level of the open section; 0 = outside it
  let fence: string | undefined; // the opener of the fence we are inside
  let fenceEntry: Entry | undefined; // the one entry a fenced block inside the section becomes
  let cur: Entry | undefined; // the item an indented continuation line joins
  for (const raw of issueBody.split(/\r?\n/)) {
    if (fence !== undefined) {
      if (fenceEntry !== undefined && raw.trim() !== "") {
        fenceEntry.text = flattenIssueText(`${fenceEntry.text} ${raw}`);
      }
      if (closesFence(raw, fence)) fence = undefined;
      continue;
    }
    const opener = raw.match(FENCE_OPEN)?.[1];
    if (opener !== undefined) {
      fence = opener;
      cur = undefined;
      fenceEntry = level > 0 ? park(raw) : undefined;
      continue;
    }
    const heading = raw.match(ATX_HEADING);
    if (heading) {
      const depth = heading[1]?.length ?? 0;
      cur = undefined;
      // A deeper heading inside the section is a sub-heading, and it parks.
      if (level > 0 && depth > level) {
        park(raw);
        continue;
      }
      level = flattenIssueText(heading[2] ?? "") === OPEN_POINTS_HEADING ? depth : 0;
      continue;
    }
    if (raw.trim() === "") {
      cur = undefined;
      continue;
    }
    if (level === 0) continue;
    if (SETEXT_UNDERLINE.test(raw)) {
      park(raw);
      cur = undefined;
      continue;
    }
    const item = raw.match(LIST_ITEM)?.[1];
    if (item !== undefined) {
      const text = flattenIssueText(item)
        .replace(/^\[[ xX]\](?: |$)/, "")
        .trim();
      cur = { kind: classifyItem(text), text };
      entries.push(cur);
      continue;
    }
    const piece = flattenIssueText(raw);
    // An indented line continues the item above it; one that opens with a bracketed token is not prose to fold in.
    if (/^[ \t]/.test(raw) && cur !== undefined && !piece.startsWith("[")) {
      cur.text = flattenIssueText(`${cur.text} ${piece}`);
      continue;
    }
    cur = park(raw);
  }
  const reading: OpenPointReading = { points: [], resolved: [], unparsed: [] };
  for (const entry of entries) {
    if (entry.kind === "point") reading.points.push(entry.text);
    else if (entry.kind === "resolved") reading.resolved.push(entry.text);
    else if (entry.kind === "parked") reading.unparsed.push(entry.text);
  }
  return reading;
}
