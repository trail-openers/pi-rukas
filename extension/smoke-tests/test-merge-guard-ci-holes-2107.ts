#!/usr/bin/env bun
/**
 * #2107 — the four holes the adversarial round found in the #2106 CI gate,
 * each pinned by the merge that used to pass.
 *
 * The #2106 gate was added LAST in the guard, after the ledger refusals. That
 * placement was chosen so an agent could not walk the refusals one merge at a
 * time — but it also put the gate BELOW the round-cap `return`, so a PR whose
 * lens row is ISSUES_FOUND at the cap reached CI never at all. Same root
 * cause, three siblings: nothing checked that the verdict the gate read
 * belongs to the head the guard verified, that a check row's `bucket` is one
 * the gatherer actually understands, or that the two forge reads are bounded
 * at all. All four are refusals now, and this file is the red-then-green
 * record for each.
 *
 * Driven through the REAL `registerMergeGuard` hook (merge-guard-helpers'
 * `hookDecision`), so each arm is the guard's decision, not a unit test of a
 * helper. The ledger rows are the ordinary passing pair except in the
 * round-cap arm, where the whole point is the capped row.
 */

import {
  assert,
  exit,
  GOOD_ENTRIES,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
  TARGET,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";
import { compareAdversarialIdentity } from "../src/merge-identity-compare.ts";
import { gatherMergeEvidence } from "../src/work-driver-merge-evidence.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";

await setupLedgerPath();

const row = (name: string, bucket: string) => ({ name, state: "completed", bucket });
const rows = (...rows: Array<{ name: string; state?: string; bucket?: string }>) =>
  JSON.stringify(rows);

// ── 1. The round-cap bypass ───────────────────────────────────────────────
// The hole: the round-cap path returned "allowed" before the CI gate ran, so a
// capped-but-merge-worthy PR with a red check merged. The fixture is the real
// round-cap allow — every condition of evaluateRoundCapMerge satisfied, which
// test-merge-guard-round-cap.ts pins at `block === false` — with a FAILURE
// check bolted on. Red at 16f956e2: that arm returned before asking gh.
{
  const PR_HEAD = "a".repeat(40);
  const ADV: LedgerEntry = {
    branch: "feature/x",
    kind: "adversarial",
    patchId: "p1",
    passed: true,
    at: 1,
  };
  const lens: LedgerEntry = {
    branch: "feature/x",
    kind: "lens",
    patchId: "p1",
    passed: false,
    detail: "ISSUES_FOUND",
    hasCritical: false,
    round: 3,
    headSha: PR_HEAD,
    at: 2,
  };
  const marker = JSON.stringify({
    comments: [
      {
        body: `residual findings\n<!-- pi-rukas:lens-residuals branch=feature/x patch=p1 -->`,
      },
    ],
  });
  const capped = {
    fetchedHead: PR_HEAD,
    target: { ...TARGET, headOid: PR_HEAD },
    ghComments: marker,
    // The round-cap allow needs green checks; each arm below overrides these.
    prChecks: rows(row("quality-gate", "pass")),
  };
  {
    // Control: the same fixture with green checks is still the round-cap allow.
    const r = await hookDecision("gh pr merge 12", [ADV, lens], capped);
    assert(
      r.block === false,
      `#2107 control: the round-cap path still allows a green PR (${(r.reason ?? "").slice(0, 120)})`,
    );
    assert(
      r.calls.some((c) => c.includes("gh pr checks")),
      "…and it asked the forge for the checks on the way",
    );
  }
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens], {
      ...capped,
      prChecks: rows(row("quality-gate", "fail")),
    });
    assert(
      r.block === true,
      `#2107: a round-cap-allowed merge with a FAILURE check is REFUSED (${(r.reason ?? "").slice(0, 160)})`,
    );
    assert(
      /quality-gate/.test(r.reason ?? ""),
      `…naming the failed check, not the round-cap rule (${(r.reason ?? "").slice(0, 160)})`,
    );
  }
  {
    // And the CI gate runs on the round-cap path even when the checks read
    // cannot be answered at all: silence is never a pass there either.
    const r = await hookDecision("gh pr merge 12", [ADV, lens], {
      ...capped,
      failChecks: true,
    });
    assert(r.block === true, "#2107: the round-cap path refuses on an unreadable checks read too");
    assert(/tooling/.test(r.reason ?? ""), "…named as a tooling failure");
  }
}

