#!/usr/bin/env bun
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
 * The rule and the N=1 reasoning live in `consolidatedRunWhere`
 * (`work-driver-consolidation-classify.ts`) — this file only pins that the
 * sites agree on what the rule says: the failure entry, the timeout clause and
 * the host-exhaustion clause of ONE failure are three strings, and a rename
 * that reaches some but not all of them is the regression caught here.
 */
import { reportConsolidatedVerifyOutcome } from "../src/work-driver-consolidated-verify-report.ts";
import type { ConsolidatedVerifyResult } from "../src/work-driver-consolidated-verify.ts";
import {
  type ConsolidationFailureVerdict,
  consolidatedFailureMessage,
  consolidatedRunWhere,
} from "../src/work-driver-consolidation-classify.ts";
import { VERIFY_TIMEOUT_LABEL } from "../src/work-driver-verify-develop-helpers.ts";

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
const TIMEOUT_MS = 600_000;

const verdict = (
  classification: ConsolidationFailureVerdict["classification"],
  ids: string[],
): ConsolidationFailureVerdict => ({
  classification,
  assertion: "src/a.ts(3,1): error TS2304",
  workstreamIds: ids,
  trivialFix: false,
  reason: "the verify command failed",
});

/** A failed consolidated run, checked against the `failed` arm it claims to be. */
const failedRun = {
  status: "failed",
  detail: "exit 1",
  rawFailure: "src/a.ts(3,1): error TS2304: Cannot find name 'nope'.\n",
} satisfies Extract<ConsolidatedVerifyResult, { status: "failed" }>;

/** The same run killed at its bound. */
const killedRun = {
  ...failedRun,
  timedOut: true,
} satisfies Extract<ConsolidatedVerifyResult, { status: "failed" }>;

/** A run whose stream says the host could not fork — the third label site. */
const forkRun = {
  status: "failed",
  detail: "exit 1",
  rawFailure: "/bin/sh: 1: Cannot fork\n",
} satisfies Extract<ConsolidatedVerifyResult, { status: "failed" }>;

/** The gate's own reporter, with everything but the shape under test fixed. */
function reported(
  cons: ConsolidatedVerifyResult,
  worktrees: Record<string, string | undefined>,
): string[] {
  const failures: string[] = [];
  reportConsolidatedVerifyOutcome(cons, {
    cmd: CMD,
    failures,
    notes: [],
    timeoutMs: TIMEOUT_MS,
    ctx: { repoRoot: REPO },
    worktrees,
    perWorktreeFailuresByWs: {},
    singlePerWs: undefined,
    singlePerAssertion: undefined,
  });
  return failures;
}

