#!/usr/bin/env bun
/**
 * #973 — the round-cap merge path: the guard's strict rule (latest lens
 * entry passed) refuses, and the round-cap path is consulted. Each
 * condition is exercised in turn: every failing condition produces a
 * refusal naming it, and all conditions met allows the merge. CRITICAL
 * never allows; a legacy entry (no hasCritical) never satisfies the
 * no-CRITICAL condition; a stale marker (different patch) is a refusal;
 * the escape hatch restores the strict rule.
 */

import {
  assert,
  exit,
  setupLedgerPath,
  teardownLedger,
  hookDecision,
  TARGET,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";
import { evaluateRoundCapMerge } from "../src/merge-guard-round-cap.ts";

await setupLedgerPath();

{
  const ADV: LedgerEntry = {
    branch: "feature/x",
    kind: "adversarial",
    patchId: "p1",
    passed: true,
    at: 1,
  };
  // The PR's current head — a 40-char SHA (the guard's round-cap path
  // shape-checks headSha against /^[0-9a-f]{40}$/; the TARGET helper's
  // headOid is a 6-char test fixture that the guard's own freshness check
  // accepts, but the round-cap path needs a full OID for the shape check).
  // We override the target's headOid and the stub's fetchedHead to this
  // value in every hookDecision call so the guard's freshness check passes
  // and the round-cap shape check sees a valid OID.
  const PR_HEAD = "a".repeat(40);
  const TARGET_OVERRIDE = { ...TARGET, headOid: PR_HEAD };
  const hook = (cmd: string, entries: LedgerEntry[], opts: Parameters<typeof hookDecision>[2] = {}) =>
    hookDecision(cmd, entries, { fetchedHead: PR_HEAD, target: TARGET_OVERRIDE, ...opts });
  const lens = (over: Partial<LedgerEntry> & { at: number }): LedgerEntry => ({
    branch: "feature/x",
    kind: "lens",
    patchId: "p1",
    passed: false,
    detail: "ISSUES_FOUND",
    hasCritical: false,
    round: 3,
    headSha: PR_HEAD,
    ...over,
  });
  const commentsWith = (branch: string, patch: string) =>
    JSON.stringify({
      comments: [
        {
          body: `residual findings\n<!-- pi-rukas:lens-residuals branch=${branch} patch=${patch} -->`,
        },
      ],
    });
  const NO_COMMENTS = JSON.stringify({ comments: [] });
  const MARKER_BRANCH = "feature/x";
  const MARKER_PATCH = "p1";

  // All conditions met → allowed (the strict rule refuses; the round-cap
  // path allows).
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === false, "round-cap: all conditions met → merge allowed");
    assert(
      r.calls.some((c) => c.includes("--json comments")),
      "…the guard read the PR's comments for the marker",
    );
  }
  // Condition 1 (verdict): the latest lens entry is not ISSUES_FOUND.
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2, detail: "REVIEW_INCOMPLETE" })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a REVIEW_INCOMPLETE entry is not ISSUES_FOUND → refused");
    assert(/not ISSUES_FOUND/.test(r.reason ?? ""), "…naming the verdict condition");
  }
  // Condition 1 (verdict): CRITICAL_ISSUES_FOUND never allows, even with a
  // marker (the round-cap rule mirrors the driver's cap: CRITICAL always
  // refuses).
  {
    const r = await hook(
      "gh pr merge 12",
      [ADV, lens({ at: 2, detail: "CRITICAL_ISSUES_FOUND", hasCritical: true, round: 5 })],
      { ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH) },
    );
    assert(r.block === true, "round-cap: CRITICAL_ISSUES_FOUND is never allowed");
    assert(/not ISSUES_FOUND/.test(r.reason ?? ""), "…naming the verdict condition");
  }
  // Condition 3: hasCritical is missing (legacy entry) → refused, naming it.
  {
    const legacy: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      round: 3,
      headSha: PR_HEAD,
    };
    const r = await hook("gh pr merge 12", [ADV, legacy], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a legacy entry without hasCritical cannot satisfy no-CRITICAL");
    assert(/hasCritical/.test(r.reason ?? ""), "…naming the missing hasCritical field");
  }
  // Condition 3: hasCritical is true → refused.
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2, hasCritical: true })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: hasCritical=true → refused");
    assert(/hasCritical/.test(r.reason ?? ""), "…naming the hasCritical condition");
  }
  // Condition 4: round below 3 → refused, naming the round.
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2, round: 2 })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: round 2 < 3 → refused");
    assert(/round 2/.test(r.reason ?? ""), "…naming the round condition");
  }
  // Condition 4: a legacy entry without `round` counts as round 1 → refused.
  {
    const legacyNoRound: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      hasCritical: false,
      headSha: PR_HEAD,
    };
    const r = await hook("gh pr merge 12", [ADV, legacyNoRound], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a legacy entry without `round` counts as round 1 → refused");
    assert(/round 1/.test(r.reason ?? ""), "…naming the round condition");
  }
  // Condition 4 (aborted runs do not advance the round): the exact
  // ISSUES_FOUND (r1) → REVIEW_INCOMPLETE (r2) → ISSUES_FOUND (r3) sequence
  // ends at round 2 (the aborted run carried round 1 unchanged), so the
  // guard refuses — the cap requires three COMPLETED runs.
  {
    const abortedSeq: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      hasCritical: false,
      round: 2,
    };
    const r = await hook("gh pr merge 12", [ADV, abortedSeq], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: an aborted run wedged in the sequence ends at round 2 → refused");
    assert(/round 2/.test(r.reason ?? ""), "…naming the round condition");
  }
  // Condition 5: no marker comment → refused, naming the disclosure.
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: NO_COMMENTS,
    });
    assert(r.block === true, "round-cap: no disclosure marker on the PR → refused");
    assert(/no disclosure marker/.test(r.reason ?? ""), "…naming the disclosure condition");
  }
  // Condition 5: a marker for a STALE patch → refused (the marker's patch
  // must equal the guard's current patch-id).
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: commentsWith(MARKER_BRANCH, "pOLD"),
    });
    assert(r.block === true, "round-cap: a marker for a stale patch → refused");
    assert(/no disclosure marker/.test(r.reason ?? ""), "…naming the disclosure condition");
  }
  // Condition 5: a marker for a DIFFERENT branch → refused.
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: commentsWith("feature/other", MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a marker for a different branch → refused");
    assert(/no disclosure marker/.test(r.reason ?? ""), "…naming the disclosure condition");
  }
  // The comments read is unreadable (no stub) → fail closed → refused.
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2 })]);
    assert(r.block === true, "round-cap: an unreadable comments read fails closed → refused");
  }
  // Condition 6 (headSha): a lens entry that reviewed an OLDER commit than
  // the PR's current head must not satisfy the cap, even with a fresh marker.
  // The headSha is a valid 40-char SHA that differs from PR_HEAD.
  {
    const otherSha = "b".repeat(40);
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2, headSha: otherSha })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a lens entry for an old headSha is refused even with a fresh marker");
    assert(
      /not the PR's current head/.test(r.reason ?? ""),
      "…naming the headSha condition (the branch moved after the review)",
    );
  }
  // Condition 6 (headSha): a legacy entry without headSha refuses, naming it.
  {
    const legacyHead: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      hasCritical: false,
      round: 3,
    };
    const r = await hook("gh pr merge 12", [ADV, legacyHead], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a legacy entry without headSha is refused (conservative)");
    assert(/no headSha/.test(r.reason ?? ""), "…naming the missing headSha field");
  }
  // #1039 — Condition 6 (headSha): a MALFORMED headSha (a branch name, not
  // a 40-char SHA) must be refused with a "malformed" message — distinct
  // from "no headSha" and "branch moved". Even when the branch name
  // string-equals the PR head branch, it must NOT be treated as a match.
  {
    const malformedSha: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      hasCritical: false,
      round: 3,
      headSha: "feature/x", // a branch name, not a SHA
    };
    const r = await hook("gh pr merge 12", [ADV, malformedSha], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a branch-name headSha is refused (malformed entry)");
    assert(/malformed/.test(r.reason ?? ""), "…naming the entry as MALFORMED (not 'branch moved')");
    assert(!/branch moved/.test(r.reason ?? ""), "…NOT the 'branch moved' message");
  }
  // #1039 — Condition 6 (headSha): a non-matching branch name (different
  // from the PR head branch) is also malformed — proving no string match.
  {
    const malformedSha2: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      hasCritical: false,
      round: 3,
      headSha: "feature/other", // a different branch name
    };
    const r = await hook("gh pr merge 12", [ADV, malformedSha2], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a non-matching branch-name headSha is refused (malformed)");
    assert(/malformed/.test(r.reason ?? ""), "…naming the entry as MALFORMED");
  }
  // #1039 — Condition 6 (headSha): a short/abbreviated OID (8 hex chars)
  // is also not a 40-char SHA → malformed.
  {
    const shortSha: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      hasCritical: false,
      round: 3,
      headSha: "abc12345", // 8 hex chars — not 40
    };
    const r = await hook("gh pr merge 12", [ADV, shortSha], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: an abbreviated OID headSha is refused (malformed)");
    assert(/malformed/.test(r.reason ?? ""), "…naming the entry as MALFORMED");
  }
  // Condition 6 (headSha): a matching headSha (a 40-char SHA equal to the
  // guard's prHeadOid) → allowed. The `hook` helper already overrides
  // fetchedHead and target to use PR_HEAD (a 40-char SHA), so the shape
  // check and the comparison both see valid OIDs.
  {
    const r = await hook("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === false, "round-cap: a matching headSha (== the PR's current head) → allowed");
  }
  // The strict rule still applies when the round-cap path does not apply
  // (latest lens entry passed → allowed via the strict rule, no comments
  // read needed).
  {
    const r = await hook("gh pr merge 12", [
      ADV,
      { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
    ]);
    assert(r.block === false, "strict rule: a passing lens entry is still allowed (round-cap not consulted)");
    assert(
      !r.calls.some((c) => c.includes("--json comments")),
      "…the strict path does not read the comments",
    );
  }
  // Escape hatch: PI_ENSEMBLE_LENS_ROUND_CAP_MERGE=0 disables the round-cap
  // path only → the strict rule's refusal applies.
  {
    const prev = process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE;
    process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE = "0";
    try {
      const r = await hook("gh pr merge 12", [ADV, lens({ at: 2 })], {
        ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
      });
      assert(r.block === true, "escape hatch: PI_ENSEMBLE_LENS_ROUND_CAP_MERGE=0 restores the strict rule");
      assert(
        /no passing lens review on file/.test(r.reason ?? ""),
        "…the strict rule's refusal text applies",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE;
      else process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE = prev;
    }
  }
}

// A malformed ledger row (non-string headSha/detail) must refuse with a
// named condition — it must NEVER throw (no .slice on a non-string).
{
  const malformed = {
    branch: "feature/x",
    kind: "lens",
    patchId: "p1",
    passed: false,
    at: 2,
    detail: 0,
    hasCritical: false,
    round: 3,
    headSha: 42,
  } as unknown as LedgerEntry;
  let threw = false;
  let decision: ReturnType<typeof evaluateRoundCapMerge> | undefined;
  try {
    decision = evaluateRoundCapMerge([malformed], "feature/x", "p1", [], "abc123");
  } catch {
    threw = true;
  }
  assert(!threw, "a malformed row (non-string headSha/detail) does not throw");
  assert(
    decision !== undefined && decision.applies === true && decision.allowed === false,
    "…it is a refusal (not a pass, not 'applies: false')",
  );
}

// Condition 4 (malformed round): a non-integer `round` (a string or a
// float that slipped past the loader) must count as round 1 — a `??`-style
// coercion would let `"3"` through `< 3` and ALLOW the merge. No cast; the
// guards must refuse, never throw. The marker comment (condition 5) is
// supplied so the round condition is the one under test.
{
  const good = {
    branch: "feature/x",
    kind: "lens",
    patchId: "p1",
    passed: false,
    at: 2,
    detail: "ISSUES_FOUND",
    hasCritical: false,
    headSha: "a".repeat(40),
  };
  const MARKER_COMMENT =
    "residual findings\n<!-- pi-rukas:lens-residuals branch=feature/x patch=p1 -->";
  const validSha = "a".repeat(40);
  const roundOk = (round: unknown) =>
    evaluateRoundCapMerge([{ ...good, round }], "feature/x", "p1", [MARKER_COMMENT], validSha);
  const badRounds: Array<[string, unknown]> = [
    ["\"3\" (a string)", "3"],
    ["true (a boolean)", true],
    ["3.5 (a non-integer float)", 3.5],
  ];
  for (const [label, value] of badRounds) {
    let threw = false;
    let decision: ReturnType<typeof evaluateRoundCapMerge> | undefined;
    try {
      decision = roundOk(value);
    } catch {
      threw = true;
    }
    assert(!threw, `a malformed round (${label}) does not throw`);
    assert(
      decision !== undefined && decision.applies === true && decision.allowed === false,
      `…a malformed round (${label}) is a refusal (never coerced into a pass)`,
    );
    assert(
      decision !== undefined && /round 1/.test(decision.failedCondition ?? ""),
      `…a malformed round (${label}) counts as round 1 (names the round condition)`,
    );
  }
  const ok = roundOk(3);
  assert(
    ok.applies === true && ok.allowed === true,
    "an integer round 3 satisfies condition 4 (allowed with marker + matching headSha)",
  );
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
