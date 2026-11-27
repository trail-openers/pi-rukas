import { TEST_RUNNER_PLACEHOLDER } from "./lean/config.ts";
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
import { criteriaBlock, scopeBlock } from "./lean/spec-blocks.ts";
import type { PiSpec } from "./lean/spec.ts";
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

/** One claim as the seat sees it: a path, and the conflict the builder stated about it. */
function claimLine(c: EvidenceRow): string {
  return `- \`${c.path}\` — ${c.reason}`;
}

/** One executed red: the file, the command the driver ran, and what came back. */
function evidenceLine(e: HeadEvidenceRow): string {
  const fence = "```";
  return `- \`${e.path}\` run as \`${e.cmd}\` came back red:\n\n  ${fence}\n  ${e.output}\n  ${fence}`;
}

/** Build the repair seat's kickoff prompt. */
export function repairPrompt(o: RepairBriefOpts): string {
  const named = o.claims.map((c) => `- \`${c.path}\``).join("\n");
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
    `You are in \`${o.worktree}\`, a checkout of the run's BASE commit — the code as it stood before anyone implemented the feature. Your replacements must be red HERE, because a test the base already passes tests nothing. Do not look for the implementation: it is deliberately not in this tree.`,
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
