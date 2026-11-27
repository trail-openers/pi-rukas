/**
 * lean/issue-prose — the issue's own words in front of Lean's three seats.
 *
 * The `specify` and `challenge` oracles and the `build` builder are each given the issue body as a fenced
 * section, between the problem and the criteria. A constraint written as prose in `Context & motivation` —
 * a non-obvious "never do X", an accessibility or perf requirement no AC bullet states — is otherwise
 * invisible to all three, so either oracle can call a spec complete while the prose contradicts it.
 *
 * Four rules make that safe:
 *
 *   1. the pi-spec block is stripped (`stripPiSpecBlocks`) — the criteria are already rendered, verbatim, one
 *      line below, so repeating the block would hand the model a second copy of the contract to disagree with;
 *   2. the body is bounded BEFORE it is fenced (`boundedIssueBody`) — the fence renders a truncation notice
 *      INSIDE the code span, where it is content, not a marker the model could read as closing the section;
 *   3. the fence itself is rendered by `fencedIssueBody`, the reviewer path's renderer — every backtick run of
 *      3+ in the body is replaced by a same-width look-alike (`fenceText`), so no run inside the issue can
 *      close the block the prompt opened;
 *   4. the builder's seat refuses a body that only restates its own `problem` line (`problemFor`), which the
 *      oracle seats do not ask about.
 */
import { fencedIssueBody } from "../adversarial-prompts.ts";
import { hasSurvivingSpecShapedFence, normalizeProse, stripPiSpecBlocks } from "./spec.ts";

/** The section heading. */
export const LEAN_ISSUE_HEADING = "## The issue";

/** The one line telling the oracle what to do with the prose. */
export const LEAN_ISSUE_LEAD =
  "The issue text below is the authority on everything the criteria do not state, so an acceptance test that contradicts it is wrong. A constraint stated in prose is a constraint.";

/**
 * The same sentence for the builder's seat, worded for what a builder is doing. The oracle lead tells an
 * adversary it is holding AUTHORITY; the builder may not touch the frozen tests, so telling it the prose is
 * "the authority" invites it to reconcile a test it cannot edit.
 */
export const LEAN_BUILD_ISSUE_LEAD =
  "The issue text below is what the acceptance criteria summarise. Where the criteria are silent it states what to build; it never overrides a frozen test.";

/**
 * The issue section of a lean prompt, or "" when it has nothing to say.
 *
 * Two answers of "nothing" belong to every seat: the body is blank once its `pi-spec` block is stripped, or a
 * spec-SHAPED FENCE survived that strip. The builder's seat adds a third of its own by passing `problemFor`:
 * a body whose prose is the spec's own `problem` line restated says nothing the brief does not already print.
 * `lead` is the seat's own instruction; it defaults to the oracle's.
 */
export function leanIssueSection(
  issueBody: string | undefined,
  lead: string = LEAN_ISSUE_LEAD,
  problemFor?: string,
): string {
  const stripped = stripPiSpecBlocks(issueBody ?? "");
  // A fence whose info merely STARTS with `pi-spec v1` is not the block, so it survives the strip and would
  // reprint the contract. Refuse the whole section rather than print a second copy. The predicate is a
  // SURVIVING FENCE LINE, not the substring.
  if (hasSurvivingSpecShapedFence(stripped)) return "";
  const prose = fencedIssueBody(stripped);
  if (prose === "") return "";
  if (problemFor !== undefined && normalizeProse(stripped) === normalizeProse(problemFor))
    return "";
  return `${LEAN_ISSUE_HEADING}\n\n${lead}\n\n${prose}\n`;
}
