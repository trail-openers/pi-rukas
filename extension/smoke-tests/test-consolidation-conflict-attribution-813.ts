#!/usr/bin/env bun
/**
 * #813 — a consolidation failure with NO fence record must state what was
 * OBSERVED, not assert that the decomposition is incoherent.
 *
 * The pre-#813 diagnosis guessed: when the consolidated verify could not
 * combine the workstreams' commits and the develop fence had recorded
 * nothing, both operator surfaces (`reportConsolidatedVerifyOutcome`'s
 * failure string and `explainCap("consolidated-verify-conflict")`) claimed
 * "two workstreams edited the same lines; the decomposition is incoherent".
 * With #1005 merging genuinely coupled workstreams at plan time, the pair
 * that still collides is usually coupled through TYPES while declaring
 * disjoint paths (the #792 DeliverableStatus/ConvergeEvidence shape) — and
 * re-splitting is no longer the fix for that.
 *
 * The two surfaces each own a renderer, so the no-fence branch is covered
 * for BOTH (the acceptance criteria), plus the reporter's `#1005`
 * "likely coupled" branch that fires when the failure names a file another
 * workstream declared.
 *
 * The conflict branch of the reporter is driven through the REAL
 * `runConsolidatedVerify` with an injected executor that aborts the batch,
 * so the string asserted here is the string production produces — including
 * `cons.detail`, which the reporter embeds verbatim.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describeSiblingFenceViolations } from "../src/work-develop-fence-verdicts.ts";
import { reportConsolidatedVerifyOutcome } from "../src/work-driver-consolidated-verify-report.ts";
import type { ConsolidatedVerifyResult } from "../src/work-driver-consolidated-verify-types.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A fake executor that behaves like a real git checkout/branch sequence and
 * then FAILS the batch the way `cherryPickWorkstreams` does when a pick
 * conflicts: `git cherry-pick --no-commit <sha>` throws for workstream `b`,
 * the abort runs, and no verify command is ever reached.
 */
