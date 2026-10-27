/**
 * plan-duplicate-disclosure — the `## Duplicate check — excluded candidates`
 * section and the character budget it lives inside (#1856).
 *
 * Split from plan-duplicate-self.ts along the 500-line seam (AGENTS.md §12).
 * One job: render the candidates the post-filter suppressed WITHOUT letting them
 * grow the filed body past the forge's cap. It takes its input shape from
 * `plan-investigate.ts` only — never from `plan-duplicate-self.ts`, which imports
 * nothing here but must keep its reason wording pinned to
 * {@link EXCLUSION_REASON_MAX_CHARS} (the budget test pins that equality).
 *
 * Why a budget at all: #1383 lens round 2 measured this section at 4,753 chars
 * for ten fully-loaded rows against a `POST_FIT_APPENDS_MAX_CHARS` of 3,072 for
 * ALL the post-fit appends together — the section alone could file a body over
 * the limit. The reason a row carries is itself composed (a fixed rule sentence,
 * and until #1856 round 5 a clause quoted from the child) and only one slot had
 * been clipped, so the width of one row was a property of whatever the model
 * wrote. Every interpolable
 * slot is bounded here and the whole section is arithmetic over those bounds, the
 * way `DROPPED_LINE_MAX_CHARS` / `DROPPED_SECTION_MAX_CHARS` are.
 *
 * #1856's own lesson applies to the constants below: a number that reads like a
 * measurement and is really a guess is the bug, restated. The one number here
 * that is not derived is the lead paragraph's width, and it is MEASURED against
 * the actual template at its widest interpolation rather than rounded up by feel.
 */
import {
  DROPPED_ATTRIBUTION_MAX_CHARS,
  POST_FIT_APPENDS_MAX_CHARS,
} from "./plan-dropped-budget.ts";
import type { DuplicateRisk, ExcludedDuplicate } from "./plan-investigate.ts";

/**
 * How many excluded candidates the disclosure itemises. Past this the section
 * counts a summary line instead, so one runaway verdict cannot grow the section
 * the body fitter has already reserved room for (`POST_FIT_APPENDS_MAX_CHARS`
 * enumerates this section in plan-dropped-budget.ts).
 */
export const EXCLUSION_DISCLOSURE_MAX_ROWS = 10;

/** The clip on one row's title — the widest title the disclosure can carry. */
export const EXCLUSION_TITLE_MAX_CHARS = 120;

/**
 * The clip on one row's reason. Both reasons are short fixed prose composed by
 * `plan-duplicate-self.ts` from `EXCLUSION_REASONS` — there is no longer a slot
 * whose width is a property of what the model wrote (#1856 round 5 removed the
 * prior-art reason and the clause it quoted). The bound is therefore generous
 * rather than derived: it comfortably clears the producer's longest sentence
 * while keeping the section's arithmetic honest, and the budget test asserts
 * both halves — that the producer's real reasons fit it, and that an oversized
 * one is cut.
 *
 * It is a literal rather than an expression over `EXCLUSION_REASONS` because
 * that import would be circular (the producer imports this module for its
 * clips); the budget test compares the producer's constants against this number
 * so a reworded rule sentence fails there rather than here quietly widening.
 */
export const EXCLUSION_REASON_MAX_CHARS = 240;

/**
 * The widest row the renderer can emit: `- #`, an id at the widest the
 * disclosure can name, ` (CLOSED)` (the state slot is bounded by
 * {@link DROPPED_ATTRIBUTION_MAX_CHARS}, the bound the dropped section puts on
 * its label fields), `: `, then the clipped reason.
 */
export const EXCLUSION_ROW_MAX_CHARS =
  3 +
  String(Number.MAX_SAFE_INTEGER).length +
  ` (${"CLOSED".padEnd(DROPPED_ATTRIBUTION_MAX_CHARS, "x")})`.length +
  2 +
  EXCLUSION_REASON_MAX_CHARS;

/**
 * The widest omission line: the count is at most the row cap (multi-digit), and
 * the pointer is a fixed sentence. Derived over {@link EXCLUSION_DISCLOSURE_MAX_ROWS}
 * because that is the largest count the renderer can emit.
 */
export const EXCLUSION_OMISSION_MAX_CHARS =
  `- and ${String(EXCLUSION_DISCLOSURE_MAX_ROWS).length} more excluded candidate(s); see the plan session trace`
    .length;

/** The section heading — the reader of the disclosure looks for this. */
export const EXCLUSION_SECTION_HEADING = "## Duplicate check — excluded candidates";

/**
 * The section's lead paragraph at its widest interpolation, MEASURED against the
 * template below rather than estimated: the source-issue number and both risk
 * levels at their longest, with the rows absent. `duplicateExclusionSection`
 * builds the string from this same template, so the two cannot disagree about
 * what the lead costs — the test pins the equality. Declared AFTER the template
 * it calls, and the template reads only the constants above it.
 */
export const EXCLUSION_LEAD_MAX_CHARS = buildLead(Number.MAX_SAFE_INTEGER, "high", "medium").length;

/** The row cap plus the newline the renderer puts between rows. */
const EXCLUSION_ROW_LINE_CHARS = EXCLUSION_ROW_MAX_CHARS + 1;

