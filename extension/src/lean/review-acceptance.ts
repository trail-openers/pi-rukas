/**
 * lean/review-acceptance — the spec's criteria, their frozen tests, and what the
 * gate said about them at the head, as ONE table the review seats read.
 *
 * The review step judges a diff. Until now it judged it against the issue's prose
 * and the criteria rows, and nothing in front of a reviewer said which frozen
 * test answers which criterion or whether that test passed at the commit under
 * review. A reviewer that suspects a criterion went uncovered has to go looking
 * for the test, and a reviewer that does not look reports nothing.
 *
 * **The table is READ, not executed.** `review` is entered only from a green
 * `publish`, which refuses to run when the head is not the newest green `verify`'s
 * `verifiedHead`, and a fix wave routes the run back through `verify`. So the
 * frozen files have already been run at this exact commit by the step that owns
 * executing them, and re-running them here would pay a second execution for the
 * same answer (`verify` pays per test file, and review is already about half a
 * lean run's step time). Every cell below is therefore read off the durable step
 * log — the spec, `testsFromLog`, and the newest green `verify`'s `verifiedHead`,
 * `commandCriteria` and `commandNotRunnable`. **Executed evidence, not model
 * output:** no cell is a reviewer's opinion, and none is composed here.
 *
 * Three shapes follow from that provenance, and each is a row a seat must be able
 * to read without guessing:
 *
 *   - a `test` criterion whose id the log records a frozen test for says
 *     `pass at <verifiedHead12>` — the head the gate actually ran it at, printed,
 *     so the seat can refuse a claim about a commit it can check;
 *   - a `command` criterion reads the gate's OWN record: `pass (command) at …` for
 *     one it executed and that exited 0, `could-not-run (command): <reason>` for
 *     one it declined. The gate's overall verdict is never borrowed for a cell —
 *     a criterion is about its own file, not about the tier;
 *   - a `manual` criterion says `manual — needs a human`, which is the whole
 *     truth and not a gap in this renderer.
 *
 * A `test` criterion with NO frozen test says `could-not-run — the log records no
 * frozen test for it`. That row is unreachable on a real run (`specify` answers
 * `uncovered` and hands back before a criterion can ride this far), so it is
 * stated rather than assumed: a renderer that guessed "pass" for an absent map
 * entry would be the loudest lie this file could tell.
 *
 * Both payloads are disarmed at the print site by `fenceText` — a criterion's text
 * is issue-author prose and a `commandNotRunnable` reason is prose out of a path
 * check, and this table goes into six lens briefs and one adversarial brief, where
 * one injected `### heading` would open a section of the prompt the step never
 * wrote. The table is bounded to the spec's own criteria count — a row per
 * criterion, never more — and fenced at one cap.
 *
 * The entry guard at the bottom of this file is the other half of the feature and
 * sits here because it exists to make one line of this table true: `pass at <head>`
 * is only a fact about the commit the gates read if that commit is the one the gate
 * certified.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { testsFromLog } from "./build.ts";
import type { ReviewDeps } from "./review-args.ts";
import { ReviewInfraError } from "./review-errors.ts";
import { parsePiSpec } from "./spec.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { Step } from "./state.ts";
import { newestDecided } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { fenceText, oneLine } from "./text-fence.ts";

/** The heading the section opens with, in a seat's brief and in the PR comment
 * alike — one constant, so a seat that read the section and a human who reads the
 * comment cite the same words. */
export const LEAN_REVIEW_ACCEPTANCE_HEADING =
  "## The acceptance table (executed by the gate at the head)";

/** What the seat is told the table is. Its wording is the claim this module can
 * actually honour: every cell came from the step that ran it, at the head named in
 * the same section. */
export const LEAN_REVIEW_ACCEPTANCE_LEAD =
  "Each row is one acceptance criterion of this issue, the frozen test the run recorded for it, and the result the verify step REPORTED for it at the head named below — read off that step's own record, not from a model. `pass at <head>` means that gate executed it there; `could-not-run` and `manual` are the gate's own answers, not this step's guesses. A finding whose fix would contradict a row is not a finding.";

/** The cap on the rendered table — the bound the criteria and carried-findings
 * blocks at these same print sites already carry, so no payload is cut shorter by
 * another's length. */
const MAX_TABLE_CHARS = 20_000;

/** What the table fence says when it clipped. Its own words, for the reason
 * `review-criteria.ts` states: a seat weighing a cut table has to be able to tell
 * which payload it lost, and a generic clip notice cannot say. */
const TABLE_TRUNCATION_MARKER = "…(acceptance table truncated)";

/** How much of a verified head one cell prints — what every other lean reason
 * line prints, and enough for a seat to cite the commit it is weighing. */
const HEAD_CLIP = 12;

/** The longest not-runnable reason one cell may print: the bound the durable
 * record's own validator puts on `commandNotRunnable`, so a cell can never carry
 * more than the record could hold. */
const REASON_MAX_CHARS = 300;

