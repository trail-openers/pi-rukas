#!/usr/bin/env bun
/**
 * #1332 — a develop round that changes nothing must end the cycle AT develop,
 * and when the developer stopped on a question (`[ensemble:plumb]`), that
 * question is the park reason. Cycle 129 burned 4.6M tokens to arrive back at
 * one unanswered question, and the handoff did not contain it.
 *
 * End to end through `runDevelopTopological` with a real git repo and a stub
 * developer that touches nothing: the step halts at `verify-failed:develop`
 * (never reaching adversarial or commit-pr), the cap evidence carries the
 * developer's question, and the question lands in `pipelineState.plumbReports`
 * so the handoff renders it. A no-op round with no question still halts, with
 * the plain empty-diff evidence.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { asShellForm, commandOf } from "./lib/argv-shell.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1332-"));

const QUESTION =
  "[ensemble:plumb]\ncategory: prior-decision-conflict\nquestion: #129 needs the approval record from #128, which is still an open PR — wait for it, or duplicate it on main?";

async function runCase(name: string, reply: string) {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  // The driver writes its state under .pi/ (excluded per clone in real use).
  writeFileSync(path.join(repo, ".git", "info", "exclude"), ".pi/\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

  const state = initialState(1332);
  state.pipelineState.worktrees = { default: repo };
  state.pipelineState.baseSha = baseSha;
  state.pipelineState.workstreams = {
    default: { id: "default", scope: "N=1 no-op", paths: ["src/x.ts"], outOfScope: [] },
  };
  const verifyExecFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    const c = commandOf(cmd, o);
    if (c.startsWith("git ")) {
      const r = await execFileP("/bin/sh", ["-c", c], { cwd: o?.cwd ?? repo });
      return { stdout: r.stdout };
    }
    return { stdout: "" };
  };
  const ctx: DriverContext = {
    host: {} as unknown as DriverContext["host"],
    repoRoot: repo,
    issue: 1332,
    dispatchFn: async () => ({
      role: "developer",
      ok: true,
      text: reply,
      toolUses: [],
      ms: 1,
      exitCode: 0,
    }),
    verifyExecFn,
  };
  return runDevelopTopological(
    ctx,
    state,
    ["default"],
    state.pipelineState.workstreams ?? {},
    [1332],
    ctx.dispatchFn as NonNullable<DriverContext["dispatchFn"]>,
    asShellForm(verifyExecFn),
    Date.now(),
    `job-1332-${name}`,
  );
}

try {
  // --- a no-op round whose developer asked a question
  const asked = await runCase("asked", `Touched files: None.\n\n${QUESTION}`);
  const cap = [...asked.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "verify-failed:develop",
    `no-op develop halts at verify-failed:develop (got ${cap?.kind === "cap-hit" ? cap.cap : "no cap"})`,
  );
  assert(
    cap?.kind === "cap-hit" && cap.nextStep === "handoff",
    "the cap routes to handoff, never to adversarial or commit-pr",
  );
  assert(
    cap?.kind === "cap-hit" && /empty diff/.test(cap.evidence ?? ""),
    "the evidence says the round changed nothing",
  );
  assert(
    cap?.kind === "cap-hit" && /approval record from #128/.test(cap.evidence ?? ""),
    "the evidence carries the developer's question",
  );
  assert(
    (asked.pipelineState.plumbReports ?? []).some((r) =>
      r.body.includes("prior-decision-conflict"),
    ),
    "the question is recorded in plumbReports for the handoff",
  );

  // --- a no-op round with no question still halts, with the plain evidence
  const silent = await runCase("silent", "Done. Touched files: None.");
  const cap2 = [...silent.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap2?.kind === "cap-hit" &&
      cap2.cap === "verify-failed:develop" &&
      /empty diff/.test(cap2.evidence ?? "") &&
      !/developer question/.test(cap2.evidence ?? ""),
    "a silent no-op round halts at develop with no invented question",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\nexit ${exit}`);
process.exit(exit);
