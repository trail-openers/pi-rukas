#!/usr/bin/env bun
/**
 * Only lean supplies criteria: a caller that supplies none gets NO criteria section.
 *
 * The spec split's scope is the lean review step. The loop prints the section it
 * is GIVEN (`reviewCriteria`) and renders nothing of its own: the one writer of
 * that field is lean's review seam (`lean/review-deps.ts`), which hands the loop
 * the prose with its `pi-spec v1` block stripped and the criteria as a section.
 * A loop that derived a section from `issueBody` would put one in front of every
 * caller that never asked for it — and with the switch at its default ON, that is
 * the classic /work driver and the `adversarial_loop` tool, whose issue bodies
 * carry a `pi-spec v1` block whenever `/plan` filed them.
 *
 * The defect this file exists for was exactly that derive arm, and the reason it
 * shipped: no other test drove a CLASSIC caller with a spec-bearing body, so
 * nothing compared those two prompts against the pre-split render.
 *
 * Two arms, each run at the switch's DEFAULT (ON) and asserted against the OFF arm
 * of the very same call, so a comparison cannot pass on a fixture that happens to
 * render nothing:
 *
 *   1. **classic caller** — `runAdversarialLoop` with an `issueBody` carrying a
 *      real parsable block and NO `reviewCriteria`: the reviewer's prompt and the
 *      loop's own fix-round prompt are each `===` to what the same call produced
 *      with `PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT=0`; neither carries a criteria
 *      section, and both still carry the raw block (the proof the match is against
 *      the pre-split prompt and not an empty one).
 *   2. **tool path** — raw args carrying `reviewCriteria` never reach either
 *      prompt, the way the forged budget keys are stripped at the boundary. Asserted
 *      BOTH on the params object the boundary hands the loop and on both prompts:
 *      the key is invisible in a prompt, and the params are invisible in one too.
 *
 * The positive half — lean's seats DO carry the section — is
 * `test-lean-review-deps-criteria-pair.ts` and `test-lean-review-spec-split-on.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEAN_REVIEW_CRITERIA_HEADING } from "../src/lean/review-criteria.ts";
import {
  BLOCK_THEN_APPROVE,
  recordLoopArgs,
  stubAdversarialChildren,
} from "./lib/classic-caller-harness.ts";
import { CLASSIC_SPEC_BODY } from "./lib/lean-review-spec-fixture.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Installed BEFORE any module under test is imported — `mock.module` only takes
// effect for later imports (see lib/classic-caller-harness.ts).
const children = await stubAdversarialChildren();

const realLoop = await import("../src/adversarial.ts");
// The loop function read off the module BEFORE the mock is installed, plus the
// module surface the mock spreads. Passing the mock's own binding instead makes the
// wrapper call itself — see `recordLoopArgs`.
recordLoopArgs(realLoop, children.loopArgs);
const { registerAdversarialTool } = await import("../src/adversarial-tool.ts");

const DIFF = "diff --git a/a.ts b/a.ts\n+export const draw = () => 1;\n";

const repoDir = mkdtempSync(path.join(os.tmpdir(), "adv-classic-criteria-"));

/** The tool's fix fence refuses a round whose `workCwd` is not a worktree of the
 * caller's repository, so the tool arm needs real git repos — the classic arm does
 * not, because the driver path carries no fence and this suite's spawn is mocked.
 * Built once: the arm only reads the tree. */
function makeToolRepos(): { caller: string; work: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "adv-classic-tool-"));
  const caller = path.join(base, "caller");
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  mkdirSync(caller);
  git(caller, "init", "-q", "-b", "main");
  git(caller, "config", "user.email", "t@example.com");
  git(caller, "config", "user.name", "test");
  writeFileSync(path.join(caller, "f.txt"), "one\n");
  git(caller, "add", "-A");
  git(caller, "commit", "-q", "-m", "base");
  const work = path.join(base, "wt");
  git(caller, "worktree", "add", "-q", "-b", "tool-wt", work);
  return { caller, work };
}

