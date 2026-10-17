#!/usr/bin/env bun
/**
 * commit-pr ends with an OPEN pull request recorded in state, or with a halt
 * that says why there is none — and it says what it did while it worked.
 *
 * orchard#97, 2026-10-13: the step ran 515 s and wrote nothing at all between
 * "running step commit-pr" and "running step lens-review". It had in fact
 * verified the consolidated tree (the project's 8.5-minute gate), pushed and
 * opened PR #107 — but a successful mechanized commit-pr traced none of it, so
 * when the PR was merged by hand during the lens review and the residuals post
 * then found "no open PR/MR for branch …", the log read as a step that had
 * produced no pull request.
 *
 *  1. The shape of that cycle — an earlier PR for the same head branch closed
 *     unmerged, a fresh `--restart` state with no PR number — opens a NEW PR,
 *     records its number, and traces the verify, the push and the number.
 *  2. A PR that does not resolve as OPEN on the cycle's branch halts the step
 *     with the evidence; it is never reported as done.
 *  3. No PR at all (create failed, the ops fallback opened none) halts too.
 *  4. #1240 — when the commit-pr consolidated verify SKIPPED its run (the
 *     committed integration tree is the tree develop already judged), the skip
 *     is named in the step's operator-facing summary AND recorded as a
 *     `consolidated-verify-skipped` event — both are produced by
 *     `finalizeCommitPrState`, which is what the mechanized path writes.
 *
 * Offline: real git in temp dirs, a scripted `gh`, no network, no model.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// `trace` reads the flag at import time, so it is set before the modules load.
process.env.PI_ENSEMBLE_DEBUG = "1";
process.env.PI_ENSEMBLE_FORGE = "github";
const { runCommitPr } = await import("../src/work-driver-commit.ts");
const { finalizeCommitPrState } = await import("../src/work-driver-commit-pr-events.ts");
const { initialState } = await import("../src/workflow-state.ts");
const { addLocalRemote, fixture, git, mkResult } = await import(
  "./helpers-integrate-pin-realgit.ts"
);
// Production's executor: driver git calls use the argv form, which the
// helper's `sh -c` executor ignores (it would turn them into a bare `git`).
const { execp: realExec } = await import("../src/exec.ts");
const { commandOf } = await import("./lib/argv-shell.ts");
type DriverContext = import("../src/work-driver-context.ts").DriverContext;
type WorkState = import("../src/workflow-state.ts").WorkState;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "pi-ens-commit-pr-reports-"));
const ISSUE = 97;
const BRANCH = "feature/issue-97-x";
const OLD_PR = 104; // the earlier cycle's PR on the same head: closed unmerged
const NEW_PR = 107;

/** How the scripted forge answers once this cycle's PR is asked for. */
type Forge = { create: "ok" | "fails"; state: "OPEN" | "CLOSED" };

