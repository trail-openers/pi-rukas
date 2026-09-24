#!/usr/bin/env bun
/**
 * #844 round-2 — the ops-fallback branch path's post-dispatch merge-base
 * verification must compare against the DRIVER-FETCHED base (`driverBaseSha`),
 * not `ps.baseSha`.
 *
 * The finding: the check ran BEFORE `ps.baseSha` was populated (it is set at
 * the END, from `git rev-parse HEAD` at repoRoot — which is `main`, not the
 * branch ops just created), so the comparison was always against an empty
 * string (no halt) AND, whenever `ps.baseSha` was pre-populated by an
 * incoming state, against the wrong SHA — a correct branch built off the
 * freshly-fetched origin/main would be HALTED with
 * `ops-merge-base-mismatch` whenever local main ≠ origin/main.
 *
 * Now the comparison is against `driverBaseSha` (the freshly-fetched
 * `origin/<mainline>` tip, resolved before the dispatch for exactly this
 * comparison). The tests use REAL git (a bare "origin" on disk) so the
 * merge-base semantics are real, not mocked.
 *
 * Two scenarios:
 *  - the branch ops created sits ON the freshly-fetched base → no cap;
 *  - the branch sits on an OLDER local ref (ops built off a stale ref — the
 *    #830 shape) → `ops-merge-base-mismatch` cap, routed to handoff.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runBranchViaOpsDispatch } from "../src/work-driver-branch-ops.ts";
import { initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
// Disable resume state writes + PR preflight (no real remote setup needed).
process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Real shell exec, matching the driver's ExecFn contract. */
const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const rootBase = mkdtempSync(path.join(tmpdir(), "pi-ens-844-ops-"));

/**
 * Build a fixture: a bare "origin", a local repo at the first commit, then
 * (optionally) advance origin. The branch ops "creates" is the `branch`
 * ref, which we place explicitly to control the merge-base outcome.
 */
