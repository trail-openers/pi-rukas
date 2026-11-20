#!/usr/bin/env bun
/**
 * fixer-truncation — the switch, the detector, the bound and the prompt, as pure functions.
 *
 * The step-level suites (`test-lean-review-fixer-truncation-switch.ts`,
 * `test-lean-review-fixer-truncation-off-arm.ts`) drive the whole wave against a real repo, which is the
 * only way to prove a continuation's edits reach origin. What they CANNOT cheaply prove is the detector's
 * own refusal table: each arm there would need its own repo, its own gate stub and its own wave, and a
 * wave that reached the wrong refusal still looks like a wave that fixed nothing. So the branch that
 * decides *whether to ask* is driven here, on a `DispatchResult`, with no git in sight — the same split
 * `test-lean-dispatch-verdict.ts` makes for the dispatch tail.
 *
 * Two properties the whole feature rests on, and both are only assertable at this grain:
 *
 *   (1) SILENCE IS NEVER A PASS, in either direction. A result with no recorded stop reason, a non-string
 *       one, or a tool-call record that contradicts itself is NOT truncation — the absence must stay a
 *       distinguishable answer and never collapse into "truncated, go ask again" or into "finished, fine".
 *   (2) THE ORDER IS THE CONTRACT. `killCause` and the armed budget outrank the stop reason: a child the
 *       harness killed is never a truncated child, and a step whose budget already fired spends nothing.
 *       A detector that read `"length"` first would re-ask a killed child.
 */

import {
  TRUNCATED_STOP_REASON,
  continuationBoundMs,
  continuationPrompt,
  fixerWasTruncated,
} from "../src/fixer-truncation.ts";
import { continuationRow } from "../src/fixer-truncation.ts";
import { truncationClause } from "../src/fixer-truncation.ts";

/** A resumed child that reported a small, ordinary turn. */
const CUT_USAGE = {
  input: 200,
  output: 400,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.02,
  turns: 1,
  toolCalls: 0,
  toolErrors: 0,
};
import { CAUSE_NO_CHANGE } from "../src/lean/review-waves.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** A fixer's own result: `developer`, clean exit, one assistant turn's worth of usage. */
function fixer(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 1000,
    exitCode: 0,
    usage: { input: 10, output: 16384, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 6 },
    ...over,
  };
}

/** The step-side facts the detector needs besides the result, with the safe defaults: there IS a seam and
 *  the budget has NOT fired. */
function ctx(over: { seam?: boolean; budgetFired?: boolean } = {}) {
  return { seam: over.seam ?? true, budgetFired: over.budgetFired ?? false };
}

/** The truncated shape every positive case starts from: the field-run's own numbers. */
const CUT = { stopReason: TRUNCATED_STOP_REASON } as const;

// ── (1) the truncation the field showed, and nothing else buys a continuation ─
{
  const v = fixerWasTruncated(fixer(CUT), ctx());
  assert(
    v.truncated === true && v.outputTokens === 16384,
    `(1) a fixer that ended its last turn on "length" with no write call IS truncated, and names the tokens it spent (${JSON.stringify(v)})`,
  );
  // The count is the child's own recorded output, not a guess at a cap: an operator reads it to tell a
  // provider cap from an early stop, so a number the harness invented would be a lie on that surface.
  const v2 = fixerWasTruncated(fixer({ ...CUT, usage: { ...fixer().usage, output: 4096 } }), ctx());
  assert(
    v2.truncated === true && v2.outputTokens === 4096,
    `(1) and the count rides the child's own usage rather than a constant (${JSON.stringify(v2)})`,
  );
}