async function run(name: string, forge: Forge) {
  const { repo } = await fixture(root, name);
  mkdirSync(path.join(repo, ".pi"));
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), "test -f feature.txt\n");
  await git(repo, ["add", ".pi/verify-cmd"]);
  await git(repo, ["commit", "-q", "-m", "gate"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await addLocalRemote(root, repo);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  // #1240 — the worktree is left with UNSTAGED residue after its commit: no
  // tree object describes it, so no identity can be established and the
  // commit-pr verify must still run. That run is what the trace assertion
  // below observes; a worktree that cleanly matched the integration would
  // legitimately skip it, and the assertion would fail for the right reason.
  const wt = path.join(repo, ".worktrees", `issue-${ISSUE}-default`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "feature.txt"), "feature\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "developer: feature"]);
  // Unstaged, uncommitted edit: keeps the worktree's tree identity undefined
  // (see the note above), so the commit-pr gate cannot be skipped here.
  writeFileSync(path.join(wt, "scratch-unstaged.txt"), "not staged\n");

  let created = false;
  const gh: string[] = [];
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (raw, o) => {
    const cmd = commandOf(raw, o);
    if (!cmd.startsWith("gh ")) return realExec(raw, o);
    gh.push(cmd);
    // OLD_PR is closed, so an open-PR list by head never returns it.
    if (cmd.startsWith("gh pr list")) {
      const open = created && forge.state === "OPEN";
      return { stdout: JSON.stringify(open ? [{ number: NEW_PR, headRefName: BRANCH }] : []) };
    }
    if (cmd.startsWith("gh pr view")) {
      const n = cmd.includes(String(OLD_PR)) ? OLD_PR : NEW_PR;
      const state = n === OLD_PR ? "CLOSED" : forge.state;
      return { stdout: JSON.stringify({ number: n, state, headRefName: BRANCH }) };
    }
    // The fixture's origin has no HEAD ref, so the mainline comes from the forge.
    if (cmd.startsWith("gh repo view")) return { stdout: "main\n" };
    if (cmd.startsWith("gh pr create")) {
      if (forge.create === "fails") throw new Error("pull request create failed: GraphQL error");
      created = true;
      return { stdout: `https://github.com/o/r/pull/${NEW_PR}\n` };
    }
    return { stdout: "" };
  };
  const ctx = {
    host: {},
    repoRoot: repo,
    issue: ISSUE,
    verifyExecFn: exec,
    // The ops fallback, when the mechanized path hands over: it opens nothing.
    dispatchFn: async () => mkResult({ role: "ops", text: "I could not open a pull request." }),
  } as unknown as DriverContext;
  const base = initialState(ISSUE, 1000);
  const initial: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      branchName: BRANCH,
      baseSha,
      worktrees: { default: wt },
    },
  };

  const traced: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    traced.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let state: WorkState;
  try {
    state = await runCommitPr(ctx, initial, 2000);
  } finally {
    process.stderr.write = realWrite;
  }
  const pushed = await git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${BRANCH}`])
    .then((r) => r.stdout.trim())
    .catch(() => "");
  const tail = state.eventLog[state.eventLog.length - 1];
  return { state, tail, gh, pushed, log: traced.join("") };
}

// ------------------ 1. an earlier PR for this head was closed; fresh state
{
  const r = await run("closed-earlier-pr", { create: "ok", state: "OPEN" });
  assert(
    r.gh.some((g) => g.startsWith("gh pr create")),
    "a closed earlier PR on the same head does not stand in for this cycle's — a new one is created",
  );
  assert(
    r.state.pipelineState.prNumber === NEW_PR,
    `the new PR's number is recorded in state (${r.state.pipelineState.prNumber})`,
  );
  assert(r.tail?.kind === "dispatch-completed", "…and the step ends done, with no cap");
  assert(
    /commit-pr — verifying the consolidated tree before the push: test -f feature\.txt/.test(r.log),
    "the step says it is running the project's gate before the minutes that takes",
  );
  assert(
    r.pushed !== "" && r.log.includes(`pushed ${BRANCH} @ ${r.pushed.slice(0, 8)}`),
    "…says what it pushed, and at which commit",
  );
  assert(
    r.log.includes(`commit-pr — opened PR #${NEW_PR} for ${BRANCH}`),
    "…and names the pull request it opened",
  );
}

// ------------------------------- 2. the created PR is not OPEN on the branch
{
  const r = await run("pr-not-open", { create: "ok", state: "CLOSED" });
  assert(
    r.tail?.kind === "cap-hit" && r.tail.cap === "verify-failed:commit-pr",
    `a PR that is not OPEN halts commit-pr (${r.tail?.kind})`,
  );
  assert(
    (r.state.pipelineState.verifyEvidence?.failures ?? []).some(
      (f) => f.includes(`#${NEW_PR}`) && f.includes("CLOSED"),
    ),
    "…and the evidence names the PR and its state",
  );
}

