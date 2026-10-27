/**
 * plan-duplicate-self — the deterministic post-filter that stops the /plan
 * duplicate-risk check naming the issue it was asked to plan (#1856).
 *
 * Field evidence: two of seven plan sessions on an external factory handed off
 * at exit 10 with a HIGH duplicate verdict, and on one of them the named
 * "duplicate" was the issue being planned itself ("#869 (OPEN …) already covers
 * this exact scope verbatim"). The descriptor of a plan started FROM an
 * existing issue is a near-copy of that issue's own title, and the mechanical
 * inventory plus the prior-context rows both feed the child a verbatim listing
 * of it — so the child's most confident duplicate is the ticket under plan.
 *
 * Five rules, all deterministic, none of them a judgment about the model's
 * reasoning:
 *
 *   1. The source issue N and its own split children are never duplicates. They
 *      are the SUBJECT of the plan. Excluded wherever they appear: the
 *      inventory rows, the prior-context rows, the child's prompt, and the
 *      verdict's named issues.
 *   2. A CLOSED issue that the child ITSELF called prior art or a reversal
 *      target is what the child's own charter says is not a duplicate, so a
 *      HIGH that rests only on those is downgraded, not believed. Prior art can
 *      be satisfied ONLY by an inventory row known to be CLOSED: a named issue
 *      the inventory never carried has no known state, and rule 3 keeps it.
 *   3. Anything else stands: a HIGH that names one other OPEN issue halts
 *      exactly as it did before, and so does a `#X-k` token whose parent is not
 *      the source — that is someone else's decomposition, not this plan's.
 *   4. A number this filter cannot account for keeps the HIGH (#1856 review
 *      rounds 1–2). The extraction above reads `#N` tokens only, so a rationale
 *      that cites the rest of its evidence some other way — `GH-12`, `ticket 12`,
 *      `bug 12`, `issue-12`, `issue:12`, `issue12`, `pull 12`, `PR 12`,
 *      `…/issues/12`, or a `#` id past `Number.MAX_SAFE_INTEGER` — looked like a
 *      self-only HIGH to rules 1–2 and was downgraded while main halted. Round 1
 *      answered that with a WORD LIST of reference shapes and it leaked: every
 *      spelling the list had not enumerated still downgraded. So rule 4 is
 *      STRUCTURAL and fail-closed instead. After the `#N` tokens this filter
 *      positively resolved as excluded, the rest of the text is stripped only of
 *      the number shapes a rationale legitimately carries (ISO dates, version
 *      strings, clock times, and the digits inside the excluded tokens) and ANY
 *      DIGIT RUN THAT SURVIVES KEEPS THE HIGH. A stray number keeps the stop,
 *      never the reverse, so an unenumerated spelling of a reference cannot
 *      downgrade anything: the failure mode moves from a silent wrong downgrade
 *      to a halt the operator can see.
 *   5. The prior-art word must sit in the SAME CLAUSE as the CLOSED issue's
 *      token (#1856 review round 2), where a clause ends at `. ! ? ; , :` or a
 *      newline. Words from an adjacent issue's clause count for nothing, so
 *      "#1856 is prior art; #103 is unlanded duplicate work" halts, and so does
 *      the comma form, while "reverses the landed decision in #103" downgrades.
 *      A clause that NEGATES the prior-art word ("#103 is not prior art, it is
 *      unlanded duplicate work") is the child saying the closed issue is a real
 *      duplicate, and suppresses nothing. Round 3: EVERY mention is judged, not
 *      just the first — "#103 is prior art for this. #103 is not landed, it is
 *      unlanded duplicate work" is one affirmation followed by a denial, and a
 *      reply that reads only the first clause suppressed a HIGH main halts on. A
 *      CLOSED issue is excluded only when SOME clause affirms prior art and NO
 *      clause naming it negates it.
 *
 * Rules 1–5 read the child's FULL reply, not the 400-char slice the parser keeps
 * for display (round-1 lens H1): an OPEN duplicate named past that cut is
 * invisible to the slice, and a HIGH that halts on main must not be downgraded
 * here because the evidence fell off the end of a window.
 *
 * An ABSENT marker is never a downgrade — `parseDuplicateRisk` defaults an
 * unparsed reply to medium, and recording that as an intentional suppression
 * would let a crashed child read as a decision the driver made.
 *
 * Issue state is normalised ONCE, where the post-filter's known-issue map is
 * built (`normaliseIssueState` in plan-investigate.ts), so every reader of
 * `KnownIssue.state` / `ExcludedDuplicate.state` sees the same three values and
 * no comparison has to re-case the string.
 */
