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
  mergeHoldToolingNote,
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
function fakeGh(responses: Record<string, string | Error>, checksFrag = "pr checks") {
  const calls: Call[] = [];
  const fn = async (cmd: string) => {
    calls.push({ cmd });
    for (const [frag, res] of Object.entries(responses)) {
      const key = frag === "pr checks" ? checksFrag : frag;
      if (cmd.includes(key)) {
        if (res instanceof Error) throw res;
        return { stdout: res };
      }
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { fn, calls };
}

const GREEN_STATE = JSON.stringify({ mergeStateStatus: "CLEAN", state: "OPEN" });
const passing = (name: string) => ({ name, state: "SUCCESS", bucket: "pass" });

{
  // #745 — the exact argv the gate shells out to is pinned here for the same
  // reason the vipune argv gate pins its flags: a single unsupported field
  // made the whole invocation fail closed on every host.
  const { fn, calls } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([passing("build"), passing("test")]),
  });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(e.ok, "all required checks passing + CLEAN → evidence gate allows the merge");
  assert(calls.length >= 2, "the gate issues two reads: the PR state and the checks");
  assert(
    calls[0]!.cmd === "gh pr view 7 --json mergeStateStatus,mergeable,state",
    `argv: gh pr view requests exactly the fields the gate knows how to read (got: ${calls[0]!.cmd})`,
  );
  assert(
    calls[1]!.cmd === "gh pr checks 7 --json name,state,bucket",
    `argv: gh pr checks requests only fields gh 2.98.0 supports (got: ${calls[1]!.cmd}) — isRequired is NOT one of them`,
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
      { name: "test", state: "FAILURE", bucket: "fail" },
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
  // #745 — the crash-versus-verdict distinction. A gate whose OWN gh
  // invocation errors used to produce the "could not read PR checks" reason,
  // which the queue summary rendered as "check the incomplete required
  // checks" — a CI verdict about a system where no check data was ever read.
  const { fn } = fakeGh({ "pr view": GREEN_STATE, "pr checks": new Error("exit 1") });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(e.ok === false, "`gh pr checks` erroring blocks the merge (fail-closed is preserved)");
  assert(
    e.failureKind === "tooling",
    "a gh invocation error is tagged `tooling`, textually distinct from a CI verdict",
  );
}
{
  // gh 2.98.0 exits non-zero with EMPTY stdout when checks are still pending
  // (exit 8) — the CLI answered nothing, so the operator must not be pointed
  // at CI. The same tag applies: the fault is the invocation, not the checks.
  const { fn } = fakeGh({ "pr view": GREEN_STATE, "pr checks": new Error("exit 8") });
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(e.ok === false, "a non-zero exit with no data still blocks the merge");
  assert(e.failureKind === "tooling", "a non-zero exit with no data is tooling, not 'no checks'");
}
{
  // A CLEAN PR with a successfully-read EMPTY check list is still a CI
  // verdict, not a tooling one: the invocation returned what GitHub has, so
  // the refusal is "the checks say no", which the operator acts on by
  // configuring required checks — unlike a crashed query, which they cannot.
  const { fn } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": "[]",
  } as Record<string, string>);
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "zero checks with a CLEAN status still blocks — no evidence of green checks");
  assert(
    e.failureKind !== "tooling",
    "an empty (but successfully read) list is a CI verdict, not tooling",
  );
}
{
  // #745 review — an exit-0 invocation that returns EMPTY stdout is no data
  // at all, not an empty check list: coercing it to `[]` would let the gate
  // say "no checks reported" (a CI verdict) about a query that answered with
  // nothing, so it is tagged tooling like a non-zero exit.
  const { fn } = fakeGh(
    {
      "pr view": GREEN_STATE,
      "pr checks": "  \n",
    } as Record<string, string>,
    "pr check",
  );
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "empty stdout from an exit-0 `gh pr checks` still blocks (fail-closed)");
  assert(
    e.failureKind === "tooling",
    "empty stdout is no data read — a tooling failure, not a 'no checks' CI verdict",
  );
}
{
  // #745 review — an exit-0 invocation whose stdout is NOT an array is a data
  // regression, not a tooling failure: the CLI answered, its shape just isn't
  // what the gate reads. The reason must show WHAT came back (truncated),
  // and must NOT carry the tooling tag that would send the operator to fix
  // their tooling instead of the malformed response.
  const { fn } = fakeGh(
    {
      "pr view": GREEN_STATE,
      "pr checks": "<html>Internal Server Error</html> not-json",
    } as Record<string, string>,
    "pr check",
  );
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "non-array stdout from an exit-0 `gh pr checks` blocks (fail-closed)");
  assert(e.failureKind !== "tooling", "malformed data is not tagged `tooling` (that would mislead)");
  assert(
    /data the gate could not read as a check list/.test(e.reason ?? ""),
    "the reason names the data regression, not a broken gh setup",
  );
  assert(
    /could not read as a check list|got:/.test(e.reason ?? ""),
    "and names the regression explicitly (raw slice or an explicit no-data note)",
  );
}
{
  // #745 review — mergeStateStatus is a string the CLI passes through, and it
  // lands verbatim in handoffs; a hostile/anomalous value must not yield an
  // unbounded operator-facing string.
  const longStatus = "X".repeat(200);
  const { fn } = fakeGh(
    {
      "pr view": JSON.stringify({ mergeStateStatus: longStatus, state: "OPEN" }),
      "pr checks": JSON.stringify([passing("build")]),
    } as Record<string, string>,
    "pr check",
  );
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(!e.ok, "an anomalous mergeStateStatus still blocks (fail-closed, not in the blocking set)");
  assert(
    (e.reason ?? "").length < 120,
    `the rendered reason is bounded (got ${e.reason?.length}) — mergeStateStatus is truncated on read`,
  );
  assert(e.mergeStateStatus?.length === 64, "the stored value itself is bounded at read time");
}

