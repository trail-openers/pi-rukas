#!/usr/bin/env bun
/**
 * #1064 — one rule for the consolidated-verify tree label: the CONSOLIDATED
 * wording is used only when there is more than one workstream.
 *
 * Five cycles parked with `verify-failed:develop` on a SINGLE `default`
 * workstream while the failure said the verify command failed "on the
 * CONSOLIDATED tree". For one workstream the probe combines nothing — its tree
 * IS that workstream's own tree — so the sentence described a combination that
 * did not happen and sent the operator hunting for an interaction between
 * workstreams where there is no second one to be between.
 *
 * What this pins, and what it deliberately does NOT:
 *   · the label switches on the WORKSTREAM COUNT, not on whether the
 *     consolidated run executed (at N=1 it still runs — the dirty-root refusal
 *     must fire even when the combined tree is trivially the one worktree);
 *   · at N=1 `failures[]` and the rendered handoff both name the workstream's
 *     own tree and never say CONSOLIDATED;
 *   · at N>1 the CONSOLIDATED wording stands byte for byte;
 *   · the classification tag, the specific assertion, the attribution and the
 *     reason are IDENTICAL across the two shapes — only the location clause
 *     moves, so nothing downstream (cap routing, the classifier, the flake
 *     precondition, ok/notes) can observe the change.
 *
 * The N>1 live-git guard lives in test-work-driver-verify-consolidated.ts
 * (#669 case 1) and is not duplicated here.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCommitPrConsolidatedVerify } from "../src/work-driver-integrate-verify.ts";
import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "../src/work-driver-consolidation-classify.ts";
import { reportConsolidatedVerifyOutcome } from "../src/work-driver-consolidated-verify-report.ts";
import type { ConsolidatedVerifyResult } from "../src/work-driver-consolidated-verify-types.ts";
import { consolidatedTreeClause } from "../src/work-driver-consolidated-verify-label.ts";
import { commandOf } from "./lib/argv-shell.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CMD = "bash scripts/verify.sh";
const WT = "/w/issue-7-default";
const REPO = "/repo";
const RAW = "running 3 tests\n✗ expected 1 to be 2\nFAILED: 1 test(s) — a::b\n";

// ---------------------------------------------------------------- 1: the rule
// The single function every consolidated label composes its tree clause from.
{
  assert(
    consolidatedTreeClause({ workstreamCount: 1, cwd: WT, at: REPO }) ===
      `in the single workstream's own tree at ${WT}`,
    "N=1: the clause names the workstream's own tree, not the probe's checkout",
  );
  assert(
    consolidatedTreeClause({ workstreamCount: 2, cwd: WT, at: REPO }) ===
      `on the CONSOLIDATED tree at ${REPO}`,
    "N>1: the CONSOLIDATED clause stands, word for word as before the fix",
  );
  assert(
    !consolidatedTreeClause({ workstreamCount: 1, cwd: WT, at: REPO }).includes("CONSOLIDATED"),
    "N=1: the clause carries no CONSOLIDATED wording at all",
  );
}

// ------------------------------------------------- 2: the message, both shapes
// The classifier's own verdict, rendered at each count. The comparison is the
// acceptance criterion: strip the location clause and the two messages are the
// same string, which is what makes this a label change and nothing else.
{
  const verdict = classifyConsolidatedVerifyFailure(1, ["default"], RAW, {}, RAW);
  const single = consolidatedFailureMessage(
    verdict,
    CMD,
    consolidatedTreeClause({ workstreamCount: 1, cwd: WT, at: REPO }),
  );
  const multi = consolidatedFailureMessage(verdict, CMD, "on the CONSOLIDATED tree");

  assert(
    !single.includes("CONSOLIDATED tree"),
    `N=1: the failures[] line carries no CONSOLIDATED wording (got: ${single.slice(0, 200)})`,
  );
  assert(
    single.includes(`failed in the single workstream's own tree at ${WT}`),
    `N=1: the line names the workstream's own tree (got: ${single.slice(0, 200)})`,
  );
  assert(multi.includes("failed on the CONSOLIDATED tree"), "N>1: the CONSOLIDATED wording stands");

  // The two clauses are the only difference between the two renderings.
  const normalised = (s: string) =>
    s
      .replace(`failed in the single workstream's own tree at ${WT}`, "<TREE>")
      .replace("failed on the CONSOLIDATED tree", "<TREE>");
  assert(
    normalised(single) === normalised(multi),
    "the classification tag, the assertion, the attribution and the reason are identical across counts",
  );
  assert(
    single.startsWith(`[${verdict.classification}]`),
    `N=1: the classifier tag still leads the line (got: ${single.slice(0, 60)})`,
  );
  // The assertion clause is checked in `single` (above) and its exact content
  // here: this verdict was classified from the clipped tail, where only the
  // `FAILED:` summary line survives the marker anchor.
  assert(
    verdict.assertion === "✗ expected 1 to be 2" ||
      (verdict.namedFailures ?? []).some((l) => l.includes("a::b")),
    "N=1: the failing test the operator needs is still there",
  );
  assert(
    single.includes("✗ expected 1 to be 2") && single.includes("the verify command failed:"),
    `N=1: the rendered line keeps the classifier's assertion clause verbatim (got: ${single.slice(0, 220)})`,
  );
}

// -------------------------------------- 3: the reporter, which builds failures[]
// Through the real reporter, so the label that lands in `failures[]` (and
// therefore in the handoff) is the one the rule produces — not a unit test of a
// string the seam never prints.
async function failedGate(count: number, singleWorktree?: string) {
  const worktrees: Record<string, string> =
    count === 1 ? { default: WT } : { a: "/w/a", b: "/w/b" };
  const cons = {
    status: "failed",
    detail: "verify failed",
    rawFailure: RAW,
    applied: Object.keys(worktrees),
  } as unknown as ConsolidatedVerifyResult;
  const failures: string[] = [];
  const notes: string[] = [];
  reportConsolidatedVerifyOutcome(cons, {
    cmd: CMD,
    failures,
    notes,
    timeoutMs: 900_000,
    ctx: { repoRoot: REPO },
    worktrees,
    perWorktreeFailuresByWs: {},
    singlePerWs: undefined,
    singlePerAssertion: undefined,
    ...(singleWorktree !== undefined ? { singleWorktree } : {}),
  });
  return { failures, notes };
}

const single = await failedGate(1, WT);
const multi = await failedGate(2);
{
  const all = single.failures.join("\n");
  assert(single.failures.length > 0, "N=1: the consolidated failure is still recorded");
  assert(
    !all.includes("CONSOLIDATED tree"),
    `#1064: the N=1 failures[] entry never says CONSOLIDATED tree (got: ${all.slice(0, 240)})`,
  );
  assert(
    single.failures.some((f) => f.includes(`in the single workstream's own tree at ${WT}`)),
    `N=1: the failures[] entry names the workstream's own tree (got: ${all.slice(0, 240)})`,
  );
  assert(
    !all.includes(REPO),
    `N=1: the label does not point the operator at the probe's checkout (got: ${all.slice(0, 240)})`,
  );
  const m = multi.failures.join("\n");
  assert(
    multi.failures.some((f) => f.includes(`on the CONSOLIDATED tree at ${REPO}`)),
    `N>1: the CONSOLIDATED wording is unchanged (got: ${m.slice(0, 240)})`,
  );
  // The clause is the whole difference: the bare `on the CONSOLIDATED tree` the
  // classifier's default renders and the qualified `at <repoRoot>` the reporter
  // appends must both be present, so a change that drops either is caught.
  assert(
    multi.failures.some((f) => f.includes("on the CONSOLIDATED tree")),
    "N>1: the bare CONSOLIDATED clause is intact as well as the qualified one",
  );
  // ok/notes and the classification the gate routes on must not move.
  assert(
    single.notes.join("\n") === multi.notes.join("\n"),
    "the notes are identical across counts — only the failure label differs",
  );
  const tag = (fs: string[]) => (fs[0] ?? "").match(/^\[[a-z-]+\]/)?.[0];
  // The classification tag the CAP ROUTER reads must be the classifier's own
  // verdict for the shape it was handed — the reporter must not overwrite it and
  // must not let the label change nudge it. N=1 can never be
  // `consolidation-created` (nothing combined), and the tag is asserted at the
  // message level in section 2, where the same verdict is rendered at both
  // counts and only the tree clause moves.
  assert(
    tag(single.failures) === "[needs-human-decision]",
    `N=1: the tag is the classifier's own verdict for one workstream (got: ${tag(single.failures)})`,
  );
  assert(
    tag(multi.failures) === "[consolidation-created]",
    `N>1: the tag is the classifier's own verdict for a combination (got: ${tag(multi.failures)})`,
  );
}

// --------------------------------------------- 4: a killed run keeps the shape
// The timeout branch composes its own sentence (`verifyTimeoutFailure`), so the
// rule has to reach it too — and the `[verify-timeout]` marker the cap router
// keys on must survive the swap.
{
  const killed = (count: number, singleWorktree?: string) => {
    const worktrees: Record<string, string> =
      count === 1 ? { default: WT } : { a: "/w/a", b: "/w/b" };
    const cons = {
      status: "failed",
      detail: "killed",
      rawFailure: RAW,
      timedOut: true,
      applied: Object.keys(worktrees),
    } as unknown as ConsolidatedVerifyResult;
    const failures: string[] = [];
    reportConsolidatedVerifyOutcome(cons, {
      cmd: CMD,
      failures,
      notes: [],
      timeoutMs: 900_000,
      ctx: { repoRoot: REPO },
      worktrees,
      perWorktreeFailuresByWs: {},
      singlePerWs: undefined,
      singlePerAssertion: undefined,
      ...(singleWorktree !== undefined ? { singleWorktree } : {}),
    });
    return failures.join("\n");
  };
  const s1 = killed(1, WT);
  const s2 = killed(2);
  assert(
    s1.includes("[verify-timeout]") &&
      s1.includes(`timeout in the single workstream's own tree at ${WT}`) &&
      !s1.includes("CONSOLIDATED"),
    `N=1 timeout: the killed run names its own tree and keeps the timeout marker (got: ${s1.slice(0, 200)})`,
  );
  assert(
    s2.includes("[verify-timeout]") && s2.includes(`timeout on the CONSOLIDATED tree at ${REPO}`),
    `N>1 timeout: the killed run keeps the CONSOLIDATED clause (got: ${s2.slice(0, 200)})`,
  );
}

// ------------------------------------------- 5: no tree to name → no N=1 claim
// A caller that supplies no single worktree has nothing to make the per-tree
// claim about. The rule must then keep the CONSOLIDATED wording rather than
// print a path nobody named: a label that invented one would be the same class
// of misdirection as the one #1064 removes.
{
  const noTree = await failedGate(1);
  assert(
    noTree.failures.some((f) => f.includes(`on the CONSOLIDATED tree at ${REPO}`)),
    `N=1 with no tree supplied: the CONSOLIDATED wording stands rather than an unnamed tree (got: ${(noTree.failures[0] ?? "").slice(0, 200)})`,
  );
  assert(
    !noTree.failures.some((f) => f.includes("single workstream's own tree")),
    "N=1 with no tree supplied: no per-tree claim is invented for a tree nobody named",
  );
}

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const sh = (cwd: string, cmd: string) =>
  execFileP("/bin/sh", ["-c", cmd], { cwd }).then((r) => ({ stdout: r.stdout }));
const root = mkdtempSync(path.join(tmpdir(), "pi-consolidated-label-"));
type Outcome = { ok: true } | { ok: false; stdout: string; killed?: boolean };

/** A stub executor: git runs for real, the verify command gets a chosen outcome. */
function stubExec(
  outcomeFor: (cmd: string) => Outcome,
): NonNullable<import("../src/work-driver-context.ts").DriverContext["verifyExecFn"]> {
  return async (cmdArg, o) => {
    const cmd = commandOf(cmdArg, o);
    if (cmd.startsWith("git ")) return sh(o?.cwd ?? "", cmd);
    const r = outcomeFor(cmd);
    if (r.ok) return { stdout: "" };
    const e = new Error(`Command failed: ${cmd}`) as Error & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    e.stdout = r.stdout;
    e.stderr = "";
    e.killed = r.killed;
    throw e;
  };
}

