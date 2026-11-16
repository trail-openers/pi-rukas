/**
 * lean/review-acceptance — the spec's criteria, their frozen tests and what the
 * gate said about them at the head, as ONE table the review seats read.
 *
 * The table is READ, never executed. `review` is entered only from a green
 * `publish`, which refuses to run unless the head equals the newest green
 * `verify`'s `verifiedHead`, and a fix wave routes the run back through `verify`;
 * the frozen files have already been run at this commit by the step that owns
 * executing them. Every cell is therefore read off the durable step log — the
 * spec, `testsFromLog`, and the newest green `verify`'s `verifiedHead`,
 * `commandCriteria` and `commandNotRunnable`. Executed evidence, not model output.
 *
 * A `command` cell reads the gate's OWN per-criterion record and never the gate's
 * overall verdict, which is a claim about the tier rather than about that file. A
 * `test` criterion the log records no frozen test for says `could-not-run`:
 * `specify` answers `uncovered` and hands back before a criterion rides this far,
 * and a renderer that guessed "pass" for an absent map entry would be the loudest
 * lie this file could tell.
 *
 * Both payloads are disarmed at the print site by `fenceText` — a criterion's text
 * is issue authorship and a `commandNotRunnable` reason is prose out of a path
 * check, and this section goes into six lens briefs, one adversarial brief and a
 * public PR comment. The table is bounded to the spec's own criteria count.
 *
 * `leanReviewAcceptanceEnabled` gates all of it; this module never consults it, so
 * the step's call sites stay the only place the switch is read.
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
 * alike, so both cite the same words for the same table. */
export const LEAN_REVIEW_ACCEPTANCE_HEADING =
  "## The acceptance table (executed by the gate at the head)";

/** What the seat is told the table is: every cell came from the step that ran it,
 * at the head named in the same section. */
export const LEAN_REVIEW_ACCEPTANCE_LEAD =
  "Each row is one acceptance criterion of this issue, the frozen test the run recorded for it, and the result the verify step REPORTED for it at the head named below — read off that step's own record, not from a model. `pass at <head>` means that gate executed it there; `could-not-run` and `manual` are the gate's own answers, not this step's guesses. A finding whose fix would contradict a row is not a finding.";

/** The table's own cap and its own clip notice — the bound the criteria and
 * carried-findings blocks at these print sites carry, in words that say WHICH
 * payload was cut (see `review-criteria.ts`). */
const MAX_TABLE_CHARS = 20_000;
const TABLE_TRUNCATION_MARKER = "…(acceptance table truncated)";

/** Head clips to the 12 every other lean reason line prints; the reason bound is
 * the one the durable record puts on `commandNotRunnable`, so a cell never carries
 * more than the record could hold. */
const HEAD_CLIP = 12;
const REASON_MAX_CHARS = 300;

/** The PR comment's own cap on the head it names: a 40-hex oid, with room for the
 * tree-ish a caller may hold. */
const HEAD_MAX_CHARS = 64;

/** Print bounds per field. The text bound is the one the PR body's criteria table
 * puts on the same field; the branch bound is the fixer's brief's. */
const ID_MAX_CHARS = 40;
const TEXT_MAX_CHARS = 200;
const PATH_MAX_CHARS = 200;
const BRANCH_MAX_CHARS = 200;

/** What every executed row reads when no green verify named a head. "pass" with no
 * head attached is the one word this table exists to license, and the step's entry
 * guard refuses a log like this before pass 1; the renderer still refuses to print
 * it, so no caller ever hands a seat an unanchored `pass`. Exported so the tests pin
 * this wording rather than a copy of it. */
export const NO_GREEN_VERIFY_CELL =
  "could-not-run — no decided green verify of this run covers a head";

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

/** Did any decided `verify` of this run come back green at all? The renderer's
 * anchor line asks this to tell "a later gate came back red" apart from "no gate
 * ever ran", and the two are different facts for the operator reading the comment.
 * `newestGreenVerify` cannot answer it — it reads the NEWEST decided verify alone. */
function anyGreenVerify(steps: Step[]): boolean {
  return steps.some((s) => s.state === "verify" && s.outcome?.kind === "green");
}

/** The newest DECIDED `verify` whose verdict was green, or `undefined`: a red or
 * errored verify says nothing about a head, and an undecided tail is the engine's
 * replay marker, which says less. */
function newestGreenVerify(steps: Step[]): Step | undefined {
  const v = newestDecided(steps, "verify");
  return v?.outcome?.kind === "green" ? v : undefined;
}

/** The head the gate certified, as a full sha or nothing. */
function certifiedHead(steps: Step[]): string | undefined {
  const head = newestGreenVerify(steps)?.outcome?.verifiedHead;
  return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
}

/** The result cell for one criterion, read off the green gate's own record — never
 * off its overall verdict. */