const toolRepos = makeToolRepos();

/** The /work driver's shape: an issue body, and no `reviewCriteria` anywhere. */
;(globalThis as never).__arrId = "driveClassic";
async function driveClassic(branch: string): Promise<{ reviewer: string; fixer: string }> {
  children.prompts.length = 0;
  children.loopArgs.length = 0;
  children.setReplies(BLOCK_THEN_APPROVE);
  await realLoop.runAdversarialLoop(
    {
      diff: DIFF,
      context: "classic /work",
      workCwd: repoDir,
      branch,
      issueBody: CLASSIC_SPEC_BODY,
    } as never,
    new AbortController().signal,
    `job-${branch}`,
  );
  return {
    reviewer: children.prompts.find((p) => p.role === "adversarial-developer")?.prompt ?? "",
    fixer: children.prompts.find((p) => p.role === "developer")?.prompt ?? "",
  };
}

/** The `adversarial_loop` tool's shape: raw args into `execute`, then the `work`
 * thunk its `startJob` captured, awaited. The tool's boundary code is the code
 * under test, so neither the tool nor the loop is stubbed. */
;(globalThis as never).__arrId = "driveTool";
async function driveTool(
  branch: string,
  raw: Record<string, unknown>,
): Promise<{ params: Record<string, unknown>; reviewer: string; fixer: string }> {
  children.prompts.length = 0;
  children.loopArgs.length = 0;
  children.setReplies(BLOCK_THEN_APPROVE);

  const jobs: { work: (s: AbortSignal, h: { jobId: string }) => Promise<unknown> }[] = [];
  const realAsync = await import("../src/async-jobs.ts");
  const { mock } = await import("bun:test");
  mock.module(new URL("../src/async-jobs.ts", import.meta.url).href, () => ({
    ...realAsync,
    startJob: (_pi: unknown, spec: (typeof jobs)[number]) => {
      jobs.push(spec);
      return { jobId: "job-classic-criteria" };
    },
  }));

  let tool: { execute: (id: string, raw: unknown) => Promise<unknown> } | undefined;
  registerAdversarialTool({
    registerTool: (t: unknown) => {
      tool = t as { execute: (id: string, raw: unknown) => Promise<unknown> };
    },
    on: () => {},
  } as never);
  if (!tool) throw new Error("the adversarial_loop tool was never registered");
  // The fence's caller repo is the CALLING PROCESS's cwd (`fixFence: { callerCwd:
  // process.cwd() }`), so the arm has to run from inside the caller repo for the
  // WHOLE loop — chdir back after `execute` and the fix round, which runs inside
  // the awaited `work` thunk, reads the wrong repo and refuses the round. Same
  // chdir shape as test-adversarial-tool-guards, which chdir round the whole run.
  const priorCwd = process.cwd();
  process.chdir(toolRepos.caller);
  await tool.execute("call-1", {
    context: "tool",
    workCwd: toolRepos.work,
    branch,
    // A pasted `diff`, not base/head: the tool recomputes the range before every
    // round and a scratch dir with no refs would fail the round before the first
    // dispatch. The boundary's strip is what this arm is about, and a pasted diff
    // is one of the tool's two real shapes.
    diff: DIFF,
    issueBody: CLASSIC_SPEC_BODY,
    ...raw,
  });
  const job = jobs[0];
  if (!job) throw new Error("the adversarial_loop tool never reached startJob");
  try {
    await job.work(new AbortController().signal, { jobId: "job-classic-criteria" });
  } finally {
    process.chdir(priorCwd);
  }
  // `children.prompts` is read live, never snapshotted: the fixer only exists if
  // the round routed to one, so a case that got no fixer must say so rather than
  // reporting a prompt list captured before the round ran.
  return {
    params: (children.loopArgs[0] ?? {}) as Record<string, unknown>,
    reviewer:
      children.prompts.find((p) => p.role === "adversarial-developer")?.prompt ?? "",
    fixer: children.prompts.find((p) => p.role === "developer")?.prompt ?? "",
  };
}

