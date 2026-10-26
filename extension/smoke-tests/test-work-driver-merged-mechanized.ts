#!/usr/bin/env bun
/**
 * Smoke test for mechanized merge + checkout restoration (issue #323).
 *
 * Covers: deriveMergeMethod, executeAndVerifyMerge, mechanizedMerge,
 * restoreCheckout, inlineMergePrompt with mergeMethod parameter, and
 * runMerged's restoration reachability (#476). No real Pi spawn; mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type VerifyExecFn, restoreCheckout } from "../src/work-driver-git.ts";
import {
  deriveMergeMethod,
  executeAndVerifyMerge,
  mechanizedMerge,
} from "../src/work-driver-merged-mechanized.ts";
import { runMerged } from "../src/work-driver-merged.ts";
import { inlineMergePrompt } from "../src/work-driver-prompts-late.ts";
import { prMergeCmd as prMergeCmdCapture } from "../src/forge-commands.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { setupSpawnGuard } from "./test-helpers.ts";
import { mkStateMerged } from "./work-driver-merged-fixtures.ts";
// The exec/context builders are shared with test-work-driver-merged-pin.ts, the
// #1533 head-pin file split out of this one (§12 size cap): two copies would be
// two fixtures that can drift while both still pass.
import { HEAD_OID, mkCtx, mkExec, mkPi } from "./lib/work-driver-merged-pin-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
// #1533 — the merged step verifies the PR head before it merges, and that
// verification sits behind the same gate as the evidence read. Switching the
// gate off (as this file used to) also skipped the head check, so the pin tests
// below would have passed with the check deleted. The gate stays on and each
// merge fixture answers its `gh pr view` evidence probe green instead.
// process.env.PI_ENSEMBLE_MERGE_AUTHORITY = "0";
setupSpawnGuard();

// ---- deriveMergeMethod tests ----

{
  // Table: repo-view settings → derived method or fallback. Covers the full
  // priority ladder (squash > merge > rebase), the all-false and all-null
  // fallbacks, and the gh-throws fallback.
  const cases: { settings: string; err?: boolean; label: string; want: string }[] = [
    {
      settings: '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
      label: "squash preferred when all allowed",
      want: "squash",
    },
    {
      settings: '{"squashMergeAllowed":false,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
      label: "squash false, merge true → merge",
      want: "merge",
    },
    {
      settings: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}',
      label: "squash+merge false, rebase true → rebase",
      want: "rebase",
    },
    {
      settings:
        '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      label: "all false → fallback",
      want: "fallback",
    },
    {
      settings: '{"squashMergeAllowed":null,"mergeCommitAllowed":null,"rebaseMergeAllowed":null}',
      label: "all null → fallback",
      want: "fallback",
    },
    {
      settings: "",
      err: true,
      label: "gh throws → fallback",
      want: "fallback",
    },
  ];
  for (const c of cases) {
    const { fn } = mkExec(
      c.err
        ? { "gh repo view": { error: true, stderr: "network error" } }
        : { "gh repo view": { stdout: c.settings } },
    );
    const r = await deriveMergeMethod(fn, "/fake");
    assert(
      c.want === "fallback"
        ? "fallback" in r && r.fallback === true
        : "method" in r && r.method === c.want,
      `deriveMergeMethod: ${c.label}`,
    );
  }
}

// ---- executeAndVerifyMerge tests ----

{
  const { fn } = mkExec({ "gh pr view": { stdout: "MERGED\n" } });
  assert(
    (await executeAndVerifyMerge(123, "squash", fn, "/fake", undefined, HEAD_OID)).merged === true,
    "executeAndVerifyMerge: already merged → short-circuit",
  );
}
{
  const { fn } = mkExec({
    "gh pr view": { stdout: "MERGED\n" },
    "gh pr merge": { stdout: "Merged" },
  });
  assert(
    (await executeAndVerifyMerge(123, "squash", fn, "/fake", undefined, HEAD_OID)).merged === true,
    "executeAndVerifyMerge: merge + verify succeeds",
  );
}
{
  // Permanent gh failure (404-style "not found") on both pre-check and
  // post-verify: gh cannot resolve the PR at all, so this is NOT the
  // transient transport blip #356's merged-with-warning behaviour covers.
  // It must return ok:false so runMerged emits the plumb-report and falls
  // back to the LLM ops dispatch rather than reporting a false success.
  const { fn } = mkExec({
    "gh pr view": { error: true, stderr: "not found" },
    "gh pr merge": { stdout: "Merged" },
  });
  const r = await executeAndVerifyMerge(123, "squash", fn, "/fake", undefined, HEAD_OID);
  assert(
    "ok" in r && r.ok === false && /permanent gh error/.test(r.reason),
    "executeAndVerifyMerge: permanent post-verify failure → ok:false (NOT merged-with-warning)",
  );
}

{
  // #1533 — the adapter seam is the other half of the pin: the direct path is
  // pinned above, and production walks the adapter path. `executeAndVerifyMerge`
  // forwards the verified OID to `forge.prMerge`, which is where the command
  // bytes are built (test-forge-github.ts pins those); this asserts the OID
  // reaches that seam rather than being dropped on the way.
  const { fn } = mkExec({
    "gh pr view": { stdout: "OPEN\n" },
    "gh repo view": {
      stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    },
  });
  const forwarded: Array<string | undefined> = [];
  const fakeForge = {
    // #1533 — two reads, and the second is the post-merge verification. An
    // object-shaped `prView` is what the production path consumes; a fixture
    // that answered OPEN twice would be asserting a merge the step then
    // refused to trust.
    prView: async () => (forwarded.length === 0 ? { state: "OPEN" } : { state: "MERGED" }),
    // Argument order is the seam's own (number, headOid, method, subject):
    // #1533 moved the pin ahead of the optional arguments so it cannot be
    // omitted, and the assertion is that the OID ARRIVES there.
    prMerge: async (_n: number, oid?: string, _m?: string, _s?: string) => {
      forwarded.push(oid);
      return "Merged";
    },
  };
  const r = await executeAndVerifyMerge(
    123,
    "squash",
    fn,
    "/fake",
    undefined,
    HEAD_OID,
    async () => fakeForge as never,
  );
  assert(
    "merged" in r && r.merged === true,
    `#1533: adapter path merges (${JSON.stringify(r)})`,
  );
  assert(
    forwarded.length === 1 && forwarded[0] === HEAD_OID,
    `#1533: the verified head reaches forge.prMerge as the pin (${JSON.stringify(forwarded)})`,
  );
  // And the command those bytes produce is the accepted pinned form — built by
  // the same builder the adapter uses, not restated here as free-standing text.
  assert(
    prMergeCmdCapture("github", 123, HEAD_OID, "squash").includes(
      `--match-head-commit ${HEAD_OID}`,
    ),
    "#1533: the builder's adapter command carries the pin",
  );
}

// ---- inlineMergePrompt tests ----

{
  const p = inlineMergePrompt([100], 999, "squash", "/tmp/scratch", HEAD_OID);
  assert(p.includes("--squash --delete-branch"), "inlineMergePrompt: includes merge method");
  assert(!/adjust the flags/i.test(p), "inlineMergePrompt: escape clause removed");
  assert(!/AGENTS\.md|CONTRIBUTING\.md/i.test(p), "inlineMergePrompt: no doc refs");
  assert(
    p.includes(`--match-head-commit ${HEAD_OID}`),
    "inlineMergePrompt: the fallback carries the same head pin the mechanized path does",
  );
  assert(
    p.includes("Do NOT change either") &&
      p.includes("DO NOT re-run the merge without the pin"),
    "inlineMergePrompt: tells the agent not to drop or change the pin",
  );
}

// ---- restoreCheckout tests ----

{
  const { fn, calls } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { stdout: "" },
  });
  await restoreCheckout({ repoRoot: "/fake", mainline: "main", mergedBranch: "feature/issue-100", execFn: fn });
  const pfx = calls.map((c) => c.split(" ").slice(0, 2).join(" "));
  assert(
    JSON.stringify(pfx) ===
      JSON.stringify(["git fetch", "git checkout", "git status", "git pull", "git check-ref-format", "git branch"]),
    "restoreCheckout: fetch→checkout→status→pull→validate→branch -d (branch validated once, before -d)",
  );
  assert(
    calls[calls.length - 1]?.includes("git branch -d") && calls[calls.length - 1]?.includes("feature/issue-100"),
    "restoreCheckout: step 5 uses lowercase -d",
  );
}
{
  const { fn } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { error: true, stderr: "not fully merged" },
  });
  const notes = await restoreCheckout({ repoRoot: "/fake", mainline: "main", mergedBranch: "feature/issue-100", execFn: fn });
  assert(
    notes.some((n) => n.includes("branch -d")),
    "restoreCheckout: branch -d refusal → note, not fatal",
  );
}
{
  const { fn, calls } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "main\n" },
    "git pull": { stdout: "" },
  });
  await restoreCheckout({ repoRoot: "/fake", mainline: "main", mergedBranch: "feature/issue-100", execFn: fn });
  assert(
    calls.some((c) => c === "git checkout main --"),
    "restoreCheckout: checks out the target even when already on it",
  );
}

// ---- #476 — restoreCheckout reached on a successful merge ----
//
// The unit blocks above pin the command sequence but say nothing about
// REACHABILITY: runMerged used to gate restoration on ctx.verifyExecFn, a
// test-only seam neither production entry point sets, so on a real merge
// the checkout was never restored, refs never pruned, branch -d never
// attempted. This block drives runMerged with verifyExecFn injected as a
// recording fake: merge succeeds, restoration is observed (fetch origin
// --prune / checkout / pull --ff-only / branch -d), and a branch -d refusal
// lands in a `Checkout restoration` plumb-report rather than halting.
//
// The literal production shape — verifyExecFn absent, so the driver's
// `ctx.verifyExecFn ?? execp` fallback resolves to the real executor — is
// asserted in the -live sibling test-work-driver-merged-mechanized-prod-restore-live.ts,
// which cannot run offline (real execp shells out to git/gh).
{
  const dir = mkdtempSync(path.join(tmpdir(), "mm-prod-restore-"));
  try {
    const calls: string[] = [];
    const base = mkExec({
      // The mainline probe (#1093: a validated ref) must get the branch name;
      // the broader "gh repo view" key below answers the repo-settings query.
      "gh repo view --json defaultBranchRef": { stdout: "main\n" },
      // #1533 — the merge-evidence probe is a `gh pr view` too, and it PARSES
      // its answer: the generic "gh pr view" key below (a plain `MERGED` token,
      // for the pre/post-merge state reads) would otherwise make the gate fail
      // closed with "could not read PR state" before the merge was attempted.
      // Listing it first also means the state reads never see the JSON.
      "mergeStateStatus,mergeable,state": {
        stdout: `{"mergeStateStatus":"CLEAN","state":"OPEN","headRefOid":"${HEAD_OID}"}`,
      },
      "gh pr checks": { stdout: '[{"name":"ci","bucket":"pass"}]' },
      "gh repo view": {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      },
      // executeAndVerifyMerge checks `stdout.trim() === "MERGED"` on the
      // plain-text `--jq '.state'` output — answer with the plain token.
      "gh pr view": { stdout: "MERGED\n" },
      // The identity comparison needs a git common dir to read the review ledger
      // from; this fixture's directory is not a clone, so the read fails and the
      // check degrades to the pin plus an honest note (which is what the merged
      // step does for a state file with no clone behind it).
      "git rev-parse --git-common-dir": { error: true, stderr: "not a git repository" },
      "git fetch": { stdout: "" },
      "git rev-parse": { stdout: "feature/issue-476\n" },
      "git check-ref-format": { stdout: "" },
      "git status": { stdout: "" },
      "git checkout": { stdout: "" },
      "git pull": { stdout: "" },
      // The refusal is the point: a failed `branch -d` must become a
      // plumb-report, not a halt.
      "git branch -d": { error: true, stderr: "not fully merged" },
    });
    // The recorder is the driver's executor: every command it issues is
    // recorded, and any command the fakes above do not cover would touch
    // the outside world in production — throw instead.
    const recorder: VerifyExecFn = async (cmd, opts) => {
      // Argv calls (#1093) are recorded as the joined command line.
      const line = opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd;
      calls.push(line);
      try {
        return await base.fn(cmd, opts);
      } catch (err) {
        if (line.includes("git branch -d")) throw err;
        throw new Error(`offline test: unmocked command: ${line}`);
      }
    };

    // mkCtx supplies mergeGrant + issueBodyFetcherFn; only repoRoot and the
    // dispatchFn differ from that helper's defaults here.
    const ctx = mkCtx(476, recorder, {
      repoRoot: dir,
      dispatchFn: async () => {
        // The mechanized merge must succeed so the ops fallback dispatch
        // (a real Pi spawn) is never attempted.
        throw new Error("offline test: fallback dispatch should not be reached");
      },
    });

    const state = mkStateMerged(476, 4761, "feature/issue-476", {
      baseSha: "HEAD",
      worktrees: { task_b: "" },
    });
    const out = await runMerged(ctx, state, Date.now());

    assert(
      out.pipelineState.status === "merged",
      "#476: mechanized merge succeeded → status='merged'",
    );
    assert(
      calls.some((c) => c.includes("git fetch origin --prune")),
      "#476: fetch origin --prune ran on the successful-merge path",
    );
    assert(
      calls.some((c) => c.includes("git checkout")) &&
        calls.some((c) => c.includes("git pull --ff-only")),
      "#476: checkout + pull --ff-only ran on the successful-merge path",
    );
    const branchD = calls.find((c) => c.includes("git branch -d"));
    assert(
      branchD?.includes("feature/issue-476") === true,
      "#476: branch -d targeted the cycle's feature branch",
    );
    const notes = out.eventLog.filter(
      (e) => e.kind === "plumb-report" && /Checkout restoration: .*branch -d/.test(e.body),
    );
    assert(
      notes.length >= 1,
      "#476: branch -d refusal emitted as a plumb-report note (restoration reached)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- mechanizedMerge integration tests ----

{
  // #393 — the PI_ENSEMBLE_MECHANIZE_OPS=0 opt-out is deleted (it restored
  // the LLM-narrated merge behind the #245/#253 silent merges). Assert there
  // is NO knob left: mechanization is attempted unconditionally.
  const r = await mechanizedMerge(
    { repoRoot: "/fake", issue: 100, host: mkPi() } as DriverContext,
    { pipelineState: { prNumber: 999 } } as unknown as WorkState,
    HEAD_OID,
  );
  assert(
    r.ok === false && !/disabled|MECHANIZE_OPS/.test(r.reason),
    "mechanizedMerge is always ATTEMPTED — no env knob can switch it off",
  );
}
{
  // Happy path: squash derived from repo settings; first `gh pr view`
  // (pre-merge check) not-merged, second (post-merge verify) MERGED.
  const dir = mkdtempSync(path.join(tmpdir(), "mm-ok-"));
  try {
    let vc = 0;
    const base = mkExec({
      "gh pr merge": { stdout: "Merged" },
      "gh repo view": {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      },
    });
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        vc++;
        if (vc === 1)
          return Promise.reject(
            Object.assign(new Error("not merged yet"), { stderr: "not merged yet" }),
          );
        return { stdout: "MERGED\n" };
      }
      return base.fn(cmd);
    };
    const r = await mechanizedMerge({ repoRoot: dir, issue: 100, host: mkPi(), verifyExecFn: exec }, {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState, HEAD_OID);
    assert(
      r.ok === true && r.method === "squash",
      "mechanizedMerge: happy path squash from repo settings",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "mm-rebase-"));
  try {
    let mergeCmd = "";
    let vc = 0;
    const base = mkExec({
      "gh repo view": {
        stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}',
      },
    });
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        vc++;
        if (vc === 1)
          return Promise.reject(Object.assign(new Error("not merged"), { stderr: "not merged" }));
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("gh pr merge")) {
        mergeCmd = cmd;
        return { stdout: "Merged" };
      }
      return base.fn(cmd);
    };
    const r = await mechanizedMerge({ repoRoot: dir, issue: 100, host: mkPi(), verifyExecFn: exec }, {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState, HEAD_OID);
    assert(
      r.ok === true && r.method === "rebase",
      "mechanizedMerge: rebase derived from repo settings",
    );
    assert(
      mergeCmd.includes("--rebase"),
      "mechanizedMerge: derived method reaches gh pr merge --rebase",
    );
    // #1533 — the DIRECT-exec fallback builds its own command line, so it is
    // the path that would silently merge unpinned. The pin must be on it.
    assert(
      mergeCmd.includes(`--match-head-commit ${HEAD_OID}`),
      `#1533: the direct-path merge command carries the pin (--match-head-commit <verified head>): ${mergeCmd}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    },
  });
  const r = await mechanizedMerge(mkCtx(100, fn), {
    pipelineState: { prNumber: 999 },
  } as unknown as WorkState, HEAD_OID);
  assert(
    r.ok === false && r.reason.includes("no merge method permitted"),
    "mechanizedMerge: all methods false → fallback",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
