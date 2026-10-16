/**
 * open-points-reader — the Open points section of a filed issue, read mechanically (#1151, #1187).
 *
 * The /plan gap gate writes the section (plan-gap-disclosure.ts); the /work intent gate
 * reads it back and decides whether the issue is buildable. The rule is TOPIC-NEUTRAL and
 * has no keyword list: EVERY unresolved CRITICAL point gates the cycle whatever it says,
 * and so does any line that is not a plain bullet, a task checkbox, a link bullet or a
 * HIGH/MEDIUM/LOW tag. Nothing here decides a verdict — `applyOpenPointGate` in
 * work-driver-intent-finalise.ts turns a reading into a park and fixes the order against
 * `reconcileVerdict`; this module only reads, never fetches the issue, and never decides
 * what the spec says.
 *
 * Split out of work-driver-intent-criticality.ts, which keeps the #574 contradiction
 * classifier: two mechanical rules, one file each, both under the size limit.
 */
import {
  CRITICAL_SEVERITY,
  OPEN_POINTS_HEADING,
  OPEN_POINTS_INTRO,
  SEVERITY_WORDS,
  openPointsHeadingPattern,
} from "./open-points-contract.ts";
import { redactSecrets } from "./secret-patterns.ts";
import { flattenIssueText } from "./text-flatten.ts";
import { trace } from "./trace.ts";

/** Case-folded token without spaces or hyphens: `[CRIT ICAL]` and `[critical]` both fold to `critical`. */
function foldToken(token: string): string {
  return token.toLowerCase().replace(/[\s-]/g, "");
}

/** Tag-like: folds to a severity word without being that word exactly. Such a tag parks; it never passes. */
function isTagLike(token: string): boolean {
  return SEVERITY_WORDS.some((word) => word !== token && word.toLowerCase() === foldToken(token));
}

/**
 * The raw lines of one list item or prose line of the section, before storage.
 *
 * `kind` is fixed when the item starts; only the kinds a reading actually emits are in
 * the union (a `plain` item contributes no text and never becomes an entry — see
 * {@link ItemDisposition}). `pieces` holds the flattened raw lines that make the entry up,
 * newest last; the closing loop joins them and computes `text` exactly once (#1187 fix
 * round 2). Re-flattening the accumulated text on every continuation line made the reader
 * O(n²) in the length of a wrapped entry, so pieces are collected raw and normalised once,
 * when the entry closes. An entry with no continuation has one piece and gets the same
 * treatment as one with twenty.
 */
