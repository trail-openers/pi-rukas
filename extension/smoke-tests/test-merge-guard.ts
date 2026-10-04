#!/usr/bin/env bun
/**
 * #912 — the merge guard: matcher table, decision matrix, registration canaries.
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mergesPr } from "../src/bash-command-parser.ts";
import { type MergeTarget } from "../src/merge-target.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import {
  type LedgerEntry,
  adversarialPassed,
  ledgerPathFor,
  latestEntry,
  lensPassed,
} from "../src/review-ledger.ts";

// The hook reads the forge from PI_ENSEMBLE_FORGE (the detectForge hard
// override) so the decision matrix below runs offline, without a real remote.
process.env.PI_ENSEMBLE_FORGE = "github";

// The ledger file the decision matrix writes — resolved via the module under
// test (ledgerPathFor) so the writer and the guard can never disagree on the
// path. The env override below points it at a private temp file BEFORE the
// resolution, so the real per-clone ledger under the git common dir is never
// touched; the temp dir is removed at the end. The round-cap block below
// (appended after the canaries) also relies on the override, so it runs
// BEFORE the teardown.
let LEDGER_FILE: string | undefined;
let LEDGER_TMP_DIR: string | undefined;

async function setupLedgerPath() {
  LEDGER_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-ledger-"));
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(
    LEDGER_TMP_DIR,
    "review-ledger.json",
  );
  const realExec = async (cmd: string) => ({
    stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
  });
  const p = await ledgerPathFor(realExec, import.meta.dirname);
  if (!p) throw new Error("cannot resolve the ledger path for the decision matrix");
  LEDGER_FILE = p;
  // Canary: the ledger must NOT live inside any .git directory — that would
  // clobber the real per-clone review ledger shared by every worktree.
  assert(
    !/([/\\])\.git([/\\]|$)/.test(p),
    "canary: the test ledger is not inside a .git directory",
  );
}

function teardownLedger() {
  if (LEDGER_TMP_DIR) {
    try {
      rmSync(LEDGER_TMP_DIR, { recursive: true, force: true });
    } catch (err) {
      console.error(`⚠ could not remove the ledger temp dir: ${(err as Error).message}`);
    }
  }
}

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

/** Save/restore the shared ledger around a row so the matrix is side-effect-free. */
async function withLedger(entries: LedgerEntry[], fn: () => Promise<unknown>) {
  const file = LEDGER_FILE;
  if (!file) throw new Error("ledger path not resolved — call setupLedgerPath() first");
  const saved = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  })();
  try {
    writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
  } catch (err) {
    throw new Error(`cannot write test ledger at ${file}: ${(err as Error).message}`);
  }
  const done = () => {
    try {
      if (saved === null) {
        if (existsSync(file)) unlinkSync(file);
      } else {
        writeFileSync(file, saved, "utf8");
      }
    } catch (err) {
      console.error(`⚠ could not restore the ledger at ${file}: ${(err as Error).message}`);
    }
  };
  try {
    return await fn();
  } finally {
    done();
  }
}

/** Register the real guard on a fake pi and drive it through `opts.execFn`. */
async function makeHook(env: {
  target: MergeTarget;
  currentPatchId: string;
  fetchedHead: string;
  calls: string[];
  failFetch?: boolean;
  failGh?: boolean;
  ledgerCommonDir?: string;
}): Promise<(event: unknown, ctx: unknown) => Promise<unknown>> {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (name === "tool_call") handler = fn;
    },
  } as never;
  const t = env.target;
  const ghView = {
    stdout: JSON.stringify({
      headRefName: t.headBranch,
      headRefOid: t.headOid,
      baseRefName: t.baseBranch,
      author: { login: t.author },
      labels: t.labels.map((n) => ({ name: n })),
    }),
  };
  const execFn = async (cmd: string): Promise<{ stdout: string }> => {
    env.calls.push(cmd);
    if (cmd.includes("gh pr view")) {
      if (cmd.includes("--json number")) {
        return { stdout: JSON.stringify({ number: t.prNumber }) };
      }
      if (env.failGh) throw new Error("gh: not found");
      if (cmd.includes("--json comments")) {
        if (env.ghComments === undefined) {
          // No comments stubbed → the comments read is unreadable (fail
          // closed): the disclosure marker cannot be verified, so the
          // round-cap path refuses and the guard falls back to the strict
          // rule's refusal.
          throw new Error("gh: comments not stubbed");
        }
        return { stdout: env.ghComments };
      }
      return ghView;
    }
    if (cmd.includes("git fetch")) {
      if (env.failFetch) throw new Error("unable to connect");
      return { stdout: "" };
    }
    // Remote resolution: origin → upstream → first remote.
    if (cmd.includes("git config --get remote.origin.url")) {
      if (env.remote === "origin") return { stdout: "git@github.com:o/r.git\n" };
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.upstream.url")) {
      if (env.remote === "upstream") return { stdout: "git@github.com:o/r.git\n" };
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.")) {
      return { stdout: "" };
    }
    if (cmd.includes("git remote")) {
      return { stdout: env.remote + "\n" };
    }
    if (cmd.includes(`rev-parse ${env.remote}/`)) return { stdout: env.fetchedHead };
    if (cmd.includes("patch-id")) return { stdout: `${env.currentPatchId} 0000` };
    if (cmd.includes("git-common-dir")) {
      return { stdout: env.ledgerCommonDir ?? "" };
    }
    throw new Error(`unexpected exec: ${cmd}`);
  };
  registerMergeGuard(fakePi, { execFn });
  if (!handler) throw new Error("the merge guard did not register a tool_call handler");
  return handler;
}

