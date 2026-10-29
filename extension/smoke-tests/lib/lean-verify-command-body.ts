/**
 * lib/lean-verify-command-body — the fixture the `command` criteria tier's
 * PR-body cases drive.
 *
 * The renderer is pure, so these cases need no repo and no git: what they pin is
 * that a blank cell in the acceptance table says WHY it is blank, and says it about
 * the right criterion. `commandBody` builds the one spec shape every case shares
 * (a `test` criterion, a runnable `command`, a symlinked one and a shell-shaped
 * one) so a change to a row's wording is a change in one place.
 */

import type { PiSpec } from "../../src/lean/spec.ts";
import { publishBody } from "../../src/lean/publish-body.ts";

const CMD_FILE = "tests/AC2-preserve.test.sh";

/** The four-criterion spec every body case renders. */
export function commandSpec(): PiSpec {
  return {
    problem: "p",
    size: "S",
    criteria: [
      { id: "AC1", text: "retried", verify: "test" },
      { id: "AC2", text: "preserved", verify: "command", command: CMD_FILE },
      { id: "AC3", text: "symlinked", verify: "command", command: "tests/link.test.sh" },
      { id: "AC4", text: "unrunnable", verify: "command", command: "rm -rf /" },
    ],
  } as PiSpec;
}

export interface CommandBodyOpts {
  /** The criterion ids the gate recorded as executed and green. */
  commandCriteria?: string[];
  /** Per-criterion why-not-run, exactly as the gate wrote it. */
  commandNotRunnable?: Record<string, string>;
  draft?: boolean;
}

/** One rendered PR body for the shared spec. */
export function commandBody(o: CommandBodyOpts): string {
  return publishBody({
    issue: 1908,
    spec: commandSpec(),
    tests: { AC1: ["tests/AC1.test.sh"] },
    verifyKind: "green",
    verifiedHead: "a".repeat(40),
    version: "1.2.3",
    models: {},
    baseSha: "b".repeat(40),
    draft: o.draft ?? false,
    ...(o.commandCriteria === undefined ? {} : { commandCriteria: o.commandCriteria }),
    ...(o.commandNotRunnable === undefined ? {} : { commandNotRunnable: o.commandNotRunnable }),
  });
}

/** The result cell of one criterion's row, extracted so a case can be exact. */
export function resultCellOf(body: string, id: string): string {
  const row = body.split("\n").find((line) => line.startsWith(`| ${id} |`));
  const cells = (row ?? "").split("|");
  return (cells[cells.length - 2] ?? "").trim();
}
