#!/usr/bin/env bun
/**
 * #1529 — the repository-declared gate-file gate (`work-driver-merged-gate-files.ts`).
 *
 * The built-in protected set (`.github/`, `.pi/`, `CODEOWNERS`, `agents.json`) is
 * one project's list. A repository that names its build manifest or a safety
 * script a gate file has another, and its own doctrine — read at the cycle's base
 * commit — is the only source for it. These cases pin what that gate means:
 *
 *   - a declared path the PR touches parks the merge and the park NAMES the path;
 *   - a directory declaration covers what is under it;
 *   - a judge entry whose quote is not in the document is not honoured, and with
 *     nothing verified the cycle parks rather than merges;
 *   - a judge that could not answer parks while the doctrine speaks of gate files
 *     (an absent answer is not a declaration of none);
 *   - doctrine that never mentions gate files asks no question and merges;
 *   - `--merge` is not an answer to this gate.
 *
 * Every park assertion reads the hold's reason, not merely the cap: six different
 * gates park at `awaiting-human-merge`, so "it parked" establishes nothing about
 * WHICH gate parked it.
 *
 * The declared paths are deliberately OUTSIDE the built-in protected set — a
 * `.github/` diff would be caught by the protected gate first and the case would
 * then assert the wrong gate.
 */

import type { PolicyJudgeFn } from "../src/work-driver-policy.ts";
import { setupSpawnGuard } from "./test-helpers.ts";
import {
  declaredDoc,
  gateFileJudge,
  gateFileRun,
  MERGE_GRANT,
  MENTION_WITHOUT_DECLARATION,
  nulNameStatus,
} from "./lib/work-driver-merged-gate-files-fixture.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

/** The doctrine sentence each case declares, in the document's own words. */
const PYPROJECT_DECLARATION =
  "pyproject.toml is one of this repository's gate files and must be merged by a person, never by an agent.";
const SCRIPTS_DECLARATION =
  "Everything under scripts/ counts as a gate file: a person merges those changes.";

/** The park this gate writes: awaiting-human-merge, hold naming why, PR left open. */
function assertParkedBy(
  r: { cap: string | undefined; holdReason: string | undefined; log: { mergeCmds: string[] } },
  needle: string,
  label: string,
) {
  assert(
    r.cap === "awaiting-human-merge",
    `${label}: the cycle parked at awaiting-human-merge (got ${JSON.stringify(r.cap)})`,
  );
  assert(
    typeof r.holdReason === "string" && r.holdReason.includes(needle),
    `${label}: the park names the declared gate file (got ${JSON.stringify((r.holdReason ?? "").slice(0, 200))})`,
  );
  assert(r.log.mergeCmds.length === 0, `${label}: nothing was merged`);
}

/** A judge that reports an entry whose quote the doctrine does not contain. */
function fabricatedQuoteJudge(declaredPath: string, calls: string[]): PolicyJudgeFn {
  return async (prompt) => {
    calls.push(prompt);
    if (!/Which paths do these documents declare/i.test(prompt)) {
      return {
        toolUses: [
          { name: "report_policy", arguments: { verdict: "permitted", quote: MERGE_GRANT } },
        ],
      };
    }
    // A sentence nobody wrote, and one that does not even name the path.
    return {
      toolUses: [
        {
          name: "report_policy",
          arguments: {
            verdict: "permitted",
            quote: MERGE_GRANT,
            entries: [
              {
                path: declaredPath,
                quote: "pyproject.toml may be merged by anyone, no review required whatsoever.",
              },
            ],
          },
        },
      ],
    };
  };
}

// ── 1. AGENTS.md declares `pyproject.toml` and the PR touches it → parks, naming it.
{
  const r = await gateFileRun({
    issue: 7101,
    agents: declaredDoc(PYPROJECT_DECLARATION),
    judge: gateFileJudge({ declares: "pyproject.toml", calls: [] }) as PolicyJudgeFn,
    diff: nulNameStatus("pyproject.toml"),
  });
  assertParkedBy(r, "pyproject.toml", "declared file in the PR");
  assert(
    (r.holdReason ?? "").includes("declared as gate files"),
    `the park attributes the refusal to the repository's own declaration, not the built-in set (got ${JSON.stringify((r.holdReason ?? "").slice(0, 220))})`,
  );
  assert(
    r.log.diffReads.length > 0,
    "the gate read the PR's own commits before deciding — the change set was inspected, not assumed",
  );
}