/** The longest criterion id, criterion text and test path one row may print. The
 * text bound is the one the PR body's own criteria table puts on the same field. */
const ID_MAX_CHARS = 40;
const TEXT_MAX_CHARS = 200;
const PATH_MAX_CHARS = 200;

/** The longest branch name the guard prints — the bound the fixer's brief puts on
 * the same value, so one refusal cannot widen a line past what its siblings print. */
const BRANCH_MAX_CHARS = 200;

/** One row, as the renderer, the comment and the tests all read it. */
export interface AcceptanceRow {
  id: string;
  /** The criterion's own text, verbatim from the spec (bounded only at print). */
  text: string;
  /** How the criterion is checked, straight from the spec. */
  verify: "test" | "command" | "manual";
  /** The frozen test paths the log records for this criterion, or none. */
  tests: string[];
  /** The cell: what the gate said about this criterion at the head. */
  result: string;
}

/** The newest DECIDED `verify` whose verdict was green, or `undefined`. A red or
 * errored verify says nothing about a head, and an undecided tail is the engine's
 * replay marker, which says less. */
function newestGreenVerify(steps: Step[]): Step | undefined {
  const v = newestDecided(steps, "verify");
  return v?.outcome?.kind === "green" ? v : undefined;
}

/** The head the gate certified, in the shape every reader here wants: a full sha
 * or nothing. Shape is not existence — `commit-sha.ts` owns that boundary. */
function certifiedHead(steps: Step[]): string | undefined {
  const head = newestGreenVerify(steps)?.outcome?.verifiedHead;
  return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
}

/**
 * The result cell for one criterion, given the green gate's own record.
 *
 * The gate's overall verdict is deliberately NOT a parameter: it is a claim about
 * the frozen tier and the project's tiers, and printing it per row would let a
 * criterion that was never executed inherit a pass it never earned.
 */
function resultCell(
  id: string,
  verify: AcceptanceRow["verify"],
  tests: string[],
  head: string | undefined,
  commandCriteria: Record<string, string> | undefined,
  commandNotRunnable: Record<string, string> | undefined,
): string {
  const at = head === undefined ? "" : ` at ${head.slice(0, HEAD_CLIP)}`;
  if (verify === "manual") return "manual — needs a human";
  if (verify === "command") {
    if (commandCriteria?.[id] !== undefined) return `pass (command)${at}`;
    const why = (commandNotRunnable?.[id] ?? "").trim();
    return why === ""
      ? "could-not-run (command): no reason recorded by the gate"
      : `could-not-run (command): ${oneLine(why, REASON_MAX_CHARS)}`;
  }
  if (tests.length === 0)
    return "could-not-run — the step log records no frozen test for this criterion";
  return `pass${at}`;
}

/**
 * The table's rows, in spec order, read from the run's own step log.
 *
 * `spec` is the parsed `pi-spec` block — the same parse `publish`'s body performs
 * on the same bytes — so a criterion that is not in the contract cannot gain a row
 * here, and the row count IS the spec's criteria count by construction.
 */
export function acceptanceRows(
  steps: Step[],
  spec: { criteria: { id: string; text: string; verify: AcceptanceRow["verify"] }[] },
): AcceptanceRow[] {
  const head = certifiedHead(steps);
  const green = newestGreenVerify(steps);
  const tests = testsFromLog(steps);
  return spec.criteria.map((c) => {
    const paths = tests[c.id] ?? [];
    return {
      id: c.id,
      text: c.text,
      verify: c.verify,
      tests: paths,
      result: resultCell(
        c.id,
        c.verify,
        paths,
        head,
        green?.outcome?.commandCriteria,
        green?.outcome?.commandNotRunnable,
      ),
    };
  });
}

/** One row as a markdown table line. Every field goes through `oneLine`, the
 * renderer for text that must stay on one line: a criterion's text is issue
 * authorship and a not-runnable reason is prose out of the gate's tree checks. */
function rowLine(row: AcceptanceRow): string {
  const tests =
    row.tests.length === 0
      ? "—"
      : row.tests.map((p) => `\`${oneLine(p, PATH_MAX_CHARS)}\``).join("<br>");
  return `| ${oneLine(row.id, ID_MAX_CHARS)} | ${oneLine(row.text, TEXT_MAX_CHARS)} | ${row.verify} | ${tests} | ${row.result} |`;
}

/** The table's header — the same five columns the PR body's criteria table uses,
 * so a reader moving between the two is not relearning a layout. */
const HEADER = "| Criterion | Requirement | Verify | Frozen tests | Result at head |";
const DIVIDER = "| --- | --- | --- | --- | --- |";

/** Every row, as one fenced markdown table. The caller decides which heading it
 * sits under, so the brief and the comment print the same bytes under their own
 * framing. */
export function renderAcceptanceTable(rows: AcceptanceRow[]): string {
  return fenceText(
    [HEADER, DIVIDER, ...rows.map(rowLine)].join("\n"),
    MAX_TABLE_CHARS,
    TABLE_TRUNCATION_MARKER,
  );
}