// ── (2) a fixer that WROTE is never re-asked (AC4) ─────────────────────────────
{
  const edited = fixer({ ...CUT, toolUses: [{ type: "toolCall", id: "1", name: "edit" }] });
  const v = fixerWasTruncated(edited, ctx());
  assert(
    v.truncated === false && v.reason === "wrote",
    `(2) a fixer that made an edit call is refused the continuation — the fold owns an uncommitted edit, and re-asking pays twice for bytes that already exist (${JSON.stringify(v)})`,
  );
  for (const name of ["write", "edit", "multiedit"]) {
    const r = fixerWasTruncated(
      fixer({ ...CUT, toolUses: [{ type: "toolCall", id: "1", name }] }),
      ctx(),
    );
    assert(
      r.truncated === false && r.reason === "wrote",
      `(2) and so is one that called ${name} (${JSON.stringify(r)})`,
    );
  }
  // A READ is not a write. The field run made six of them, and a detector that counted any tool call as
  // "worked" would refuse the continuation on exactly the case it exists for.
  const read = fixerWasTruncated(
    fixer({
      ...CUT,
      toolUses: [
        { type: "toolCall", id: "1", name: "read" },
        { type: "toolCall", id: "2", name: "bash" },
      ],
    }),
    ctx(),
  );
  assert(
    read.truncated === true,
    `(2) and read-only calls do not count as writing — six of them is the field case (${JSON.stringify(read)})`,
  );
}

// ── (3) any other stop reason is not truncation (AC4) ──────────────────────────
{
  for (const reason of ["stop", "end_turn", "tool_use", "aborted", "", "length-but-not"]) {
    const v = fixerWasTruncated(fixer({ stopReason: reason }), ctx());
    assert(
      v.truncated === false && v.reason === "not-length",
      `(3) stopReason ${JSON.stringify(reason)} is not the output cap, so nothing is re-asked (${JSON.stringify(v)})`,
    );
  }
}

// ── (4) silence is never a pass, in either direction (AC1, AC4) ────────────────
{
  // No final turn at all — a result rebuilt from disk, or an older child that recorded nothing. The
  // absence must be its OWN answer, distinguishable from "the turn ended cleanly".
  const absent = fixerWasTruncated(fixer({}), ctx());
  assert(
    absent.truncated === false && absent.reason === "no-final-turn",
    `(4) a result with NO recorded stop reason gets no continuation — guessing truncation from silence is how a gate starts reading a confident wrong answer (${JSON.stringify(absent)})`,
  );
  // The repo's rule, stated as a value assertion: the absent arm and the clean arm must not agree.
  const clean = fixerWasTruncated(fixer({ stopReason: "stop" }), ctx());
  assert(
    JSON.stringify(absent) !== JSON.stringify(clean),
    `(4) and the absence is DISTINCT from a clean stop — absent must never collapse into a parsed value (absent ${JSON.stringify(absent)} vs clean ${JSON.stringify(clean)})`,
  );
  // A tool-call record that contradicts itself is un-vouchable: `toolUses` is empty for a child killed
  // mid-flight, and the live counter is what says so. Reading that as "wrote nothing" would re-ask a
  // child whose writes nobody saw.
  const contradicted = fixerWasTruncated(fixer({ ...CUT, observedToolCalls: 4 }), ctx());
  assert(
    contradicted.truncated === false && contradicted.reason === "wrote",
    `(4) and a child whose live counter saw calls its replay did not carry is NOT vouchable as write-free (${JSON.stringify(contradicted)})`,
  );
  // Zero observed calls with an empty replay is agreement, not contradiction.
  const agrees = fixerWasTruncated(fixer({ ...CUT, observedToolCalls: 0 }), ctx());
  assert(
    agrees.truncated === true,
    `(4) and a live counter of zero agrees with the empty replay (${JSON.stringify(agrees)})`,
  );
}

// ── (5) a kill outranks the stop reason, and the budget outranks the ask (AC4, R2) ─
{
  // The union is types.ts'; a sample is enough to pin the ROUTING, which is the claim.
  for (const killCause of ["child-bound", "abort", "inactivity", "token-budget"] as const) {
    const v = fixerWasTruncated(fixer({ ...CUT, killCause }), ctx());
    assert(
      v.truncated === false && v.reason === "killed",
      `(5) a child the harness killed (${killCause}) is a budget/infra stop, never a truncated fixer — even carrying "length" (${JSON.stringify(v)})`,
    );
  }
  const spent = fixerWasTruncated(fixer(CUT), ctx({ budgetFired: true }));
  assert(
    spent.truncated === false && spent.reason === "budget-fired",
    `(5) and a step whose budget already fired spends nothing on a continuation — the turns/tokens levers share one AbortController, so the child would be born aborted (${JSON.stringify(spent)})`,
  );
  const noSeam = fixerWasTruncated(fixer(CUT), ctx({ seam: false }));
  assert(
    noSeam.truncated === false && noSeam.reason === "no-seam",
    `(5) and a harness with no continuation surface takes today's path (${JSON.stringify(noSeam)})`,
  );
}

