#!/usr/bin/env bun
/**
 * Corrective-round and residual-union tests for the /plan gap gate.
 *
 * Split out of test-plan-gap-gate.ts (500-line hard limit). These tests
 * exercise the two fixes from the CRITICAL-only terminal rule follow-up:
 *
 *   - NO-OP ROUND ELIMINATED: a round-1 reply with HIGH/MEDIUM/LOW and
 *     NEEDS_ITERATION must result in exactly ONE gate dispatch (the
 *     corrective branch would iterate over an empty blocking array,
 *     producing a byte-identical body — a provably useless second round).
 *   - CRITICAL STILL ITERATES: a round-1 CRITICAL must still produce two
 *     gate dispatches (the corrective round fires only when blocking is
 *     non-empty).
 *   - UNION DISCLOSURE: with a CRITICAL at round 1 (so a corrective round
 *     fires) plus non-blocking findings in both rounds, the filed body's
 *     residual section contains findings from BOTH rounds (the union, not
 *     just the last).
 *   - RATCHETING (re-pointed): a stream of fresh HIGHs can never prevent
 *     filing — the first round with zero CRITICAL is terminal (one
 *     dispatch, file with residual).
 */

import { setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { runPlanPipeline } from "../src/plan-driver.ts";
import type { Forge } from "../src/forge.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------------------------------------------------- stub the seams

const gatePrompts: string[] = [];

interface ForgeStubState {
  created: { title: string; body: string }[];
  mode: "ok" | "throw" | "empty-url";
  error?: string;
}
const forgeStub: ForgeStubState = { created: [], mode: "ok" };

function installForgeStub() {
  const stub = {
    issueCreate: (title: string, body: string) => {
      forgeStub.created.push({ title, body });
      if (forgeStub.mode === "throw") {
        return Promise.reject(new Error(forgeStub.error ?? "gh: HTTP 403 (rate limit exceeded)"));
      }
      if (forgeStub.mode === "empty-url") {
        return Promise.resolve({ url: "" });
      }
      return Promise.resolve({ url: "https://github.com/test/test/issues/1" });
    },
  } as unknown as Forge;
  setPlanForge(() => Promise.resolve(stub));
}

function makeDispatchStub(gateReply: string | string[]) {
  const replies = Array.isArray(gateReply) ? gateReply : [gateReply];
  let gateIteration = 0;
  return ((pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      const text = replies[gateIteration] ?? replies[replies.length - 1] ?? "";
      gateIteration++;
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none — no overlapping open work",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "summary prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
        },
      ],
      ms: 1,
      exitCode: 0,
    } as never);
  }) as never;
}

// Install the forge stub BEFORE any non-dryRun invocation.
installForgeStub();

// ------------------------------ NO-OP ROUND ELIMINATED (speed fix)

