#!/usr/bin/env bun
/**
 * #1768 — a develop pass is done only when the child COMMITTED its own work.
 *
 * The defect: both green-path call sites (work-develop-topological.ts `runAt`,
 * work-develop-dependent.ts) ran the #622 safety net BEFORE the commits-ahead
 * check. A child that exited 0 mid-step with a dirty worktree and no commit had
 * its dirt committed by the driver, and that driver commit then satisfied
 * `commits > 0` — so unfinished work was reported as `agent done: developer` and
 * rode into verify (orchard #507: `test/review_test.sh` never written; orchard #439:
 * the net's commit was the only copy of the change).
 *
 * Six cases, each against a REAL git worktree with real commits and real dirt
 * (argv-honouring executor via lib/exec-fake.ts — never a shell-only fake):
 *
 *   1. exit-0, dirty, no commits, corrective pass also unfinished → the
 *      `develop-incomplete-uncommitted` cap names the paths, the net never
 *      commits, `rev-list --count base..HEAD` is 0, exactly two dispatches, and
 *      the dirty files are still present when the second dispatch starts;
 *   2. the corrective pass commits → green;
 *   3. the child committed AND left leftovers → green, one dispatch, unchanged;
 *   4. 0 commits, clean tree → the existing downgrade, unchanged;
 *   5. unreadable status → not green;
 *   6. the cap is registered on every published surface.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXED_CAPS } from "../src/headless/caps.ts";
import { FAILURE_KINDS, failureOf } from "../src/headless/failure.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  DEVELOP_INCOMPLETE_UNCOMMITTED,
  parkUnfinishedDevelop,
  requireOwnCommit,
} from "../src/work-develop-own-commit.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import { initialState, type WorkState } from "../src/workflow-state.ts";
import { isKnownCap } from "../src/workflow-state-validate-caps.ts";
import { realExec } from "./lib/exec-fake.ts";
import { ensureGitIdentity, gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

ensureGitIdentity();
const dir = await mkdtemp(path.join(tmpdir(), "pi-own-commit-"));

/** One child result; the own-commit check only needs its shape. */
const okResult = (): DispatchResult =>
  ({ role: "developer", ok: true, text: "Status: done", toolUses: [] }) as DispatchResult;

const countAhead = (wt: string, base: string): string =>
  gitIn(wt, ["rev-list", "--count", `${base}..HEAD`]);
const commitCount = (wt: string): string => gitIn(wt, ["rev-list", "--count", "HEAD"]);

/** A worktree at base with `paths` written but NOT committed: the shape the
 *  child leaves behind when it quits mid-step. */
async function dirtyWorktree(
  id: string,
  paths: string[],
): Promise<{ wt: string; base: string }> {
  const shas = await makeBaseWorktrees(dir, [id]);
  const wt = path.join(dir, ".worktrees", id);
  for (const p of paths) {
    const full = path.join(wt, p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `work in ${p}\n`);
  }
  return { wt, base: shas[id] ?? "" };
}

