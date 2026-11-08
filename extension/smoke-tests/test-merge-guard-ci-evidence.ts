#!/usr/bin/env bun
/**
 * #2106 — the merge guard reads the PR's CI, and refuses when it is not green.
 *
 * The incident: a plain squash-merge shipped a PR whose ONLY CI check had
 * concluded FAILURE fifteen minutes earlier, with no re-run. main went red and
 * a release was blocked. The guard had passed it because the guard reads the
 * local review ledger and nothing else — and both rows had legitimately
 * passed. The driver's in-process merge has always consulted
 * `gatherMergeEvidence`; the `tool_call` hook never did, so AGENTS.md's claim
 * that an agent merge needs executed gh evidence was true only on the driver
 * path.
 *
 * So this file pins the two things that were missing, and nothing else:
 *
 *   1. every not-green shape refuses — a FAILURE check, a pending check, a
 *      skipped or neutral one, an UNKNOWN or BLOCKED `mergeStateStatus`, and
 *      a read that cannot be answered at all (which is a TOOLING failure, not
 *      a CI verdict: R4 wants "gh is broken" distinguishable from "CI is red");
 *   2. the guard really ASKED. The argv canary at the bottom is the load-
 *      bearing half: a guard that issued both reads and ignored the answers
 *      would pass every verdict arm above, and a stub that answered the
 *      evidence read with the identity payload would pass them vacuously. Both
 *      reads are asserted by their exact argv, so the assertion is about the
 *      guard consulting the forge, not about the stub's good manners.
 *
 * The verdict arms are driven through the REAL `registerMergeGuard` hook via
 * merge-guard-helpers' `hookDecision`, so this is the guard's decision on the
 * ledger rows the writer would have written — not a reimplementation of the
 * rule. The ledger is the ordinary passing pair throughout: what varies is
 * what the forge says, which is the only axis this issue is about.
 *
 * Out of scope here, by R2: the glab path. `gatherMergeEvidence` spells
 * GitHub argv unconditionally and GitLab's pipelines payload has neither
 * `bucket` nor `state`, so gating a glab merge on it would refuse every MR on
 * the absence of evidence. That decision is its own issue.
 */

import { mergeEvidenceViewCmd, prChecksCmd } from "../src/forge-commands.ts";
import {
  assert,
  exit,
  GOOD_ENTRIES,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

await setupLedgerPath();

/** One passing check row, the shape `gh pr checks --json name,state,bucket` gives. */
const row = (name: string, bucket: string) => ({ name, state: "completed", bucket });
const rows = (...rows: Array<{ name: string; state?: string; bucket?: string }>) =>
  JSON.stringify(rows);

// ---------------------------------------------------------------- a red check
{
  // The regression this issue exists for: the ledger rows pass, the check did
  // not. Red on main, where the guard never asked the forge anything. gh's
  // `bucket` is a CLOSED set (pass / fail / skipping / pending) — `failure` is
  // the REST conclusion the gatherer's set also carries, and a bucket outside
  // the set is graded as nothing, so this arm uses the bucket gh really prints.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: rows(row("quality-gate", "fail")),
  });
  assert(r.block === true, "#2106: a passing ledger with a FAILURE check is refused");
  assert(
    /quality-gate/.test(r.reason ?? ""),
    `…naming the check that failed (${(r.reason ?? "").slice(0, 120)})`,
  );
  assert(
    /failing/i.test(r.reason ?? ""),
    "…naming its state, not just its name",
  );
}
{
  // The REST conclusion spelling, which the gatherer's failing set also carries.
  // The REST conclusion spelling. `gh pr checks` reports the bucket verbatim,
  // so a row carrying `bucket: ""` is a gh that answered with something other
  // than its closed set — which the gatherer grades as NO verdict, not as red.
  // The spelling that IS red (and which test-gh-argv.ts pins the fields for)
  // carries the conclusion in `state` with no `bucket` key at all.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: rows({ name: "quality-gate", state: "FAILURE" }),
  });
  assert(
    r.block === true,
    "…and a `FAILURE` state with no bucket refuses too (both red spellings are red)",
  );
}

// ---------------------------------------------------------------- pending
{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: rows(row("quality-gate", "pending")),
  });
  assert(r.block === true, "#2106: a still-running check is refused (no merging behind a queue)");
  // R3: the type exposes no pending list, so the refusal quotes the gatherer's
  // own sentence rather than re-deriving names from it.
  assert(
    /still running/.test(r.reason ?? ""),
    `…quoting MergeEvidence.reason for the pending arm (${(r.reason ?? "").slice(0, 140)})`,
  );
}

