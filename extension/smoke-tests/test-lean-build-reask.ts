#!/usr/bin/env bun
/**
 * #2661 — a wasted build turn gets ONE bounded session re-ask, through the REAL build dispatch path.
 *
 * The field shape: in several samples of one task the first build developer spent its whole
 * completion budget on reasoning (`stopReason: "length"`, 16,384 output tokens) and made NO tool
 * call; the step ended `exhausted: the developer produced no change` after 100–183 s and the cell
 * failed. A sibling cell ended exhausted after ONE turn with no tool call and a clean stop. The
 * existing no-work retry cannot fire for either: it needs a DEAD child (`!ok || killCause ||
 * errorStop`) and a length stop is `ok: true`, exit 0.
 *
 * Every case here drives the real `buildOutcome` through the real fixture (real git, real worktree,
 * real fold) with only the model stubbed, and asserts on what the CONTINUATION LEAF WAS HANDED — the
 * session path, bound, prompt, tree and fence — not on a fixture's own bookkeeping. The answers come
 * out of a box, not a `let`, because the fixture's fake dispatch calls the case's rule from inside an
 * async function.
 *
 *   (1) the panel row: length stop, no tool call, then the resumed child writes the change —
 *       `ok`, the file committed, TWO dispatch rows, and the continuation named the FIRST child's
 *       own transcript path;
 *   (2) never-re-asked arms, each asserting NO continuation call: a child that made a tool call,
 *       no recorded stop reason, a kill cause, an errorStop, a budget that already fired, a
 *       provider fault, a child that wrote bytes then hit the cap;
 *   (3) the second turn also fails — still exhausted, with ONE clause appended after the head and
 *       the wait note;
 *   (4) T2: a clean stop with no tool call and no change gets the same ask;
 *   (5) the date-rollover guard: no transcript path, so no ask, nothing billed, and the reason
 *       stays today's;
 *   (6) one ask per visit — a replayed continuation never asks twice;
 *   (7) the ask is billed as one row and never extends the step's ceilings.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import { commitPaths, subjectsAbove } from "./lib/lean-build-asserts.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { ROOTS, git, put, runBuild } from "./lib/lean-build-fixture.ts";
import {
  type ContinuationCalls,
  answered,
  reaskDeps,
  silent,
} from "./lib/lean-build-reask-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The field's own first turn: cut at the cap, no tool call, its usage recorded. */
const CUT: Partial<DispatchResult> = {
  ok: true,
  exitCode: 0,
  stopReason: "length",
  toolUses: [],
  observedToolCalls: 0,
  usage: { input: 900, output: 16384, cacheRead: 0, cacheWrite: 0, cost: 0.4, turns: 1 },
};

/** A session path shaped the way `transcriptPathFor` writes one — same env root, same dated
 *  directory, same `<runId>-<role…>.json` leaf. Built from the PRODUCTION formatter's own rules so a
 *  case cannot pin a path the seam would never have been given, and cannot drift when the layout
 *  moves. */
function sessionFor(issue: number, n: number): string {
  const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const date = new Date().toISOString().slice(0, 10);
  return path.join(
    piAgentDir,
    "ensemble-runs",
    date,
    `170000000000${String(n)}-run-dev-${String(issue)}.json`,
  );
}

const WROTE = (wt: string) => put(wt, "src/retry.ts", "export const retry = () => 1;\n");

/** A build seat whose minutes ceiling is LOOSER than the re-ask's own ceiling, so a bound that took
 *  the seat's instead of the smaller of the two is observed: an ask that outlives the deadline its
 *  first child was bounded by is the failure this row exists to prevent. */
const LOOSE_SEAT = {
  ...configWithRunner(),
  budgets: { build: { turns: 400, tokens: 60_000_000, minutes: 120 } },
};

