/**
 * lean/issue-prose — the issue's own words in front of Lean's oracles.
 *
 * The specify and challenge oracles are given the issue body as a fenced
 * section, between the problem and the criteria. They had the rendered criteria
 * and nothing else: a constraint written as prose in `Context & motivation` —
 * "check the token before the draw", a non-obvious "never do X", an
 * accessibility or perf requirement no AC bullet states — was invisible to both
 * the oracle that writes the acceptance tests and the adversary that tries to
 * break them, so either could call a spec complete while the prose contradicted
 * it.
 *
 * Three rules make that safe:
 *
 *   1. the pi-spec block is stripped (`stripPiSpecBlocks`) — the criteria are
 *      already rendered, verbatim, one line below, so repeating the block would
 *      print the same text twice and hand the model a second copy of the contract
 *      to disagree with;
 *   2. the body is bounded BEFORE it is fenced (`boundedIssueBody`) — the fence
 *      renders a truncation notice INSIDE the code span, where it is content, not
 *      a marker the model could read as closing the section;
 *   3. the fence itself is rendered by `fencedIssueBody`, the reviewer path's
 *      renderer — backslash escapes so a fence run inside the issue cannot close
 *      the block early and speak as the prompt.
 *
 * `PI_ENSEMBLE_LEAN_ISSUE_PROSE=0` removes the section entirely and restores the
 * pre-feature prompt byte for byte, so a run that behaves differently with the
 * prose in front of the oracle can be compared against one without it.
 */
import { fencedIssueBody } from "../adversarial-prompts.ts";
import { stripPiSpecBlocks } from "./spec.ts";

/** The section heading. */
export const LEAN_ISSUE_HEADING = "## The issue";

/** The one line telling the oracle what to do with the prose. */
export const LEAN_ISSUE_LEAD =
  "The issue text below is the authority on everything the criteria do not state, so an acceptance test that contradicts it is wrong. A constraint stated in prose is a constraint.";

/** Whether the oracle prompts carry the issue section (#2171). */
export function leanIssueProseEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE;
  return v !== "0";
}

/**
 * The issue section of an oracle prompt, or "" when the switch is off. The body
 * arrives as the step already read it: the prompt layer never fetches, so a
 * `gh` failure cannot change what the oracle sees.
 */
export function leanIssueSection(issueBody: string | undefined): string {
  if (!leanIssueProseEnabled()) return "";
  const prose = fencedIssueBody(stripPiSpecBlocks(issueBody ?? ""));
  if (prose === "") return "";
  return `${LEAN_ISSUE_HEADING}\n\n${LEAN_ISSUE_LEAD}\n\n${prose}\n`;
}