// ---------------------------------------------------- skipped / neutral are not green
for (const bucket of ["skipped", "skipping", "neutral"]) {
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: rows(row("quality-gate", bucket)),
  });
  assert(
    r.block === true,
    `#2106: a check reported \`${bucket}\` is refused (GitHub counts it green; this guard does not)`,
  );
  assert(/quality-gate/.test(r.reason ?? ""), `…naming the \`${bucket}\` check`);
}

// ---------------------------------------------------- mergeStateStatus is authoritative
for (const state of ["UNKNOWN", "BLOCKED"]) {
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    mergeStateStatus: state,
    // The rows are green here: the state alone must be enough to refuse, so
    // nothing above the state read can be doing the work.
    prChecks: rows(row("quality-gate", "pass")),
  });
  assert(r.block === true, `#2106: mergeStateStatus ${state} is refused`);
  assert(
    new RegExp(state).test(r.reason ?? ""),
    `…naming mergeStateStatus ${state} in the refusal`,
  );
}

// ---------------------------------------------------------------- unreadable gh
{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { failEvidence: true });
  assert(r.block === true, "#2106: an unreadable PR-state read refuses (fail closed)");
  assert(
    /tooling/.test(r.reason ?? ""),
    `…carrying failureKind "tooling" so a broken gh is not read as red CI (${(r.reason ?? "").slice(0, 140)})`,
  );
}
{
  // The check rows are the other read the gate makes, and they fail on their
  // own: an exit-0 answer that is not check data, and a throw.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { prChecks: "" });
  assert(
    r.block === true,
    "#2106: an empty checks answer refuses — the absence of evidence is not a pass",
  );
  const t = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { failChecks: true });
  assert(
    t.block === true && /tooling/.test(t.reason ?? ""),
    "#2106: a checks read that throws refuses as a tooling failure, not a verdict",
  );
}

// ---------------------------------------------------------------- all green
{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    mergeStateStatus: "CLEAN",
    prChecks: rows(row("quality-gate", "pass"), row("lint", "pass")),
  });
  assert(
    r.block === false,
    `#2106: a passing ledger with green checks is allowed (${(r.reason ?? "").slice(0, 140)})`,
  );
}

// ---------------------------------------------------------------- the carve-out
{
  // R1: the evidence read runs strictly AFTER the carve-out return, so a bot
  // merge keeps its pass-through and issues no evidence read at all. The
  // ledger is EMPTY to prove the point further: a carve-out that fell through
  // to the ledger would refuse before ever reaching the forge.
  const r = await hookDecision("gh pr merge 12", [], {
    target: {
      forge: "github",
      prNumber: 12,
      headBranch: "release-please--branches--main",
      headOid: "abc123",
      baseBranch: "main",
      author: "release-please[bot]",
      labels: ["autorelease: pending"],
    },
  });
  assert(r.block === false, "#2106: a bot carve-out is still allowed");
  assert(
    !r.calls.some((c) => c.includes("gh pr checks") || c.includes("mergeStateStatus,")),
    `…with no evidence read at all (${JSON.stringify(r.calls)})`,
  );
}

// ------------------------------------------------ the argv canary: it must have ASKED
{
  // The counterweight to every arm above. Each of them could be satisfied by a
  // guard that refused for a reason it invented, and the whole matrix would
  // pass on a stub that answered everything with the identity payload. So: the
  // two exact argv strings the gate is allowed to issue, from the builders
  // themselves (test-gh-argv.ts pins those builders; #745 is why nothing here
  // invents a field list of its own). A guard that reads gh and ignores the
  // answer cannot pass, and a guard that stopped asking is caught on the spot.
  const wantState = mergeEvidenceViewCmd(12);
  const wantChecks = prChecksCmd("github", 12);
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    mergeStateStatus: "CLEAN",
    prChecks: rows(row("quality-gate", "pass")),
  });
  assert(
    r.calls.some((c) => c === wantState),
    `canary: the guard issued the pinned PR-state argv (${wantState})`,
  );
  assert(
    r.calls.some((c) => c === wantChecks),
    `canary: the guard issued the pinned checks argv (${wantChecks})`,
  );
  assert(r.block === false, "…and on that answer it allowed the merge");

  // The two reads are distinct calls: the identity read the guard already made
  // must not be mistaken for the evidence read by a matcher keying on `pr view`.
  const identity = r.calls.filter((c) => c.includes("gh pr view 12"));
  assert(
    identity.some((c) => c.includes("--json headRefName,headRefOid,baseRefName,author,labels")) &&
      identity.some((c) => c.includes("--json mergeStateStatus,mergeable,state,headRefOid")),
    `canary: the identity read and the evidence read are separate calls with separate field lists (${JSON.stringify(identity)})`,
  );
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