function conflictingExec(failedId: "a" | "b") {
  const shas: Record<string, string> = {};
  const calls: string[] = [];
  const exec = async (cmd: string): Promise<{ stdout: string }> => {
    calls.push(cmd);
    if (cmd.startsWith("git rev-list")) {
      const wt = cmd.match(/--reverse --first-parent (\S+)\.\.HEAD/)?.[1] ?? "";
      const id = wt.endsWith("wt-a") ? "a" : wt.endsWith("wt-b") ? "b" : "?";
      const sha = shas[id] ?? "0000000000000000000000000000000000000001";
      return { stdout: `${sha}\n` };
    }
    if (cmd.startsWith("git rev-parse HEAD"))
      return { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
    if (cmd.startsWith("git rev-parse --verify")) return { stdout: "", ...{} };
    if (cmd.includes("cat-file -e")) throw new Error("not on branch");
    if (cmd.startsWith("git cherry-pick --no-commit")) {
      const sha = cmd.match(/--no-commit (\S+)/)?.[1] ?? "";
      // The batch fails on the SECOND pick (workstream b).
      const pickIndex = calls.filter((c) => c.startsWith("git cherry-pick --no-commit")).length;
      if (pickIndex >= 2) {
        const e = new Error(`could not apply ${sha}`) as Error & { stderr?: string };
        e.stderr = "CONFLICT (content): Merge conflict";
        throw e;
      }
      return { stdout: "" };
    }
    return { stdout: "" };
  };
  return { exec, calls, shas };
}

function runReporter(
  cons: ConsolidatedVerifyResult,
  opts: {
    worktrees: Record<string, string>;
    workstreams?: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    >;
    fenceViolations?: FenceViolationRecord[];
  },
): string[] {
  const failures: string[] = [];
  const notes: string[] = [];
  reportConsolidatedVerifyOutcome(cons, {
    cmd: "bun test",
    failures,
    notes,
    ctx: { repoRoot: "/repo" },
    worktrees: opts.worktrees,
    // #813 — the declared paths are what license the "likely coupled" clause.
    ...(opts.workstreams !== undefined ? { workstreams: opts.workstreams } : {}),
    perWorktreeFailuresByWs: {},
    singlePerWs: undefined,
    singlePerAssertion: undefined,
    ...(opts.fenceViolations !== undefined ? { fenceViolations: opts.fenceViolations } : {}),
  });
  return failures;
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-813-"));

try {
  // ──────────────────────────────────────────────────────────────────────
  // Case 1 — the REAL consolidated run, no fence record.
  //
  // Observed: the batch aborted on workstream `b` after `a` picked cleanly.
  // Required: the failure string says which pick failed and does NOT claim
  // the decomposition is incoherent.
  // ──────────────────────────────────────────────────────────────────────
  {
    const { exec } = conflictingExec("b");
    const cons = await runConsolidatedVerify(exec, {
      repoRoot: "/repo",
      baseSha: "abc1234",
      worktrees: { a: "/w/wt-a", b: "/w/wt-b" },
      scratchDir: path.join(root, "scratch-1"),
      verifyCmd: "bun test",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "conflict" && cons.kind === "conflict",
      `case 1: the injected executor produces a genuine conflict outcome (got: ${JSON.stringify(cons).slice(0, 160)})`,
    );
    const failures = runReporter(cons, {
      worktrees: { a: "/w/wt-a", b: "/w/wt-b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    });
    const conflictFailure = failures.find((f) => /could not combine/.test(f));
    assert(
      !!conflictFailure,
      `case 1: a conflict failure string is produced (got: ${failures.join("; ")})`,
    );
    assert(
      !!conflictFailure && !/incoherent/.test(conflictFailure),
      `case 1 reporter: the no-fence failure does NOT assert "incoherent" (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure && !/Two workstreams edited the same lines/.test(conflictFailure),
      `case 1 reporter: the no-fence failure does NOT assert "two workstreams edited the same lines" (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure && /cherry-pick|patch-apply/.test(conflictFailure),
      `case 1 reporter: the failure states what was observed — a pick/apply that failed (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure &&
        /the pick for workstream 'b' failed after 'a' applied cleanly/.test(conflictFailure),
      `case 1 reporter: the failure names WHICH pick failed (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure && /do NOT re-split on this alone/.test(conflictFailure),
      `case 1 reporter: the failure tells the operator re-splitting is not the fix (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure && /verified restored/.test(conflictFailure),
      `case 1 reporter: the #750 verified-restore claim still rides on the string (got: ${conflictFailure?.slice(0, 260)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 2 — the explainCap renderer, no fence record (the SECOND renderer).
  // ──────────────────────────────────────────────────────────────────────
  {
    const s = initialState(813, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      worktrees: { a: "/w/a", b: "/w/b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    };
    s.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "consolidated-verify-conflict",
      reviewRound: 0,
      nextStep: "handoff",
      evidence:
        "consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict",
    });
    const text = explainCap("consolidated-verify-conflict", s);
    assert(
      !/incoherent/.test(text),
      `case 2 explainCap: no-fence text does NOT say "incoherent" (got: ${text.slice(0, 260)})`,
    );
    assert(
      !/edited the same lines, so the work is individually plausible/.test(text),
      `case 2 explainCap: the "edited the same lines" inference is gone (got: ${text.slice(0, 260)})`,
    );
    assert(
      !/fix is to re-split the work into non-overlapping/.test(text),
      `case 2 explainCap: the text does not tell the operator to re-split (got: ${text.slice(0, 260)})`,
    );
    assert(
      /which workstream|could not be combined/.test(text),
      `case 2 explainCap: the text states what was observed (got: ${text.slice(0, 260)})`,
    );
    assert(
      /1005/.test(text) || /merge[ds]? the pair|merge-and-retry/.test(text),
      `case 2 explainCap: the text points at the #1005 merge behaviour (got: ${text.slice(0, 260)})`,
    );
    assert(
      /Worktrees:/.test(text),
      `case 2 explainCap: the worktree list is preserved (got: ${text.slice(0, 200)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 3 — the failure names a file another workstream DECLARED → the
  // "likely coupled" diagnosis + the #1005 pointer (reporter side).
  // ──────────────────────────────────────────────────────────────────────
  {
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "conflict",
      detail: "cherry-pick conflict on src/a.ts",
    };
    const failures = runReporter(cons, {
      worktrees: { a: "/w/a", b: "/w/b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    });
    const f = failures.find((x) => /could not combine/.test(x));
    assert(!!f, `case 3: a conflict failure string is produced (got: ${failures.join("; ")})`);
    assert(
      !!f && !/incoherent/.test(f),
      `case 3 reporter: no "incoherent" claim (got: ${f?.slice(0, 260)})`,
    );
    assert(
      !!f && /src\/a\.ts/.test(f) && /workstream a/.test(f),
      `case 3 reporter: names the file and its declaring workstream (got: ${f?.slice(0, 260)})`,
    );
    assert(
      !!f && /likely coupled/i.test(f),
      `case 3 reporter: says the workstreams are LIKELY COUPLED (got: ${f?.slice(0, 260)})`,
    );
    assert(
      !!f && /#1005/.test(f) && /merge/i.test(f),
      `case 3 reporter: points at the #1005 merge behaviour (got: ${f?.slice(0, 260)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 4 — the same shape on the explainCap renderer: cap evidence names
  // a file the OTHER workstream declared → likely coupled + #1005.
  // ──────────────────────────────────────────────────────────────────────
  {
    const s = initialState(813, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      worktrees: { a: "/w/a", b: "/w/b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    };
    s.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "consolidated-verify-conflict",
      reviewRound: 0,
      nextStep: "handoff",
      evidence:
        "consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict on src/a.ts",
    });
    const text = explainCap("consolidated-verify-conflict", s);
    assert(
      !/incoherent/.test(text),
      `case 4 explainCap: no "incoherent" claim (got: ${text.slice(0, 260)})`,
    );
    assert(
      /likely coupled/i.test(text) && /#1005/.test(text),
      `case 4 explainCap: names the coupling and points at #1005 (got: ${text.slice(0, 260)})`,
    );
    assert(
      /src\/a\.ts/.test(text) && /workstream a\b/.test(text),
      `case 4 explainCap: names the file and the declaring workstream (got: ${text.slice(0, 260)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 5 — the fence-recorded branch is UNCHANGED by this fix (regression
  // guard for the pre-existing #814 attribution, on both renderers).
  // ──────────────────────────────────────────────────────────────────────
  {
    const fence: FenceViolationRecord[] = [
      { workstreamId: "b", file: "src/a.ts", declaredById: "a", kind: "sibling-declared" },
    ];
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "conflict",
      detail:
        "cherry-pick conflict — two workstreams edited the same lines; verified restored to abc1234",
    };
    const failures = runReporter(cons, {
      worktrees: { a: "/w/a", b: "/w/b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
      fenceViolations: fence,
    });
    const f = failures.find((x) => /could not combine/.test(x));
    assert(
      !!f && f.includes(describeSiblingFenceViolations(fence) ?? "«never»"),
      `case 5 reporter: the sibling-declared attribution still renders verbatim (got: ${f?.slice(0, 260)})`,
    );

    const s = initialState(813, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      worktrees: { a: "/w/a", b: "/w/b" },
      verifyEvidence: { step: "develop", failures: [], at: 1, fenceViolations: fence },
    };
    s.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "consolidated-verify-conflict",
      reviewRound: 0,
      nextStep: "handoff",
      evidence: "cherry-pick conflict",
    });
    const text = explainCap("consolidated-verify-conflict", s);
    assert(
      text.includes("workstream b touched src/a.ts, declared by workstream a"),
      `case 5 explainCap: the fence attribution still wins when a record exists (got: ${text.slice(0, 260)})`,
    );
    assert(
      !/incoherent/.test(text),
      `case 5 explainCap: still no "incoherent" with a fence record (got: ${text.slice(0, 200)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 6 — the undeclared-only branch is unchanged: an `undeclared` record
  // is a warning, so the no-fence diagnosis runs (and no longer over-claims).
  // ──────────────────────────────────────────────────────────────────────
  {
    const s = initialState(813, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      worktrees: { a: "/w/a", b: "/w/b" },
      verifyEvidence: {
        step: "develop",
        failures: [],
        at: 1,
        fenceViolations: [{ workstreamId: "a", file: "src/extra.ts", kind: "undeclared" }],
      },
    };
    s.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "consolidated-verify-conflict",
      reviewRound: 0,
      nextStep: "handoff",
      evidence: "cherry-pick conflict",
    });
    const text = explainCap("consolidated-verify-conflict", s);
    assert(
      !text.includes("fence was violated"),
      `case 6 explainCap: an undeclared record does not trigger the fence attribution (got: ${text.slice(0, 200)})`,
    );
    assert(
      !/incoherent/.test(text),
      `case 6 explainCap: the no-fence branch no longer over-claims (got: ${text.slice(0, 200)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 7 — the dirty-root refusal keeps its OWN wording (the routing the
  // #725 discriminator protects must not move when the conflict text moves).
  // ──────────────────────────────────────────────────────────────────────
  {
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "dirty-root",
      detail: "repoRoot dirty: M src/x.ts",
    };
    const failures = runReporter(cons, { worktrees: { a: "/w/a" } });
    assert(
      failures.some((f) => /was refused/.test(f) && !/could not combine/.test(f)),
      `case 7: a dirty-root refusal is still reported as a refusal, not a conflict (got: ${failures.join("; ")})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