import {
  citesUnaccountedNumber,
  clauseNaming,
  everyClauseNaming,
  namedIssueRefs,
  priorArtClause,
  priorArtForAllMentions,
} from "./plan-duplicate-citations.ts";
import {
  EXCLUSION_CLAUSE_MAX_CHARS,
  EXCLUSION_REASON_MAX_CHARS,
  EXCLUSION_TITLE_MAX_CHARS,
} from "./plan-duplicate-disclosure.ts";
import type { MechanicalInventory } from "./plan-inventory.ts";
import type { DuplicateRisk, ExcludedDuplicate } from "./plan-investigate.ts";

// Re-exported so the extractor's consumers and its tests keep one import site:
// the post-filter's rules and the text functions they call are one contract, and
// a reader of `downgradeSelfDuplicate` should not have to discover a second
// module to understand what a `#token` match means.
export {
  citesUnaccountedNumber,
  citesUnaccountedNumberStripped,
  clauseNaming,
  everyClauseNaming,
  namedIssueRefs,
  namedIssueTokens,
  priorArtForAllMentions,
  type NamedIssueRef,
} from "./plan-duplicate-citations.ts";

/** The prior-context source tag the duplicate-risk child is shown for a related issue. */
const ISSUE_SOURCE_RE = /^issue #(\d+) \(/;

/** The rule that removed a candidate, rendered into the disclosure. */
export const EXCLUSION_REASONS = {
  source: "the issue this plan is for (a plan is not the duplicate of its own subject)",
  "split-child": "the planned issue's own split child",
  "prior-art": "a CLOSED issue the risk check itself called prior art or a reversal target",
} as const;

/**
 * Tail of the prior-art disclosure: the clause the rule matched is quoted, so
 * the operator reads the child's own words instead of a fixed claim the filter
 * asserts about them.
 */
export const PRIOR_ART_EVIDENCE = "the risk check called it that in this clause";

/**
 * The disclosure itself — the section renderer and every character bound on it —
 * lives in plan-duplicate-disclosure.ts, which also names why each slot is
 * bounded the width it is. `EXCLUSION_REASONS` and `PRIOR_ART_EVIDENCE` stay
 * HERE because the rules below compose them into the row they explain; a row
 * whose wording the rule that removed it cannot see is a disclosure nobody can
 * check.
 */

/**
 * Is this already-normalised state "CLOSED"? The comparison is exact by design:
 * {@link normaliseIssueState} is the only place a forge's spelling is cased, and
 * a caller that passes raw bytes gets `false` — a state nobody normalised is
 * never evidence that an issue's work landed.
 */
export function isClosedState(state: PlanIssueState): boolean {
  return state === "CLOSED";
}

/**
 * Is `n` the source issue itself, or one of its split children? A split child
 * of issue N is anything the child or the inventory writes as `N-k` (the
 * decomposition id form a planner uses for an issue's own sub-issues), so
 * `#869-2` is the subject, never a duplicate. A bare `#N` is decided by
 * `number === source` at the call site, so an unrelated `N` from some other
 * numbering can never be mistaken for the subject.
 */
export function isSplitChildOf(parent: number, source: number): boolean {
  return Number.isSafeInteger(parent) && parent === source;
}

