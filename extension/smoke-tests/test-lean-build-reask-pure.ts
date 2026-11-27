#!/usr/bin/env bun
/**
 * #2661 — the pure decision about a BUILD turn that bought nothing, asserted on the production
 * detector (`buildTurnWasWasted`) rather than on a copy of its condition.
 *
 * The field shape: a `developer` build child spent its whole completion budget reasoning —
 * `stopReason: "length"`, 16,384 output tokens, no tool call — and the step called that exhaustion.
 * Its sibling: one turn, `stopReason: "stop"`, no tool call, no change. Both get ONE continuation on
 * the child's own session before the step says `exhausted`; nothing else does.
 *
 * The refusal table is the point of this file. A detector that re-asked a killed child, a
 * provider-faulted one, or one whose own tool-call record contradicts its replay, spends a child on
 * a shape that was never the bug — and `fixerWasTruncated`'s rule order is the shipped answer for
 * exactly that, so it is the order asserted here: kill cause and error stop FIRST, then the budget,
 * then the stop reason, then the tool calls.
 *
 * No git, no step import, no child: the detector is pure and the leaf it consults is a field.
 */

import {
  BUILD_REASK_BOUND_MS,
  CLEAN_STOP_REASON,
  buildReaskClause,
  buildReaskPrompt,
  buildTurnWasWasted,
} from "../src/lean-build-reask.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** The field's own child: cut at the cap, no tool call, its usage recorded. */
const CUT: Partial<DispatchResult> = {
  stopReason: "length",
  toolUses: [],
  observedToolCalls: 0,
  usage: { input: 900, output: 16384, cacheRead: 0, cacheWrite: 0, cost: 0.4, turns: 1 },
};

function child(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 1000,
    exitCode: 0,
    usage: { input: 11, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
    ...over,
  };
}

/** The step-side facts besides the result: no ceiling had fired, and the fold found no change. */
function ctx(over: { budgetFired?: boolean; noChange?: boolean } = {}) {
  return { budgetFired: over.budgetFired ?? false, noChange: over.noChange ?? true };
}

