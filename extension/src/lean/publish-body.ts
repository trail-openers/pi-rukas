/**
 * lean/publish-body — the PR description the publish step opens with.
 *
 * The body is the run's OWN claim about itself, written from the step log
 * rather than from a model's recollection: one row per acceptance criterion,
 * with the frozen test that answers for it and the verdict the run's own gate
 * recorded for it. A reviewer reading it can tell which criteria were executed
 * and which were never run, which is the question a prose PR description lets
 * a writer blur.
 *
 * Everything untrusted goes through `text-fence`: criterion text is whatever the
 * issue author typed, and the verify reason is the tail of a build log. Both
 * arrive as markdown in the same document as the structure above them, so
 * without the fence a `\n### ` inside either is a section of the PR body.
 *
 * Every line is emitted unconditionally except where the brief says otherwise:
 * a reader should be able to tell "not run" apart from "not applicable", and a
 * run that has no evidence should print that rather than print nothing.
 */

import type { PiSpec } from "./spec.ts";
import { fenceText, oneLine } from "./text-fence.ts";

/** The marker that says which renderer produced this body, for a later reader. */
const BODY_MARKER = "<!-- work-lean v1 -->";

/** What a path must look like to be printed at all; anything else is dropped. */
/**
 * A path the body may print. The brief's filter, character for character: it is
 * a PRINT filter (no whitespace, no shell or markdown metacharacters, no
 * newline that could end the table row), not the pipeline's traversal rule —
 * `specify-tree`'s `pathProblem` is what refuses a test file at capture time,
 * and by the time a path is in the step log it passed that gate. Tightening it
 * again here would drop the paths the record says cover a criterion.
 */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/** A base sha is printed only when it really is a full commit id. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** How much of the gate's reason the PR body quotes — see its use site. */
const VERIFY_REASON_CLIP = 2000;

export interface PublishBodyInput {
  issue: number;
  spec: PiSpec;
  /** criterion id -> the test files that cover it, merged from the step log. */
  tests: Record<string, string[]>;
  /** The verdict the run's own gate last recorded, or none if it never ran. */
  verifyKind: "green" | "red" | undefined;
  /** The 40-hex commit the green verdict was decided about. */
  verifiedHead?: string;
  /** The gate's own reason, verbatim, fenced. */
  verifyReason?: string;
  /**
   * The criterion ids the gate EXECUTED as `command` criteria and that exited 0,
   * read off the verify record. A `command` row whose id is not here was not run
   * and says `not runnable (command is not a repo test path)` — it never borrows
   * the gate's overall verdict, which is about the frozen tests and the tiers.
   */
  commandCriteria?: string[];
  /**
   * Why the gate did not execute each `command` criterion, keyed by criterion id —
   * e.g. the path it names is absent at base. When a row's id is absent the cell
   * says only `not executed (command)`; when present it says why, which is the
   * difference between an issue to fix and a step to re-run.
   */
  commandNotRunnable?: Record<string, string>;
  draft: boolean;
  version: string;
  models: Record<string, string>;
  baseSha: string;
}

/** The result cell for a `test` criterion, given the gate's verdict. */
function rowCells(kind: "green" | "red" | undefined): string {
  if (kind === "green") return "green";
  if (kind === "red") return "red";
  return "not run";
}

/**
 * The result cell for one criterion.
 *
 * A `command` criterion NEVER prints the gate's verdict: `verify` runs the frozen
 * tests and the project's configured tiers, and a criterion's own `command` is a
 * third thing, executed separately and recorded separately. So the cell reads the
 * gate's `commandCriteria` record — `passed (command)` for one the gate ran and
 * that exited 0, `not executed (command): <reason>` for one it declined (the
 * gate's own per-criterion reason: the file is absent at base, is a symlink, or
 * changed since base), and `not executed (command)` for one it declined without
 * recording a reason. A declined criterion is treated like `manual`, so publish
 * opens a draft. Printing the overall verdict here would be the body claiming an
 * execution that never happened.
 */
