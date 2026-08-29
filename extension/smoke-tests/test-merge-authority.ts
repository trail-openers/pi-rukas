#!/usr/bin/env bun
/**
 * #380 — merging is the one irreversible act in the cycle, and had no gate.
 *
 * Before this: `grep -rniE "merge.?polic|allowed to merge|automerge|canMerge"`
 * over `src/` returned NOTHING, and the decision to merge came from
 * `text.includes("ci-status: success")` in an LLM's reply. Two things are now
 * required, and both default to "no":
 *
 *   1. Someone explicitly permitted it (the project's documents, or `--merge`).
 *   2. `gh` — not an agent — reports the required checks passed.
 *
 * The exec seam is a fake, so this is offline. Every `gh` invocation the
 * production path makes is asserted, because a gate that never calls `gh` and
 * a gate that calls it and ignores the answer look identical from outside.
 */

import {
  contradictsSuccess,
  gatherMergeEvidence,
  mergeAuthorityEnabled,
  mergeHoldAction,
} from "../src/work-driver-merge-authority.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Authority RESOLUTION moved to test-policy-judge.ts in #407: the three
// English regexes are gone, replaced by a judged + citation-verified seam.
// What remains here is the half that never depended on parsing — the
// executed-evidence gate, and how a hold is explained to the operator.

// -------------------------------------------------------- evidence

type Call = { cmd: string };
function fakeGh(responses: Record<string, string | Error>) {
  const calls: Call[] = [];
  const fn = async (cmd: string) => {
    calls.push({ cmd });
    for (const [frag, res] of Object.entries(responses)) {
      if (cmd.includes(frag)) {
        if (res instanceof Error) throw res;
        return { stdout: res };
      }
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { fn, calls };
}

const GREEN_STATE = JSON.stringify({ mergeStateStatus: "CLEAN", state: "OPEN" });
const passing = (name: string) => ({ name, state: "SUCCESS", bucket: "pass", isRequired: true });

{
  const { fn, calls } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([passing("build"), passing("test")]),
  });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(e.ok, "all required checks passing + CLEAN → evidence gate allows the merge");
  assert(
    calls.some((c) => c.cmd.includes("gh pr checks")),
    "the gate actually SHELLED OUT to `gh pr checks` — it is not reading an LLM's text",
  );
  assert(
    calls.some((c) => c.cmd.includes("mergeStateStatus")),
    "...and read mergeStateStatus",
  );
}
{
  // The GitHub-docs trap: "Successful check statuses are success, skipped and
  // neutral". A required workflow that gains a `paths-ignore:` becomes a gate
  // that cannot fail.
  const { fn } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([
      passing("build"),
      { name: "test", state: "SKIPPED", bucket: "skipping", isRequired: true },
    ]),
  });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "a required check reporting `skipped` is NOT passing, though GitHub says it is");
  assert(e.inconclusive.includes("test"), "and the skipped check is named for the operator");
}
{
  const { fn } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([
      passing("build"),
      { name: "test", state: "FAILURE", bucket: "fail", isRequired: true },
    ]),
  });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok && e.failing.includes("test"), "a failing required check blocks the merge");
}
{
  const { fn } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([
      passing("build"),
      { name: "test", state: "PENDING", bucket: "pending", isRequired: true },
    ]),
  });
  assert(
    (await gatherMergeEvidence(fn, "/x", 7)).ok === false,
    "a still-running required check blocks the merge (no racing CI)",
  );
}
{
  const { fn } = fakeGh({
    "pr view": JSON.stringify({ mergeStateStatus: "BLOCKED", state: "OPEN" }),
    "pr checks": JSON.stringify([passing("build")]),
  });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "mergeStateStatus BLOCKED blocks the merge even when every check is green");
  assert(
    /BLOCKED/.test(e.reason ?? ""),
    "...because branch protection knows about reviews and conversations that checks do not",
  );
}
{
  const { fn } = fakeGh({
    "pr view": JSON.stringify({ mergeStateStatus: "CLEAN", state: "MERGED" }),
  });
  assert(
    (await gatherMergeEvidence(fn, "/x", 7)).ok === false,
    "an already-MERGED / non-OPEN PR is not re-merged",
  );
}
{
  // Fails CLOSED — the opposite of every other gate in the driver, because
  // this one is followed by an irreversible act.
  const { fn } = fakeGh({ "pr view": new Error("gh: not authenticated") });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "an unreadable `gh` blocks the merge — no evidence is not evidence of green");
}
{
  const { fn } = fakeGh({ "pr view": GREEN_STATE, "pr checks": new Error("exit 1") });
  assert(
    (await gatherMergeEvidence(fn, "/x", 7)).ok === false,
    "`gh pr checks` erroring blocks the merge",
  );
}
{
  const { fn } = fakeGh({ "pr view": GREEN_STATE, "pr checks": "[]" });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "zero required checks blocks the merge — refusing to merge on absence of evidence");
}
{
  // Non-required checks must not be able to hold a merge hostage.
  const { fn } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([
      passing("build"),
      { name: "optional-lint", state: "FAILURE", bucket: "fail", isRequired: false },
    ]),
  });
  assert(
    (await gatherMergeEvidence(fn, "/x", 7)).ok,
    "a FAILING non-required check does not block — only required ones gate",
  );
}

// ------------------------------------ narration cannot promote, evidence demotes

{
  const { fn } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([
      { name: "test", state: "FAILURE", bucket: "fail", isRequired: true },
    ]),
  });
  assert(
    contradictsSuccess(await gatherMergeEvidence(fn, "/x", 7)) !== undefined,
    "at the `ci` step, a failing check contradicts an ops agent's claimed success",
  );
}
{
  // At `ci` (unlike the merge gate) an unreadable gh must NOT demote — it
  // would burn the retry budget on a run that genuinely passed. The merge
  // gate is the one that fails closed.
  const { fn } = fakeGh({ "pr view": new Error("network") });
  assert(
    contradictsSuccess(await gatherMergeEvidence(fn, "/x", 7)) === undefined,
    "an unreadable `gh` does NOT demote a claimed success at the ci step",
  );
}

// ------------------------------------------------- operator-facing actions

{
  const denied = mergeHoldAction({ granted: false, source: "none" }, 42);
  assert(/#42/.test(denied), "the human action names the PR");
  assert(
    !/state file|--restart/.test(denied),
    "and never says '--restart' — the work is done and pushed; restarting would duplicate it",
  );
  assert(
    /review and merge/.test(denied),
    "it names the action only a human can take, per the SRE rule for notifications",
  );
  assert(
    /check the failing/.test(mergeHoldAction({ granted: true, source: "agents-md" }, 42)),
    "with authority granted, the action points at the checks instead",
  );
}

// ------------------------------------------------------------ escape hatch

{
  const prev = process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
  process.env.PI_ENSEMBLE_MERGE_AUTHORITY = "0";
  try {
    assert(!mergeAuthorityEnabled(), "PI_ENSEMBLE_MERGE_AUTHORITY=0 restores pre-#380 behaviour");
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_MERGE_AUTHORITY = undefined;
    else process.env.PI_ENSEMBLE_MERGE_AUTHORITY = prev;
  }
  assert(mergeAuthorityEnabled(), "and the gate is ON by default");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