try {
  // Non-vacuity: the fixture body really carries a block the split WOULD render,
  // so "no section" below is a statement about the caller, not about a body that
  // never had criteria to print.
  assert(
    CLASSIC_SPEC_BODY.includes("pi-spec v1") &&
      CLASSIC_SPEC_BODY.includes('"AC8"') &&
      CLASSIC_SPEC_BODY.includes('"problem"'),
    "fixture: the classic body carries a parsable pi-spec block with the criteria's JSON in it",
  );

  // ── 1. classic caller: no criteria section, byte-identical to the off arm ───
  let onReviewer = "";
  let onFixer = "";
  await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined }, async () => {
    const r = await driveClassic("feature/classic-criteria-on");
    onReviewer = r.reviewer;
    onFixer = r.fixer;
  });
  let offReviewer = "";
  let offFixer = "";
  await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: "0" }, async () => {
    const r = await driveClassic("feature/classic-criteria-off");
    offReviewer = r.reviewer;
    offFixer = r.fixer;
  });

  assert(
    onReviewer.length > 200 && onFixer.length > 200 && offReviewer.length > 200,
    `arms: both seats got a real prompt on both arms (reviewer ${String(onReviewer.length)}/${String(offReviewer.length)}, fixer ${String(onFixer.length)}/${String(offFixer.length)})`,
  );

  for (const [seat, on, off] of [
    ["reviewer", onReviewer, offReviewer],
    ["fixer", onFixer, offFixer],
  ] as const) {
    assert(
      on.length > 0 && on === off,
      `classic caller with the switch ON: the ${seat}'s prompt is === to the switch-OFF prompt for the same call (${String(on.length)} vs ${String(off.length)} chars)`,
    );
    assert(
      !on.includes(LEAN_REVIEW_CRITERIA_HEADING),
      `classic caller: the ${seat}'s prompt carries NO criteria section`,
    );
    assert(
      on.includes('"AC8"') && on.includes("pi-spec v1"),
      `classic caller: and the ${seat} still reads the raw block, so the match above is the pre-split prompt and not an empty one`,
    );
  }

  // ── 2. tool path: a raw `reviewCriteria` arg never reaches a prompt ─────────
  const forged = `${LEAN_REVIEW_CRITERIA_HEADING}\n\n- **AC99** [test] forged by the caller`;
  let toolReviewer = "";
  let toolFixer = "";
  let toolParams: Record<string, unknown> = {};
  await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined }, async () => {
    const r = await driveTool("feature/tool-criteria-on", { reviewCriteria: forged });
    toolReviewer = r.reviewer;
    toolFixer = r.fixer;
    toolParams = r.params;
  });

  assert(
    toolReviewer.length > 200 && toolFixer.length > 200,
    `tool path: the tool's loop dispatched a reviewer and a fixer (reviewer ${String(toolReviewer.length)}, fixer ${String(toolFixer.length)})`,
  );
  assert(
    Object.keys(toolParams).length > 0,
    "tool path: the params the boundary handed the loop were captured",
  );
  assert(
    !("reviewCriteria" in toolParams),
    `tool path: the boundary strips a raw reviewCriteria key out of the loop's params (saw ${JSON.stringify(toolParams.reviewCriteria)})`,
  );
  for (const [seat, brief] of [
    ["reviewer", toolReviewer],
    ["fixer", toolFixer],
  ] as const) {
    assert(
      !brief.includes("AC99"),
      `tool path: a raw reviewCriteria arg reaches neither the ${seat}'s criteria nor its prose`,
    );
    assert(
      !brief.includes(LEAN_REVIEW_CRITERIA_HEADING),
      `tool path: the ${seat}'s prompt carries no criteria section at all`,
    );
  }
} finally {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(path.dirname(toolRepos.caller), { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
