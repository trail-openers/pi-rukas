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
  draft: boolean;
  version: string;
  models: Record<string, string>;
  baseSha: string;
}

/** The result cell for a test / command criterion, given the gate's verdict. */
function rowCells(kind: "green" | "red" | undefined): string {
  if (kind === "green") return "green";
  if (kind === "red") return "red";
  return "not run";
}

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
  for (const c of o.spec.criteria) {
    const result = c.verify === "manual" ? "manual — needs a human" : rowCells(o.verifyKind);
    lines.push(
      `| ${c.id} | ${oneLine(c.text, 200)} | ${c.verify} | ${testsCell(o.tests[c.id])} | ${result} |`,
    );
  }
  lines.push("", "## Verification");
  lines.push(
    `- head: ${o.verifiedHead === undefined ? "not verified (draft)" : `\`${o.verifiedHead}\``}`,
  );
  if (o.verifyReason !== undefined && o.verifyReason !== "") {
    lines.push("- last verify:", fenceText(o.verifyReason, 2000));
  }
  lines.push("", "## Run");
  lines.push(`- pi-rukas ${oneLine(o.version, 40)}`);
  if (FULL_SHA.test(o.baseSha)) lines.push(`- base \`${o.baseSha}\``);
  lines.push(`- models: ${modelsLine(o.models)}`);
  if (o.draft) lines.push("- draft: verification is not green or a criterion needs a human");
  return `${lines.join("\n")}\n`;
}
