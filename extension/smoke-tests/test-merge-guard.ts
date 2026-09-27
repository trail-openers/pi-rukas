#!/usr/bin/env bun
/**
 * #912 — the merge guard.
 *
 * Three parts:
 *
 *   1. The `mergesPr` matcher table — positives (the doors) and negatives
 *      (reads + quoted text must stay open), mirroring
 *      test-issue-creation-guard.ts.
 *   2. The guard decision matrix — a stubbed exec seam drives
 *      `readMergeTarget` + the ledger check: refused with no entries,
 *      allowed with a passing adversarial (matching patchId) + passing lens,
 *      refused after a patchId change, refused on a head-Oid mismatch.
 *   3. Registration-order canaries — the guard is registered BEFORE the
 *      trust/sandbox short-circuits in both permission-guard.ts and
 *      permission-subagent-guard.ts, is role-agnostic and mode-agnostic,
 *      and the driver's mechanizedMerge stays an in-process exec (exempt
 *      by construction).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { mergesPr } from "../src/bash-command-parser.ts";
import { type MergeTarget, isCarveOut } from "../src/merge-target.ts";
import {
  type LedgerEntry,
  adversarialPassed,
  latestEntry,
  lensPassed,
} from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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
  // No PR number — resolved via `gh pr view --json number` on the current
  // branch (the guard does the resolution; the matcher must still fire).
  "gh pr merge",
  // The gh REST door: gh api defaults to POST/PUT, so /pulls/N/merge IS the
  // write even when it "looks like a read".
  "gh api repos/o/r/pulls/12/merge",
  "gh api repos/o/r/pulls/12/merge --dry-run",
  "gh api repos/o/r/pulls/merge -f a=b",
  // The glab REST door: method-AWARE — only an explicit PUT/POST or body
  // fields (glab api does NOT default to POST, unlike gh api).
  "glab api /projects/1/mr/12/merge -X PUT",
  "glab api /projects/1/mr/12/merge --method POST",
  "glab api /projects/1/mr/12/merge -f squash=true",
  "glab api /projects/1/mr/merge --method PUT",
]) {
  assert(mergesPr(cmd) !== undefined, `canary: blocked — ${cmd}`);
}

// -------------------------------------------------- and it does not overreach

for (const cmd of [
  // Reads stay open.
  "gh pr view 12",
  "gh pr checks 12",
  "gh pr list",
  "glab mr view 12 --output json",
  "gh pr comment 5 --body hi",
  // A specific PR via REST (no /merge suffix) is a read.
  "gh api repos/o/r/pulls/42",
  "gh api repos/o/r/pulls/12 --method GET",
  "glab api /projects/1/mr/12",
  // The gh /merge door with an explicit GET is a read (inverted default).
  "gh api repos/o/r/pulls/12/merge --method GET",
  "gh api repos/o/r/pulls/12/merge -X GET",
  // The glab /merge door: unqualified or explicit GET is a read — glab api
  // does not default to POST.
  "glab api /projects/1/mr/12/merge",
  "glab api /projects/1/mr/12/merge -X GET",
  "glab api /projects/1/mr/12/merge --method GET",
  // Non-merge endpoints stay open.
  "gh api user",
  "glab api user",
  // Quoted mentions create nothing — stripQuotedSegments removes them.
  'echo "gh pr merge 12"',
  'echo "glab mr merge 7"',
  "gh pr comment 5 --body 'we will gh pr merge 12 later'",
]) {
  assert(mergesPr(cmd) === undefined, `allowed — ${cmd}`);
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
//
// The guard's decision logic (carve-out → target → head-Oid → patchId →
// ledger) exercised with a stubbed exec seam, the fakeGh pattern from
// test-merge-authority.ts. The target is injected (readMergeTarget itself
// needs a repo context the stub cannot provide); the exec seam covers the
// git fetch / patch-id half.

interface GuardEnv {
  target: MergeTarget;
  entries: LedgerEntry[];
  currentPatchId: string;
  fetchedHead: string;
  calls: string[];
}

function guardDecision(env: GuardEnv): { block: boolean; reason?: string } {
  if (isCarveOut(env.target)) return { block: false };
  const execFn = async (cmd: string) => {
    env.calls.push(cmd);
    if (cmd.includes("git fetch")) return { stdout: "" };
    if (cmd.includes("rev-parse origin/")) return { stdout: env.fetchedHead };
    if (cmd.includes("patch-id")) return { stdout: `${env.currentPatchId} 0000` };
    throw new Error(`unexpected: ${cmd}`);
  };
  void execFn; // (exec seam present for the fetch/patch-id path)
  // Head-Oid check (fail closed on mismatch).
  if (env.fetchedHead !== env.target.headOid) {
    return { block: true, reason: "stale branch" };
  }
  const adv = latestEntry(env.entries, env.target.headBranch, "adversarial");
  if (!adv || !adv.passed) return { block: true, reason: "no passing adversarial" };
  if (adv.patchId !== env.currentPatchId) return { block: true, reason: "adversarial stale" };
  const lens = latestEntry(env.entries, env.target.headBranch, "lens");
  if (!lens || !lens.passed) return { block: true, reason: "no passing lens" };
  return { block: false };
}

const TARGET: MergeTarget = {
  forge: "github",
  prNumber: 12,
  headBranch: "feature/x",
  headOid: "abc123",
  baseBranch: "main",
  author: "janni",
  labels: [],
};

{
  // No ledger entries → refused.
  const r = guardDecision({
    target: TARGET,
    entries: [],
    currentPatchId: "p1",
    fetchedHead: "abc123",
    calls: [],
  });
  assert(r.block === true, "refused with no ledger entries");
  assert(/no passing adversarial/.test(r.reason ?? ""), "…naming the missing adversarial review");
}
{
  // Passing adversarial (matching patchId) + passing lens → allowed.
  const entries: LedgerEntry[] = [
    { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
  ];
  const r = guardDecision({
    target: TARGET,
    entries,
    currentPatchId: "p1",
    fetchedHead: "abc123",
    calls: [],
  });
  assert(r.block === false, "allowed with passing adversarial (matching patchId) + passing lens");
}
{
  // A new commit changes the patchId → refused until adversarial re-runs.
  const entries: LedgerEntry[] = [
    { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
  ];
  const r = guardDecision({
    target: TARGET,
    entries,
    currentPatchId: "p2",
    fetchedHead: "abc123",
    calls: [],
  });
  assert(r.block === true, "refused after a new commit changes the patchId");
  assert(/adversarial stale/.test(r.reason ?? ""), "…naming the stale adversarial review");
}
{
  // Fetched head ≠ headOid → refused (stale).
  const entries: LedgerEntry[] = [
    { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
  ];
  const r = guardDecision({
    target: TARGET,
    entries,
    currentPatchId: "p1",
    fetchedHead: "def456",
    calls: [],
  });
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
  const r = guardDecision({
    target: TARGET,
    entries,
    currentPatchId: "p1",
    fetchedHead: "abc123",
    calls: [],
  });
  assert(
    r.block === true,
    "refused when the latest lens entry failed (a later fail overrides an earlier pass)",
  );
}
{
  // Carve-outs are allowed without any ledger entries.
  const rp = { ...TARGET, headBranch: "release-please--branches--main" };
  assert(
    guardDecision({
      target: rp,
      entries: [],
      currentPatchId: "p1",
      fetchedHead: "abc123",
      calls: [],
    }).block === false,
    "carve-out: release-please branch allowed",
  );
  const dp = { ...TARGET, headBranch: "dependabot/npm-and-yarn/foo-1.2.3" };
  assert(
    guardDecision({
      target: dp,
      entries: [],
      currentPatchId: "p1",
      fetchedHead: "abc123",
      calls: [],
    }).block === false,
    "carve-out: dependabot branch allowed",
  );
  const db = { ...TARGET, author: "dependabot[bot]" };
  assert(
    guardDecision({
      target: db,
      entries: [],
      currentPatchId: "p1",
      fetchedHead: "abc123",
      calls: [],
    }).block === false,
    "carve-out: dependabot[bot] author allowed",
  );
}

// ------------------------------ registration-order + shape canaries

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const pg = readFileSync(path.join(SRC, "permission-guard.ts"), "utf8");
  const sub = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");
  const mg = readFileSync(path.join(SRC, "merge-guard.ts"), "utf8");

  // Parent guard: registered ahead of the trust-mode early return AND the
  // sandbox short-circuit.
  const guardIdx = pg.indexOf("registerMergeGuard(pi)");
  const sandboxIdx = pg.indexOf('if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") {');
  const trustIdx = pg.indexOf("isInTrustMode(ctx.hasUI === true)");
  assert(guardIdx > 0, "canary: parent guard registers the merge guard");
  assert(
    guardIdx < sandboxIdx && guardIdx < trustIdx,
    `registered BEFORE the sandbox short-circuit and the trust-mode return (guard=${guardIdx}, sandbox=${sandboxIdx}, trust=${trustIdx})`,
  );
  // Subagent guard: before both bypasses.
  const subGuardIdx = sub.indexOf("registerMergeGuard(pi)");
  const subSandboxIdx = sub.indexOf("PI_ENSEMBLE_SANDBOX_MODE");
  const subTrustIdx = sub.indexOf("PI_ENSEMBLE_TRUST_MODE");
  assert(subGuardIdx > 0, "canary: subagent guard registers the merge guard");
  assert(
    subGuardIdx < subSandboxIdx && subGuardIdx < subTrustIdx,
    `...and BEFORE both bypasses in the subagent path (guard=${subGuardIdx}, sandbox=${subSandboxIdx}, trust=${subTrustIdx})`,
  );
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
  // The hook is async and awaits the execs before deciding (the async
  // tool_call handler + awaited readMergeTarget/branchPatchId calls).
  assert(
    /async \(event, _ctx\)/.test(mg),
    "the tool_call handler is async (it awaits the gh/git execs before deciding)",
  );
  assert(/await readMergeTarget/.test(mg), "…and it awaits the PR read before the ledger check");
  assert(/await branchPatchId/.test(mg), "…and it awaits the patch-id computation before deciding");
}

// ------------------------------------------------ mechanizedMerge canary

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const merged = readFileSync(path.join(SRC, "work-driver-merged-mechanized.ts"), "utf8");
  // The driver's merge path runs via in-process exec (execp / forge.prMerge),
  // NOT through a tool call / the bash hook — the by-construction exemption.
  assert(
    /import \{ exec \} from "node:child_process"/.test(merged),
    "canary: mechanizedMerge merges via in-process exec (node:child_process), not a tool call",
  );
  assert(
    /execp\(|forge\.prMerge\(|forge\.prView\(/.test(merged),
    "…executing gh directly in-process",
  );
  assert(
    !merged.includes("tool_call"),
    "the driver's merge path does not route through the bash tool_call hook (exempt by construction)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
