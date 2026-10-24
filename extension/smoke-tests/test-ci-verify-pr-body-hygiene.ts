#!/usr/bin/env bun
/**
 * #1788 — the ci step's PR-body disclosure is a PUBLIC publish the tool_call
 * guard cannot see (an in-process `gh pr edit`), so the same matcher judges the
 * body before the file is written. A dirty body is refused and `gh pr edit`
 * never runs; a clean one still writes, so the block is not satisfied by a gate
 * that refuses everything. Every term is synthetic (`example-private-host`);
 * this repository is public.
 *
 * Split out of test-verify-select-hardening.ts under AGENTS.md §12's 500-line
 * cap — the disclosure assertions are a different concern from the selector and
 * attribution hardening that file judges.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discloseInPrBody } from "../src/work-driver-ci-verify.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { foldVerifyAttribution } from "../src/work-driver-verify-events.ts";
import type { ExecFn } from "../src/worktree.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const root = mkdtempSync(path.join(tmpdir(), "pi-ci-verify-hygiene-"));
mkdirSync(path.join(root, "tmp"), { recursive: true });
const T2 = "smoke-tests/test-flaky-a.ts";

// The record must be non-empty, or the write is a no-op (`next === current`)
// and the hygiene check under test is never reached at all.
const state = foldVerifyAttribution(
  { ...initialState(9), pipelineState: { ...initialState(9).pipelineState, prNumber: 77 } },
  { flaky: [T2], baselineRed: [] },
);
// discloseInPrBody reads only the repo root and the issue number.
const ctx = { repoRoot: root, issue: 9 } as unknown as CycleContext;

const ghWith = (view: () => string, edits: string[]): ExecFn =>
  (async (cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    if (cmd !== "gh") throw new Error(`unexpected command ${cmd}`);
    if (argv[1] === "view") return { stdout: view(), stderr: "" };
    if (argv[1] === "edit") {
      edits.push(readFileSync(argv[argv.indexOf("--body-file") + 1] ?? "", "utf8"));
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh ${argv.join(" ")}`);
  }) as unknown as ExecFn;
const bodyOf = (body: string | null) => JSON.stringify({ body });

const dirtyTerm = "example-private-host";
const dirtyList = path.join(root, "denylist");
writeFileSync(dirtyList, `# synthetic\n${dirtyTerm}\n`, "utf8");
const prevDenylist = process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = dirtyList;
try {
  const dirtyBody = `Intro mentioning ${dirtyTerm} and nothing else`;
  const edits: string[] = [];
  const execSpy = ghWith(() => bodyOf(dirtyBody), edits);
  let seenCmd = "";
  const spying: ExecFn = (async (cmd: string, opts?: { argv?: string[] }) => {
    if (cmd === "git") seenCmd = (opts?.argv ?? []).join(" ");
    return execSpy(cmd, opts);
  }) as unknown as ExecFn;
  const dirty = await discloseInPrBody(ctx, state, spying);
  assert(
    !dirty.ok &&
      edits.length === 0 &&
      /private/.test(dirty.reason) &&
      seenCmd.startsWith("remote get-url"),
    `a dirty disclosure body is refused before the PR is edited, and nothing is written (reason ${dirty.ok ? "ok" : dirty.reason.slice(0, 40)}, git saw ${seenCmd || "nothing"})`,
  );
  // The same command with a clean body writes, so the check above is a filter
  // and not a wall.
  const cleanEdits: string[] = [];
  const clean = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf("Intro about the public build"), cleanEdits),
  );
  assert(
    clean.ok && cleanEdits.length === 1,
    "a clean disclosure body still reaches gh pr edit — the check refuses nothing it should not",
  );
} finally {
  if (prevDenylist === undefined) delete process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
  else process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = prevDenylist;
}

rmSync(root, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll ci PR-body hygiene checks passed." : "\nFAILED");
process.exit(exit);
