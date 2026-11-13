/**
 * lean/issue-prose — the issue's own words in front of Lean's three seats.
 *
 * The `specify` and `challenge` oracles and the `build` builder are each given
 * the issue body as a fenced section, between the problem and the criteria. They
 * had the rendered criteria and nothing else: a constraint written as prose in
 * `Context & motivation` — "check the token before the draw", a non-obvious
 * "never do X", an accessibility or perf requirement no AC bullet states — was
 * invisible to all three, so either oracle could call a spec complete while the
 * prose contradicted it and the builder could implement to the problem line alone
 * while the frozen tests enforced the prose.
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
 *      renderer — every backtick run of 3+ in the body is replaced by a same-width
 *      look-alike (`fenceText`), so no run inside the issue can close the block the
 *      prompt opened and speak as the prompt's own prose. Tildes are deliberately not
 *      in that class — see the jsdoc of `BACKTICK_RUN` in `lean/text-fence.ts`, which is
 *      where the fence's own character (and so what can close it) is decided.
 *
 * `PI_ENSEMBLE_LEAN_ISSUE_PROSE=0` removes the section from all three seats and
 * restores the two oracle prompts' pre-feature bytes byte for byte (the builder
 * has no pre-feature section to restore — the switch is what #2228 added there).
 * `PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE=0` reaches the builder's seat only.
 */
import { fencedIssueBody } from "../adversarial-prompts.ts";
import { SPEC_INFO, stripPiSpecBlocks } from "./spec.ts";

/** The section heading. */
export const LEAN_ISSUE_HEADING = "## The issue";

/** The one line telling the oracle what to do with the prose. */
export const LEAN_ISSUE_LEAD =
  "The issue text below is the authority on everything the criteria do not state, so an acceptance test that contradicts it is wrong. A constraint stated in prose is a constraint.";

/**
 * The same sentence for the builder's seat, worded for what a builder is doing.
 *
 * The oracle lead tells an adversary it is holding AUTHORITY — the right frame
 * when the job is to write or attack the contract. The builder's job is the
 * opposite: the frozen tests already exist and it may not touch them, so telling
 * it the prose is "the authority" invites it to reconcile a test it cannot edit.
 * This sentence says what the prose is FOR at that seat and where its reach
 * stops.
 */
export const LEAN_BUILD_ISSUE_LEAD =
  "The issue text below is what the acceptance criteria summarise. Where the criteria are silent it states what to build; it never overrides a frozen test.";

/** Whether the oracle prompts carry the issue section (#2171). */
export function leanIssueProseEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE;
  return v !== "0";
}

/**
 * Whether the BUILDER's prompt carries the issue section (#2228). Read at call
 * time, like its sibling: every lean smoke file runs in one `bun` process and
 * pins its own arms with `withEnv`, so a load-time read would let one file's pin
 * disable the next file's.
 */
export function leanBuildIssueProseEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE;
  return v !== "0";
}

/**
 * Collapse a body to the shape a comparison against the spec's own `problem`
 * line can survive: whitespace runs are one space, leading and trailing
 * whitespace goes. The `/plan` problem line is a clipped restatement of the
 * body, so the two differ only in layout for a great many issues.
 */
function normalizeProse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The issue section of a lean prompt, or "" when it has nothing to say.
 *
 * Three answers of "nothing": either switch is `0`, the body is blank once its
 * `pi-spec` block is stripped, or — the builder's case, and the one a body-free
 * render cannot show — the prose is the spec's own `problem` line restated, in
 * which case the section would hand the seat its own heading back and label it
 * the task. `problemFor` is passed only by the builder; the oracles omit it and
 * are byte-unchanged, since for them the problem line and the prose are read for
 * different jobs.
 *
 * `lead` is the seat's own instruction; it defaults to the oracle's, so the two
 * adversary seats render through here without naming anything new.
 */
export function leanIssueSection(
  issueBody: string | undefined,
  lead: string = LEAN_ISSUE_LEAD,
  problemFor?: string,
): string {
  if (!leanIssueProseEnabled() || !leanBuildIssueProseEnabled()) return "";
  const stripped = stripPiSpecBlocks(issueBody ?? "");
  // The section's own rule 1 — the spec block never appears here, because the
  // criteria print it verbatim one heading below — holds only when the strip fired.
  // `stripPiSpecBlocks` recognises exactly `pi-spec v1` and no other info string,
  // a rule `test-lean-spec.ts` pins (a fence whose info merely STARTS with it is
  // not the block, because `parsePiSpec` must not read it as one either), so such a
  // look-alike survives the strip and would reprint the contract. Refuse the whole
  // section rather than print a second copy: a body whose spec is unreadable is a
  // body whose criteria were never rendered, and its text is a contract no test
  // enforces. The strip is NOT loosened — its exact-info rule belongs to
  // `lean/spec.ts` and every reader of the same body.
  if (stripped.includes(SPEC_INFO)) return "";
  const prose = fencedIssueBody(stripped);
  if (prose === "") return "";
  if (problemFor !== undefined && normalizeProse(stripped) === normalizeProse(problemFor))
    return "";
  return `${LEAN_ISSUE_HEADING}\n\n${lead}\n\n${prose}\n`;
}
