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
import { redactSecrets } from "./decision-log.ts";
import {
  CRITICAL_SEVERITY,
  OPEN_POINTS_HEADING,
  OPEN_POINTS_INTRO,
} from "./open-points-contract.ts";
import { flattenIssueText } from "./text-flatten.ts";
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

/**
 * The unflattened raw lines of one list item or prose line of the section.
 *
 * `kind` is fixed when the item starts. `text` is the stored form; `pieces` holds the
 * raw lines that make it up (#1187 fix round 2). Re-flattening the accumulated text on
 * every continuation line made the reader O(n²) in the length of a wrapped entry, so the
 * pieces are collected and joined and normalised once, when the entry closes. An item with
 * no continuation has one piece and keeps the text computed when it opened.
 */
interface Entry {
  kind: "point" | "resolved" | "parked" | "plain";
  /** Normalised, redacted and bounded (#1187 fix round 2): blocking texts are posted to a public issue. */
  text: string;
  pieces: string[];
}

/**
 * Cap the number of blocking entries one section contributes to a park.
 *
 * A pathological body — thousands of bullets, or one enormous wrapped entry — would
 * otherwise be copied verbatim into `openPoints` and then into a public handoff comment.
 * The settlement's "unclipped" rules out a *quote* clip (no 300-character truncation of a
 * real point); it cannot mean "no bound at all". Both bounds were added after review, and
 * a bound that fires is traced, so a cycle that lost points is visible rather than
 * silently narrowed.
 */
const MAX_OPEN_POINT_ENTRIES = 20;
/** Cap the length of one stored entry; see {@link MAX_OPEN_POINT_ENTRIES}. */
const MAX_OPEN_POINT_CHARS = 2000;
/** Marker for an entry that hit {@link MAX_OPEN_POINT_CHARS}. */
const CLIPPED_MARKER = "…(clipped)";
/** Final entry recording what {@link MAX_OPEN_POINT_ENTRIES} dropped. */
function moreEntriesNote(dropped: number): string {
  return `…and ${dropped} more open-point lines`;
}

/** Bound one blocking line, redacting first so a clip can never cut a secret in half. */
function boundEntry(text: string): string {
  const { text: redacted } = redactSecrets(text);
  const chars = Array.from(redacted);
  return chars.length > MAX_OPEN_POINT_CHARS
    ? `${chars.slice(0, MAX_OPEN_POINT_CHARS - CLIPPED_MARKER.length).join("")}${CLIPPED_MARKER}`
    : redacted;
}

/**
 * The one normaliser for every text a reading stores (#1187 fix round 2).
 *
 * Redaction and the clip belong here rather than at the `openPoints` write site: the
 * resolved texts become assumptions the PR body renders, and an assumption is public text
 * too. Redacting before clipping matters — clipping first can cut a token into a fragment
 * no pattern recognises (the same reasoning as `redactClip`).
 *
 * Every stored text in `readOpenPoints` goes through this one function, including a list
 * item's own text: `classifyItem` reads the *raw* flatten (a tag the redactor rewrote would
 * misclassify), and only the stored form is sanitised.
 */
function storedText(flat: string): string {
  return boundEntry(flat);
}

/**
 * The blocking lines of a reading, capped and traced.
 *
 * One call site (the gate), so the entry cap lives here rather than in every entry.
 */
