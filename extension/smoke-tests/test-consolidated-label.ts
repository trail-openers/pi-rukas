#!/usr/bin/env bun
import { reportConsolidatedVerifyOutcome } from "../src/work-driver-consolidated-verify-report.ts";
import type { ConsolidatedVerifyResult } from "../src/work-driver-consolidated-verify.ts";
/**
 * #1064 — the tree a consolidated verify failure names.
 *
 * The consolidated probe runs for a single workstream too, but then it
 * cherry-picks that workstream's own commits onto its own base: there is no
 * combination, so "on the CONSOLIDATED tree" described something that never
 * happened, in every single-workstream `verify-failed:develop` cycle sampled on
 * this host. The rule now reads the workstream count: one workstream names the
 * tree it actually verified, in the same words the per-worktree run already uses
 * for a tree; more than one keeps the CONSOLIDATED wording.
 *
 * Three things this pins that a source read cannot show:
 *   - the wording changes at N=1 and ONLY at N=1;
 *   - an unresolvable tree keeps the old wording rather than inventing one (a
 *     workstream id is not a path, `failed in default` is not a location);
 *   - all three label sites of ONE failure agree — the message, the timeout
 *     clause and the host-exhaustion clause are produced by the caller from a
 *     single decision, so a partial rename is the regression this catches.
 */
import {
  type ConsolidationFailureVerdict,
  consolidatedFailureMessage,
  consolidatedRunWhere,
} from "../src/work-driver-consolidation-classify.ts";
import { verifyTimeoutFailure } from "../src/work-driver-verify-develop-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/repo";
const WT = "/repo/.worktrees/issue-7-default";
const CMD = "bash scripts/verify.sh";

const verdict = (
  classification: ConsolidationFailureVerdict["classification"],
  ids: string[],
  reason = "the verify command failed",
) =>
  ({
    classification,
    assertion: "src/a.ts(3,1): error TS2304",
    workstreamIds: ids,
    trivial: false,
    reason,
  }) as ConsolidationFailureVerdict;

// ---------------------------------------------------------------- the rule
{
  // N>1: a genuine combination — the CONSOLIDATED wording, and repoRoot as the
  // tree (where the probe checked the combination out). Exactly as before #1064.
  const many = consolidatedRunWhere(2, WT, REPO);
  assert(
    many.phrase === "on the CONSOLIDATED tree" && many.treeName === REPO,
    "N>1 keeps the CONSOLIDATED wording and names repoRoot",
  );

  // N=1 with a resolvable tree: the workstream's own worktree, in the
  // per-worktree wording (`in <tree>`) — same tree, same wording.
  const one = consolidatedRunWhere(1, WT, REPO);
  assert(
    one.phrase === `in ${WT}` && one.treeName === WT,
    "N=1 names the one workstream's own tree, in the per-worktree wording",
  );

  // N=1 with NO tree to name: the old wording, NOT the repo root and NOT the
  // workstream id. The probe ran under repoRoot, so naming it would put the
  // CONSOLIDATED tree's label on the operator's own checkout; naming the id
  // would call an identifier a location.
  const unknown = consolidatedRunWhere(1, undefined, REPO);
  assert(
    unknown.phrase === "on the CONSOLIDATED tree",
    "N=1 with no resolvable tree keeps the CONSOLIDATED wording",
  );
  assert(
    !consolidatedRunWhere(1, undefined, REPO).phrase.includes("default"),
    "the tree clause never falls back to a workstream id",
  );
  assert(
    consolidatedRunWhere(1, WT, REPO).phrase !== consolidatedRunWhere(2, WT, REPO).phrase,
    "the wording differs between N=1 and N>1 for the same tree",
  );
}

// ------------------------------------------------------- the message, per N
{
  const oneMsg = consolidatedFailureMessage(
    verdict("per-workstream-defect", ["default"]),
    CMD,
    WT,
    REPO,
  );
  assert(
    oneMsg.includes(`failed in ${WT}`),
    `N=1 message names the workstream's own tree (got: ${oneMsg.slice(0, 140)})`,
  );
  assert(!oneMsg.includes("CONSOLIDATED"), "N=1 message never says CONSOLIDATED");

  const manyMsg = consolidatedFailureMessage(
    verdict("consolidation-created", ["a", "b"]),
    CMD,
    undefined,
    REPO,
  );
  assert(
    manyMsg.includes("failed on the CONSOLIDATED tree"),
    `N>1 message keeps the CONSOLIDATED wording (got: ${manyMsg.slice(0, 140)})`,
  );
  assert(manyMsg.includes("a + b"), "N>1 message still names BOTH workstreams");

  // The unattributable N=1 shape (no tree resolved) — old wording, and the
  // classification prefix is untouched by a label change.
  const unknownMsg = consolidatedFailureMessage(
    verdict("needs-human-decision", ["default"]),
    CMD,
    undefined,
    REPO,
  );
  assert(
    unknownMsg.startsWith("[needs-human-decision]") &&
      unknownMsg.includes("failed on the CONSOLIDATED tree"),
    "N=1 with no tree keeps the pre-#1064 message shape and its label",
  );
}