// ------------------------------------ narration cannot promote, evidence demotes

{
  const { fn } = fakeGh({
    "pr view": GREEN_STATE,
    "pr checks": JSON.stringify([
      { name: "test", state: "FAILURE", bucket: "fail" },
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
  // #745 — when the gate's own gh call errored, the action must not tell the
  // operator to inspect the checks (a CI-flavoured line about a system whose
  // check data was never read).
  const tooling = mergeHoldAction({ granted: true, source: "doctrine" }, 42, "tooling");
  assert(
    /gh invocation/.test(tooling) && !/incomplete required checks/.test(tooling),
    "a tooling refusal renders a tooling action, not 'check the checks'",
  );
  const ci = mergeHoldAction({ granted: true, source: "doctrine" }, 42, "ci");
  assert(
    /check the failing/.test(ci),
    "a CI-verdict refusal still points the operator at the checks",
  );
  const legacy = mergeHoldAction({ granted: true, source: "doctrine" }, 42);
  assert(
    /check the failing/.test(legacy),
    "state files without the tag (pre-#745) keep the CI-flavoured action",
  );
  assert(
    /tooling failure/.test(mergeHoldAction({ granted: false, source: "none" }, 42, "tooling")) === false,
    "the no-authority action never changes with the tag",
  );
  assert(
    !/state file|--restart/.test(denied),
    "and never says '--restart' — the work is done and pushed; restarting would duplicate it",
  );
  assert(
    /grant the driver authority/.test(denied),
    "it names the fix — grant the driver the authority — not a manual merge",
  );
  assert(
    /check the failing/.test(mergeHoldAction({ granted: true, source: "agents-md" }, 42)),
    "with authority granted, the action points at the checks instead",
  );
}

  assert(
    /tooling failure|The gh invocation itself failed/.test(mergeHoldToolingNote(true, "tooling")),
    "the shared helper renders the tooling note for a tooling refusal",
  );
  assert(
    mergeHoldToolingNote(true, "ci") === "" && mergeHoldToolingNote(true, undefined) === "",
    "the shared helper is silent for CI-verdict and untagged refusals",
  );
  assert(
    mergeHoldToolingNote(false, "tooling") === "",
    "the shared helper is silent when authority was not granted (that line already points correctly)",
  );

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