// ── 2. AGENTS.md declares the `scripts/` directory and the PR touches scripts/x.py.
{
  const r = await gateFileRun({
    issue: 7102,
    agents: declaredDoc(SCRIPTS_DECLARATION),
    judge: gateFileJudge({ declares: "scripts/", calls: [] }) as PolicyJudgeFn,
    diff: nulNameStatus("scripts/x.py"),
  });
  assertParkedBy(r, "scripts/x.py", "declared directory prefix");
}

// ── 3. A judge entry whose quote is not in the document is not honoured, and with
// nothing verified the cycle parks as unverified rather than merging.
{
  const calls: string[] = [];
  const r = await gateFileRun({
    issue: 7103,
    agents: declaredDoc(PYPROJECT_DECLARATION),
    judge: fabricatedQuoteJudge("pyproject.toml", calls),
    diff: nulNameStatus("pyproject.toml"),
  });
  assert(
    calls.some((p) => /Which paths do these documents declare/i.test(p)),
    "the declared-list question was asked, so the refusal is this gate's",
  );
  assert(
    r.cap === "awaiting-human-merge",
    `an unverifiable declaration parks rather than merging (got cap ${JSON.stringify(r.cap)})`,
  );
  assert(
    (r.holdReason ?? "").includes("no declared path could be verified"),
    `the park says WHY — nothing could be verified against the doctrine (got ${JSON.stringify((r.holdReason ?? "").slice(0, 220))})`,
  );
  assert(r.log.mergeCmds.length === 0, "and the fabricated quote bought no merge");
}

// ── 4. The judge is unavailable while the doctrine mentions gate files → parks.
{
  const r = await gateFileRun({
    issue: 7104,
    agents: declaredDoc(PYPROJECT_DECLARATION),
    judge: gateFileJudge({ declares: "pyproject.toml", throws: true, calls: [] }) as PolicyJudgeFn,
    diff: nulNameStatus("pyproject.toml"),
  });
  assert(
    r.cap === "awaiting-human-merge",
    `an unavailable judge parks the merge while the doctrine speaks of gate files (got ${JSON.stringify(r.cap)})`,
  );
  assert(
    (r.holdReason ?? "").includes("mention gate files"),
    `the park names the doctrine that mentions gate files as the reason nothing was cleared (got ${JSON.stringify((r.holdReason ?? "").slice(0, 220))})`,
  );
  assert(r.log.mergeCmds.length === 0, "and no merge was attempted on an absent answer");
}

// ── 5. Doctrine that never mentions gate files: no question is asked, the merge goes ahead.
{
  const judgeCalls: string[] = [];
  const r = await gateFileRun({
    issue: 7105,
    agents: declaredDoc("Nothing here names a path a person has to merge."),
    judge: gateFileJudge({ declares: "pyproject.toml", calls: judgeCalls }) as PolicyJudgeFn,
    authorityJudge: true,
    diff: nulNameStatus("pyproject.toml"),
  });
  assert(
    judgeCalls.length === 1 &&
      !judgeCalls.some((p) => /Which paths do these documents declare/i.test(p)),
    `the declared-list question was never asked of a doctrine that does not mention gate files (${judgeCalls.length} judge call(s))`,
  );
  assert(
    r.log.mergeCmds.length > 0,
    `the merge command was issued (got ${r.log.mergeCmds.length})`,
  );
  assert(r.cap === undefined, `the cycle did not park (got cap ${JSON.stringify(r.cap)})`);
}

// ── 6. `--merge` is not an answer to this gate: case 1's setup still parks.
{
  const r = await gateFileRun({
    issue: 7106,
    agents: declaredDoc(PYPROJECT_DECLARATION),
    judge: gateFileJudge({ declares: "pyproject.toml", calls: [] }) as PolicyJudgeFn,
    mergeGrant: true,
    diff: nulNameStatus("pyproject.toml"),
  });
  assertParkedBy(r, "pyproject.toml", "with the operator's --merge grant");
}

// ── 7. A mention with nothing declared behind it parks, and the question WAS asked.
{
  const judgeCalls: string[] = [];
  const r = await gateFileRun({
    issue: 7107,
    agents: MENTION_WITHOUT_DECLARATION,
    judge: gateFileJudge({ calls: judgeCalls }) as PolicyJudgeFn,
    diff: nulNameStatus("pyproject.toml"),
  });
  assert(
    judgeCalls.some((p) => /Which paths do these documents declare/i.test(p)),
    `the doctrine's mention of gate files asked the declared-list question (${judgeCalls.length} call(s))`,
  );
  assertParkedBy(r, "no declared path could be verified", "a mention with no declaration");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