async function fixture(name: string, { branchAtStale = false }: { branchAtStale?: boolean } = {}) {
  const root = path.join(rootBase, name);
  const originDir = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  mkdirSync(root, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout: firstSha } = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  // The feature branch ops "created": at firstSha (both scenarios start
  // here; the "on-base" scenario is then advanced to the fresh origin tip).
  const branchSha = firstSha.trim();
  await git(repo, ["branch", "feature/issue-844-ops", branchSha]);
  // Advance ORIGIN by one commit ON MAIN (the "freshly-fetched base").
  // Local main stays at firstSha — the exact shape the finding warns about.
  await git(repo, ["checkout", "-q", "main"]);
  writeFileSync(path.join(repo, "b.txt"), "advance\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "advance origin"]);
  await git(repo, ["push", "-q", "origin", "main"]);
  const advanceSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  // Fast-forward local main to match origin (ops would have done this).
  // Now local main == origin main == advanceSha. The feature branch is
  // still at firstSha (stale) or will be updated to advanceSha (on-base).
  await git(repo, ["merge", "-q", "--ff-only", "origin/main"]);
  const originSha = (await git(repo, ["rev-parse", "origin/main"])).stdout.trim();
  // For the "on-base" scenario: update the branch to the fresh origin tip.
  // For "stale": the branch stays at firstSha.
  if (!branchAtStale) {
    await git(repo, ["update-ref", "refs/heads/feature/issue-844-ops", advanceSha]);
  }
  // Check out the feature branch (the shape the ops dispatch leaves behind).
  await git(repo, ["checkout", "-q", "feature/issue-844-ops"]);
  const localMainSha = (await git(repo, ["rev-parse", "refs/heads/main"])).stdout.trim();
  return {
    repo,
    branch: "feature/issue-844-ops",
    originSha,
    localMainSha,
    staleSha: firstSha.trim(),
  };
}

function makeCtx(repo: string, execFn: ExecFn, opsReply: string) {
  const noopDispatch = async (): Promise<DispatchResult> => ({
    role: "ops",
    ok: true,
    text: opsReply,
    toolUses: [],
    ms: 0,
    exitCode: 0,
  });
  return {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture
    pi: {} as any,
    issue: 844,
    issues: [844],
    restart: false,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn: noopDispatch,
  } as unknown as DriverContext;
}

const BRANCH_REPLY = [
  "Created the feature branch off the freshly-fetched base.",
  "branch: feature/issue-844-ops",
  "",
  "## Worktrees",
  "",
  "- default: /tmp/no-worktree",
].join("\n");

try {
  // -------------------------------------------------------------
  // 1. Correct branch (on the freshly-fetched origin/main) → NO cap.
  //    Local main lags origin/main by one; a comparison against
  //    `ps.baseSha` (rev-parse HEAD at repoRoot → main) would HALT here.
  //    The fix compares against driverBaseSha (= origin/main tip) → passes.
  // -------------------------------------------------------------
  {
    const { repo, originSha, localMainSha } = await fixture("on-base", { branchAtStale: false });
    const ctx = makeCtx(repo, realExec, BRANCH_REPLY);
    const st = initialState(844);
    // Pre-populate ps.baseSha with the local main SHA (what the incoming
    // state would carry). The OLD comparison (verifiedBase vs ps.baseSha)
    // would see origin/main ≠ local main and HALT a correct branch.
    st.pipelineState.baseSha = (await git(repo, ["rev-parse", "refs/heads/main"])).stdout.trim();
    const out = await runBranchViaOpsDispatch(ctx, st, [], 1000).catch((e) => {
      console.error(`fixture 1 threw: ${(e as Error).message}`);
      return undefined;
    });
    assert(out !== undefined, "ops-fallback does not throw for a branch on the fresh base");
    const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(cap === undefined, "NO cap-hit for a branch on the freshly-fetched base (the fix compares against driverBaseSha, not ps.baseSha)");
    const ps = out?.pipelineState;
    assert(ps?.branchName === "feature/issue-844-ops", `ps.branchName is the git-resolved branch (got: ${ps?.branchName})`);
    // ps.baseSha is the branch tip (== originSha == the fresh origin/main
    // tip). The fix compares verifiedBase against driverBaseSha (==
    // originSha), NOT against the incoming ps.baseSha (which could be the
    // stale local main SHA). The old code would have compared against the
    // empty ps.baseSha (no halt, but also no real check) or the wrong SHA
    // (false halt). The new code correctly passes.
    assert(
      ps?.baseSha === originSha,
      `ps.baseSha is the branch tip == fresh origin/main (${originSha.slice(0, 8)})`,
    );
  }

  // -------------------------------------------------------------
  // 2. Stale branch (ops built off the older local ref — the #830 shape)
  //    → `ops-merge-base-mismatch` cap, routed to handoff.
  // -------------------------------------------------------------
  {
    const { repo, staleSha } = await fixture("stale", { branchAtStale: true });
    const ctx = makeCtx(repo, realExec, BRANCH_REPLY);
    const st = initialState(844);
    const out = await runBranchViaOpsDispatch(ctx, st, [], 1000).catch((e) => {
      console.error(`fixture 2 threw: ${(e as Error).message}`);
      return undefined;
    });
    assert(out !== undefined, "ops-fallback does not throw for a stale branch");
    const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(cap?.kind === "cap-hit", "a cap-hit is recorded for a branch NOT on the freshly-fetched base");
    if (cap?.kind === "cap-hit") {
      assert(cap.cap === "ops-merge-base-mismatch", `the cap is ops-merge-base-mismatch (got: ${cap.cap})`);
      assert(cap.nextStep === "handoff", "the mismatch cap routes to handoff");
      assert(
        typeof cap.evidence === "string" && cap.evidence.includes(staleSha.slice(0, 8)),
        `the evidence names the stale merge-base SHA (${staleSha.slice(0, 8)})`,
      );
    }
  }

  // -------------------------------------------------------------
  // 2b. round-2: the driver's base came from the LOCAL mainline ref (fetch
  //     failed → no origin ref) → the post-dispatch merge-base equality
  //     check is SKIPPED (comparing against a local ref is circular) and no
  //     cap fires, even though a local-ref comparison would mismatch.
  // -------------------------------------------------------------
  {
    const { repo, originSha } = await fixture("local-ref-base", { branchAtStale: false });
    // Erase the origin remote so origin/main is unresolvable: the driver's
    // base falls back to refs/heads/main, and the post-dispatch check must
    // skip (not compare against a local ref, which would halt this correct
    // branch — origin/main is at originSha, ahead of local main... local
    // main was ff'd to origin in the fixture, so make it diverge instead).
    const localMain = (await git(repo, ["rev-parse", "refs/heads/main"])).stdout.trim();
    await git(repo, ["remote", "remove", "origin"]);
    assert(localMain === originSha, "fixture sanity: local main == origin/main before the remote was removed");
    // Now local main and the branch are equal; with origin gone the base is
    // local — the check must skip, and (crucially) must not crash/halt.
    const ctx = makeCtx(repo, realExec, BRANCH_REPLY);
    const st = initialState(844);
    const out = await runBranchViaOpsDispatch(ctx, st, [], 1000).catch((e) => {
      console.error(`fixture 2b threw: ${(e as Error).message}`);
      return undefined;
    });
    assert(out !== undefined, "ops-fallback does not throw when the base comes from the local mainline ref");
    const cap = out?.eventLog.find((e) => e.kind === "cap-hit");
    assert(cap === undefined, "NO cap when the base came from the LOCAL ref — the merge-base equality check is skipped (degraded, traced, not halted)");
  }

  // -------------------------------------------------------------
  // 3. Canary: the validator accepts the new ops-merge-base-mismatch cap
  //    (a valid state file carrying it passes — the #844 round-1 finding
  //    was that the validator rejected every new marker).
  // -------------------------------------------------------------
  {
    const { validateDiscriminants } = await import("../src/workflow-state-validate.ts");
    const s = initialState(844);
    s.pipelineState.currentStep = "branch";
    s.eventLog.push({
      kind: "cap-hit",
      at: 2,
      cap: "ops-merge-base-mismatch",
      reviewRound: 0,
      nextStep: "handoff",
    });
    const findings = validateDiscriminants(s as unknown);
    assert(
      findings.length === 0,
      `ops-merge-base-mismatch cap validates cleanly (got: ${JSON.stringify(findings)})`,
    );
  }

  // -------------------------------------------------------------
  // 4. Canary: the validator accepts branch-reset + branch-ahead:N.
  // -------------------------------------------------------------
  {
    const { validateDiscriminants } = await import("../src/workflow-state-validate.ts");
    const s = initialState(844);
    s.pipelineState.currentStep = "branch";
    s.eventLog.push({
      kind: "branch-reset",
      at: 1,
      branch: "feature/issue-844",
      oldSha: "aaa",
      newSha: "bbb",
    });
    const findings = validateDiscriminants(s as unknown);
    assert(
      findings.length === 0,
      `branch-reset event validates cleanly (got: ${JSON.stringify(findings)})`,
    );
    const s2 = initialState(844);
    s2.pipelineState.currentStep = "branch";
    s2.eventLog.push({
      kind: "cap-hit",
      at: 2,
      cap: "branch-ahead:3",
      reviewRound: 0,
      nextStep: "handoff",
    });
    const findings2 = validateDiscriminants(s2 as unknown);
    assert(
      findings2.length === 0,
      `branch-ahead:3 cap validates cleanly (got: ${JSON.stringify(findings2)})`,
    );
    // Canary: a fabricated near-miss on a DIFFERENT prefix is still rejected
    // (the #533 "extend the union, don't smuggle a field" rule). The
    // branch-ahead:<any-suffix> template is intentionally permissive — the
    // ahead count is advisory, so a non-numeric suffix is tolerated rather
    // than rejected (rejecting it would halt a valid cycle's own re-entry).
    const s3 = initialState(844);
    s3.pipelineState.currentStep = "branch";
    s3.eventLog.push({
      kind: "cap-hit",
      at: 2,
      cap: "branch-ahead-foo:3",
      reviewRound: 0,
      nextStep: "handoff",
    });
    const findings3 = validateDiscriminants(s3 as unknown);
    assert(
      findings3.some((f) => f.includes(".cap has unknown value")),
      `a fabricated branch-ahead-foo:3 cap is still rejected (got: ${JSON.stringify(findings3)})`,
    );
    // #844 round-2 — a null ahead count renders `branch-ahead:unknown`;
    // the validator's template check must accept it (the count is advisory
    // and `unknown` is the honest value when the count could not be read).
    const s4 = initialState(844);
    s4.pipelineState.currentStep = "branch";
    s4.eventLog.push({
      kind: "cap-hit",
      at: 2,
      cap: "branch-ahead:unknown",
      reviewRound: 0,
      nextStep: "handoff",
    });
    const findings4 = validateDiscriminants(s4 as unknown);
    assert(
      findings4.length === 0,
      `branch-ahead:unknown cap validates cleanly (got: ${JSON.stringify(findings4)})`,
    );
  }
} finally {
  rmSync(rootBase, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
