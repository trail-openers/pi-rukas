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
 * the limit. The reason a row carries is itself composed (a fixed rule sentence
 * plus the child's quoted clause) and only the clause had been clipped, so the
 * width of one row was a property of whatever the model wrote. Every interpolable
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

/**
 * The longest quoted prior-art clause one row can carry. Deliberately NARROWER
 * than the 300-char `truncateForDisclosure` the residual/open-point disclosures
 * use: the clause is the child's own sentence quoted back as evidence, and the
 * row that carries it also carries a fixed rule sentence, so the room the clause
 * takes is room the section does not have.
 */
export const EXCLUSION_CLAUSE_MAX_CHARS = 120;

/** The clip on one row's title — the widest title the disclosure can carry. */
export const EXCLUSION_TITLE_MAX_CHARS = 120;

/**
 * The clip on one row's reason. The widest reason is the prior-art one: the fixed
 * rule sentence plus the quoted clause in its quotes plus the evidence tail, which
 * `plan-duplicate-self.ts` composes as
 * `EXCLUSION_REASONS["prior-art"] + ' — "' + clause + '" (' + PRIOR_ART_EVIDENCE + ')'`.
 * Those two constants and this composition are pinned EQUAL to the strings below
 * by `test-plan-duplicate-exclusion-budget.ts` — a circular import is not a price
 * worth paying for a bound, but an unpinched literal here would drift the moment
 * the wording is reworded, and the bound would then be arithmetic over prose
 * nobody writes any more.
 *
 * The other two reasons are shorter, so this is the bound that matters.
 */
export const EXCLUSION_REASON_MAX_CHARS =
  "a CLOSED issue the risk check itself called prior art or a reversal target".length +
  ` — "${"the risk check called it that in this clause"}" () `.length +
  EXCLUSION_CLAUSE_MAX_CHARS;

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
 * Cut a reason to the row's width, leaving the quoted clause whole and closed.
 *
 * The widest reason is the prior-art one, and a plain `slice` cut it in the
 * middle of the quotation — `…target — "ccc`, a quote the section opens and never
 * closes, which is not something a reader of a filed body can trust. So the
 * clause is clipped FIRST, at the width the disclosure documents
 * ({@link EXCLUSION_CLAUSE_MAX_CHARS}), exactly as the producer clips it before
 * composing the reason at all; the row is then cut at the reason bound, which
 * every reason the producer composes already satisfies. A row is therefore never
 * cut inside a quotation, and a caller that somehow supplies an oversized reason
 * still cannot exceed {@link EXCLUSION_ROW_MAX_CHARS}.
 */
function fitReason(reason: string): string {
  const open = reason.indexOf('"');
  const close = reason.lastIndexOf('"');
  const bounded =
    open >= 0 && close > open
      ? `${reason.slice(0, open + 1)}${reason
          .slice(open + 1, close)
          .slice(0, EXCLUSION_CLAUSE_MAX_CHARS)}${reason.slice(close)}`
      : reason;
  return bounded.length <= EXCLUSION_REASON_MAX_CHARS
    ? bounded
    : bounded.slice(0, EXCLUSION_REASON_MAX_CHARS);
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
