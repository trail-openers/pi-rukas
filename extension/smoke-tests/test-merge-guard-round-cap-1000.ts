#!/usr/bin/env bun
/**
 * #1000 — the `applies: false` fall-through wording and the
 * `readPrCommentBodies` repo-value boundary.
 *
 * Companion to test-merge-guard-round-cap.ts (#973 — the round-cap merge
 * path's decision matrix). This file covers the #1000 cases:
 *   - the `applies: false` fall-through refusal names that the round-cap
 *     path was NOT evaluated (distinct from the `applies: true` path, where
 *     a specific condition N failed and is named verbatim);
 *   - the legacy-entry-without-detail fall-through shows the verdict state
 *     (`verdict=unrecorded (legacy entry)`);
 *   - a malformed detail (non-string) is still refused with the
 *     condition-N wording — the rule IS evaluated, never "not evaluated";
 *   - `readPrCommentBodies`' defensive repo-value check (mirroring
 *     readGhTarget's #955 boundary): an invalid repo value returns [] with
 *     NO exec (never interpolated); a valid value still reaches the exec
 *     with -R.
 *
 * Ledger isolation: the shared merge-guard-helpers import self-isolates
 * (PI_ENSEMBLE_REVIEW_LEDGER_FILE set to a temp path on import —
 * test-ledger-isolation.ts).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assert,
  exit,
  setupLedgerPath,
  teardownLedger,
  hookDecision,
  TARGET,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";
import { readPrCommentBodies } from "../src/merge-guard-reads.ts";

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

  // #1000 — readPrCommentBodies' defensive repo-value check (mirroring
  // readGhTarget's #955 boundary): an invalid repo value returns [] with NO
  // exec (never interpolated); a valid value still reaches the exec with -R.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-rc-repo-"));
    try {
      const calls: string[] = [];
      const fn = async (cmd: string): Promise<{ stdout: string }> => {
        calls.push(cmd);
        return { stdout: NO_COMMENTS };
      };
      const T = {
        forge: "github",
        prNumber: 12,
        headBranch: "feature/x",
        headOid: PR_HEAD,
        baseBranch: "main",
        author: "janni",
        labels: [],
      } as never;
      const bodies = await readPrCommentBodies(fn, dir, T, 12, `o/r;id`);
      assert(bodies.length === 0, "readPrCommentBodies: an invalid repo value returns [] (fail closed)");
      assert(calls.length === 0, "…with NO exec call (the value is never interpolated)");
      const ok = await readPrCommentBodies(fn, dir, T, 12, "o/r");
      assert(ok.length === 0 && calls.length === 1, "a valid repo value still reaches the exec");
      assert(calls[0].includes("-R o/r"), "…with the repo flag appended to the comments command");
      // #1000 — a malformed PR number (fail closed, mirroring the repo-value
      // check): non-integer and non-positive values are refused before any
      // exec → [] (the marker check fails, the merge is refused).
      const badPr = await readPrCommentBodies(fn, dir, T, NaN, "o/r");
      assert(badPr.length === 0 && calls.length === 1, "an invalid PR number (NaN) returns [] with NO new exec");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // #1000 — the `applies: false` fall-through: "the round-cap path was NOT
  // evaluated" (distinct from the `applies: true` path, where a specific
  // condition N failed). The strict-rule text alone hides which situation
  // applies; it must now name that the round-cap path was not evaluated.
  {
    // No lens entry at all → "not evaluated (there is no entry to evaluate)".
    const noLens = await hook("gh pr merge 12", [ADV]);
    assert(noLens.block === true, "fall-through: no lens entry → refused");
    assert(
      /round-cap path was not evaluated/.test(noLens.reason ?? ""),
      "…the refusal names that the round-cap path was NOT evaluated",
    );
    assert(/no entry to evaluate/.test(noLens.reason ?? ""), "…naming no entry to evaluate");

    // Legacy entry without a `detail` field → not evaluated (the rule cannot
    // verify the verdict), with the verdict state shown (unrecorded, legacy).
    const legacyNoDetail: LedgerEntry = {
      branch: "feature/x",
      kind: "lens",
      patchId: "p1",
      passed: false,
      at: 2,
    };
    const legacy = await hook("gh pr merge 12", [ADV, legacyNoDetail], {
      ghComments: commentsWith("feature/x", "p1"),
    });
    assert(legacy.block === true, "fall-through: a legacy entry without detail → refused");
    assert(
      /round-cap path was not evaluated/.test(legacy.reason ?? ""),
      "…the refusal names that the round-cap path was NOT evaluated",
    );
    assert(
      /verdict=unrecorded \(legacy entry\)/.test(legacy.reason ?? ""),
      "…the verdict state is shown as unrecorded (legacy entry)",
    );

    // REVIEW_INCOMPLETE with all fields present → condition-1 failure
    // (applies: true, verdict check fails). This is NOT the "not evaluated"
    // path — it IS evaluated and the specific condition is named.
    const incomplete = await hook(
      "gh pr merge 12",
      [ADV, { ...lens({ at: 2 }), detail: "REVIEW_INCOMPLETE" }],
      { ghComments: commentsWith("feature/x", "p1") },
    );
    assert(incomplete.block === true, "condition-1: a REVIEW_INCOMPLETE verdict → refused");
    assert(
      /not ISSUES_FOUND/.test(incomplete.reason ?? ""),
      "…the condition-1 'not ISSUES_FOUND' wording is used (a specific condition failed)",
    );
    assert(
      !/round-cap path was not evaluated/.test(incomplete.reason ?? ""),
      "…NOT the 'not evaluated' wording (the rule WAS evaluated and failed on condition 1)",
    );

    // And the `applies: true` condition-N refusal does NOT carry the "not
    // evaluated" wording — the two situations are textually distinct.
    const condN = await hook("gh pr merge 12", [ADV, { ...lens({ at: 2 }), round: 1 }], {
      ghComments: commentsWith("feature/x", "p1"),
    });
    assert(condN.block === true, "condition-N: round 1 → refused");
    assert(/round 1/.test(condN.reason ?? ""), "…naming the round condition");
    assert(
      !/round-cap path was not evaluated/.test(condN.reason ?? ""),
      "…the condition-N refusal does NOT say the path was not evaluated",
    );

    // #1000 — a malformed detail (non-string) is still refused with the
    // condition-N wording (the round-cap rule IS evaluated), never "not
    // evaluated".
    {
      const malformed: LedgerEntry = {
        branch: "feature/x",
        kind: "lens",
        patchId: "p1",
        passed: false,
        at: 2,
        detail: 0 as unknown as string,
        hasCritical: false,
        round: 3,
        headSha: "a".repeat(40),
      };
      const r = await hook("gh pr merge 12", [ADV, malformed], {
        ghComments: commentsWith("feature/x", "p1"),
      });
      assert(r.block === true, "malformed detail → refused");
      assert(/verdict is malformed/.test(r.reason ?? ""), "…naming the malformed verdict (condition-N wording)");
      assert(!/round-cap path was not evaluated/.test(r.reason ?? ""), "…NOT the 'not evaluated' fall-through");
    }
  }
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
