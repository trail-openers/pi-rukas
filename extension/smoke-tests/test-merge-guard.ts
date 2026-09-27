#!/usr/bin/env bun
/**
 * #912 — the merge guard: matcher table, decision matrix, registration canaries.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
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
// path.
let LEDGER_FILE: string | undefined;

async function setupLedgerPath() {
  const realExec = async (cmd: string) => ({
    stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
  });
  const p = await ledgerPathFor(realExec, import.meta.dirname);
  if (!p) throw new Error("cannot resolve the ledger path for the decision matrix");
  LEDGER_FILE = p;
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
  "gh api repos/o/r/pulls/12/merge -X get",
  // The glab /merge door: unqualified or explicit GET is a read.
  "glab api /projects/1/mr/12/merge",
  "glab api /projects/1/mr/12/merge -X GET",
  "glab api /projects/1/mr/12/merge --method GET",
  "glab api /projects/1/merge_requests/12/merge",
  "glab api /projects/1/merge_requests/12/merge --method GET",
  // A direct push to the base branch is not a forge merge (git-level control).
  "git push origin HEAD:main",
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
  const sub = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");
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
  // Subagent guard: before both bypasses.
  const subGuardIdx = sub.indexOf("registerMergeGuard(pi)");
  const subSandboxIdx = sub.indexOf("PI_ENSEMBLE_SANDBOX_MODE");
  const subTrustIdx = sub.indexOf("PI_ENSEMBLE_TRUST_MODE");
  assert(subGuardIdx > 0, "canary: subagent guard registers the merge guard");
  assert(subGuardIdx < subSandboxIdx && subGuardIdx < subTrustIdx, "subagent: before both bypasses");
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

console.log(`\nexit ${exit}`);
process.exit(exit);
