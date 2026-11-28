/**
 * oracle-repair-brief — the repair seat's prompt, and the closed list of what it may contain.
 *
 * The seat is the specify adversary: it writes tests, not implementation, and this round asks it to correct
 * one frozen acceptance test the driver PROVED cannot do its job. Two things make the round worth having, and
 * both are properties of the text built here rather than of the child's good sense:
 *
 *   - **It is blind.** The brief carries the spec, the claim's file names, the driver's one-line reason for
 *     each named file, and the output the driver watched the project's runner print. It carries no build diff,
 *     no build session text and none of the builder's report beyond the names it filed. A repair seat that
 *     could read the builder's code would write the test that code already passes, which is the oracle the run
 *     was trying to repair.
 *   - **Its scope is one sentence long and mechanical.** It may submit replacements for the named frozen files
 *     and nothing else; the driver refuses every other submission before it judges a byte.
 *
 * The heading this module renders is the string the harness routes on, and the blindness cases assert on.
 * Change it and those cases go red rather than passing on a brief nobody reads.
 */
import { TEST_RUNNER_PLACEHOLDER } from "./lean/config.ts";
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP } from "./lean/state-outcome-maps.ts";
import { BLOCKED_EVIDENCE_OUTPUT_CAP } from "./oracle-repair-record.ts";
import { criteriaBlock, scopeBlock } from "./lean/spec-blocks.ts";
import type { PiSpec } from "./lean/spec.ts";
import { fenceText, oneLine } from "./lean/text-fence.ts";
import type { EvidenceRow, HeadEvidenceRow } from "./oracle-repair-evidence.ts";

/** The heading a repair brief carries and no other lean brief contains. */
export const REPAIR_HEADING = "## Repair the named frozen tests";

/** What the brief is built from: the contract, the named files, the driver's evidence. Nothing else. */
export interface RepairBriefOpts {
  issue: number;
  spec: PiSpec;
  /** The worktree the seat works in — the specify tree, reset to the run's base sha. */
  worktree: string;
  /** The project's `verify.test` runner template, when the project configured one. */
  testRunner?: string;
  /** The named frozen files with the driver's one-line reason for each. */
  claims: EvidenceRow[];
  /** The output the DRIVER watched the runner print at the build head, per named file. */
  evidence: HeadEvidenceRow[];
}

/** A run of 3+ backticks: the sequence that opens or closes a markdown fence. */
const BACKTICK_RUN = /`{3,}/g;
/** A heading marker a one-line value may still carry, with or without leading spaces. */
const HEADING_MARKER = /^ +#?(?=\S)/gm;

/**
 * An inline prompt value that came from outside the run: one line, no fence, no heading.
 *
 * `oneLine` already drops every control character but keeps backticks — right for a path the seat must read,
 * wrong for a value the brief sits between two backticks, where one surviving run closes the span and the rest
 * of the line renders as structure. The fold is the one `fenceText` applies to a fenced payload (same character
 * class, same U+02CB replacement, so the count survives and the reader sees what was there), plus escaping a
 * heading marker the value carries. A state file an operator edited is untrusted input, and these fields are a
 * path from it into a child's prompt.
 */
function inlinePrompt(s: string, max: number): string {
  return oneLine(s, max)
    .replace(BACKTICK_RUN, (run) => "\u02cb".repeat(run.length))
    .replace(HEADING_MARKER, "\\#");
}

/** One claim as the seat sees it: a path, and the conflict the builder stated about it. */
function claimLine(c: EvidenceRow): string {
  return `- \`${inlinePrompt(c.path, BLOCKED_PATH_CAP)}\` — ${inlinePrompt(c.reason, BLOCKED_REASON_CAP)}`;
}

/** One executed red: the file, the command the driver ran, and what came back. */
function evidenceLine(e: HeadEvidenceRow): string {
  // The output is the one field long enough to want a block, and `fenceText` is the module that owns folding a
  // payload into a fence: it neutralises every 3+ backtick run inside, so nothing the runner printed closes
  // the fence this line opens.
  return (
    `- \`${inlinePrompt(e.path, BLOCKED_PATH_CAP)}\` run as \`${inlinePrompt(e.cmd, BLOCKED_PATH_CAP)}\` came back red:\n\n` +
    fenceText(inlinePrompt(e.output, BLOCKED_EVIDENCE_OUTPUT_CAP), BLOCKED_EVIDENCE_OUTPUT_CAP)
  );
}

/** Build the repair seat's kickoff prompt. */
export function repairPrompt(o: RepairBriefOpts): string {
  const named = o.claims.map((c) => `- \`${inlinePrompt(c.path, BLOCKED_PATH_CAP)}\``).join("\n");
  const runner =
    o.testRunner === undefined
      ? "No project test runner is configured, so run each file with whatever command runs this repository's tests."
      : `The project runs one test file with \`${o.testRunner}\` — the literal \`${TEST_RUNNER_PLACEHOLDER}\` is replaced by the file's path.`;
  return [
    REPAIR_HEADING,
    "",
    `You are the adversary for issue #${o.issue}. The driver PROVED, by running them itself, that the frozen acceptance tests below cannot do their job. Your one task is to correct THOSE FILES and nothing else.`,
    "",
    "## The spec",
    "",
    criteriaBlock(o.spec),
    scopeBlock(o.spec),
    "",
    "## The files the driver named",
    "",
    named,
    "",
    "The driver's reason for each:",
    "",
    o.claims.map(claimLine).join("\n"),
    "",
    "## What the driver executed",
    "",
    "These are the driver's own runs of the named files with the project's runner, on the builder's tree. They are the evidence, not your opinion of it.",
    "",
    o.evidence.length === 0
      ? "- (the driver recorded no runner output)"
      : o.evidence.map(evidenceLine).join("\n"),
    "",
    "## Your working tree",
    "",
    `You are in \`${o.worktree}\`, the tree the driver reset to the commit the driver judged the red at — the run's frozen tests as their records hash them, with none of the builder's implementation. Your replacements must be red HERE, because a test this tree already passes tests nothing. Do not look for the implementation: it is deliberately not in this tree.`,
    "",
    runner,
    "",
    "## What you may submit",
    "",
    `Call \`submit_tests\` for the named files ONLY, one call per criterion, with that criterion's id and the path(s) you rewrote. A submission that touches any other file is refused whole, and the run hands back. Do not add a new test file to cover a gap you noticed: this round corrects the named oracle, it does not extend the contract.`,
    "",
    "Do not commit. Leave the bytes in the working tree; the parent hashes, freezes and commits them if they pass the driver's checks.",
    "",
  ].join("\n");
}