function resultCell(
  c: PiSpec["criteria"][number],
  kind: "green" | "red" | undefined,
  passedCommands: ReadonlySet<string>,
  notRunnable?: Record<string, string>,
): string {
  if (c.verify === "manual") return "manual — needs a human";
  if (c.verify === "command") {
    // The wording names the residual rather than implying isolation: the FILE was
    // pinned to the base commit, but the code it loads is HEAD's, because a
    // preservation criterion that ran the base's own source would say nothing
    // about this run. A reader must not take `passed (command)` for a sandboxed
    // replay of the base.
    if (passedCommands.has(c.id)) return "passed (command; test file unchanged since base)";
    const why = (notRunnable?.[c.id] ?? "").trim();
    // Two truths the reader must not confuse: the gate refused the command (the
    // spec's or the tree's own defect, and publish keeps a draft), versus a
    // criterion nobody declined but that never reached the runner either. Both
    // are "not executed"; only the reason differs, and the reason is what tells
    // the operator whether to fix the issue or re-run the step.
    return why === ""
      ? "not executed (command)"
      : `not executed (command): ${oneLine(why, COMMAND_NOT_RUNNABLE_MAX_CHARS)}`;
  }
  return rowCells(kind);
}

/** The why-not-run is prose out of a path check; it must not widen the row freely. */
const COMMAND_NOT_RUNNABLE_MAX_CHARS = 90;

/** The test paths a criterion claims, filtered to printable ones. */
function testsCell(paths: string[] | undefined): string {
  const kept = (paths ?? []).filter((p) => SAFE_PATH.test(p));
  if (kept.length === 0) return "—";
  return kept.map((p) => `\`${p}\``).join("<br>");
}

/** The models the run dispatched with, as `role = model` pairs. */
function modelsLine(models: Record<string, string>): string {
  const pairs = Object.entries(models).map(
    ([role, model]) => `${oneLine(role, 60)} = ${oneLine(model, 80)}`,
  );
  return pairs.length === 0 ? "—" : pairs.join(", ");
}

/**
 * The full PR body.
 *
 * `verifyKind` is the newest DECIDED `verify` verdict and `verifiedHead` the
 * commit it was about; when the run never reached a verdict both are absent and
 * every row reads "not run" — the body never claims more than the log holds.
 */
export function publishBody(o: PublishBodyInput): string {
  const lines: string[] = [
    BODY_MARKER,
    `Closes #${o.issue}`,
    "",
    "## Acceptance criteria",
    "| id | criterion | verify | tests | result |",
    "| --- | --- | --- | --- | --- |",
  ];
  const passedCommands = new Set(o.commandCriteria ?? []);
  for (const c of o.spec.criteria) {
    lines.push(
      `| ${oneLine(c.id, 40)} | ${oneLine(c.text, 200)} | ${c.verify} | ${testsCell(o.tests[c.id])} | ${resultCell(c, o.verifyKind, passedCommands, o.commandNotRunnable)} |`,
    );
  }
  lines.push("", "## Verification");
  lines.push(
    `- head: ${o.verifiedHead === undefined ? "not verified (draft)" : `\`${o.verifiedHead}\``}`,
  );
  if (o.verifyReason !== undefined && o.verifyReason !== "") {
    // Deliberately SHORTER than the record's own bound (`RED_REASON_CLIP` in
    // `verify.ts`, 4096): the record keeps the tail `build`'s re-entry prompt
    // needs, while the PR is read by a person, and a 4 KB log tail in a comment is
    // a wall nobody scrolls. The two bounds are different claims — what a machine
    // may re-read versus what a reviewer can read — so they are not kept equal.
    lines.push("- last verify:", fenceText(o.verifyReason, VERIFY_REASON_CLIP));
  }
  lines.push("", "## Run");
  lines.push(`- pi-rukas ${oneLine(o.version, 40)}`);
  if (FULL_SHA.test(o.baseSha)) lines.push(`- base \`${o.baseSha}\``);
  lines.push(`- models: ${modelsLine(o.models)}`);
  if (o.draft)
    lines.push(
      "- draft: verification is not green, a criterion needs a human, or a command criterion was not runnable",
    );
  return `${lines.join("\n")}\n`;
}
