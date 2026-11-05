/**
 * lens-unproven-high — the executed check on a HIGH's claimed reproduction
 * (#2040), the second of the two severity caps beside `SEVERITY_RUBRIC`.
 *
 * The rubric asks a HIGH to state a reachable failure, but a stated failure is
 * still a claim, and AGENTS.md §7 is that a gate checks executed evidence, never
 * a child's claim. Field evidence: one six-lens round on a ~780-line diff
 * returned 138 findings with 2 HIGH, and both were refuted elsewhere — one
 * demanded behaviour the issue put out of scope, the other claimed a
 * verdict-forgery path that did not survive ~16,000 crafted inputs through the
 * real parsers. Each fix round produced new unproven HIGHs (1, then 2, then 2),
 * so the review never converged and a correct PR needed an operator.
 *
 * The rule: a HIGH keeps its severity only when it names `reproduction`
 * (`lens-review-types.ts`) whose `command` equals — whitespace collapsed on both
 * sides — the `command` argument of a `bash` call the SAME lens child is
 * recorded as having made, and whose `observed` says something. Anything else
 * comes down to MEDIUM with `severityCapped: "unproven"`. The finding is kept and
 * rendered; only its blocking power changes.
 *
 * `observed` is a gate, never content: nothing here parses it and no renderer
 * prints it, so untrusted child text reaches neither a prompt nor a post.
 *
 * Not capped, each deliberate:
 *   - CRITICAL — the harness does not downgrade what the lens called critical,
 *     the same call `capTestPathFinding` makes, and the reason `hasCritical`, the
 *     delta veto and CRITICAL carry stay untouched;
 *   - `CLAIM_SCAN` rows — deterministic lookups with no lens judgement behind
 *     them, so there is no inflated label to correct;
 *   - a row any cap already moved — the test-path cap runs FIRST and wins (see
 *     `capFindings` in lens-severity-rubric.ts), so a reproduction can never
 *     rescue a HIGH that cited a test file, and a capped row is not re-capped.
 */

import { sortFindings } from "./lens-review-format.ts";
import type { Finding } from "./lens-review-types.ts";

/** The tool whose recorded calls can carry a reproduction. A child that ran its
 * command through anything else recorded nothing the harness can read, and the
 * harness does not second-guess what a lens chose to run. */
const REPRODUCTION_TOOL = "bash";
/** The argument naming the command on a recorded call. */
const COMMAND_KEY = "command";

/**
 * One row, checked against the recorded calls of the child that reported it
 * (see the module header). Returns the SAME object when nothing moves, so
 * `severityCapped` always means "this row's severity was lowered here".
 */
export function capUnprovenHighFinding(finding: Finding, toolUses: readonly unknown[]): Finding {
  if (finding.lens === "CLAIM_SCAN") return finding;
  if (finding.severity !== "HIGH") return finding;
  if (finding.severityCapped !== undefined) return finding;
  if (runsTheClaimedCommand(finding, toolUses)) return finding;
  return { ...finding, severity: "MEDIUM", severityCapped: "unproven" };
}

/**
 * The merge-path pass (see `capUnprovenHighFinding`), and the reason it takes
 * the child's recorded calls as a parameter rather than reading them itself: the
 * row that survives a dedup collision is the row whose evidence decides, and the
 * calls belong to the lens child that made them — never to another lens's child
 * that happened to run a similar command.
 *
 * Re-sorts afterwards for the reason `capTestPathFindings` states: rows move
 * between severity levels, and every report reads this array's order.
 *
 * The `toolUses` a caller hands this is the whole evidence surface: an empty
 * list means nothing was proven, so every HIGH caps — the same outcome as a
 * round whose lens children ran no commands at all.
 */
export function capUnprovenHighFindings(
  findings: readonly Finding[],
  toolUses: readonly unknown[],
): Finding[] {
  return findings.map((f) => capUnprovenHighFinding(f, toolUses)).sort(sortFindings);
}

/**
 * Did this row's own child run the command the row names?
 *
 * The comparison is equality after collapsing whitespace on BOTH sides — the
 * child's call and its claim are two separate renderings of one command, and the
 * child is told to spell it as it ran it. Substrings and prefixes are refused: a
 * claim of `bun test` does not evidence a call of `bun test x
 * --reporter=junit`, and a claim carrying `; rm -rf /` beside a real command is
 * not that command.
 */
function runsTheClaimedCommand(finding: Finding, toolUses: readonly unknown[]): boolean {
  const claimed = collapse(finding.reproduction?.command ?? "");
  const observed = collapse(finding.reproduction?.observed ?? "");
  // An empty `observed` is not evidence of anything: the child said it ran
  // something and reported no result. Same for an empty command — nothing was
  // named to check.
  if (claimed === "" || observed === "") return false;
  return toolUses.some((tu) => {
    if (!tu || typeof tu !== "object") return false;
    const t = tu as { name?: unknown; arguments?: unknown };
    if (t.name !== REPRODUCTION_TOOL) return false;
    const args = t.arguments as { [COMMAND_KEY]?: unknown } | undefined;
    if (!args || typeof args !== "object") return false;
    return collapse(args[COMMAND_KEY]) === claimed;
  });
}

/** Whitespace collapsed for comparison; a non-string is no command at all. */
function collapse(v: unknown): string {
  return typeof v === "string" ? v.replaceAll(/\s+/g, " ").trim() : "";
}
