#!/usr/bin/env bun
/**
 * #912 — the merge guard: matcher table, decision matrix, registration canaries.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { mergesPr } from "../src/bash-command-parser.ts";
import {
  assert,
  exit,
  setupLedgerPath,
  teardownLedger,
  hookDecision,
  withLedger,
  TARGET,
  GOOD_ENTRIES,
  adversarialPassed,
  lensPassed,
  latestEntry,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";

await setupLedgerPath();

// The ledger file the decision matrix writes — resolved via the module under
// test (ledgerPathFor) so the writer and the guard can never disagree on the
// path. The env override below points it at a private temp file BEFORE the
// resolution, so the real per-clone ledger under the git common dir is never
// touched; the temp dir is removed at the end.

// ------------------------------------------------------------ it catches

for (const cmd of [
  // The plain verb, with the shapes agents actually emit.
  "gh pr merge 12 --squash",
  "glab mr merge 12",
  "oo gh pr merge 12 --squash",
  "oo glab mr merge 7",
  // Wrappers + chains — the predicate scans, it does not anchor.
  "timeout 60 gh pr merge 12",
  "cd x && gh pr merge 12",
  "git status; gh pr merge 12 --squash",
  "nice -n 5 glab mr merge 3",
  "env FOO=1 gh pr merge 12",
  // No PR number — resolved via `gh pr view --json number` on the current branch.
  "gh pr merge",
  // The gh REST door: gh api defaults to POST/PUT, so /pulls/N/merge IS the write.
  "gh api repos/o/r/pulls/12/merge",
  "gh api repos/o/r/pulls/12/merge --dry-run",
  "gh api repos/o/r/pulls/merge -f a=b",
  // Body fields force a PUT regardless of --method — a GET with -f is the write.
  "gh api repos/o/r/pulls/12/merge --method GET --field merge_method=squash",
  "gh api repos/o/r/pulls/12/merge -X GET -f merge_method=squash",
  // The glab REST door: method-AWARE — only an explicit PUT/POST or body fields.
  "glab api /projects/1/mr/12/merge -X PUT",
  "glab api /projects/1/mr/12/merge --method POST",
  "glab api /projects/1/mr/12/merge -f squash=true",
  "glab api /projects/1/mr/merge --method PUT",
  // The repo's canonical glab shape: /merge_requests/{n}/merge (unquoted).
  "glab api /projects/1/merge_requests/12/merge -X PUT",
  "glab api /projects/1/merge_requests/12/merge --method put",
  "glab api /projects/1/merge_requests/12/merge -f squash=true",
  "glab api /projects/123/merge_requests/45/merge --method POST",
  // Lowercase method names — the CLIs normalise case, the matcher must too.
  "glab api /projects/1/mr/12/merge -X put",
]) {
  assert(mergesPr(cmd) !== undefined, `canary: blocked — ${cmd}`);
}

// ----------------------------------- the shared predicates (writer == guard)

assert(
  adversarialPassed({ ok: true, loopOutcome: "approved" }),
  "MINOR_OBSERVATIONS pass (approved) → passed",
);
assert(
  !adversarialPassed({ ok: false, loopOutcome: "rejected" }),
  "CRITICAL rejection → not passed",
);
assert(
  !adversarialPassed({ ok: false, loopOutcome: "infra-failure" }),
  "infra-failure → not passed",
);
assert(!adversarialPassed({ ok: false }), "dispatch failure → not passed");
assert(
  !adversarialPassed({ ok: false, errorStop: { reason: "error" } }),
  "provider error → not passed",
);
assert(!adversarialPassed({ ok: false, killCause: "timeout" }), "killed → not passed");

assert(lensPassed("APPROVED", "MEDIUM"), "lens APPROVED → passed");
assert(!lensPassed("CRITICAL_ISSUES_FOUND", "LOW"), "lens CRITICAL blocks at every threshold");
assert(!lensPassed("REVIEW_INCOMPLETE", "LOW"), "lens REVIEW_INCOMPLETE → not passed");
assert(lensPassed("ISSUES_FOUND", "LOW"), "lens ISSUES_FOUND passes at the LOW threshold");
assert(!lensPassed("ISSUES_FOUND", "MEDIUM"), "lens ISSUES_FOUND blocks at the MEDIUM threshold");

{
  // Latest-entry semantics: the guard reads the LATEST per kind.
  const entries: LedgerEntry[] = [
    { branch: "b", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "b", kind: "adversarial", patchId: "p2", passed: false, at: 2 },
    { branch: "b", kind: "lens", patchId: "p1", passed: true, at: 1 },
    { branch: "b", kind: "lens", patchId: "p3", passed: true, at: 3 },
  ];
  const adv = latestEntry(entries, "b", "adversarial");
  assert(
    adv !== undefined && adv.passed === false,
    "adversarial: latest entry wins (a later fail overrides an earlier pass)",
  );
  const lens = latestEntry(entries, "b", "lens");
  assert(
    lens !== undefined && lens.patchId === "p3",
    "lens: latest entry wins (any patchId allowed)",
  );
}

// ------------------------------------------------- the guard decision matrix
// Driven through the REAL hook via `opts.execFn`.
//
// Lens: latest entry must be passed (any patchId). The #973 round-cap path
// is a sibling test (test-merge-guard-round-cap.ts) that exercises the
// conditions below when the strict rule refuses.

{
  // No ledger entries → refused; the hook issues the pinned argv on the way.
  const r = await hookDecision("gh pr merge 12", []);
  assert(r.block === true, "refused with no ledger entries");
  assert(/no passing adversarial/.test(r.reason ?? ""), "…naming the missing adversarial review");
  assert(
    r.calls.some(
      (c) => c === "gh pr view 12 --json headRefName,headRefOid,baseRefName,author,labels",
    ),
    "…after issuing the pinned gh pr view argv",
  );
  assert(
    r.calls.some((c) => c.includes("git fetch origin feature/x")),
    "…after fetching the head branch",
  );
  assert(
    r.calls.some((c) => c.includes("git fetch origin main")),
    "…after fetching the base branch (the patch-id's merge-base needs fresh refs)",
  );
  assert(
    r.calls.some(
      (c) => c.includes("git diff origin/main...origin/feature/x") && c.includes("patch-id"),
    ),
    "…after computing the patch-id over the PR's actual base (three-dot: merge-base semantics, matching the ledger writers)",
  );
  assert(
    !r.calls.some((c) => c.includes("git diff origin/main..origin/")),
    "…not the two-dot base-tip form (that shape diverges from the writers once the base advances)",
  );
}
{
  // Passing adversarial (matching patchId) + passing lens → allowed.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES);
  assert(r.block === false, "allowed with passing adversarial (matching patchId) + passing lens");
}
{
  // A new commit changes the patchId → refused until adversarial re-runs.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { patchId: "p2" });
  assert(r.block === true, "refused after a new commit changes the patchId");
  assert(
    /adversarial review is stale/.test(r.reason ?? ""),
    "…naming the stale adversarial review",
  );
}
{
  // Fetched head ≠ headOid → refused (stale).
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { fetchedHead: "def456" });
  assert(r.block === true, "refused when fetched head ≠ headOid");
  assert(/stale branch/.test(r.reason ?? ""), "…naming the head mismatch");
}
{
  // A later FAILING lens run overrides an earlier pass → refused.
  const entries: LedgerEntry[] = [
    { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/x", kind: "lens", patchId: "p1", passed: false, at: 2 },
  ];
  const r = await hookDecision("gh pr merge 12", entries);
  assert(
    r.block === true,
    "refused when the latest lens entry failed (a later fail overrides an earlier pass)",
  );
  assert(/no passing lens/.test(r.reason ?? ""), "…naming the missing lens review");
}
{
  // Unreadable gh → fail-closed refusal naming the failed read.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { failGh: true });
  assert(r.block === true, "fail-closed: unreadable gh refuses");
  assert(/gh pr view 12 failed/.test(r.reason ?? ""), "…naming the failed gh pr view");
}
{
  // Fetch failure → fail-closed refusal naming the fetch.
  const r = await hookDecision("gh pr merge 12", GOOD_ENTRIES, { failFetch: true });
  assert(r.block === true, "fail-closed: git fetch failure refuses");
  assert(/git fetch failed/.test(r.reason ?? ""), "…naming the fetch failure");
}
// ------------------------------------------- the carve-outs (item 8)
{
  // Carve-outs require a BOT IDENTITY, not a branch shape. The hook
  // short-circuits after the target read when the bot identity is present.
  const carveTargets: Array<[string, typeof TARGET, boolean]> = [
    ["dependabot[bot] author", { ...TARGET, author: "dependabot[bot]" }, false],
    ["app/dependabot author", { ...TARGET, author: "app/dependabot" }, false],
    [
      "dependabot/ branch alone",
      { ...TARGET, headBranch: "dependabot/npm-and-yarn/foo-1.2.3" },
      true,
    ],
    [
      "release-please branch + label",
      { ...TARGET, headBranch: "release-please--branches--main", labels: ["autorelease: pending"] },
      false,
    ],
    [
      "release-please branch + bot author",
      { ...TARGET, headBranch: "release-please--branches--main", author: "release-please[bot]" },
      false,
    ],
    ["release-please branch alone", { ...TARGET, headBranch: "release-please--branches--main" }, true],
  ];
  for (const [label, target, expectBlock] of carveTargets) {
    const r = await hookDecision("gh pr merge 12", [], { target });
    if (expectBlock) assert(r.block === true, `carve-out: ${label} is NOT a carve-out (bot ID required)`);
    else {
      assert(r.block === false, `carve-out: ${label} allowed`);
      assert(
        !r.calls.some((c) => c.includes("patch-id")),
        `carve-out: ${label} does not reach the ledger check`,
      );
    }
  }
}
{
  // The gh REST /merge door goes through the same decision path.
  const r = await hookDecision("gh api repos/o/r/pulls/12/merge", []);
  assert(r.block === true, "the gh REST /merge door is gated by the same decision path");
  assert(/no passing adversarial/.test(r.reason ?? ""), "…with the same refusal text");
}
{
  // PR-number scoping: a digit inside an EARLIER command of the chain (the
  // `cd /data/3` path) is not a PR number — the hook must not validate the
  // ledger for PR #3 (the stub would throw on an unexpected `gh pr view 3`).
  const r = await hookDecision("cd /data/3 && gh pr merge", GOOD_ENTRIES);
  assert(
    r.block === false,
    "a chained `cd /N && gh pr merge` does not pick the digit up as the PR number",
  );
}

// ------------------------------------------- the remote is NOT hardcoded
{
  const entries: LedgerEntry[] = [
    { branch: "feature/up", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/up", kind: "lens", patchId: "p1", passed: true, at: 2 },
  ];
  const r = await hookDecision("gh pr merge 12", entries, {
    target: { ...TARGET, headBranch: "feature/up" },
    remote: "upstream",
  });
  assert(r.calls.some((c) => c.includes("upstream/feature/up")), "remote resolved via git config");
  assert(!r.calls.some((c) => c.includes("origin/feature/up")), "no hardcoded origin");
  assert(r.block === false, "merge allowed when remote is upstream and patchId matches");
}

// ------------------------------ registration-order + shape canaries

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const pg = readFileSync(path.join(SRC, "permission-guard.ts"), "utf8");
  const subSrc = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");
  const subBlock = readFileSync(path.join(SRC, "subagent-guard-guards.ts"), "utf8");
  const mg = readFileSync(path.join(SRC, "merge-guard.ts"), "utf8");

  // Parent guard: before trust-mode return AND sandbox short-circuit.
  const guardIdx = pg.indexOf("registerMergeGuard(pi)");
  const sandboxIdx = pg.indexOf('if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") {');
  const trustIdx = pg.indexOf("isInTrustMode(ctx.hasUI === true)");
  assert(guardIdx > 0, "canary: parent guard registers the merge guard");
  assert(
    guardIdx < sandboxIdx && guardIdx < trustIdx,
    `registered BEFORE the sandbox short-circuit and the trust-mode return (guard=${guardIdx}, sandbox=${sandboxIdx}, trust=${trustIdx})`,
  );
  // Subagent guard: before both bypasses (shared block call site here,
  // guard presence in the block there).
  const subGuardIdx = subSrc.indexOf("registerModeIndependentGuards(pi)");
  const subSandboxIdx = subSrc.indexOf("PI_ENSEMBLE_SANDBOX_MODE");
  const subTrustIdx = subSrc.indexOf("PI_ENSEMBLE_TRUST_MODE");
  assert(subGuardIdx > 0, "canary: subagent path registers the shared guard block");
  assert(subGuardIdx < subSandboxIdx && subGuardIdx < subTrustIdx, "subagent: before both bypasses");
  assert(subBlock.includes("registerMergeGuard(pi)"), "canary: the shared block registers the merge guard");
  // Role-agnostic, mode-agnostic, escape hatch present.
  assert(
    !/PI_ENSEMBLE_ROLE/.test(mg),
    "canary: the guard is role-agnostic — it fires for PM, explore, ops, developer alike",
  );
  assert(
    !/PI_ENSEMBLE_TRUST_MODE|PI_ENSEMBLE_SANDBOX_MODE|PI_ENSEMBLE_SUBAGENT_MODE/.test(mg),
    "the guard is mode-agnostic — it is the hook registered before the bypasses, not a branch inside them",
  );
  assert(
    /PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE === "1"/.test(mg),
    "escape hatch: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 opens the door for a human",
  );
  // The hook is async and awaits the execs before deciding.
  assert(/async \(event, _ctx\)/.test(mg), "the tool_call handler is async");
  assert(/await readMergeTarget/.test(mg), "…and it awaits the PR read before the ledger check");
  assert(/await branchPatchId/.test(mg), "…and it awaits the patch-id computation before deciding");
}

// ------------------------------------------------ mechanizedMerge canary
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const merged = readFileSync(path.join(SRC, "work-driver-merged-mechanized.ts"), "utf8");
  assert(/import \{ exec \} from "node:child_process"/.test(merged), "canary: mechanizedMerge merges via in-process exec");
  assert(/execp\(|forge\.prMerge\(|forge\.prView\(/.test(merged), "…executing gh directly in-process");
  assert(!merged.includes("tool_call"), "the driver's merge path does not route through the bash tool_call hook");
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
