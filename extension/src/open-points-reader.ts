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
import { flattenIssueText, redactThenBound } from "./text-flatten.ts";
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
/**
 * Cap the length of one stored entry; see {@link MAX_OPEN_POINT_ENTRIES}.
 *
 * Exported because the artifact reader bounds the strings it restores from a persisted
 * file with the SAME number (#1187 fix round 4): two independent 2000s drift, and when
 * they do the write side clips tighter than the read side and nobody notices.
 */
export const OPEN_POINT_CHAR_CAP = 2000;
/** Marker for an entry that hit {@link OPEN_POINT_CHAR_CAP}. */
const CLIPPED_MARKER = "…(clipped)";
/** How many code points survive {@link OPEN_POINT_CHAR_CAP} once the marker fits beside them. */
const CLIPPED_KEEP = OPEN_POINT_CHAR_CAP - Array.from(CLIPPED_MARKER).length;
/** Final entry recording what {@link MAX_OPEN_POINT_ENTRIES} dropped from the blocking list. */
function moreEntriesNote(dropped: number): string {
  return `…and ${dropped} more open-point lines`;
}
/** Final entry recording what {@link MAX_OPEN_POINT_ENTRIES} dropped from the resolved list. */
function moreResolvedNote(dropped: number): string {
  return `…and ${dropped} more resolved open points`;
}

/**
 * Bound one stored entry: redact, then clip, so a clip can never cut a secret in half.
 *
 * The marker is appended from {@link redactThenBound}'s own `clipped` flag rather than from
 * a length comparison the caller re-derives: the bound is what knows whether it trimmed,
 * and a caller that measures the returned string again can lose the marker (measured on
 * bun 1.4.3 and node 22 — the same expression, `chars.length > max` inside the callee and
 * `chars.length > max` in the caller, disagreed once the callee was inlined, and the
 * clipped branch silently returned the un-marked text). `CLIPPED_KEEP` leaves room for the
 * marker so a bounded entry never exceeds {@link OPEN_POINT_CHAR_CAP} (#1187 fix round 4).
 */