// ---------------------------------------------------------------- the rule
{
  // N>1: a genuine combination — the CONSOLIDATED wording, and the rule says
  // the probe ran at repoRoot (where it checked the combination out).
  const many = consolidatedRunWhere(2, WT, REPO);
  assert(
    many.phrase === "on the CONSOLIDATED tree" && many.atRepoRoot === true,
    "N>1 keeps the CONSOLIDATED wording and places the run at repoRoot",
  );

  // N=1 with a resolvable tree: the workstream's own worktree, in the
  // per-worktree wording (`in <tree>`) — same tree, same wording.
  const one = consolidatedRunWhere(1, WT, REPO);
  assert(
    one.phrase === `in ${WT}` && one.atRepoRoot === false,
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

  // A value that is not a usable location — a relative path, an empty string,
  // or anything a hand-written / stale state file puts in the map — degrades to
  // the honest old wording rather than printing a location that points nowhere.
  for (const unusable of ["relative/wt", "", ".", "~wt"]) {
    assert(
      consolidatedRunWhere(1, unusable, REPO).phrase === "on the CONSOLIDATED tree",
      `an unusable tree (${JSON.stringify(unusable)}) keeps the CONSOLIDATED wording`,
    );
  }
  assert(
    consolidatedRunWhere(1, 42 as unknown as string, REPO).phrase === "on the CONSOLIDATED tree",
    "a non-string map value never reaches the clause",
  );
}

// ------------------------------------------------------- the message, per N
{
  const oneMsg = consolidatedFailureMessage(
    verdict("per-workstream-defect", ["default"]),
    CMD,
    WT,
    REPO,
    1,
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
    2,
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
    1,
  );
  assert(
    unknownMsg.startsWith("[needs-human-decision]") &&
      unknownMsg.includes("failed on the CONSOLIDATED tree"),
    "N=1 with no tree keeps the pre-#1064 message shape and its label",
  );

  // The count is the CALLER's N, not the verdict's id list: the classifier
  // slices `workstreamIds` per classification, so a message composed from the
  // id list alone could name a different tree than the sibling clauses of the
  // same failure (which read the map).
  const sliced = verdict("per-workstream-defect", ["default"]);
  assert(
    consolidatedFailureMessage(sliced, CMD, WT, REPO, 2).includes("on the CONSOLIDATED tree"),
    "a per-workstream verdict at N>1 does not claim a single workstream's tree",
  );
  assert(
    consolidatedFailureMessage(sliced, CMD, WT, REPO).includes(`failed in ${WT}`),
    "omitting the count falls back to the verdict's id list",
  );
}

// ------------------------------------- one failure, three label sites, via the reporter
// The rule above is unit-level; this drives the function that actually builds
// `failures[]`, because that is where the three sites are composed and where a
// partial rename would live: the failure entry, its timeout clause and its
// host-exhaustion clause are three strings for ONE failure.
{
  const [entry] = reported(failedRun, { default: WT });
  assert(
    (entry ?? "").includes(`failed in ${WT}`) && !(entry ?? "").includes("CONSOLIDATED"),
    `N=1: the failure entry names the one workstream's tree (got: ${(entry ?? "").slice(0, 150)})`,
  );

  // Same shape, no worktree in the map: the old wording, and emphatically not
  // the workstream id standing in for a path.
  const [orphan] = reported(failedRun, { default: undefined });
  assert(
    (orphan ?? "").includes("on the CONSOLIDATED tree") && !(orphan ?? "").includes("failed in "),
    `N=1 with no tree: keeps CONSOLIDATED rather than naming an id (got: ${(orphan ?? "").slice(0, 150)})`,
  );

  const [timeoutEntry] = reported(killedRun, { default: WT });
  assert(
    (timeoutEntry ?? "").startsWith(VERIFY_TIMEOUT_LABEL) &&
      (timeoutEntry ?? "").includes(`timeout in ${WT}`) &&
      !(timeoutEntry ?? "").includes("CONSOLIDATED"),
    `N=1: the timeout clause of the same failure names the same tree (got: ${(timeoutEntry ?? "").slice(0, 150)})`,
  );

  const [hostEntry] = reported(forkRun, { default: WT });
  assert(
    (hostEntry ?? "").includes(`verify command \`${CMD}\` in ${WT} could not run`) &&
      !(hostEntry ?? "").includes("CONSOLIDATED"),
    `N=1: the host-exhaustion clause of the same failure names the same tree (got: ${(hostEntry ?? "").slice(0, 150)})`,
  );
}

// ------------------------------------------------- N>1 keeps the old wording
{
  // N>1: unchanged — the CONSOLIDATED tree, with both ids.
  const many = reported(failedRun, {
    a: "/repo/.worktrees/issue-7-a",
    b: "/repo/.worktrees/issue-7-b",
  });
  assert(
    many.some((f) => f.includes("on the CONSOLIDATED tree")),
    `reporter N>1: the failure keeps the CONSOLIDATED wording (got: ${many.join(" | ").slice(0, 150)})`,
  );

  // N=1 whose worktree cannot be resolved (no map entry) is pinned above, with
  // the failure entry it shares.
  const [killedMany] = reported(killedRun, { a: "/w/a", b: "/w/b" });
  assert(
    (killedMany ?? "").includes(`timeout on the CONSOLIDATED tree at ${REPO}`),
    "reporter N>1: the timeout clause keeps CONSOLIDATED and repoRoot",
  );

  // And the host-exhaustion clause of the same N=1 shape names the tree, in the
  // composed form — not merely "somewhere in the string".
  const [hostMany] = reported(forkRun, { a: "/w/a", b: "/w/b" });
  assert(
    (hostMany ?? "").includes(`verify command \`${CMD}\` on the CONSOLIDATED tree could not run`),
    "reporter N>1: the host-exhaustion sentence keeps the CONSOLIDATED wording",
  );
}

process.exit(exit);