/** The inventory rows for a plan of issue `source`, with the subject removed. */
export function relatedExcludingSource(
  inv: MechanicalInventory,
  source: number | undefined,
): MechanicalInventory["related"] {
  if (source === undefined) return inv.related;
  return inv.related.filter((r) => r.number !== source && !isSplitChildOf(r.number, source));
}

/**
 * The prior-context rows the duplicate-risk child sees, with the subject
 * removed. `assemblePriorContext` pushes `issue #N (STATE)` entries straight
 * from the inventory, so without this the "PM has already established" block
 * names the planned issue itself — the second self-match vector.
 */
export function priorContextExcludingSource(
  priorContext: { source: string; fact: string }[],
  source: number | undefined,
): { source: string; fact: string }[] {
  if (source === undefined) return priorContext;
  return priorContext.filter((p) => {
    const m = ISSUE_SOURCE_RE.exec(p.source);
    if (!m) return true;
    const n = Number(m[1]);
    return n !== source && !isSplitChildOf(n, source);
  });
}

/**
 * The three issue states this filter reasons about. The forges agree on
 * `OPEN`/`CLOSED` (`mapGhIssue` upper-cases, `mapGlIssue` maps `opened`/`closed`
 * onto them); anything else they or a cache file carry is `"unknown"`, which
 * satisfies no rule rather than being compared case-by-case at each site.
 *
 * `PlanIssueState`, not `IssueState`: forge-types.ts already owns that name for
 * the two-state forge union, and a second `IssueState` here shadowed it in every
 * file that imported both.
 */
export type PlanIssueState = "OPEN" | "CLOSED" | "unknown";

/**
 * Normalise a forge's state string to {@link PlanIssueState}. ONE site does this —
 * where the post-filter's known-issue map is built — so no downstream rule has
 * to re-case or trim a string to decide whether an issue is closed.
 */
export function normaliseIssueState(state: string | undefined): PlanIssueState {
  const upper = (state ?? "").trim().toUpperCase();
  return upper === "OPEN" || upper === "CLOSED" ? upper : "unknown";
}

/**
 * Is this value already one of the three states the union admits? The cache
 * guard asks, because it reads bytes nobody passed through
 * {@link normaliseIssueState}: admitting only the normalised forms means a
 * hand-edited entry with `"closed"` or `"wontfix"` is a MISS rather than a state
 * some rule later has to second-guess.
 */
export function isIssueState(x: unknown): x is PlanIssueState {
  return x === "OPEN" || x === "CLOSED" || x === "unknown";
}

/** What the inventory knows about one issue number. */
export interface KnownIssue {
  state: PlanIssueState;
  title: string;
}

/**
 * The post-filter. `verdict` is what the child's marker parsed to; a failed
 * dispatch (no verdict at all) and an absent marker both come back untouched —
 * nothing here may invent a downgrade. Pass `fullText` (the child's uncut reply)
 * so the fail-closed rules read evidence the 400-char display slice dropped.
 * `known` maps an issue number to what the inventory carried for it; a number
 * with no row has no known state, so it can never satisfy the CLOSED-prior-art
 * rule and its HIGH stands.
 */