function boundEntry(text: string): string {
  const { text: kept, clipped } = redactThenBound(text, CLIPPED_KEEP);
  return clipped ? `${kept}${CLIPPED_MARKER}` : kept;
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

/**
 * Code points an entry has accumulated so far, without building its stored text.
 *
 * The bound an entry closes to is {@link OPEN_POINT_CHAR_CAP} over the join of its pieces,
 * and the join only ever grows, so once that join passes the cap no further piece can move
 * the stored text — it is clipped either way. Counting the pieces (plus one separator each)
 * is O(pieces) and never allocates a joined string, so the reader stops bounding an entry it
 * has already bounded (#1187 fix round 4).
 */
function entryChars(entry: Entry): number {
  let n = 0;
  for (const piece of entry.pieces) n += piece.length + 1;
  return n;
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
 * Whether any bracketed token in `text` case-folds to CRITICAL (#1187).
 *
 * One place for the anywhere-scan, so the fall-through at the end of {@link classifyItem}
 * and the link-bullet exemption cannot disagree about what a CRITICAL-shaped tag is.
 */
function hasCriticalToken(text: string): boolean {
  return [...text.matchAll(/\[([^\]]*)\]/g)].some(
    (m) => foldToken(m[1] ?? "") === foldToken(CRITICAL_SEVERITY),
  );
}

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
    // The link exemption is not a blind pass either (#1187 fix round 4): the anywhere-CRITICAL
    // scan runs on the whole bullet first, so a tag hidden inside link syntax —
    // `- [x](https://e/#[CRITICAL] who)` — parks instead of reading as an ordinary note.
    if (after.startsWith("(")) return hasCriticalToken(text) ? "parked" : "plain";
    return "parked";
  }
  if (/^\W*critical\b/i.test(text)) return "parked";
  return hasCriticalToken(text) ? "parked" : "plain";
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
 *
 * Derived from the FLATTENED constant: invisible characters (U+200B, bidi controls, BOM)
 * are removed from the pattern rather than required by it. `escapeRegExpLiteral` in the
 * contract escapes regex metacharacters but not format characters, so a matcher built from
 * the raw constant turned every stray zero-width character in a pasted heading into a
 * requirement at that exact position — and a heading that does not match opens no section,
 * so the gate silently did not run while the body looked clean. Deriving from the flatten
 * keeps the match an exact literal (a mangled word, a truncated tail or a reworded heading
 * still opens nothing) while making an unrenderable heading gate the way its visible text
 * reads (#1187 fix round 4).
 */
const OPEN_POINTS_ATX = new RegExp(openPointsHeadingPattern());

/**
 * Whether `raw` is the exact OPEN_POINTS_HEADING, read independently of fence state.
 *
 * Both sides of the comparison are flattened — the pattern above is derived from the
 * flattened constant and the line is flattened here — so a stray invisible character
 * anywhere in the heading cannot disable the gate (#1187 fix round 4). The match stays an
 * exact literal: every other difference still opens no section, which is what the
 * settlement's "no cross-section scan" actually settles.
 */
function isOpenPointsHeading(raw: string): boolean {
  return OPEN_POINTS_ATX.test(flattenIssueText(raw));
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
   *
   * Saturation is checked BEFORE the entry is built (#1187 fix round 4): the old order
   * allocated an Entry and a pieces array for every overflow line and threw both away, so a
   * megabyte section paid one allocation per line for work that was counted and dropped. The
   * caller skips the flatten for the same reason (see {@link acceptsMore}).
   */
  const push = (kind: Entry["kind"], piece: string): Entry | undefined => {
    if (piece === "") return undefined;
    const produced = counts[kind]++;
    if (!acceptEntry(produced)) return undefined;
    const entry: Entry = { kind, text: "", pieces: [piece] };
    entries.push(entry);
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
  /**
   * Whether one more line of `kind` can be stored (#1187 fix round 4).
   *
   * Lets the two accumulation sites skip `flattenIssueText` — the expensive part of the
   * loop — for a line whose kind is already full and whose text is therefore thrown away.
   */
  const acceptsMore = (kind: Entry["kind"]): boolean => acceptEntry(counts[kind]);
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
      //
      // Two bounds keep an unclosed fence linear (#1187 fix round 4): once the entry that
      // accumulates the block already exceeds the char cap, further lines cannot change the
      // stored text at all, so they are counted but not flattened or joined; and a piece is
      // never appended to an entry that is already over the cap, so `pieces` cannot grow
      // without limit on a body nobody would ever read.
      if (fenceEntry === undefined || entryChars(fenceEntry) >= OPEN_POINT_CHAR_CAP) {
        if (closesFence(raw, fence)) fence = undefined;
        continue;
      }
      const flat = flattenIssueText(raw);
      if (flat !== "") fenceEntry.pieces.push(flat);
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
    //
    // A continuation of a kind that is already full, or of an entry that already exceeds the
    // char cap, is neither flattened nor appended (#1187 fix round 4): the text was going to
    // be counted and dropped either way, and a wrapped entry of a megabyte of indented lines
    // is precisely the pathological body the bounds exist for.
    if (/^[ \t]/.test(raw) && cur !== undefined && !raw.replace(/^[ \t]+/, "").startsWith("[")) {
      if (entryChars(cur) < OPEN_POINT_CHAR_CAP && acceptsMore(cur.kind)) {
        cur.pieces.push(flattenIssueText(raw));
      }
      continue;
    }
    cur = push("parked", flattenIssueText(raw));
  }
  const reading: OpenPointReading = { points: [], resolved: [], unparsed: [], counts };
  // The ONE place `text` is computed: for every entry, from all its pieces, once. A
  // one-piece entry gets exactly the same treatment as a wrapped one, so no entry can
  // reach a reading with the empty string it was created with.
  for (const entry of entries) {
    entry.text = boundEntry(entry.pieces.join(" "));
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
  // No `map(boundEntry)`: every text in a reading is bounded at the single close site in
  // `readOpenPoints`, so re-bounding here was a second pass over text the reader already
  // redacted and clipped (#1187 fix round 4).
  const kept = all.slice(0, MAX_OPEN_POINT_ENTRIES);
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
  // Bounded at the reader's single close site, like the blocking list (#1187 fix round 4).
  const kept = reading.resolved.slice(0, MAX_OPEN_POINT_ENTRIES);
  const dropped = reading.counts.resolved - kept.length;
  if (dropped > 0) {
    trace(
      `work-driver: intent — resolved open-point bound dropped ${dropped} beyond ${MAX_OPEN_POINT_ENTRIES}; the spec records the first ${MAX_OPEN_POINT_ENTRIES}`,
    );
    kept.push(moreResolvedNote(dropped));
  }
  return kept;
}