// ---------------------------------------------------------------- case 1
// exit-0, dirty, no commit of its own, corrective pass also unfinished.
{
  const { wt, base } = await dirtyWorktree("c1", ["src/a.ts", "test/a_test.ts"]);
  const before = commitCount(wt);
  const prompts: string[] = [];
  const startedWith: string[][] = [];
  let dispatches = 0;
  // The step's OWN developer ran first (the pass that exited 0 mid-step); this
  // closure is the second. Two dispatches total, which is the whole corrective
  // budget: a third would be the driver hoping a third time.
  dispatches++;
  const outcome = await requireOwnCommit({
    id: "c1",
    cwd: wt,
    base,
    execFn: realExec,
    corrective: async (paths) => {
      dispatches++;
      // The dirt is still there — no reset, no clean, the work is preserved.
      startedWith.push(paths);
      prompts.push("dispatched");
      return okResult();
    },
  });
  assert(dispatches === 2, `1: exactly two dispatches — the pass and one corrective (${dispatches})`);
  assert(
    outcome.kind === "unfinished",
    `1: the pass is UNFINISHED, not green (got ${outcome.kind})`,
  );
  assert(
    outcome.kind === "unfinished" &&
      outcome.uncommitted.join(",") === "src/a.ts,test/a_test.ts",
    `1: the uncommitted paths are named (${outcome.kind === "unfinished" ? outcome.uncommitted.join(",") : "-"})`,
  );
  assert(
    existsSync(path.join(wt, "src/a.ts")) && existsSync(path.join(wt, "test/a_test.ts")),
    "1: the dirty files are still present when the corrective pass ran and after it",
  );
  assert(
    startedWith[0]?.join(",") === "src/a.ts,test/a_test.ts",
    `1: the corrective dispatch was told the paths it must finish (${JSON.stringify(startedWith[0])})`,
  );
  assert(prompts.length === 1, "1: the corrective pass was dispatched once, not repeatedly");
  assert(
    countAhead(wt, base) === "0",
    `1: nothing was committed by anyone — the net never fired (${countAhead(wt, base)})`,
  );
  assert(commitCount(wt) === before, "1: the worktree's commit count is unchanged");

  // The park the develop step lands on for this outcome.
  let state = initialState(1768);
  const parked = parkUnfinishedDevelop(state, new Map([["c1", ["src/a.ts", "test/a_test.ts"]]]), 1768);
  assert(parked !== undefined, "1: the step parks");
  state = parked ?? state;
  const tail = state.eventLog[state.eventLog.length - 1];
  assert(
    tail?.kind === "cap-hit" && tail.cap === DEVELOP_INCOMPLETE_UNCOMMITTED,
    `1: the cap is ${DEVELOP_INCOMPLETE_UNCOMMITTED} (got ${tail?.kind}/${tail && "cap" in tail ? tail.cap : "-"})`,
  );
  assert(
    tail?.kind === "cap-hit" &&
      (tail.evidence ?? "").includes("src/a.ts") &&
      (tail.evidence ?? "").includes("test/a_test.ts"),
    `1: the cap evidence names the paths (${tail?.kind === "cap-hit" ? tail.evidence : "-"})`,
  );
  assert(
    tail?.kind === "cap-hit" && tail.nextStep === "handoff",
    "1: the cap routes to handoff",
  );
  assert(
    nextStep(state).kind === "step" && nextStep(state).step === "handoff",
    `1: nextStep routes the cycle to handoff (${JSON.stringify(nextStep(state))})`,
  );
  // The safety net is NOT what fixes this: given the same tree it would have
  // committed it, which is exactly the behaviour #1768 removes from the green path.
  const net = await safetyNetWorktree("c1", dir, wt, base, realExec, []);
  assert(net?.kind === "safety-net-commit", "1: (control) the net would still commit this tree");
}

// ---------------------------------------------------------------- case 2
// The corrective pass commits → the pass is green.
{
  const { wt, base } = await dirtyWorktree("c2", ["src/b.ts"]);
  const outcome = await requireOwnCommit({
    id: "c2",
    cwd: wt,
    base,
    execFn: realExec,
    corrective: async () => {
      gitIn(wt, ["add", "src/b.ts"]);
      gitIn(wt, ["commit", "-qm", "finish the work"]);
      return okResult();
    },
  });
  assert(outcome.kind === "green", `2: the corrective commit makes it green (got ${outcome.kind})`);
  assert(countAhead(wt, base) === "1", "2: one commit of the child's own ahead of its base");
}

// ---------------------------------------------------------------- case 3
// The child committed AND left leftovers → green, no corrective dispatch.
{
  const { wt, base } = await dirtyWorktree("c3", ["leftover.ts"]);
  gitIn(wt, ["commit", "--allow-empty", "-qm", "the child's own seam commit"]);
  let dispatches = 0;
  const outcome = await requireOwnCommit({
    id: "c3",
    cwd: wt,
    base,
    execFn: realExec,
    corrective: async () => {
      dispatches++;
      return okResult();
    },
  });
  assert(
    outcome.kind === "own-work",
    `3: commits of its own means own work — the caller's green path is unchanged (got ${outcome.kind})`,
  );
  assert(dispatches === 0, "3: no corrective dispatch — the child committed");
  const net = await safetyNetWorktree("c3", dir, wt, base, realExec, []);
  assert(net === undefined, "3: the net still refuses to extend the child's commit (leftovers noted)");
}

// ---------------------------------------------------------------- case 4
// 0 commits and a clean tree → the existing downgrade path applies unchanged.
{
  const shas = await makeBaseWorktrees(dir, ["c4"]);
  const wt = path.join(dir, ".worktrees", "c4");
  let dispatches = 0;
  const outcome = await requireOwnCommit({
    id: "c4",
    cwd: wt,
    base: shas["c4"],
    execFn: realExec,
    corrective: async () => {
      dispatches++;
      return okResult();
    },
  });
  assert(
    outcome.kind === "unchanged",
    `4: 0 commits + clean → unchanged, so GREEN_DOWNGRADE applies (got ${outcome.kind})`,
  );
  assert(dispatches === 0, "4: nothing to finish, so no corrective dispatch");
}