export function downgradeSelfDuplicate(
  verdict: DuplicateRisk,
  args: { sourceIssue?: number; known?: Map<number, KnownIssue>; fullText?: string },
): DuplicateRisk {
  if (verdict.downgradedFrom !== undefined) return verdict;
  if (verdict.level.toLowerCase() !== "high") return verdict;
  const source = args.sourceIssue;
  if (source === undefined) return verdict;
  const text = args.fullText ?? verdict.rationale;
  const named = namedIssueRefs(text);
  // A HIGH that names NO issue cannot be attributed to the subject, so it is
  // not the defect this filter exists for and it halts as any other HIGH does.
  if (named.length === 0) return verdict;
  const known = args.known ?? new Map<number, KnownIssue>();
  // Rules 3 and 5, judged first, on the untouched text: a CLOSED issue whose own
  // clause carries no unnegated prior-art word, and an `X-k` token that is not
  // this plan's decomposition, are evidence the child meant as a real duplicate —
  // no later reasoning about the subject may talk the operator out of that halt.
  for (const ref of named) {
    if (ref.parent !== undefined) {
      if (!isSplitChildOf(ref.parent, source)) return verdict;
      continue;
    }
    if (ref.id === source) continue;
    const row = known.get(ref.id);
    if (row === undefined || !isClosedState(row.state)) continue;
    if (!priorArtForAllMentions(everyClauseNaming(text, ref.token))) return verdict;
  }
  const excluded: ExcludedDuplicate[] = [];
  // The tokens this filter positively resolved as excluded; their digits come
  // out of the text before rule 4 looks for what is left.
  const resolved: string[] = [];
  for (const ref of named) {
    // A split-child token: #<parent>-<k> of the planned issue is its own
    // decomposition, never a duplicate of it.
    if (ref.parent !== undefined) {
      // Checked against the source in the pass above; an unrelated parent never
      // gets here.
      if (!isSplitChildOf(ref.parent, source)) return verdict;
      resolved.push(ref.token);
      excluded.push({
        number: ref.parent,
        state: known.get(ref.parent)?.state ?? "unknown",
        title: clip(known.get(ref.parent)?.title ?? "", EXCLUSION_TITLE_MAX_CHARS),
        reason: EXCLUSION_REASONS["split-child"],
      });
      continue;
    }
    const n = ref.id;
    const row = known.get(n);
    if (n === source) {
      resolved.push(ref.token);
      excluded.push(excludedRow(n, row, EXCLUSION_REASONS.source));
      continue;
    }
    if (row !== undefined && isClosedState(row.state)) {
      // Judged by rule 5 above, so SOME clause naming it carries the prior-art
      // word and none negates it. The disclosure quotes the FIRST affirming
      // clause — the one that satisfied the rule — not merely the first mention.
      const affirming =
        everyClauseNaming(text, ref.token).find((c) => priorArtClause(c)) ??
        clauseNaming(text, ref.token);
      const clause = clip(affirming, EXCLUSION_CLAUSE_MAX_CHARS);
      resolved.push(ref.token);
      excluded.push(
        excludedRow(
          n,
          row,
          `${EXCLUSION_REASONS["prior-art"]} — "${clause}" (${PRIOR_ART_EVIDENCE})`,
        ),
      );
      continue;
    }
    // A named issue the filter may not suppress: no inventory row means no
    // known state, so the CLOSED-prior-art rule cannot apply to it (rule 2).
    return verdict;
  }
  // Rule 4, after every token has been judged: a number this filter has not
  // accounted for is evidence it never saw, so the HIGH stands exactly as an
  // OPEN one would rather than ride along unexamined in a downgrade that never
  // read it.
  if (citesUnaccountedNumber(text, resolved)) return verdict;
  return {
    ...verdict,
    level: "medium",
    downgradedFrom: "high",
    downgradeReason: `every issue the duplicate-risk check named was the plan's own subject or closed prior art (${excluded
      .map((e) => `#${e.number}: ${e.reason}`)
      .join("; ")})`,
    excludedIssues: excluded,
  };
}

function excludedRow(
  number: number,
  row: KnownIssue | undefined,
  reason: string,
): ExcludedDuplicate {
  return {
    number,
    state: row?.state ?? "unknown",
    title: clip(row?.title ?? "", EXCLUSION_TITLE_MAX_CHARS),
    reason: clip(reason, EXCLUSION_REASON_MAX_CHARS),
  };
}

/**
 * The row's own clip: cut to width, no ellipsis — a row's slots are bounded
 * rather than decorated, and the prior-art reason ends in a closing bracket
 * whose mate the quoted clause opened, which an ellipsis would drop.
 */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