interface Entry {
  kind: "point" | "resolved" | "parked";
  /** Computed once by the closing loop: normalised, redacted and bounded. */
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
/** The cap, exported so a test asserts against the constant rather than a copy of it. */
export const OPEN_POINT_ENTRY_CAP = MAX_OPEN_POINT_ENTRIES;
/** Cap the length of one stored entry; see {@link MAX_OPEN_POINT_ENTRIES}. */ const MAX_OPEN_POINT_CHARS = 2000;
/** Marker for an entry that hit {@link MAX_OPEN_POINT_CHARS}. */
const CLIPPED_MARKER = "…(clipped)";
/** Final entry recording what {@link MAX_OPEN_POINT_ENTRIES} dropped from the blocking list. */
function moreEntriesNote(dropped: number): string {
  return `…and ${dropped} more open-point lines`;
}
/** Final entry recording what {@link MAX_OPEN_POINT_ENTRIES} dropped from the resolved list. */
function moreResolvedNote(dropped: number): string {
  return `…and ${dropped} more resolved open points`;
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
 * Every stored text in `readOpenPoints` goes through this one function, and through it
 * exactly once, from the closing loop: `classifyItem` reads the *raw* flatten (a tag the
 * redactor rewrote would misclassify), and only the stored form is sanitised.
 */
function storedText(flat: string): string {
  return boundEntry(flat);
}

/**
 * Keep at most {@link MAX_OPEN_POINT_ENTRIES} entries of one kind, counting the rest.
 *
 * Once a kind is full the reader stops building entries for it and only increments the
 * counter, so a megabyte section costs one push per line rather than one push and one
 * bound per line, and the "N more" figure stays exact against the number the cap actually
 * dropped (#1187 fix round 2).
 */
function acceptEntry(count: number): boolean {
  return count < MAX_OPEN_POINT_ENTRIES;
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
 * The disposition {@link classifyItem} reads from one item. A `plain` item contributes no
 * text to a reading, so it is not one of {@link Entry}'s kinds — which is why the union here
 * is wider than Entry's and the reader drops `plain` without counting it.
 */
type ItemDisposition = Entry["kind"] | "plain";

/**
 * The disposition of one list item, from its flattened text with any task checkbox removed.
 * Severity is recognised only at the start of the text (#1187): a tag behind emphasis or
 * strikethrough is not read, and a CRITICAL-shaped tag anywhere else in the text parks.
 */
function classifyItem(text: string): ItemDisposition {
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
  /**
   * How many entries of each kind the section PRODUCED, kept entries and cap overflow alike.
   *
   * The reader stops building entries once a kind is full, so the kept lists alone cannot
   * say what was dropped; this is what makes the "…and N more" notes exact.
   */
  counts: Record<Entry["kind"], number>;
}

/**
 * The exact heading, tolerant of leading spaces, `#` count and trailing hashes — nothing else.
 *
 * Derived from {@link OPEN_POINTS_HEADING} by {@link openPointsHeadingPattern}, so the
 * reader cannot keep matching a heading the contract no longer writes; the `(` and `)` of
 * "(unresolved at the gap-gate cap)" are escaped to literals, so a near-miss heading
 * ("Open points (unresolved at the gap-gate", a reworded tail, a trailing word) does not
 * match and opens no section: the settlement's "no cross-section scan" holds exactly.
 */
const OPEN_POINTS_ATX = new RegExp(openPointsHeadingPattern());

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
 * The one text the Open points heading would have to appear as to be read.
 *
 * Used ONLY for the diagnostic in {@link readOpenPoints}: when no exact heading matched but
 * the body contains the heading text somewhere — inside a fence, as a fence info string, in
 * a table cell — the operator is told the section was not read. Behaviour is unchanged
 * (no park, per the settlement); this is the trace that says the gate did not run rather
 * than that it ran and found nothing.
 */
const OPEN_POINTS_HEADING_FLAT = flattenIssueText(OPEN_POINTS_HEADING);

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
  // Per-kind counts of everything the section produced, kept entries and overflow alike,
  // so the "N more" note is exact and a full kind stops building entries at all.
  const counts: Record<Entry["kind"], number> = { point: 0, resolved: 0, parked: 0 };
  /**
   * Push one entry of one kind, or count it and drop it once that kind is full.
   *
   * An empty piece never becomes an entry at all (#1187 fix round 2): a blank line inside a
   * fence used to open an entry whose only piece was "", which drained into the reading as
   * an empty bullet and consumed a cap slot.
   */
  const push = (kind: Entry["kind"], piece: string): Entry | undefined => {
    if (piece === "") return undefined;
    const entry: Entry = { kind, text: "", pieces: [piece] };
    counts[kind]++;
    if (acceptEntry(counts[kind] - 1)) entries.push(entry);
    return entry;
  };
  /**
   * The ONE place a non-item entry is created (#1187 fix round 2).
   *
   * Entries store no `text` when they open: an entry that eagerly flattened its first line
   * left every entry with a stale text unless a continuation happened to arrive, so a prose
   * line, a sub-heading, a setext underline, a fence or a single-line item drained a blank
   * string into the reading and the handoff rendered empty bullets. `text` is computed once,
   * by the closing loop, from every piece.
   */
  const open = (kind: Entry["kind"], piece: string): void => {
    push(kind, piece);
  };
  let level = 0; // heading level of the open section; 0 = outside it
  let fence: string | undefined; // opener of the fence we are inside — INSIDE the section only
  let fenceEntry: Entry | undefined; // the one entry a fenced block inside the section becomes
  let cur: Entry | undefined; // the item an indented prose line joins
  let sawHeading = false;
  for (const raw of issueBody.split(/\r?\n/)) {
    const heading = raw.match(ATX_HEADING);
    // The heading is read before any fence handling, so a fence opened above cannot
    // swallow the section, and entering it clears state carried from outside.
    if (heading !== null && isOpenPointsHeading(raw)) {
      level = heading[1]?.length ?? 0;
      fence = undefined;
      fenceEntry = undefined;
      cur = undefined;
      sawHeading = true;
      continue;
    }
    if (level === 0) continue;
    if (fence !== undefined) {
      // Fence bodies are quoted verbatim, so they are flattened here rather than at close.
      // A blank line inside a fence is skipped outright: it is not a piece and, on the
      // opening line, never became an entry of its own (#1187 fix round 2).
      const flat = flattenIssueText(raw);
      if (fenceEntry !== undefined && flat !== "") fenceEntry.pieces.push(flat);
      if (closesFence(raw, fence)) fence = undefined;
      continue;
    }
    const opener = raw.match(FENCE_OPEN)?.[1];
    if (opener !== undefined) {
      fence = opener;
      cur = undefined;
      // The fence's opening line is the entry the whole block accumulates into; a fence of
      // nothing but blank lines contributes that one line and no empty entry.
      fenceEntry = push("parked", flattenIssueText(raw));
      continue;
    }
    if (heading !== null) {
      const depth = heading[1]?.length ?? 0;
      cur = undefined;
      // A deeper heading inside the section is a sub-heading, and it parks.
      if (depth > level) {
        open("parked", flattenIssueText(raw));
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
      open("parked", flattenIssueText(raw));
      cur = undefined;
      continue;
    }
    const item = raw.match(LIST_ITEM)?.[1];
    if (item !== undefined) {
      // An indented list item is its own entry (#1187 fix round 2): folding it into the
      // bullet above lost a nested CRITICAL point that `classifyItem` reads perfectly well.
      // Classified on the raw flatten (a tag the redactor rewrote would misclassify); the
      // stored form goes through the one normaliser at close, so no credential reaches the
      // assumption or the handoff.
      const flat = flattenIssueText(item)
        .replace(/^\[[ xX]\](?: |$)/, "")
        .trim();
      const kind = classifyItem(flat);
      // A plain item contributes nothing to the reading, so it takes no slot and no counter
      // tick — but it is still the item an indented prose line below it continues, which is
      // why `cur` still points at a (never-closed, never-counted) entry rather than nothing.
      if (kind === "plain") {
        cur = flat === "" ? undefined : { kind: "parked", text: "", pieces: [flat] };
        continue;
      }
      cur = push(kind, flat);
      continue;
    }
    // Indented plain prose continues the item above it — except a bracketed token, which
    // is not prose to fold in and parks on its own instead.
    const piece = flattenIssueText(raw);
    if (/^[ \t]/.test(raw) && cur !== undefined && !piece.startsWith("[")) {
      cur.pieces.push(piece);
      continue;
    }
    cur = push("parked", piece);
  }
  const reading: OpenPointReading = { points: [], resolved: [], unparsed: [], counts };
  // The ONE place `text` is computed: for every entry, from all its pieces, once. A
  // one-piece entry gets exactly the same treatment as a wrapped one, so no entry can
  // reach a reading with the empty string it was created with.
  for (const entry of entries) {
    entry.text = storedText(entry.pieces.join(" "));
    if (entry.kind === "point") reading.points.push(entry.text);
    else if (entry.kind === "resolved") reading.resolved.push(entry.text);
    else reading.unparsed.push(entry.text);
  }
  // A heading the reader could not read is a gate that silently did not run. The settlement
  // is that a mangled or near-miss heading opens no section and does NOT park — behaviour
  // unchanged — but the operator is told, because "the section was clean" and "there was no
  // section" otherwise look identical downstream.
  if (!sawHeading && flattenIssueText(issueBody).includes(OPEN_POINTS_HEADING_FLAT)) {
    trace(
      `work-driver: intent — no Open points section was read: the body mentions ${JSON.stringify(
        OPEN_POINTS_HEADING,
      )} but not as an exact heading, so no section was scanned and the gate did not park on it`,
    );
  }
  return reading;
}

/**
 * The blocking lines of a reading: unresolved CRITICAL points first, then every line the
 * reader could not classify (#1187 fix round 2).
 *
 * ONE combined cap over the concatenation, not one per list: two lists each capped at 20
 * made the park store 40 entries while its own documentation said 20. When anything was
 * dropped the last entry says how many, and the drop is traced, so a cycle that lost points
 * is visible rather than silently narrowed.
 */
export function blockingOpenPointTexts(reading: OpenPointReading): string[] {
  const all = [...reading.points, ...reading.unparsed];
  const produced = reading.counts.point + reading.counts.parked;
  const kept = all.slice(0, MAX_OPEN_POINT_ENTRIES).map(boundEntry);
  const dropped = produced - kept.length;
  if (dropped > 0) {
    trace(
      `work-driver: intent — open-point bound dropped ${dropped} blocking line(s) beyond ${MAX_OPEN_POINT_ENTRIES}; the park lists the first ${MAX_OPEN_POINT_ENTRIES}`,
    );
    kept.push(moreEntriesNote(dropped));
  }
  return kept;
}

/**
 * The resolved points of a reading, as assumption text (#1187 fix round 2).
 *
 * Its own cap at the same constant, with its own note and its own trace: resolved points
 * become assumptions the PR body renders, so an uncapped list was an unbounded public
 * surface that none of the bounds on the blocking list covered.
 */
export function resolvedOpenPointTexts(reading: OpenPointReading): string[] {
  const kept = reading.resolved.slice(0, MAX_OPEN_POINT_ENTRIES).map(boundEntry);
  const dropped = reading.counts.resolved - kept.length;
  if (dropped > 0) {
    trace(
      `work-driver: intent — resolved open-point bound dropped ${dropped} beyond ${MAX_OPEN_POINT_ENTRIES}; the spec records the first ${MAX_OPEN_POINT_ENTRIES}`,
    );
    kept.push(moreResolvedNote(dropped));
  }
  return kept;
}