function boundedBlockingTexts(values: string[], what: string): string[] {
  const kept = values.slice(0, MAX_OPEN_POINT_ENTRIES).map(boundEntry);
  const dropped = values.length - kept.length;
  if (dropped > 0) {
    trace(
      `work-driver: intent — open-point bound dropped ${dropped} ${what} line(s) beyond ${MAX_OPEN_POINT_ENTRIES}; the park lists the first ${MAX_OPEN_POINT_ENTRIES}`,
    );
    kept.push(moreEntriesNote(dropped));
  }
  return kept;
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
    // The tag-like check runs BEFORE the link exemption (#1187 fix round 2): the writer
    // puts ` — proposed: …` between the tag and anything else, so a near-miss tag can
    // never be followed by `(` in a rendered section — exempting link bullets first made
    // `- [CRIT ICAL](https://x) …` an ordinary note, which the old keyword classifier parked on.
    if (isTagLike(token)) return "parked";
    // A markdown link is an ordinary bullet. Any other bracketed token is one we cannot read.
    // An EXACT severity tag is not exempted by a following link: the tag wins, fail closed.
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
 * The exact heading, tolerant of leading spaces, `#` count and trailing hashes — nothing else.
 *
 * The `(` and `)` of "(unresolved at the gap-gate cap)" are literal, so a near-miss heading
 * ("Open points (unresolved at the gap-gate", a reworded tail, a trailing word) does not
 * match and opens no section: the settlement's "no cross-section scan" holds exactly.
 */
const OPEN_POINTS_ATX =
  /^ {0,3}#{1,6}[ \t]+Open points \(unresolved at the gap-gate cap\)[ \t]*#*[ \t]*$/;

/**
 * Whether `raw` is the exact OPEN_POINTS_HEADING, read independently of fence state.
 *
 * Deliberately not `flattenIssueText`: an invisible character inside the heading would make
 * a mangled heading match, and a mangled heading is precisely what must NOT open a section.
 */
function isOpenPointsHeading(raw: string): boolean {
  return OPEN_POINTS_ATX.test(raw);
}

/**
 * Read the Open points section of a filed issue (#1151, #1187).
 *
 * The section starts at an exact OPEN_POINTS_HEADING and ends at the next heading of the
 * same or higher level outside a fenced block, or at the end of the body. Inside it:
 * blank lines never park; plain bullets, task checkboxes, link bullets and the writer's
 * own intro line do not park; a CRITICAL point parks unless `[RESOLVED]` follows its tag
 * on the same line; and any other line that is not a plain item parks (non-bullet prose,
 * unindented continuation, a sub-heading, a setext underline, a fenced block, an unreadable
 * leading token). Indented prose continues the item above it, and only that item, with no
 * blank line between; an indented line that is itself a list item is its own entry.
 *
 * Fence state is scoped to the section (#1187 fix round 2). The heading is matched whatever
 * the fence state, and fence/continuation state reset on entry, so an unclosed ``` a
 * thousand lines above the section can no longer hide the heading and every point in it.
 * The stateless reader is also the right shape for a gate that runs once per cycle: it has
 * to be right about a body it has never seen, not fast about one it has.
 */
export function readOpenPoints(issueBody: string): OpenPointReading {
  const entries: Entry[] = [];
  const add = (kind: Entry["kind"], flat: string): Entry => {
    const entry: Entry = { kind, text: "", pieces: [flat] };
    entries.push(entry);
    return entry;
  };
  /** Open a list item: its text is normalised now, and stays unless a continuation joins it. */
  const openItem = (flat: string): Entry => ({
    kind: classifyItem(flat),
    text: storedText(flat),
    pieces: [flat],
  });
  let level = 0; // heading level of the open section; 0 = outside it
  let fence: string | undefined; // opener of the fence we are inside — INSIDE the section only
  let fenceEntry: Entry | undefined; // the one entry a fenced block inside the section becomes
  let cur: Entry | undefined; // the item an indented prose line joins
  for (const raw of issueBody.split(/\r?\n/)) {
    const heading = raw.match(ATX_HEADING);
    // The heading is read before any fence handling, so a fence opened above cannot
    // swallow the section, and entering it clears state carried from outside.
    if (heading !== null && isOpenPointsHeading(raw)) {
      level = heading[1]?.length ?? 0;
      fence = undefined;
      fenceEntry = undefined;
      cur = undefined;
      continue;
    }
    if (level === 0) continue;
    if (fence !== undefined) {
      // Fence bodies are quoted verbatim, so they are flattened here rather than at close.
      const flat = raw.trim() === "" ? "" : flattenIssueText(raw);
      if (fenceEntry !== undefined && flat !== "") fenceEntry.pieces.push(flat);
      if (closesFence(raw, fence)) fence = undefined;
      continue;
    }
    const opener = raw.match(FENCE_OPEN)?.[1];
    if (opener !== undefined) {
      fence = opener;
      cur = undefined;
      fenceEntry = add("parked", flattenIssueText(raw));
      continue;
    }
    if (heading !== null) {
      const depth = heading[1]?.length ?? 0;
      cur = undefined;
      // A deeper heading inside the section is a sub-heading, and it parks.
      if (depth > level) {
        add("parked", flattenIssueText(raw));
        continue;
      }
      level = 0;
      continue;
    }
    if (raw.trim() === "") {
      cur = undefined;
      continue;
    }
    // The one prose line the writer itself emits is not an author's unparseable line.
    if (flattenIssueText(raw) === OPEN_POINTS_INTRO) {
      cur = undefined;
      continue;
    }
    if (SETEXT_UNDERLINE.test(raw)) {
      add("parked", flattenIssueText(raw));
      cur = undefined;
      continue;
    }
    const item = raw.match(LIST_ITEM)?.[1];
    if (item !== undefined) {
      // An indented list item is its own entry (#1187 fix round 2): folding it into the
      // bullet above lost a nested CRITICAL point that `classifyItem` reads perfectly well.
      const flat = flattenIssueText(item)
        .replace(/^\[[ xX]\](?: |$)/, "")
        .trim();
      // Classified on the raw flatten; stored through the one normaliser, so the credential
      // never reaches the assumption or the handoff.
      cur = openItem(flat);
      entries.push(cur);
      continue;
    }
    // Indented plain prose continues the item above it — except a bracketed token, which
    // is not prose to fold in and parks on its own instead.
    const piece = flattenIssueText(raw);
    if (/^[ \t]/.test(raw) && cur !== undefined && !piece.startsWith("[")) {
      cur.pieces.push(piece);
      continue;
    }
    cur = add("parked", piece);
  }
  const reading: OpenPointReading = { points: [], resolved: [], unparsed: [] };
  for (const entry of entries) {
    // Flatten-once happens at open (one `flattenIssueText` per line, never per line of a
    // growing entry); a multi-piece entry — one that took a continuation — joins its pieces
    // and re-normalises here, once, in place of the old per-line rebuild.
    if (entry.pieces.length > 1) entry.text = storedText(entry.pieces.join(" "));
    if (entry.kind === "point") reading.points.push(entry.text);
    else if (entry.kind === "resolved") reading.resolved.push(entry.text);
    else if (entry.kind === "parked") reading.unparsed.push(entry.text);
  }
  return reading;
}

/**
 * The bounded, redacted texts of one kind of a reading (#1187 fix round 2).
 *
 * The gate takes `points` and `unparsed` (the blocking lines, capped and traced) and
 * `resolved` (assumption text, bounded but never counted as blocking). Keeping this here
 * rather than at the call site means a `openPoints` list cannot be written by a path that
 * forgot the bound.
 */
export function openPointTexts(reading: OpenPointReading, kind: keyof OpenPointReading): string[] {
  return kind === "points" || kind === "unparsed"
    ? boundedBlockingTexts(reading[kind], kind)
    : reading[kind];
}