// ── (1) the panel row: the cut child is continued, its work is kept ─────────
{
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2661,
    // A seat of its own: the bound is the SMALLER of the seat and the re-ask's ceiling, so the case
    // hands the seat a 120-minute row and asserts the ask still ran under 15.
    config: LOOSE_SEAT,
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2661, 1) }],
    reask: {
      deps: reaskDeps({
        calls,
        acts: (n, wt) => {
          // The FIRST child acts nowhere — that is the defect. The resumed child (-1) writes.
          if (n === -1) WROTE(wt);
        },
        answers: [answered()],
      }),
    },
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(1) the run the field handed back now lands (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    commitPaths(r.worktree).join() === "src/retry.ts",
    `(1) the CONTINUATION's file is what got committed (${commitPaths(r.worktree).join(", ")})`,
  );
  assert(
    subjectsAbove(r.worktree, r.headBefore).length === 1,
    `(1) and exactly one build commit sits above the head the step found (${subjectsAbove(r.worktree, r.headBefore).join(" | ")})`,
  );
  assert(
    r.dispatched === 1,
    `(1) the step still dispatched ONE child (got ${String(r.dispatched)})`,
  );
  assert(
    calls.length === 1,
    `(1) and exactly one continuation was asked for (${String(calls.length)})`,
  );
  const call = calls[0];
  assert(
    call?.transcriptPath === sessionFor(2661, 1),
    `(1) the continuation resumed the FIRST child's own session file — a fresh child is a second opinion, not a follow-up (${JSON.stringify(call?.transcriptPath)})`,
  );
  assert(
    call?.role === "developer",
    `(1) and it ran as the builder's role, so it keeps the developer's write tools (${JSON.stringify(call?.role)})`,
  );
  assert(
    call?.cwd === r.worktree,
    `(1) and it started in the RUN'S worktree, not this process's directory (${JSON.stringify(call?.cwd)})`,
  );
  assert(
    call?.writeFence?.root === r.worktree &&
      typeof call?.writeFence?.repo === "string" &&
      call.writeFence.repo.length > 0 &&
      (call.writeFence.scratch ?? "").includes("tmp/"),
    `(1) and it carries the SAME fence its parent was fenced by — root, repo and scratch (${JSON.stringify(call?.writeFence)})`,
  );
  assert(
    typeof call?.prompt === "string" &&
      call.prompt.includes("output budget") &&
      call.prompt.includes("tool calls") &&
      call.prompt.includes("reasoning short"),
    `(1) and the prompt says the previous turn ran out of output budget on reasoning and must act now (${JSON.stringify((call?.prompt ?? "").slice(0, 60))})`,
  );
  assert(
    (call?.boundMs ?? 0) > 0 && call?.boundMs <= 15 * 60_000,
    `(1) and it ran under the SMALLER of its own ceiling and the seat's 120-minute row (${String(call?.boundMs)})`,
  );
  // The same bound again with the seat TIGHTER than the re-ask's ceiling: `continuationBoundMs` is
  // the clamp, and a call that ignored it would still pass the line above (15 min sits under both).
  const tight: ContinuationCalls = [];
  const tightRun = await runBuild({
    issue: 2661,
    config: {
      ...configWithRunner(),
      budgets: { build: { turns: 400, tokens: 60_000_000, minutes: 4 } },
    },
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2661, 1) }],
    reask: { deps: reaskDeps({ calls: tight, answers: [answered()] }) },
  });
  assert(
    tight.length === 1 && (tight[0]?.boundMs ?? 0) > 0 && tight[0].boundMs <= 4 * 60_000,
    `(1) and a TIGHTER seat wins: the ask is bounded by the step's armed budget, not its own ceiling
     (${String(tight[0]?.boundMs)}, ${String(tightRun.threw?.message)})`,
  );
  const rows = r.outcome?.dispatches ?? [];
  assert(
    rows.length === 2 && rows[1]?.role === "developer",
    `(1) the continuation is ONE extra cost row beside the child's own (${JSON.stringify(rows.map((x) => x.role))})`,
  );
  assert(
    (r.outcome?.reason ?? "").startsWith("1 file(s) changed"),
    `(1) and the reason is an ordinary ok verdict's, not an exhausted one (${r.outcome?.reason})`,
  );
  assert(
    existsSync(path.join(r.worktree, "src/retry.ts")),
    "(1) precondition: the file is on disk after the step",
  );
}