/** The line that anchors every `pass at …` cell. Absent green is stated as the
 * absence it is, rather than leaving the cells unanchored. */
function headLine(head: string | undefined): string {
  return head === undefined
    ? "Verified head: none — no decided green `verify` step of this run named one."
    : `Verified head: \`${head.slice(0, HEAD_CLIP)}\``;
}

/**
 * The section as a review seat reads it, or `""` when it has nothing to say:
 * no body, no parsable block, no criteria.
 *
 * The block's absence is the same refusal `review-criteria.ts` applies to its own
 * section — a body whose spec cannot be parsed has no criteria to make a table
 * from, and a table invented from prose would be a contract nothing enforces.
 */
export function renderAcceptanceSection(steps: Step[], issueBody: string | undefined): string {
  if (issueBody === undefined || issueBody.trim() === "") return "";
  const parsed = parsePiSpec(issueBody);
  if (!parsed.ok) return "";
  const rows = acceptanceRows(steps, parsed.spec);
  if (rows.length === 0) return "";
  return `${LEAN_REVIEW_ACCEPTANCE_HEADING}\n\n${LEAN_REVIEW_ACCEPTANCE_LEAD}\n\n${headLine(
    certifiedHead(steps),
  )}\n\n${renderAcceptanceTable(rows)}`;
}

/**
 * The comment the step posts on its own PR, once per attempt.
 *
 * `publish` ran before this step and writes the PR body there alone, so the body
 * cannot carry what this step learned. This is an ADDITIVE disclosure keyed on the
 * review step's own record: the body's `## Acceptance criteria` table and its
 * `result` column are a different claim — cells derived from the run-level verify
 * verdict — and are not replaced here.
 *
 * The reviewed head is stated beside the certified one rather than assumed from
 * it: a reader comparing the table against the branch has to be able to see which
 * commit each claim names.
 */
export function acceptanceComment(
  steps: Step[],
  issueBody: string | undefined,
  reviewedHead: string,
): string {
  const section = renderAcceptanceSection(steps, issueBody);
  if (section === "") return "";
  const same = certifiedHead(steps) === reviewedHead;
  const anchor = `Reviewed head: \`${oneLine(reviewedHead, 80)}\` — the commit the gates read, ${
    same ? "which is the certified head." : "not the head a green verify named."
  }`;
  return `${section}\n\n${anchor}`;
}

/**
 * The entry guard: the head the step is about to buy a review for must be the head
 * the gate certified.
 *
 * `publish` refuses to open a PR unless its own head equals the newest green
 * `verify`'s `verifiedHead`, but between that step and this one the branch is
 * pushable by anything holding the credentials, and `reviewedHead()` reads origin
 * fresh — so a push in that window has both gates reading bytes no gate ever
 * certified, and every `pass at …` cell above would be a claim about a commit
 * nobody ran. This closes the window at the cheapest point: one git read, before
 * the first child is paid.
 *
 * It refuses a run whose green named no head too. "No head was certified" is not a
 * state in which a table of results at the head may be printed, and a step that
 * printed one would be doing exactly what the feature exists to make impossible.
 *
 * Both shas are named in the refusal because the operator has to be able to tell
 * which move to look at. The caller skips this entirely when the switch is off, so
 * the off arm pays no read and keeps the pre-feature path byte for byte.
 */
export async function assertHeadIsVerified(
  deps: ReviewDeps,
  steps: Step[],
  repoRoot: string,
  branch: string,
  head: string,
  rows: DispatchUsageRow[],
): Promise<void> {
  const certified = certifiedHead(steps);
  const printedBranch = oneLine(branch, BRANCH_MAX_CHARS);
  // Read origin at the moment of the check, not the value the caller still holds:
  // the guard's whole subject is whether origin still holds the certified commit.
  const read = await gitQuiet(deps.exec, repoRoot, ["rev-parse", `origin/${branch}`]);
  const onOrigin = read?.stdout.trim();
  if (onOrigin === undefined || !isFullCommitSha(onOrigin))
    throw new ReviewInfraError(
      `could not ask git what origin/${printedBranch} is, so the review cannot certify that it reads a verified head`,
      rows,
    );
  if (certified === undefined)
    throw new ReviewInfraError(
      `no decided green verify of this run named a verified head, and origin/${printedBranch} holds ${onOrigin.slice(0, HEAD_CLIP)} — the review cannot print results at a head no gate certified`,
      rows,
    );
  // The head the step holds is checked too, against the same read: every cell of
  // the table speaks about the head the gates receive, so a caller that resolved
  // its own head earlier in the step has to still be holding this one.
  if (certified === onOrigin && head === onOrigin) return;
  throw new ReviewInfraError(
    `the branch moved since the gate certified it: the newest green verify covers ${certified.slice(0, HEAD_CLIP)} but origin/${printedBranch} holds ${onOrigin.slice(0, HEAD_CLIP)} and the step resolved ${oneLine(head, HEAD_CLIP * 4)} — those bytes have never been verified, and reviewing them is not verifying them`,
    rows,
  );
}