function resultCell(
  id: string,
  verify: AcceptanceRow["verify"],
  tests: string[],
  head: string | undefined,
  commandCriteria: Record<string, string> | undefined,
  commandNotRunnable: Record<string, string> | undefined,
): string {
  // The head is the row's whole warrant: A1's `test` cell is `pass at <head12>` or
  // it is not a claim about executed bytes, so with none to name every executed row is
  // the refusal, never a bare `pass` (see `NO_GREEN_VERIFY_CELL`). A `manual` row is
  // the gate's standing "needs a human" whatever the log holds, so it precedes it.
  if (verify === "manual") return "manual — needs a human";
  if (head === undefined) return NO_GREEN_VERIFY_CELL;
  const at = ` at ${head.slice(0, HEAD_CLIP)}`;
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

/** The table's rows, in spec order, read from the run's own step log. `spec` is
 * the parsed `pi-spec` block, so the row count IS the spec's criteria count by
 * construction and a criterion outside the contract cannot gain a row. */
export function acceptanceRows(
  steps: Step[],
  spec: { criteria: { id: string; text: string; verify: AcceptanceRow["verify"] }[] },
): AcceptanceRow[] {
  const head = certifiedHead(steps);
  const green = newestGreenVerify(steps);
  const tests = testsFromLog(steps);
  return spec.criteria.map((c) => {
    const paths = tests?.[c.id] ?? [];
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

/** One row as a markdown line. Every field goes through `oneLine`, the renderer
 * for text that must stay on one line. */
function rowLine(row: AcceptanceRow): string {
  const tests =
    row.tests.length === 0
      ? "—"
      : row.tests.map((p) => `\`${oneLine(p, PATH_MAX_CHARS)}\``).join("<br>");
  return `| ${oneLine(row.id, ID_MAX_CHARS)} | ${oneLine(row.text, TEXT_MAX_CHARS)} | ${row.verify} | ${tests} | ${row.result} |`;
}

/** The five columns the PR body's criteria table uses, so a reader moving between
 * the two is not relearning a layout. */
const HEADER = "| Criterion | Requirement | Verify | Frozen tests | Result at head |";
const DIVIDER = "| --- | --- | --- | --- | --- |";

/** The section a review seat reads, or `""` when it has nothing to say: no body, no
 * parsable block, no criteria. A body whose spec cannot be parsed has no criteria,
 * and a table invented from prose would be a contract nothing enforces. */
export function renderAcceptanceSection(steps: Step[], issueBody: string | undefined): string {
  if (issueBody === undefined || issueBody.trim() === "") return "";
  const parsed = parsePiSpec(issueBody);
  if (!parsed.ok) return "";
  const rows = acceptanceRows(steps, parsed.spec);
  if (rows.length === 0) return "";
  const head = certifiedHead(steps);
  // Which absence the reader is told about is a separate question from whether there
  // is one: a run whose newest decided verify came back RED (the shape a CI-fix round
  // leaves) and a run that never verified anything both name no head, and a comment
  // that called the first the second would send the operator looking at the wrong gate.
  const red = head === undefined && anyGreenVerify(steps);
  const anchor =
    head === undefined
      ? red
        ? "Verified head: none — the newest decided `verify` of this run came back RED, so no green gate covers these rows."
        : "Verified head: none — no decided green `verify` step of this run named one."
      : `Verified head: \`${head.slice(0, HEAD_CLIP)}\``;
  return `${LEAN_REVIEW_ACCEPTANCE_HEADING}\n\n${LEAN_REVIEW_ACCEPTANCE_LEAD}\n\n${anchor}\n\n${fenceText(
    [HEADER, DIVIDER, ...rows.map(rowLine)].join("\n"),
    MAX_TABLE_CHARS,
    TABLE_TRUNCATION_MARKER,
  )}`;
}

/** The comment the step posts on its own PR, once per attempt. `publish` wrote the
 * PR body before this step ran and nothing re-enters it, so the body cannot carry
 * what this step learned: this is an ADDITIVE disclosure, and the body's own
 * `## Acceptance criteria` table and its `result` column are a different claim.
 * The reviewed head is stated beside the certified one so a reader can see which
 * commit each claim names. */
export function acceptanceComment(
  steps: Step[],
  issueBody: string | undefined,
  reviewedHead: string,
): string {
  const section = renderAcceptanceSection(steps, issueBody);
  if (section === "") return "";
  const same = certifiedHead(steps) === reviewedHead;
  return `${section}\n\nReviewed head: \`${oneLine(reviewedHead, HEAD_MAX_CHARS)}\` — the commit the gates read, ${
    same ? "which is the certified head." : "not the head a green verify named."
  }`;
}

/**
 * The entry guard: the head the step is about to buy a review for must be the head
 * the gate certified. `publish` already refused any other head, but the branch is
 * pushable by anything holding the credentials between that step and this one, and
 * `reviewedHead()` reads origin fresh — so a push in that window would have every
 * `pass at …` cell speak about bytes no gate ever ran. One git read, asked before
 * the first child is paid.
 *
 * A green that named no head is refused too: "nothing was certified" is not a state
 * in which a table of results at the head may be printed. Both shas are named so the
 * operator can tell which move to look at.
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
  // Read origin at the moment of the check: the guard's whole subject is whether
  // origin still holds the certified commit, not what the caller saw earlier.
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
  if (certified === onOrigin && head === onOrigin) return;
  throw new ReviewInfraError(
    `the branch moved since the gate certified it: the newest green verify covers ${certified.slice(0, HEAD_CLIP)} but origin/${printedBranch} holds ${onOrigin.slice(0, HEAD_CLIP)} and the step resolved ${oneLine(head, HEAD_MAX_CHARS)} — those bytes have never been verified, and reviewing them is not verifying them`,
    rows,
  );
}