/**
 * The widest string this renderer can be asked for: the lead at its longest,
 * every row the renderer is allowed to emit at its own clip, and the omission
 * line that replaces the rows past the row cap.
 *
 * That shape — 10 rows, every slot full — is the one #1856 review round 2
 * measured at 4,753 chars against a `POST_FIT_APPENDS_MAX_CHARS` of 3,072 for
 * ALL the post-fit appends together, and the reason the section has a budget at
 * all. Clipping every slot shrinks the arithmetic; the policy below then keeps
 * the section a minority shareholder in the shared budget.
 */
export const EXCLUSION_WORST_CASE_CHARS =
  EXCLUSION_LEAD_MAX_CHARS +
  EXCLUSION_DISCLOSURE_MAX_ROWS * EXCLUSION_ROW_LINE_CHARS +
  EXCLUSION_OMISSION_MAX_CHARS +
  1;

/**
 * Ceiling on the whole section: {@link EXCLUSION_WORST_CASE_CHARS}, halved.
 *
 * Why half rather than the whole arithmetic: `POST_FIT_APPENDS_MAX_CHARS` is
 * what the residual gaps, the open points, the base fallback, the image links,
 * the provenance wrapper AND this section must share after `fitDraftToBudget`
 * returns. A section that merely respected its own worst case could still spend
 * the entire append budget by itself. Half of a bound that is itself arithmetic
 * over the row/lead/omission clips is a bound a reader can check in two steps.
 */
export const EXCLUSION_SECTION_MAX_CHARS = Math.min(
  Math.floor(EXCLUSION_WORST_CASE_CHARS / 2),
  Math.floor(POST_FIT_APPENDS_MAX_CHARS / 2),
);

/**
 * The disclosure the drafted/filed body carries: which duplicate candidates the
 * driver suppressed, and on what grounds. Rendered at ONE fixed site
 * (`filedBodyOf`) so the prior-context budget cannot clip it away the way it
 * clips an inventory row.
 *
 * Bounded twice over: at most `EXCLUSION_DISCLOSURE_MAX_ROWS` rows with a summary
 * line for the rest, AND every slot of every row clipped to the constants above,
 * so the whole section fits {@link EXCLUSION_SECTION_MAX_CHARS} — the ceiling the
 * post-fit append budget in plan-dropped-budget.ts accounts it against. A row
 * that would not fit the section is COUNTED, not rendered: the disclosure stays
 * honest about how many candidates were suppressed when it stops itemising them.
 */
export function duplicateExclusionSection(
  risk: DuplicateRisk | undefined,
  sourceIssue: number | undefined,
): string {
  if (sourceIssue === undefined || !risk) return "";
  const all = risk.excludedIssues ?? [];
  if (all.length === 0) return "";
  const lead = buildLead(sourceIssue, risk.downgradedFrom, risk.level);
  const rows: string[] = [];
  let used = lead.length;
  for (const e of all.slice(0, EXCLUSION_DISCLOSURE_MAX_ROWS)) {
    const row = exclusionRow(e);
    // +1 for the newline this row costs, and the omission line's whole width is
    // reserved from the first row onward so a section that has to stop itemising
    // can always afford to say how many it stopped on. The trailing newline the
    // section ends with is already inside the budget constant.
    if (used + row.length + 1 + EXCLUSION_OMISSION_MAX_CHARS > EXCLUSION_SECTION_MAX_CHARS) {
      break;
    }
    rows.push(row);
    used += row.length + 1;
  }
  const hidden = all.length - rows.length;
  if (hidden > 0) {
    rows.push(`- and ${hidden} more excluded candidate(s); see the plan session trace`);
  }
  return `${lead}${rows.join("\n")}\n`;
}

/** One disclosure row: `- #N (STATE): reason`. The title is stored, not rendered. */
function exclusionRow(e: ExcludedDuplicate): string {
  const state = e.state === "unknown" ? "" : ` (${e.state})`;
  return `- #${e.number}${state}: ${fitReason(e.reason)}`;
}

/**
 * Cut a reason to the row's width. Every reason the producer composes is fixed
 * prose that already satisfies this bound, so this clip is the guard against a
 * hostile or stale input (a cached verdict written by an older build) rather
 * than a cut the producer relies on; the budget test pins that the producer's
 * own longest reason fits it, so a real row is never silently shortened.
 */
function fitReason(reason: string): string {
  return reason.length <= EXCLUSION_REASON_MAX_CHARS
    ? reason
    : reason.slice(0, EXCLUSION_REASON_MAX_CHARS);
}

/** The lead paragraph — one template, so the budget constant and the render agree. */
function buildLead(
  sourceIssue: number,
  downgradedFrom: DuplicateRisk["level"] | undefined,
  level: DuplicateRisk["level"],
): string {
  const downgrade =
    downgradedFrom === undefined
      ? ""
      : ` The check reported ${downgradedFrom} and was downgraded to ${level}.`;
  return `${EXCLUSION_SECTION_HEADING}\n\nThis plan is for existing issue #${sourceIssue}, so that issue and its own split children are not duplicate candidates. The candidates below were excluded from the duplicate-risk verdict (${level}).${downgrade}\n`;
}