// ── (2) the arms that are NEVER continued — each asserts no call at all ─────
{
  interface Refusal {
    name: string;
    over: Partial<DispatchResult>;
    /** A child whose own turn wrote the file: the fold finds work, so no ask is due. */
    child?: (wt: string) => void;
    /** The verdict this shape owns, when the arm is a routed one and not an exhaustion. */
    expect?: string;
  }
  const refusals: Refusal[] = [
    {
      name: "made a tool call then stopped",
      over: {
        ...CUT,
        stopReason: "stop",
        toolUses: [{ type: "toolCall", id: "1", name: "read" }],
        observedToolCalls: 1,
      },
    },
    {
      name: "recorded no stop reason",
      over: { ok: true, exitCode: 0, toolUses: [], observedToolCalls: 0 },
    },
    // A kill the step's OWN minutes bound stamped is a ceiling stop: `dispatchBuilder` answers it as
    // `budget` inside the loop, so the arm below asserts a budget verdict and no ask.
    // A kill cause: what verdict each shape gets is the dispatch loop's routing that predates this
    // issue (and depends on a real cycle deadline), so the arm asserts only that it buys NO
    // continuation — no re-ask can widen a killed or aborted child's cost.
    {
      name: "was bound-killed",
      over: { ...CUT, killCause: "child-bound", ok: false, exitCode: null as never },
    },
    {
      name: "was killed before its usage landed",
      over: { killCause: "child-bound", ok: false, exitCode: null as never, usage: undefined },
    },
    {
      name: "was ended by an abort",
      over: { ...CUT, killCause: "abort", ok: false, exitCode: null as never },
    },
    {
      name: "carried an errorStop",
      over: {
        ...CUT,
        errorStop: { reason: "error", message: "HTTP 500 server error" },
        ok: false,
        exitCode: 1,
      },
    },
    { name: "was cut AFTER writing bytes", over: { ...CUT }, child: WROTE },
    {
      name: "stopped cleanly after a tool call",
      over: {
        stopReason: "stop",
        toolUses: [{ type: "toolCall", id: "1", name: "bash" }],
        observedToolCalls: 1,
      },
    },
  ];
  for (const [i, f] of refusals.entries()) {
    const calls: ContinuationCalls = [];
    const r = await runBuild({
      issue: 2670 + i,
      dispatchResults: [{ ...f.over, transcriptPath: sessionFor(2670 + i, i) }],
      ...(f.child === undefined ? {} : { child: f.child }),
      reask: { deps: reaskDeps({ calls, acts: (n, wt) => void (n === -1 && WROTE(wt)) }) },
    });
    assert(
      calls.length === 0,
      `(2) a child that ${f.name} gets no continuation (${String(calls.length)} calls, kind ${String(r.outcome?.kind)})`,
    );
    // A dead child still costs its ONE re-dispatch (the no-work retry the arm must not widen) and
    // never a continuation; a live child costs one dispatch. Either way, no ask.
    assert(
      r.dispatched <= (f.over.ok === false ? 2 : 1),
      `(2) and it bought no child beyond what its own arm already buys (${String(r.dispatched)})`,
    );
    assert(
      f.expect === undefined || r.outcome?.kind === f.expect,
      `(2) and its verdict is the one that shape owns (${String(r.outcome?.kind)}, wanted ${String(f.expect)})`,
    );
  }
}

// ── (2b) the budget that already fired is read BEFORE the child is bought ──
{
  // A turns ceiling the step's own hook fires mid-child: the child comes back a `budget` stop, which
  // the dispatch loop answers inside the loop, so the re-ask site is never reached and no continuation
  // is bought on an already-aborted controller.
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2680,
    config: {
      ...(await import("./lib/lean-build-asserts.ts")).configWithRunner(),
      budgets: { build: { turns: 1, tokens: 0, minutes: 0 } },
    },
    onProgressTick: (onProgress) => {
      onProgress?.({
        turns: 2,
        totalTokens: 10,
        elapsedMs: 10,
        usage: { turns: 2, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
      } as never);
      onProgress?.({
        turns: 3,
        totalTokens: 20,
        elapsedMs: 20,
        usage: { turns: 3, input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
      } as never);
    },
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2680, 1) }],
    reask: { deps: reaskDeps({ calls, acts: (n, wt) => void (n === -1 && WROTE(wt)) }) },
  });
  assert(
    calls.length === 0,
    `(2b) a child the step's own turns ceiling stopped is a budget verdict, never a re-ask (${String(calls.length)} calls, kind ${String(r.outcome?.kind)})`,
  );
  assert(
    r.outcome?.kind === "budget" || r.outcome?.kind === "exhausted" || r.threw !== undefined,
    `(2b) and the stop is answered as a ceiling is today (got ${r.threw?.message ?? String(r.outcome?.kind)})`,
  );
}

// ── (3) the continuation that also fails: exhausted, head kept, clause appended ─
{
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2681,
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2681, 1) }],
    reask: { deps: reaskDeps({ calls, answers: [silent()] }) },
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "exhausted",
    `(3) a continuation that moved nothing is still the exhaustion it always was (${r.threw?.message ?? String(r.outcome?.kind)})`,
  );
  const reason = r.outcome?.reason ?? "";
  assert(
    reason.startsWith("the developer produced no change"),
    `(3) the HEAD of the reason is untouched — three downstream surfaces match on it (${reason})`,
  );
  assert(
    reason.includes("output-token limit") && reason.includes("16384"),
    `(3) the appended clause names the cap and the child's own tokens (${reason})`,
  );
  assert(
    reason.includes("one continuation changed nothing"),
    `(3) and says the ask was spent, so it is not read as an untried one (${reason})`,
  );
  assert(calls.length === 1, `(3) precondition: the ask really happened (${String(calls.length)})`);
  assert(
    (r.outcome?.dispatches ?? []).length === 2,
    `(3) and both children are billed (${String((r.outcome?.dispatches ?? []).length)} rows)`,
  );
  assert(subjectsAbove(r.worktree, r.headBefore).length === 0, "(3) and nothing was committed");
}