// ------------------------------------------------ 3. no PR was opened at all
{
  const r = await run("no-pr", { create: "fails", state: "OPEN" });
  assert(
    r.tail?.kind === "cap-hit" && r.tail.nextStep === "handoff",
    `no PR at all halts commit-pr (${r.tail?.kind}${r.tail?.kind === "cap-hit" ? ` ${r.tail.cap}` : ""})`,
  );
  assert(r.state.pipelineState.prNumber === undefined, "…with no PR number recorded");
  assert(
    r.log.includes("mechanized commit-pr fell back to ops dispatch") &&
      r.log.includes("pull request create failed"),
    "…and the log carries what the forge answered",
  );
  assert(
    (r.state.pipelineState.verifyEvidence?.failures ?? []).some((f) => /no PR exists/.test(f)),
    "…and the evidence says no PR exists for the branch",
  );
}

// ------------- 4. #1240 — the commit-pr skip is visible in the state finalizeCommitPrState writes
{
  // The mechanized path's own event builder, driven with the integrate()
  // result the skip seam produces. Both halves of "never silent" are asserted
  // here because BOTH are produced by this one function: the event (which is
  // what survives in the state file) and the summary line (which is what an
  // operator reads when commit-pr came back fast). The negative control is the
  // same call with no `verifySkipped` — a run that happened must claim no skip.
  const { initialState: init } = await import("../src/workflow-state.ts");
  const base = init(ISSUE, 1000);
  const res = {
    ok: true as const,
    empty: false as const,
    workstreams: ["default"],
    verifySkipped: {
      treeHash: "a".repeat(40),
      worktree: "/tmp/wt-issue-1299-default",
    },
  };
  const rootInspect = { ok: false as const, error: "root inspect not exercised here" };
  const skipped = finalizeCommitPrState(
    base,
    2000,
    1500,
    ["default"],
    BRANCH,
    NEW_PR,
    res as never,
    rootInspect as never,
    undefined,
  );
  const skipEvents = skipped.eventLog.filter((e) => e.kind === "consolidated-verify-skipped");
  assert(
    skipEvents.length === 1 &&
      skipEvents[0]?.kind === "consolidated-verify-skipped" &&
      skipEvents[0].step === "commit-pr" &&
      skipEvents[0].workstreamCount === 1 &&
      skipEvents[0].treeHash === "a".repeat(40),
    `#1240: a skipped commit-pr verify records a consolidated-verify-skipped event, step commit-pr (${JSON.stringify(skipEvents)})`,
  );
  const completion = [...skipped.eventLog].reverse().find((e) => e.kind === "dispatch-completed");
  assert(
    completion?.kind === "dispatch-completed" &&
      (completion.summary as string).includes("consolidated verify skipped") &&
      (completion.summary as string).includes("a".repeat(40)) &&
      (completion.summary as string).includes("/tmp/wt-issue-1299-default"),
    `#1240: the same skip is named in the step summary the operator reads (${JSON.stringify((completion as { summary?: string } | undefined)?.summary)})`,
  );
  const ran = finalizeCommitPrState(
    base,
    2000,
    1500,
    ["default"],
    BRANCH,
    NEW_PR,
    { ...res, verifySkipped: undefined } as never,
    rootInspect as never,
    undefined,
  );
  assert(
    !ran.eventLog.some((e) => e.kind === "consolidated-verify-skipped"),
    "#1240 (control): a commit-pr that RAN the verify records no skip event",
  );
  const ranCompletion = [...ran.eventLog].reverse().find((e) => e.kind === "dispatch-completed");
  assert(
    ranCompletion?.kind === "dispatch-completed" &&
      !(ranCompletion.summary as string).includes("consolidated verify skipped"),
    `#1240 (control): …and its summary claims no skip (${JSON.stringify((ranCompletion as { summary?: string } | undefined)?.summary)})`,
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