async function hookDecision(
  command: string,
  entries: LedgerEntry[],
  opts: {
    target?: MergeTarget;
    patchId?: string;
    fetchedHead?: string;
    failGh?: boolean;
    failFetch?: boolean;
    ledgerCommonDir?: string;
    remote?: string;
    ghComments?: string;
  } = {},
) {
  const env = {
    target: opts.target ?? TARGET,
    currentPatchId: opts.patchId ?? "p1",
    fetchedHead: opts.fetchedHead ?? "abc123",
    failGh: opts.failGh,
    failFetch: opts.failFetch,
    ledgerCommonDir: opts.ledgerCommonDir ?? (LEDGER_FILE ? path.dirname(LEDGER_FILE) : ""),
    calls: [] as string[],
    remote: opts.remote ?? "origin",
    ghComments: opts.ghComments,
  };
  const handler = await makeHook(env);
  const r = await withLedger(entries, () =>
    handler({ toolName: "bash", input: { command } }, undefined as never),
  );
  return {
    block: r?.block === true,
    reason: (r as { reason?: string } | undefined)?.reason,
    calls: env.calls,
  };
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

const GOOD_ENTRIES: LedgerEntry[] = [
  { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
  { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
];

await setupLedgerPath();

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
    r.calls.some(
      (c) => c.includes("git diff origin/main..origin/feature/x") && c.includes("patch-id"),
    ),
    "…after computing the patch-id over the PR's actual base",
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
  const carveTargets: Array<[string, MergeTarget, boolean]> = [
    ["dependabot[bot] author", { ...TARGET, author: "dependabot[bot]" }, false],
    ["app/dependabot author", { ...TARGET, author: "app/dependabot" }, false],
    ["dependabot/ branch alone", { ...TARGET, headBranch: "dependabot/npm-and-yarn/foo-1.2.3" }, true],
    ["release-please branch + label", { ...TARGET, headBranch: "release-please--branches--main", labels: ["autorelease: pending"] }, false],
    ["release-please branch + bot author", { ...TARGET, headBranch: "release-please--branches--main", author: "release-please[bot]" }, false],
    ["release-please branch alone", { ...TARGET, headBranch: "release-please--branches--main" }, true],
  ];
  for (const [label, target, expectBlock] of carveTargets) {
    const r = await hookDecision("gh pr merge 12", [], { target });
    if (expectBlock) assert(r.block === true, `carve-out: ${label} is NOT a carve-out (bot ID required)`);
    else {
      assert(r.block === false, `carve-out: ${label} allowed`);
      assert(!r.calls.some((c) => c.includes("patch-id")), `carve-out: ${label} does not reach the ledger check`);
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

// ------------------------------------------------- the #973 round-cap path
// The guard's strict rule (latest lens entry passed) is refused; the
// round-cap path is then consulted. Each condition below is exercised in
// turn: every failing condition produces a refusal naming it, and all
// conditions met allows the merge. CRITICAL never allows; a legacy entry
// (no hasCritical) never satisfies the no-CRITICAL condition; a stale
// marker (different patch) is a refusal; the escape hatch restores the
// strict rule.
//
// The comments stub is the guard's comment read (design decision 5 — the
// guard's own exec call, `gh pr view N --json comments`). A `ghComments`
// stub of `undefined` makes the read throw (fail closed → no marker →
// refusal), which is the shape the "no comments on the PR" cases use.

{
  const ADV = {
    branch: "feature/x",
    kind: "adversarial" as const,
    patchId: "p1",
    passed: true,
    at: 1,
  };
  const lens = (over: Partial<LedgerEntry> & { at: number }): LedgerEntry => ({
    branch: "feature/x",
    kind: "lens",
    patchId: "p1",
    passed: false,
    detail: "ISSUES_FOUND",
    hasCritical: false,
    round: 3,
    ...over,
  });
  const commentsWith = (branch: string, patch: string) =>
    JSON.stringify({
      comments: [
        {
          body:
            `residual findings\n<!-- pi-rukas:lens-residuals branch=${branch} patch=${patch} -->`,
        },
      ],
    });
  const NO_COMMENTS = JSON.stringify({ comments: [] });
  const MARKER_BRANCH = "feature/x";
  const MARKER_PATCH = "p1";

  // All conditions met → allowed (the strict rule refuses; the round-cap
  // path allows).
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2 })], {
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
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2, detail: "REVIEW_INCOMPLETE" })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a REVIEW_INCOMPLETE entry is not ISSUES_FOUND → refused");
    assert(/not ISSUES_FOUND/.test(r.reason ?? ""), "…naming the verdict condition");
  }
  // Condition 1 (verdict): CRITICAL_ISSUES_FOUND never allows, even with a
  // marker (the round-cap rule mirrors the driver's cap: CRITICAL always
  // refuses).
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2, detail: "CRITICAL_ISSUES_FOUND", hasCritical: true, round: 5 })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: CRITICAL_ISSUES_FOUND is never allowed");
    assert(/not ISSUES_FOUND/.test(r.reason ?? ""), "…naming the verdict condition");
  }
  // Condition 3: hasCritical is missing (legacy entry) → refused, naming it.
  {
    const legacy = {
      branch: "feature/x",
      kind: "lens" as const,
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      round: 3,
    };
    const r = await hookDecision("gh pr merge 12", [ADV, legacy], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a legacy entry without hasCritical cannot satisfy no-CRITICAL");
    assert(/hasCritical/.test(r.reason ?? ""), "…naming the missing hasCritical field");
  }
  // Condition 3: hasCritical is true → refused.
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2, hasCritical: true })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: hasCritical=true → refused");
    assert(/hasCritical/.test(r.reason ?? ""), "…naming the hasCritical condition");
  }
  // Condition 4: round below 3 → refused, naming the round.
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2, round: 2 })], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: round 2 < 3 → refused");
    assert(/round 2/.test(r.reason ?? ""), "…naming the round condition");
  }
  // Condition 4: a legacy entry without `round` counts as round 1 → refused.
  {
    const legacyNoRound = {
      branch: "feature/x",
      kind: "lens" as const,
      patchId: "p1",
      passed: false,
      at: 2,
      detail: "ISSUES_FOUND",
      hasCritical: false,
    };
    const r = await hookDecision("gh pr merge 12", [ADV, legacyNoRound], {
      ghComments: commentsWith(MARKER_BRANCH, MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a legacy entry without `round` counts as round 1 → refused");
    assert(/round 1/.test(r.reason ?? ""), "…naming the round condition");
  }
  // Condition 5: no marker comment → refused, naming the disclosure.
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: NO_COMMENTS,
    });
    assert(r.block === true, "round-cap: no disclosure marker on the PR → refused");
    assert(/no disclosure marker/.test(r.reason ?? ""), "…naming the disclosure condition");
  }
  // Condition 5: a marker for a STALE patch → refused (the marker's patch
  // must equal the guard's current patch-id).
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: commentsWith(MARKER_BRANCH, "pOLD"),
    });
    assert(r.block === true, "round-cap: a marker for a stale patch → refused");
    assert(/no disclosure marker/.test(r.reason ?? ""), "…naming the disclosure condition");
  }
  // Condition 5: a marker for a DIFFERENT branch → refused.
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2 })], {
      ghComments: commentsWith("feature/other", MARKER_PATCH),
    });
    assert(r.block === true, "round-cap: a marker for a different branch → refused");
    assert(/no disclosure marker/.test(r.reason ?? ""), "…naming the disclosure condition");
  }
  // The comments read is unreadable (no stub) → fail closed → refused.
  {
    const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2 })]);
    assert(r.block === true, "round-cap: an unreadable comments read fails closed → refused");
  }
  // The strict rule still applies when the round-cap path does not apply
  // (latest lens entry passed → allowed via the strict rule, no comments
  // read needed).
  {
    const r = await hookDecision("gh pr merge 12", [
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
      const r = await hookDecision("gh pr merge 12", [ADV, lens({ at: 2 })], {
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

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