/** A repo with one worktree holding one commit ahead of base — the N=1 shape. */
async function makeRepo(name: string) {
  const repo = path.join(root, name, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const wt = path.join(repo, ".worktrees", "issue-9-default");
  await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "change.txt"), "new\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "change"]);
  writeFileSync(path.join(repo, ".git", "info", "exclude"), ".worktrees/\ntmp/\n");
  return { repo, wt, baseSha };
}

// ---------------------------------- 6: the commit-pr seam shares the same rule
// #1064 is one rule for the whole driver, so the commit-pr consolidated seam
// (`runCommitPrConsolidatedVerify`) labels the same way — it is the site where an
// operator reads the line in that step's own summary. These runs differ ONLY in
// the workstream shape, so the pair pins the switch on both message paths the
// seam produces: the classified failure and the killed-run timeout clause. Real
// git fixture, real function; the fast tier of #1324 is pinned in
// test-verify-fast-tier.ts.
{
  const { repo, wt } = await makeRepo("commit-pr-label");
  const run = (opts: {
    workstreamCount: number;
    workstreamIds: string[];
    singleWorktree?: string;
    killed?: boolean;
  }) =>
    runCommitPrConsolidatedVerify(
      stubExec((c) =>
        c === CMD
          ? { ok: false, stdout: opts.killed ? "" : "✗ a.ts: expected 1\n", killed: opts.killed }
          : { ok: true },
      ),
      {
        verifyCmd: CMD,
        repoRoot: repo,
        workstreamCount: opts.workstreamCount,
        workstreamIds: opts.workstreamIds,
        timeoutMs: 900_000,
        ...(opts.singleWorktree !== undefined ? { singleWorktree: opts.singleWorktree } : {}),
      },
    );
  const single = await run({ workstreamCount: 1, workstreamIds: ["default"], singleWorktree: wt });
  assert(
    single.ok === false &&
      !single.classifiedMessage.includes("CONSOLIDATED tree") &&
      single.classifiedMessage.includes(`failed in the single workstream's own tree at ${wt}`),
    `commit-pr N=1: the failure names the workstream's own tree, not a CONSOLIDATED tree (got: ${single.ok ? "" : single.classifiedMessage.slice(0, 240)})`,
  );
  const singleKilled = await run({
    workstreamCount: 1,
    workstreamIds: ["default"],
    singleWorktree: wt,
    killed: true,
  });
  assert(
    singleKilled.ok === false &&
      singleKilled.timedOut === true &&
      !singleKilled.classifiedMessage.includes("CONSOLIDATED tree") &&
      singleKilled.classifiedMessage.includes(
        `timeout in the single workstream's own tree at ${wt}`,
      ),
    `commit-pr N=1 timeout: the killed run's clause names the workstream's own tree too (got: ${singleKilled.ok ? "" : singleKilled.classifiedMessage.slice(0, 240)})`,
  );
  const pair = await run({ workstreamCount: 2, workstreamIds: ["a", "b"] });
  assert(
    pair.ok === false && pair.classifiedMessage.includes(`on the CONSOLIDATED tree at ${repo}`),
    `commit-pr N>1: the CONSOLIDATED wording stands (got: ${pair.ok ? "" : pair.classifiedMessage.slice(0, 240)})`,
  );
  const pairKilled = await run({ workstreamCount: 2, workstreamIds: ["a", "b"], killed: true });
  assert(
    pairKilled.ok === false &&
      pairKilled.classifiedMessage.includes(`timeout on the CONSOLIDATED tree at ${repo}`),
    `commit-pr N>1 timeout: the killed run keeps the CONSOLIDATED clause (got: ${pairKilled.ok ? "" : pairKilled.classifiedMessage.slice(0, 240)})`,
  );
}

process.exit(
  (() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* a scratch dir we could not remove is not a failed assertion */
    }
    return exit;
  })(),
);