// ── (1) the two shapes that earn the ask ─────────────────────────────────────
{
  const cut = buildTurnWasWasted(child(CUT), ctx());
  assert(
    cut.wasted === true && cut.trigger === "length" && cut.outputTokens === 16384,
    `(1) the field's cut turn with no tool call IS a wasted turn, and it quotes the child's own output (${JSON.stringify(cut)})`,
  );
  const clean = buildTurnWasWasted(child({ stopReason: CLEAN_STOP_REASON }), ctx());
  assert(
    clean.wasted === true && clean.trigger === "no-change",
    `(1) a clean stop with no tool call and no fold change is the sibling shape (${JSON.stringify(clean)})`,
  );
  // The count rides the child's record, never a constant: a different cap must print a different
  // number, or the reason would be narration about a turn nobody saw.
  const other = buildTurnWasWasted(
    child({ ...CUT, usage: { input: 1, output: 4096, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }),
    ctx(),
  );
  assert(
    other.wasted === true && other.outputTokens === 4096,
    `(1) and the token count comes from the child's own usage (${JSON.stringify(other)})`,
  );
  // Reads are calls too: a builder that read the tree and then hit the cap still made no change, and
  // the shape the field showed was exactly this — six reads, one long think, cut.
  const readFirst = buildTurnWasWasted(
    child({
      ...CUT,
      toolUses: [
        { type: "toolCall", id: "1", name: "read" },
        { type: "toolCall", id: "2", name: "bash" },
      ],
      observedToolCalls: 2,
    }),
    ctx(),
  );
  assert(
    readFirst.wasted === false && readFirst.reason === "made-tool-call",
    `(1) and a turn that made ANY tool call is not this shape — the fold owns work, and a tool call means the child acted (${JSON.stringify(readFirst)})`,
  );
}

// ── (2) the refusals: a kill, a fault and a fired ceiling outrank the ask ────
{
  for (const killCause of [
    "child-bound",
    "abort",
    "inactivity",
    "token-budget",
    "stuck-tool",
  ] as const) {
    const v = buildTurnWasWasted(child({ ...CUT, killCause }), ctx());
    assert(
      v.wasted === false && v.reason === "killed",
      `(2) a child pi-rukas ended (${killCause}) is a budget/infra stop already routed by dispatchBuilder — never re-asked, even carrying "length" (${JSON.stringify(v)})`,
    );
  }
  const dead = buildTurnWasWasted(child({ ...CUT, ok: false, exitCode: 1 }), ctx());
  assert(
    dead.wasted === true,
    `(2) precondition: an unhappy exit alone does not refuse the ask — the detector reads recorded fields, not the caller's verdict (${JSON.stringify(dead)})`,
  );
  const faulted = buildTurnWasWasted(
    child({ ...CUT, errorStop: { reason: "error", message: "HTTP 503" } }),
    ctx(),
  );
  assert(
    faulted.wasted === false && faulted.reason === "provider-fault",
    `(2) a provider fault is routed by dispatchBuilder today and gains no same-session ask here (${JSON.stringify(faulted)})`,
  );
  const spent = buildTurnWasWasted(child(CUT), ctx({ budgetFired: true }));
  assert(
    spent.wasted === false && spent.reason === "budget-fired",
    `(2) and a step whose ceiling already fired spends nothing — the turns/tokens levers share one AbortController, so the continuation would be born aborted (${JSON.stringify(spent)})`,
  );
}

// ── (3) silence is never a pass, in either direction ───────────────────────
{
  const absent = buildTurnWasWasted(child({ toolUses: [], observedToolCalls: 0 }), ctx());
  assert(
    absent.wasted === false && absent.reason === "no-final-turn",
    `(3) a result with NO recorded stop reason gets no ask — absent must stay distinguishable from every parsed value (${JSON.stringify(absent)})`,
  );
  const clean = buildTurnWasWasted(child({ stopReason: "stop" }), ctx({ noChange: false }));
  assert(
    JSON.stringify(absent) !== JSON.stringify(clean),
    `(3) and the absence is DISTINCT from a clean stop that made a change (absent ${JSON.stringify(absent)} vs clean ${JSON.stringify(clean)})`,
  );
  const nonString = buildTurnWasWasted(
    child({ ...CUT, stopReason: 42 as unknown as string }),
    ctx(),
  );
  assert(
    nonString.wasted === false && nonString.reason === "no-final-turn",
    `(3) a non-string stop reason is not a stop reason (${JSON.stringify(nonString)})`,
  );
  // The live counter contradicting an empty replay is the un-vouchable shape: `toolUses` is empty
  // for a child killed mid-flight, so `observedToolCalls` is what says calls happened.
  const contradicted = buildTurnWasWasted(child({ ...CUT, observedToolCalls: 4 }), ctx());
  assert(
    contradicted.wasted === false && contradicted.reason === "made-tool-call",
    `(3) a child whose live counter saw calls its replay did not carry is not vouchable as call-free (${JSON.stringify(contradicted)})`,
  );
  const agrees = buildTurnWasWasted(child({ ...CUT, observedToolCalls: 0 }), ctx());
  assert(
    agrees.wasted === true,
    `(3) and a live counter of zero AGREES with the empty replay (${JSON.stringify(agrees)})`,
  );
  for (const reason of ["end_turn", "tool_use", "aborted", "", "length-but-not"]) {
    const v = buildTurnWasWasted(child({ ...CUT, stopReason: reason }), ctx());
    assert(
      v.wasted === false && v.reason === "other-stop",
      `(3) stopReason ${JSON.stringify(reason)} is neither the cap nor a clean stop, so nothing is asked (${JSON.stringify(v)})`,
    );
  }
}

// ── (4) the second shape is the FOLD's answer, not the child's ─────────────
{
  const changed = buildTurnWasWasted(child({ stopReason: "stop" }), ctx({ noChange: false }));
  assert(
    changed.wasted === false && changed.reason === "other-stop",
    `(4) a clean stop whose fold FOUND a change is an ordinary build — the ask is refused on a builder that wrote bytes (${JSON.stringify(changed)})`,
  );
  const cutUnchanged = buildTurnWasWasted(child(CUT), ctx({ noChange: true }));
  assert(
    cutUnchanged.wasted === true,
    `(4) precondition: the cut arm does not depend on the fold's answer (${JSON.stringify(cutUnchanged)})`,
  );
}

// ── (5) the switch: only the literal 0, read at CALL time ───────────────────
{
  await withEnv({ PI_ENSEMBLE_LEAN_BUILD_REASK: undefined }, async () => {
    const on = buildTurnWasWasted(child(CUT), ctx());
    assert(on.wasted === true, `(5) default ON: the cut turn is asked (${JSON.stringify(on)})`);
  });
  await withEnv({ PI_ENSEMBLE_LEAN_BUILD_REASK: "0" }, async () => {
    const off = buildTurnWasWasted(child(CUT), ctx());
    assert(
      off.wasted === false && off.reason === "switch-off",
      `(5) 0 turns the whole change off (${JSON.stringify(off)})`,
    );
  });
  for (const value of ["", "false", "NO", " 0 ", "00", "one"]) {
    await withEnv({ PI_ENSEMBLE_LEAN_BUILD_REASK: value }, async () => {
      const v = buildTurnWasWasted(child(CUT), ctx());
      assert(
        v.wasted === true,
        `(5) PI_ENSEMBLE_LEAN_BUILD_REASK=${JSON.stringify(value)} is not an operator asking for the old behaviour (${JSON.stringify(v)})`,
      );
    });
  }
}

// ── (6) the prompts and the clause say what they must, and stay short ──────
{
  const cut = buildReaskPrompt(2661, "length");
  assert(
    cut.includes("output budget") && cut.includes("tool calls") && cut.includes("reasoning short"),
    `(6) the cut prompt names the output budget, demands tool calls now, and says keep reasoning short (${JSON.stringify(cut.slice(0, 80))})`,
  );
  assert(cut.includes("#2661"), "(6) and it names the issue the child is working");
  const noChange = buildReaskPrompt(2661, "no-change");
  assert(
    noChange.includes("unchanged") && noChange.includes("tool call"),
    `(6) the no-change prompt says the tree is unchanged and names the missing tool call (${JSON.stringify(noChange.slice(0, 80))})`,
  );
  assert(
    noChange !== cut,
    "(6) and the two shapes get different prompts — a cut child is told something a declining child is not",
  );
  const clause = buildReaskClause("length", 16384);
  assert(
    clause.includes("output-token limit") && clause.includes("16384") && clause.includes("one continuation"),
    `(6) the clause names the cap, the child's own token count, and the spent ask (${JSON.stringify(clause)})`,
  );
  assert(
    clause.length <= 140,
    `(6) and it is short by construction — it is appended to a reason the consumer clips from the end (${String(clause.length)})`,
  );
  const stopClause = buildReaskClause("no-change", 12);
  assert(
    !stopClause.includes("output-token limit") && stopClause.includes("tool call"),
    `(6) the sibling clause names the missing tool call and not a cap it never hit (${JSON.stringify(stopClause)})`,
  );
  assert(
    BUILD_REASK_BOUND_MS === 15 * 60_000,
    `(6) the seat's own per-child bound is the shipped 15 min (${String(BUILD_REASK_BOUND_MS)})`,
  );
  assert(
    CLEAN_STOP_REASON === "stop",
    `(6) and the clean stop literal is the shipped one (${CLEAN_STOP_REASON})`,
  );
}

process.exit(failures());