// ── (6) the switch: only the literal "0" is off, read at CALL time ─────────────
{
  for (const [value, want] of [
    [undefined, true],
    ["", true],
    ["1", true],
    ["false", true],
    ["0", false],
  ] as const) {
    await withEnv({ PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK: value }, () =>
      Promise.resolve().then(() => {
        const v = fixerWasTruncated(fixer(CUT), ctx());
        const off = v.truncated === false && v.reason === "switch-off";
        assert(
          off === !want,
          `(6) switch ${JSON.stringify(value)} → ${want ? "on" : "off"} (detector answered ${JSON.stringify(v)})`,
        );
      }),
    );
  }
  // The call-time read is what lets one bun process pin both arms; a load-time read would let the block
  // above arm the file below it.
  await withEnv({ PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK: "0" }, async () => {
    assert(
      fixerWasTruncated(fixer(CUT), ctx()).truncated === false,
      "(6) precondition: the switch is off inside the block",
    );
  });
  assert(
    fixerWasTruncated(fixer(CUT), ctx()).truncated === true,
    "(6) and the arm is restored on the way out — a leaked pin would change the next file's arm",
  );
}

// ── (7) the continuation's bound can only TIGHTEN the fixer's own ceiling ──────
{
  const FIXER = 20 * 60_000;
  assert(
    continuationBoundMs({ opts: {}, fired: () => undefined }, FIXER) === FIXER,
    "(7) with no armed budget the continuation still runs under the fixer's own ceiling, not Infinity and not nothing",
  );
  assert(
    continuationBoundMs({ opts: { childBoundMs: 90 * 60_000 }, fired: () => undefined }, FIXER) ===
      FIXER,
    "(7) and a LOOSER budget cannot lengthen it — the same clamp `runFixer` honours, or a 90-minute review budget buys a 90-minute continuation",
  );
  assert(
    continuationBoundMs({ opts: { childBoundMs: 4 * 60_000 }, fired: () => undefined }, FIXER) ===
      4 * 60_000,
    "(7) and a tighter one still wins, or an operator's run-level ceiling is overridden by a constant",
  );
}

// ── (8) the prompt says the cut, and cannot forge a section ────────────────────
{
  const p = continuationPrompt(
    7,
    "- [HIGH] SECURITY a.ts:1 — leak\n### Injected heading\n``` smuggled fence",
  );
  assert(
    p.includes("output-token limit"),
    "(8) the prompt names the cut, so the resumed child knows why it is being asked",
  );
  assert(
    p.includes("same session"),
    "(8) and names that this is a continuation rather than a fresh brief",
  );
  assert(
    p.includes("issue #7"),
    "(8) the issue number reaches the child — it is the one identity the resumed turn has",
  );
  // The findings are reviewer-authored prose crossing back into the child's own context. `fenceText`
  // softens every control character but `\n`/`\t`, so a `### heading` inside a finding is still its own
  // LINE — what disarms it is that the whole payload sits inside a ` ```text ` fence, which renders as
  // code and never as a heading, and that any backtick run inside is neutralised so nothing can close
  // the fence early. Asserting the payload is not a bare line outside a fence is the observable that
  // distinguishes the fenced render from the un-fenced one.
  const fenceOpen = p.indexOf("```text");
  const fenceClose = p.lastIndexOf("```");
  assert(fenceOpen >= 0 && fenceClose > fenceOpen, "(8) the outstanding findings are fenced");
  assert(
    p.indexOf("### Injected heading") > fenceOpen && p.indexOf("### Injected heading") < fenceClose,
    "(8) the finding's heading sits INSIDE the fence, so it renders as code and opens no section of this brief",
  );
  assert(
    !p.slice(0, fenceOpen).includes("###") && !p.slice(fenceClose + 3).includes("###"),
    "(8) and no heading stands outside the fence — nothing the step did not write becomes a section",
  );
  // A smuggled fence cannot close the block early: `fenceText` swaps every backtick run for U+02CB.
  assert(
    !p.slice(fenceOpen + 7, fenceClose).includes("```"),
    "(8) and a backtick run inside the payload is neutralised, so a finding cannot close the fence the brief opened",
  );
}