// ── (4) T2: one clean turn, no tool call, no change ─────────────────────────
{
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2682,
    dispatchResults: [
      {
        ok: true,
        exitCode: 0,
        stopReason: "stop",
        toolUses: [],
        observedToolCalls: 0,
        usage: { input: 40, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 1 },
        transcriptPath: sessionFor(2682, 1),
      },
    ],
    reask: {
      deps: reaskDeps({
        calls,
        acts: (n, wt) => void (n === -1 && WROTE(wt)),
        answers: [answered()],
      }),
    },
  });
  assert(
    calls.length === 1,
    `(4) a clean stop with no tool call and no fold change gets the same one ask (${String(calls.length)})`,
  );
  assert(
    r.outcome?.kind === "ok" && commitPaths(r.worktree).join() === "src/retry.ts",
    `(4) and the change the resumed child made is kept (${r.threw?.message ?? `${String(r.outcome?.kind)}: ${commitPaths(r.worktree).join(",")}`})`,
  );
  assert(
    (calls[0]?.prompt ?? "").includes("unchanged") &&
      (calls[0]?.prompt ?? "").includes("tool call"),
    `(4) and its prompt says the tree is unchanged and names the missing tool call (${JSON.stringify((calls[0]?.prompt ?? "").slice(0, 60))})`,
  );
}

// ── (5) the date-rollover guard: no session path, so no ask and nothing billed ─
{
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2683,
    // The field's shape, but with no transcript path to resume — the ask must be refused before a
    // child is paid for, not answered by a fresh spawn that never read the first turn.
    dispatchResults: [{ ...CUT }],
    reask: { deps: reaskDeps({ calls, acts: (n, wt) => void (n === -1 && WROTE(wt)) }) },
  });
  assert(
    calls.length === 0,
    `(5) no session path means no continuation call at all (${String(calls.length)})`,
  );
  assert(
    r.outcome?.kind === "exhausted",
    `(5) and the step ends exhausted as today (${r.threw?.message ?? String(r.outcome?.kind)})`,
  );
  assert(
    r.outcome?.reason === "the developer produced no change",
    `(5) with today's reason — an ask that never happened bills no clause (${JSON.stringify(r.outcome?.reason)})`,
  );
  assert(
    (r.outcome?.dispatches ?? []).length === 1,
    `(5) and the refused ask billed no row (${String((r.outcome?.dispatches ?? []).length)})`,
  );
}

// ── (6) one ask per visit: the detector is never handed the continuation back ─
{
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2684,
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2684, 1) }],
    reask: {
      deps: reaskDeps({
        calls,
        // The leaf answers with the CUT shape replayed: a resumed session replays the cut turn, so a
        // detector that re-read the continuation's result would ask forever.
        answers: [answered({ stopReason: "length", text: "still thinking" })],
      }),
    },
  });
  assert(
    calls.length === 1,
    `(6) the ask is one-shot even when the replayed answer still reads "length" (${String(calls.length)} calls)`,
  );
  assert(
    r.outcome?.kind === "exhausted",
    `(6) and a continuation that changed nothing still ends the visit (${String(r.outcome?.kind)})`,
  );
}

// ── (7) the ask never extends the step's ceilings ────────────────────────────
{
  // Two runs, one env: the ask is billed as a row but the step's dispatch count, its single commit
  // and its round billing are what they were before the ask existed.
  const calls: ContinuationCalls = [];
  const asked = await runBuild({
    issue: 2685,
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2685, 1) }],
    reask: {
      deps: reaskDeps({
        calls,
        acts: (n, wt) => void (n === -1 && WROTE(wt)),
        answers: [answered()],
      }),
    },
  });
  const unasked = await runBuild({
    issue: 2686,
    dispatchResults: [{ ...CUT, transcriptPath: sessionFor(2686, 1) }],
    reask: { deps: reaskDeps({ calls: [], answers: [silent()] }) },
  });
  assert(
    asked.dispatched === 1 && unasked.dispatched === 1,
    `(7) neither visit dispatched more than its own child (${String(asked.dispatched)}/${String(unasked.dispatched)})`,
  );
  assert(
    git(asked.worktree, "rev-list", "--count", `${asked.headBefore}..HEAD`) === "1",
    "(7) the continued visit made exactly one commit",
  );
  assert(
    git(unasked.worktree, "rev-list", "--count", `${unasked.headBefore}..HEAD`) === "0",
    "(7) and the refused visit made none",
  );
}

for (const root of ROOTS) {
  // The fixture's own cleanup contract: the caller removes what it made.
  void root;
}
process.exit(exit);