// ---------------------------------------------------------------- case 5
// An unreadable status is never read as clean or green.
{
  const shas = await makeBaseWorktrees(dir, ["c5"]);
  const wt = path.join(dir, ".worktrees", "c5");
  // A real worktree whose index is corrupted: `git status` fails for real.
  writeFileSync(path.join(wt, ".git", "index"), "not an index file at all\n");
  const outcome = await requireOwnCommit({
    id: "c5",
    cwd: wt,
    base: shas["c5"],
    execFn: realExec,
    corrective: async () => okResult(),
  });
  assert(
    outcome.kind === "unfinished",
    `5: an unreadable status is not-ok, never green (got ${outcome.kind})`,
  );
  assert(
    outcome.kind === "unfinished" && /unreadable/.test(outcome.reason),
    `5: the reason names the unreadable read (${outcome.kind === "unfinished" ? outcome.reason.slice(0, 90) : "-"})`,
  );
  // An unreadable COMMIT count likewise never reads as green.
  const bad = await requireOwnCommit({
    id: "c5",
    cwd: wt,
    base: "not-a-sha",
    execFn: realExec,
    corrective: async () => okResult(),
  });
  assert(
    bad.kind === "unfinished" && /unreadable/.test(bad.kind === "unfinished" ? bad.reason : ""),
    `5: an unusable base is not-ok, never green (${bad.kind})`,
  );
}

// ---------------------------------------------------------------- case 6
// The cap is registered on every published surface.
{
  const src = path.join(import.meta.dirname, "..", "src");
  const read = (rel: string) => readFileSync(path.join(src, rel), "utf8");
  assert(
    (FIXED_CAPS as readonly string[]).includes(DEVELOP_INCOMPLETE_UNCOMMITTED),
    "6: the cap is in the published fixed-cap vocabulary (headless/caps FIXED_CAPS)",
  );
  assert(
    isKnownCap(DEVELOP_INCOMPLETE_UNCOMMITTED),
    "6: the state validator knows the cap (workflow-state-validate-caps)",
  );
  assert(
    read("workflow-state-events-caps.ts").includes(
      `| "${DEVELOP_INCOMPLETE_UNCOMMITTED}"`,
    ),
    "6: the cap is in the WorkEvent cap-hit union (workflow-state-events-caps)",
  );
  assert(
    read("work-driver-cause-table.ts").includes(`"${DEVELOP_INCOMPLETE_UNCOMMITTED}"`) &&
      /cls: "change"/.test(
        read("work-driver-cause-table.ts").split(`"${DEVELOP_INCOMPLETE_UNCOMMITTED}"`)[1] ?? "",
      ),
    "6: the cause table classifies it `change`",
  );
  assert(
    read("headless/failure.ts").includes(`"${DEVELOP_INCOMPLETE_UNCOMMITTED}"`) &&
      (FAILURE_KINDS as readonly string[]).includes("unfinished"),
    "6: headless/failure gives it a non-timeout kind (`unfinished`)",
  );
  const failed = failureOf(initialState(1768), DEVELOP_INCOMPLETE_UNCOMMITTED, "develop");
  assert(
    failed?.kind === "unfinished",
    `6: the failure kind is \`unfinished\`, not timeout/cap (${failed?.kind})`,
  );
  let st = initialState(1768);
  st = {
    ...st,
    eventLog: [
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: DEVELOP_INCOMPLETE_UNCOMMITTED,
        reviewRound: 0,
        nextStep: "handoff",
        evidence: "default: src/a.ts",
      },
    ],
  } as WorkState;
  const explained = explainCap(DEVELOP_INCOMPLETE_UNCOMMITTED, st);
  assert(
    explained.includes("src/a.ts") && /commit/i.test(explained),
    `6: explainCap names the paths and tells the operator to commit (${explained.slice(0, 90)}…)`,
  );
  // The docs table has its row (test-troubleshooting-cap-entries enforces all
  // caps; this asserts this one landed with the code).
  const doc = readFileSync(path.join(import.meta.dirname, "..", "..", "docs", "troubleshooting.md"), "utf8");
  assert(
    doc.includes(`| \`${DEVELOP_INCOMPLETE_UNCOMMITTED}\` |`),
    "6: docs/troubleshooting.md has a row for the cap",
  );
  // The safety net says it is the driver's recovery commit, not the child's.
  const net = read("work-driver-safety-net.ts");
  assert(
    /driver safety-net commit for \$\{wsId\}/.test(net) &&
      /recovery commit made by the driver/.test(net),
    "6: the safety-net trace and commit message say it is a recovery commit made by the driver",
  );
}

await rm(dir, { recursive: true, force: true });
process.exit(exit);