// ── 2. An unrecognised bucket is not a pass ───────────────────────────────
// The hole: the gatherer's verdict for a row whose `bucket` is outside gh's
// closed set is "no verdict", and the rows that produced none were never
// counted — a CLEAN `mergeStateStatus` carried the merge. The guard refuses on
// its own read now; the gatherer's behaviour is untouched (arm 2c pins that).
{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: rows(row("quality-gate", "completed")),
  });
  assert(
    r.block === true,
    `#2107: a check row whose bucket is not a known verdict is refused (${(r.reason ?? "").slice(0, 160)})`,
  );
  assert(
    /unrecognis|unrecogniz|not a known|unknown/i.test(r.reason ?? ""),
    `…naming the unrecognised bucket as the reason (${(r.reason ?? "").slice(0, 160)})`,
  );
  assert(
    /quality-gate/.test(r.reason ?? ""),
    `…and the row that carried it (${(r.reason ?? "").slice(0, 160)})`,
  );
}
{
  // A row with neither bucket nor state is the same hole in a different
  // spelling — `norm()` reads "" and the row counts as nothing.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: JSON.stringify([{ name: "quality-gate" }]),
  });
  assert(r.block === true, "#2107: a check row with no bucket and no state is refused");
}
{
  // 2c — the gatherer itself is unchanged: an unrecognised row is still NOT a
  // verdict there, and the guard (not the driver) is what turns it into a
  // refusal. If this arm flips, the driver's behaviour moved.
  const fn = (async (cmd: string) => {
    if (cmd.startsWith("gh pr view"))
      return {
        stdout: JSON.stringify({
          mergeStateStatus: "CLEAN",
          state: "OPEN",
          headRefOid: "a".repeat(40),
        }),
      };
    return { stdout: rows(row("quality-gate", "completed")) };
  }) as unknown as VerifyExecFn;
  const e = await gatherMergeEvidence(fn, "/x", 7);
  assert(e.ok === true, "#2107: the shared gatherer still answers ok for an unrecognised row");
  assert(
    e.unrecognised?.length === 1 && e.unrecognised[0] === "quality-gate",
    `…and now reports the rows it could not grade (${JSON.stringify(e.unrecognised)})`,
  );
  assert(
    compareAdversarialIdentity(GOOD_ENTRIES, "feature/x", "p1").ok === true,
    "(fixture sanity: the ledger rows this file merges behind do pass)",
  );
}

// ── 3. The head the verdict was read at ───────────────────────────────────
// The hole: the gate trusted `mergeStateStatus` from a read whose `headRefOid`
// it never compared to the head it had just fetched and verified. A verdict
// about some other commit, or about no commit at all, was a pass.
{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { evidenceHeadOid: "b".repeat(40) });
  assert(
    r.block === true,
    `#2107: a CI verdict read at a head other than the verified one is refused (${(r.reason ?? "").slice(0, 160)})`,
  );
  assert(
    /head/i.test(r.reason ?? ""),
    `…naming the head mismatch (${(r.reason ?? "").slice(0, 160)})`,
  );
}
{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { evidenceHeadOid: "" });
  assert(r.block === true, "#2107: a CI verdict with no head OID at all is refused");
  assert(/head/i.test(r.reason ?? ""), "…naming the absent head");
}

// ── 4. The reads are bounded ──────────────────────────────────────────────
// The hole: `gatherMergeEvidence` passes `maxBuffer` only — no `timeout` — so
// a gh that hangs holds the `tool_call` hook open indefinitely, and neither
// read carries the command's `-R <repo>`. The guard bounds the call itself;
// this pins the bound and the repo scoping on the argv the guard issued.
{
  const r = await hookDecision("gh -R o/r pr merge 12", GOOD_ENTRIES, {
    repoFlag: " -R o/r",
    targetRepo: "o/r",
    prChecks: rows(row("quality-gate", "pass")),
  });  assert(r.block === false, `#2107: a -R merge with green checks is allowed (${r.reason ?? ""})`);
  const evidence = r.calls.filter((c) => c.includes("mergeStateStatus,"));
  const checks = r.calls.filter((c) => c.includes("gh pr checks"));
  assert(
    evidence.some((c) => c.includes("-R o/r")),
    `#2107: the evidence read is scoped to the command's repo (${JSON.stringify(evidence)})`,
  );
  assert(
    checks.some((c) => c.includes("-R o/r")),
    `#2107: the checks read is scoped to the command's repo (${JSON.stringify(checks)})`,
  );
  assert(
    r.timeouts.some((t) => t === 30000),
    `#2107: the guard bounded the evidence reads with its own EXEC_TIMEOUT_MS (${JSON.stringify(r.timeouts)})`,
  );
}
{
  // The hang itself: a check read that never settles must come back as a
  // tooling refusal, not as the guard waiting forever.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { hangChecks: true });  assert(
    r.block === true,
    `#2107: a hanging checks read refuses rather than hanging the hook (${(r.reason ?? "").slice(0, 160)})`,
  );
  assert(/tooling|timed out|timeout/i.test(r.reason ?? ""), "…named as a tooling failure");
}

// ── 5. The refusal's name list is bounded and sanitised ───────────────────
// The hole: every failing and inconclusive name was pasted into the refusal
// verbatim, so a PR with 200 checks produced a 200-name refusal, and a check
// whose name carried a newline (a gh that echoed a stack trace into the field)
// broke the line the operator reads and any log that parses it.
{
  const many = Array.from({ length: 12 }, (_, i) => row(`check-${i + 1}`, "fail"));
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: rows(...many),
  });
  assert(r.block === true, "#2107: many failing checks still refuse");
  assert(
    /\(\+2 more\)/.test(r.reason ?? ""),
    `…clipping the list to the first ten and counting the rest (${(r.reason ?? "").slice(0, 220)})`,
  );
  assert(
    !r.reason?.includes("check-11"),
    `…dropping the names past the clip (${(r.reason ?? "").slice(0, 220)})`,
  );
  assert(
    r.reason!.includes("check-1,") && r.reason!.includes("check-10"),
    "…keeping the first ten",
  );
}
{
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, {
    prChecks: rows(row("red\n\u0007gate", "fail")),
  });
  assert(r.block === true, "#2107: a check name carrying control characters refuses");
  assert(
    !/[\r\n\u0000-\u001f]/.test(r.reason ?? ""),
    `…and the refusal stays one line with the control characters stripped (${JSON.stringify((r.reason ?? "").slice(0, 200))})`,
  );
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