// ------------------------------------------- one failure, three label sites
// The regression this file exists for: the message, the timeout clause and the
// host-exhaustion clause are three separate strings for ONE failure. A rename
// that reaches some but not all of them makes the handoff contradict itself.
{
  const runWhere = consolidatedRunWhere(1, WT, REPO);
  const clause = runWhere.phrase;
  const message = consolidatedFailureMessage(
    verdict("per-workstream-defect", ["default"]),
    CMD,
    WT,
    REPO,
  );
  const timeout = verifyTimeoutFailure(CMD, clause, 600_000);
  const host = `verify command \`${CMD}\` ${clause} could not run`;

  for (const [name, site] of [
    ["message", message],
    ["timeout", timeout],
    ["host-exhaustion", host],
  ] as const) {
    assert(
      site.includes(WT) && !site.includes("CONSOLIDATED"),
      `N=1: the ${name} clause names the one workstream's tree`,
    );
  }

  // And at N>1 the same three sites stay on the CONSOLIDATED tree.
  const manyWhere = consolidatedRunWhere(2, undefined, REPO);
  const manyClause = manyWhere.phrase;
  const sites = [
    consolidatedFailureMessage(verdict("consolidation-created", ["a", "b"]), CMD, undefined, REPO),
    verifyTimeoutFailure(CMD, manyClause, 600_000),
    `verify command \`${CMD}\` ${manyClause} could not run`,
  ];
  assert(
    sites.every((s) => s.includes("on the CONSOLIDATED tree")),
    "N>1: all three label sites keep the CONSOLIDATED wording",
  );
}

// ------------------------------------------------- through the real reporter
// The rule above is unit-level; this drives the function that actually builds
// `failures[]`, because that is where the three sites are composed and where a
// partial rename would live.
function reported(cons: ConsolidatedVerifyResult, worktrees: Record<string, string>): string[] {
  const failures: string[] = [];
  reportConsolidatedVerifyOutcome(cons, {
    cmd: CMD,
    failures,
    notes: [],
    timeoutMs: 600_000,
    ctx: { repoRoot: REPO },
    worktrees,
    perWorktreeFailuresByWs: {},
    singlePerWs: undefined,
    singlePerAssertion: undefined,
  });
  return failures;
}

const failedRun = {
  status: "failed",
  detail: "exit 1",
  rawFailure: "src/a.ts(3,1): error TS2304: Cannot find name 'nope'.\n",
} as ConsolidatedVerifyResult;

const killedRun = {
  ...failedRun,
  timedOut: true,
} as ConsolidatedVerifyResult;

{
  // N=1: the reporter's failure entry names the one workstream's worktree.
  const [entry] = reported(failedRun, { default: WT });
  assert(
    entry.includes(`failed in ${WT}`) && !entry.includes("CONSOLIDATED"),
    `reporter N=1: the failure names the workstream's own tree (got: ${(entry ?? "").slice(0, 150)})`,
  );

  // N>1: unchanged — the CONSOLIDATED tree, with both ids.
  const many = reported(failedRun, {
    a: "/repo/.worktrees/issue-7-a",
    b: "/repo/.worktrees/issue-7-b",
  });
  assert(
    many.some((f) => f.includes("on the CONSOLIDATED tree")),
    `reporter N>1: the failure keeps the CONSOLIDATED wording (got: ${many.join(" | ").slice(0, 150)})`,
  );

  // N=1 whose worktree cannot be resolved (no map entry): the old wording, and
  // emphatically not the workstream id standing in for a path.
  const [orphan] = reported(failedRun, { default: undefined as unknown as string });
  assert(
    orphan.includes("on the CONSOLIDATED tree") && !orphan.includes("failed in default"),
    `reporter N=1, no tree: keeps CONSOLIDATED rather than naming an id (got: ${(orphan ?? "").slice(0, 150)})`,
  );

  // The timeout site of the SAME shape renames with the message — the pair is
  // the regression this file exists for.
  const [killed] = reported(killedRun, { default: WT });
  assert(
    killed.includes(`timeout in ${WT}`) && !killed.includes("CONSOLIDATED"),
    `reporter N=1: the timeout clause names the tree too (got: ${(killed ?? "").slice(0, 150)})`,
  );
  const [killedMany] = reported(killedRun, { a: "/w/a", b: "/w/b" });
  assert(
    killedMany.includes(`timeout on the CONSOLIDATED tree at ${REPO}`),
    "reporter N>1: the timeout clause keeps CONSOLIDATED and repoRoot",
  );
}

process.exit(exit);