{
  // A round-1 reply with HIGH/MEDIUM/LOW and NEEDS_ITERATION must result in
  // exactly ONE gate dispatch. Under CRITICAL-only, the corrective branch
  // would iterate over an EMPTY blocking array, push nothing to openQuestions,
  // and call draftSpec again producing a byte-identical body — a provably
  // useless second round. The gate must go straight to the cap/file path.
  const nonBlockingReplies = [
    "GAP: HIGH the mock curl's -o flag is unspecified — proposed resolution: name the output file\n" +
      "GAP: MEDIUM clarify the boundary — proposed resolution: add a criterion\n" +
      "GAP: LOW heading is cosmetic — proposed resolution: retitle\n" +
      "VERDICT: NEEDS_ITERATION",
    // This reply should NEVER be reached — the gate must not dispatch round 2.
    "GAP: HIGH this should never appear — proposed resolution: nothing\nVERDICT: READY",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  const gatePromptsBefore = gatePrompts.length;
  setPlanDispatch(makeDispatchStub(nonBlockingReplies) as never);

  const r1 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  const gateDispatchCount = gatePrompts.length - gatePromptsBefore;
  assert(
    gateDispatchCount === 1,
    `NO-OP: exactly ONE gate dispatch (got ${gateDispatchCount})`,
  );
  assert(r1.filed === true, `NO-OP: filed (got filed=${r1.filed})`);
  assert(
    r1.capReason === "residual-high",
    `NO-OP: capReason is residual-high (got ${r1.capReason})`,
  );

  setPlanDispatch(null);
}

// ------------------------------ CRITICAL STILL ITERATES

{
  // A round-1 reply with a CRITICAL must still produce two gate dispatches.
  // The corrective round fires only when blocking is non-empty (CRITICAL
  // present). This is the existing behaviour that must be preserved.
  const criticalReplies = [
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: add a criterion\nVERDICT: NEEDS_ITERATION",
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: add a criterion\nVERDICT: NEEDS_ITERATION",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  const gatePromptsBefore = gatePrompts.length;
  setPlanDispatch(makeDispatchStub(criticalReplies) as never);

  const r1 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  const gateDispatchCount = gatePrompts.length - gatePromptsBefore;
  assert(
    gateDispatchCount === 2,
    `CRITICAL-STILL-ITERATES: exactly TWO gate dispatches (got ${gateDispatchCount})`,
  );
  assert(r1.filed === false, `CRITICAL-STILL-ITERATES: not filed (got filed=${r1.filed})`);
  assert(
    r1.capReason === "unresolved-blocking",
    `CRITICAL-STILL-ITERATES: capReason is unresolved-blocking (got ${r1.capReason})`,
  );

  setPlanDispatch(null);
}

// ------------------------------ UNION DISCLOSURE

{
  // With a CRITICAL at round 1 (so a corrective round fires) plus
  // non-blocking findings in both rounds, the filed body's residual section
  // must contain findings from BOTH rounds (the union, not just the last).
  const unionReplies = [
    // Round 1: CRITICAL (fires corrective) + HIGH (non-blocking, round 1 only)
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: add a criterion\n" +
      "GAP: HIGH the mock curl's -o flag is unspecified — proposed resolution: name the output file\n" +
      "VERDICT: NEEDS_ITERATION",
    // Round 2: no CRITICAL (so the cap routes to file) + MEDIUM (round 2 only)
    "GAP: MEDIUM clarify the retry boundary — proposed resolution: sharpen the boundary\n" +
      "VERDICT: NEEDS_ITERATION",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  setPlanDispatch(makeDispatchStub(unionReplies) as never);

  const r1 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  assert(r1.filed === true, `UNION: filed (got filed=${r1.filed})`);
  const filedBody = forgeStub.created[0]?.body ?? "";
  assert(
    filedBody.includes("## Residual gap-gate findings"),
    "UNION: the filed spec has the residual section",
  );
  // Round 1's HIGH finding must be in the residual.
  assert(
    filedBody.includes("mock curl's -o flag"),
    "UNION: round-1 HIGH finding is in the residual section",
  );
  // Round 2's MEDIUM finding must also be in the residual.
  assert(
    filedBody.includes("clarify the retry boundary"),
    "UNION: round-2 MEDIUM finding is in the residual section",
  );
  // Both severities disclosed.
  assert(
    filedBody.includes("[HIGH]"),
    "UNION: [HIGH] severity is disclosed",
  );
  assert(
    filedBody.includes("[MEDIUM]"),
    "UNION: [MEDIUM] severity is disclosed",
  );
  // Adversarial follow-up: the inline cap list must use the SAME union as
  // the filed body — a 2-round CRITICAL-then-HIGH case used to disclose the
  // round-1 HIGH in the body but not in the inline list (last-round-only).
  assert(
    (r1.residualForDisclosure ?? []).some((g) =>
      g.description.includes("mock curl's -o flag"),
    ),
    "UNION follow-up: the residual union on the result carries the round-1 HIGH (inline list source)",
  );
  assert(
    (r1.residualForDisclosure ?? []).some((g) =>
      g.description.includes("clarify the retry boundary"),
    ),
    "UNION follow-up: the residual union on the result carries the round-2 MEDIUM (inline list source)",
  );

  setPlanDispatch(null);
}

// ------------------------------ RATCHETING (re-pointed for single-round)

{
  // Re-pointed ratcheting test: under CRITICAL-only, a stream of fresh HIGHs
  // can never prevent filing. The key property: even if the reviewer
  // ratchets (each round produces different fresh HIGHs), the first round
  // with zero CRITICAL is terminal — one dispatch, file with residual.
  // The old 2-round shape is no longer reachable: round 1 with only HIGHs
  // goes straight to cap/file, so the corrective branch never fires.
  const ratchetingReplies = [
    "GAP: HIGH the mock curl's -o flag is unspecified — proposed resolution: name the output file\n" +
      "GAP: HIGH the grep needle substring-matches adjacent text — proposed resolution: anchor the pattern\n" +
      "VERDICT: NEEDS_ITERATION",
    // This reply should NEVER be reached — round 1 is terminal.
    "GAP: HIGH this should never appear — proposed resolution: nothing\nVERDICT: READY",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  const gatePromptsBefore = gatePrompts.length;
  setPlanDispatch(makeDispatchStub(ratchetingReplies) as never);

  const r1 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  const gateDispatchCount = gatePrompts.length - gatePromptsBefore;
  assert(
    gateDispatchCount === 1,
    `RATCHETING: exactly ONE gate dispatch (got ${gateDispatchCount})`,
  );
  assert(
    r1.filed === true,
    `RATCHETING: fresh-HIGH stream → FILED (got filed=${r1.filed})`,
  );
  assert(
    r1.capReason === "residual-high",
    `RATCHETING: capReason is residual-high (got ${r1.capReason})`,
  );
  assert(
    r1.capReason !== "unresolved-blocking",
    "RATCHETING: the cap never routes a HIGH-only stream to unresolved-blocking",
  );
  const filedBody = forgeStub.created[0]?.body ?? "";
  assert(
    filedBody.includes("## Residual gap-gate findings"),
    "RATCHETING: the filed spec carries the residual section",
  );
  assert(
    filedBody.includes("[HIGH]"),
    "RATCHETING: the residual HIGHs are disclosed with severity",
  );
  assert(
    filedBody.includes("mock curl's -o flag") && filedBody.includes("grep needle"),
    "RATCHETING: both round-1 HIGH findings are disclosed in the residual section",
  );

  setPlanDispatch(null);
}

// ------------------------------ DEDUPE COMPLETENESS (lens finding 1, PR #637)

{
  // Lens review finding 1 (four independent lenses, PR #637): the union
  // dedupe keyed seenDescriptions on the description, but parseGaps had
  // ALREADY truncated it to 300 chars at parse time. Two genuinely different
  // findings sharing a 300-char prefix therefore collided and the second was
  // silently dropped from residualForDisclosure — which feeds BOTH the
  // residual section in the filed issue body AND the inline cap-message
  // list. Under the CRITICAL-only terminal rule, disclosure IS the
  // precondition for filing, so silent under-disclosure breaks the D2
  // guarantee (AGENTS.md §7: "passing a finding on is not discarding it").
  //
  // TDD: this test MUST FAIL before the fix (dedupe on the truncated
  // string drops the second finding) and pass after (dedupe on the FULL
  // string keeps both; truncation happens only at the render sites).
  const sharedPrefix =
    "the retry backoff policy in spawn.ts is under-specified in the following respects: " +
    "x".repeat(320);
  const findingA = `${sharedPrefix} the initial delay is never named`;
  const findingB = `${sharedPrefix} the max delay is never named`;
  const longReplies = [
    `GAP: HIGH — ${findingA} — proposed resolution: name the initial delay\n` +
      `GAP: MEDIUM — ${findingB} — proposed resolution: name the max delay\n` +
      `VERDICT: NEEDS_ITERATION`,
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  setPlanDispatch(makeDispatchStub(longReplies) as never);

  const r1 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  const descs = (r1.residualForDisclosure ?? []).map((g) => g.description);
  assert(
    descs.some((d) => d.includes("the initial delay is never named")),
    "DEDUPE: first finding (shared >300-char prefix) is in the residual disclosure",
  );
  assert(
    descs.some((d) => d.includes("the max delay is never named")),
    "DEDUPE: second finding (same >300-char prefix, different tail) is NOT silently dropped",
  );
  assert(
    (r1.residualForDisclosure ?? []).length === 2,
    `DEDUPE: both findings disclosed (got ${(r1.residualForDisclosure ?? []).length} — a prefix collision dropped one)`,
  );
  // Both renderings (filed body residual section AND inline list source)
  // must carry both findings — the two cannot drift (PERFORMANCE lens).
  // The filed body uses truncateForDisclosure, so the identifying tail
  // (beyond 300 chars) is truncated there — assert on the shared prefix
  // (which IS within 300 chars) to verify both entries are present.
  const filedBody = forgeStub.created[0]?.body ?? "";
  const residualSection = filedBody.slice(filedBody.indexOf("## Residual gap-gate findings"));
  const bulletCount = (residualSection.match(/^- \[/gm) ?? []).length;
  assert(
    bulletCount === 2,
    `DEDUPE: the filed body's residual section has 2 bullets (got ${bulletCount} — a prefix collision dropped one from the body)`,
  );

  setPlanDispatch(null);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