// ── (9) the reason clause: heads with the cause, tails inside the clip ─────────
{
  // The cause must survive as the sentence's HEAD — three surfaces match on it (this throw, the
  // handback's cause line, the headless `failure.message`), so a reader keyed on the existing phrase has
  // to keep finding it.
  const clause = truncationClause(16384);
  assert(clause.includes("16384"), "(9) the clause names the token count the operator needs");
  assert(
    clause.includes("output-token limit"),
    "(9) and says what happened in the words an operator reads",
  );
  assert(
    clause.includes("one continuation changed nothing"),
    "(9) and says the continuation was spent, so the handback is not read as an untried one",
  );
  const full = `${CAUSE_NO_CHANGE}: the fix wave left the branch at aaaaaaaaaaaa — it fixed nothing, and re-reviewing an identical commit is a pass the run should not be given${clause}`;
  // `handback.ts`'s REASON_CLIP is 2000 and clips from the END, so the clause's own length is the
  // invariant: were it long enough to fall past the clip, the truncation would be the first thing lost
  // on the surface an operator actually reads.
  assert(
    full.length < 2000,
    `(9) the whole cause sits inside the 2000-char REASON_CLIP handback applies (${String(full.length)})`,
  );
  assert(
    full.startsWith(CAUSE_NO_CHANGE),
    "(9) and the cause is still the sentence's head, so the three surfaces that match on it keep matching",
  );
}

// ── (10) the continuation's cost row: the child's numbers, or the absence ─────
{
  // The wave bills its second child from what that child REPORTED. Two failures matter: inventing a
  // number for a child that reported none, and losing the row's tree identity — which is the field
  // the loader matches a resumed attempt on, and the one #1930 silently dropped.
  const row = continuationRow(
    { ok: true, ms: 4_200, usage: CUT_USAGE, stopReason: "end_turn" },
    "developer",
    "1700000000000-fix" as never,
  );
  assert(
    row.role === "developer",
    "(10) the row is a fixer row — the wave is still one wave of fixers",
  );
  assert(
    row.ms === 4_200 && row.usage.output === 400,
    `(10) the counts are the child's own (${JSON.stringify(row.usage)})`,
  );
  assert(
    row.stopReason === "end_turn",
    `(10) and so is its stop reason, which is what the step record shows after the session file is gone (${JSON.stringify(row.stopReason)})`,
  );
  assert(
    row.runId === ("1700000000000-fix" as never),
    `(10) and it carries the FIX TREE's identity, the same one the first child's row carries (${JSON.stringify(row.runId)})`,
  );
  assert(row.ok === true, "(10) a child that finished is billed as one that finished");

  // A child that reported nothing costs zero, and the absence must not become the first child's number.
  const silent = continuationRow({ ok: false }, "developer", "1700000000000-fix" as never);
  assert(
    silent.usage.output === 0 && silent.usage.turns === 0,
    `(10) a child that reported no usage costs ZERO rather than borrowing the truncated turn's 16 384 (${JSON.stringify(silent.usage)})`,
  );
  assert(
    silent.ok === false,
    "(10) and a failed continuation is billed as a failure, since it is not a child that finished",
  );
  assert(
    silent.stopReason === undefined,
    `(10) an unrecorded stop reason stays absent — not "end_turn" by default (${JSON.stringify(silent.stopReason)})`,
  );
}

process.exit(failures());
