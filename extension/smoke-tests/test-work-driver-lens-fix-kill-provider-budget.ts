#!/usr/bin/env bun
/**
 * #1798 round 5 — the STORE bound must never sit below the phrase the
 * classifier reads.
 *
 * Round 4 narrowed `providerMessage` to `FAILURE_REASON_CHARS` (240) while
 * keeping the front of the body. Classification does not happen at write time:
 * the step router runs `classifyFailureCause` over the STORED text much later,
 * and the spend-cap / retry-delay regexes match ANYWHERE in it. A realistic
 * provider body — gateway prefix, request id, then the terminal phrase — pushed
 * that phrase past char 240, so a genuine spend cap read as a plain 429, a quota
 * window read as a severance, and `isSystemicFailure` let every remaining queue
 * group start into the same cap. Before round 4 the provider kind stored the
 * body RAW, so the narrowing was new.
 *
 * The fix is the budget, not the clip direction: the front clip and the
 * redact-then-clip ORDER both stay (`test-work-driver-lens-fix-kill-redaction.ts`
 * pins them), and `errorTail` keeps its own reason budget.
 *
 * Every body here is ASSEMBLED AT RUNTIME from pieces, exactly as the companion
 * file does, so this file's own bytes never carry a credential-class string that
 * a hygiene scan would (rightly) flag.
 */
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { isSystemicFailure } from "../src/work-queue.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import {
  MIN,
  killed,
  killedByProvider,
  lensFixCtx,
  lensFixWindow,
} from "./lib/lens-fix-kill-cause-fixtures.ts";
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import { PROVIDER_MAX } from "../src/provider-text-budget.ts";
import { FAILURE_REASON_CHARS } from "../src/work-driver-failure-taxonomy.ts";

let exitCode = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

/** Fillers/prefixes built from pieces so the terminal phrase is the only
 *  meaningful text in the body, and sits FAR past the 240-char reason budget. */
function gatewayPrefix(): string {
  return ["gateway", "edge-cache-7", "req_9f3a21c4b8", "upstream-v2"].join(" · ");
}

/** `fillerChars` of neutral padding — NOT a credential shape, so the redaction
 *  seam leaves the phrase intact and only the BOUND can lose it. */
function filler(n: number): string {
  return Array.from({ length: Math.ceil(n / 8) }, () => "detail-block").join(" ").slice(0, n);
}

/** The two provider bodies, with the terminal phrase deliberately late. */
const PREFIX = gatewayPrefix();
const PAST_240 = filler(200);

const spendCapBody = `${PREFIX} ${PAST_240} 429 status code — monthly ${["spend", "cap"].join(" ")} reached, contact billing`;
const quotaWindowBody = `${PREFIX} ${PAST_240} Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code (no body)`;

async function providerKindEvent(message: string) {
  const result = {
    ok: false,
    ms: MIN,
    exitCode: 0,
    text: "",
    toolUses: [],
    errorStop: { reason: "error", message },
  } as never;
  return (await buildCompletionEvent(
    lensFixCtx(result) as never,
    "lens-fix",
    "developer",
    "lens-fix",
    result,
  )) as Extract<WorkEvent, { kind: "dispatch-failed-provider" }>;
}

// ─── 1. the fixture really puts the phrase past the reason budget ───
{
  assert(
    spendCapBody.length > FAILURE_REASON_CHARS &&
      spendCapBody.indexOf("spend") > FAILURE_REASON_CHARS,
    `the spend-cap phrase sits PAST the 240-char reason budget (idx=${spendCapBody.indexOf("spend")}, len=${spendCapBody.length})`,
  );
  assert(
    quotaWindowBody.length > FAILURE_REASON_CHARS &&
      quotaWindowBody.indexOf("retry delay") > FAILURE_REASON_CHARS,
    `…and so does the quota window's stated delay (idx=${quotaWindowBody.indexOf("retry delay")})`,
  );
}

// ─── 2. provider kind: a late spend cap still halts the queue ───
{
  const ev = await providerKindEvent(spendCapBody);
  assert(
    ev.providerMessage !== undefined && ev.providerMessage.includes("spend"),
    "the stored provider-kind providerMessage still carries the terminal phrase",
  );
  const cls = classifyFailureCause(ev as never);
  assert(
    cls.cause === "rate-limited:quota-terminal",
    `a late spend-cap 429 classifies TERMINAL, not as a plain 429 (got ${cls.cause})`,
  );
  const state = await lensFixWindow([
    {
      ok: false,
      ms: MIN,
      exitCode: 0,
      text: "",
      toolUses: [],
      errorStop: { reason: "error", message: spendCapBody },
    } as never,
  ]);
  assert(
    isSystemicFailure(state).systemic,
    "…and isSystemicFailure halts the queue on it (a spend cap is every group's problem)",
  );
}

// ─── 3. provider kind: a late quota window still halts the queue ───
{
  const ev = await providerKindEvent(quotaWindowBody);
  const cls = classifyFailureCause(ev as never);
  assert(
    cls.cause === "rate-limited:quota-window",
    `a late quota-window 429 classifies as the WINDOW rung, not a severance (got ${cls.cause})`,
  );
  assert(
    cls.waitMs === 86_399_000,
    `…and keeps the delay the provider actually asked for (waitMs=${String(cls.waitMs)})`,
  );
  const state = await lensFixWindow([
    {
      ok: false,
      ms: MIN,
      exitCode: 0,
      text: "",
      toolUses: [],
      errorStop: { reason: "error", message: quotaWindowBody },
    } as never,
  ]);
  assert(
    isSystemicFailure(state).systemic,
    "…and the queue halts on the window too — nothing succeeds until it resets",
  );
}

// ─── 4. the killed kind owns the same field, so it gets the same budget ───
{
  const result = killedByProvider(spendCapBody);
  const ev = (await buildCompletionEvent(
    lensFixCtx(result) as never,
    "lens-fix",
    "developer",
    "lens-fix",
    result,
  )) as Extract<WorkEvent, { kind: "dispatch-failed" }>;
  assert(
    ev.killCause === "timeout" && ev.providerMessage !== undefined,
    `the killed kind keeps its kill AND its provider field (cause=${ev.killCause})`,
  );
  assert(
    (ev.providerMessage ?? "").includes("spend"),
    "…at a budget that reaches the phrase behind a 200-char gateway prefix",
  );
  const cls = classifyFailureCause(ev as never);
  assert(
    cls.cause === "rate-limited:quota-terminal" && cls.shouldRetry === false,
    `a fixer killed at its bound by a late spend cap is TERMINAL and never retried (got ${cls.cause}/retry=${cls.shouldRetry})`,
  );
  const state = await lensFixWindow([result]);
  assert(
    isSystemicFailure(state).systemic,
    "…and that killed dispatch halts the remaining groups (round 3's original defect)",
  );
}

// ─── 5. the bound is the writer's job, and it is the SHARED one ───
{
  const huge = `${spendCapBody} ${filler(PROVIDER_MAX * 2)}`;
  assert(huge.length > PROVIDER_MAX + 400, `the fixture exceeds the store budget (len=${huge.length})`);
  const ev = await providerKindEvent(huge);
  assert(
    ev.providerMessage !== undefined && ev.providerMessage.length <= PROVIDER_MAX,
    `a >${PROVIDER_MAX}-char body is stored at most ${PROVIDER_MAX} chars (len=${ev.providerMessage?.length})`,
  );
  // A credential-shaped token assembled at runtime, near the END: the bound has
  // to bind even when the redaction seam would prefer to keep scanning.
  const secret = ["sk-ant", "api03", "AbCdEf0123456789ghi", "jKlMnOpQrStUvwXy"].join("-");
  const leaked = await providerKindEvent(`${filler(PROVIDER_MAX)} ${secret} trailing`);
  assert(
    leaked.providerMessage !== undefined && !leaked.providerMessage.includes(secret),
    "…and a credential past the bound never lands in the stored text",
  );
  assert(
    ev.providerMessage !== undefined && classifyFailureCause(ev as never).cause === "rate-limited:quota-terminal",
    "clipping at the store budget still leaves the classifier's phrase intact",
  );
}

// ─── 6. errorTail keeps ITS bound — the two fields are not one budget ───
{
  const result = killed({
    errorStop: { reason: "error", message: spendCapBody },
  });
  const ev = (await buildCompletionEvent(
    lensFixCtx(result) as never,
    "lens-fix",
    "developer",
    "lens-fix",
    result,
  )) as Extract<WorkEvent, { kind: "dispatch-failed" }>;
  assert(
    (ev.errorTail ?? "").length <= FAILURE_REASON_CHARS,
    `the composed errorTail stays at the reason budget while providerMessage widens (len=${ev.errorTail?.length})`,
  );
  assert(
    (ev.providerMessage?.length ?? 0) > (ev.errorTail?.length ?? 0),
    "…which means the stored provider text is now LONGER than the scrollback line, by design",
  );
}

console.log(
  exitCode === 0
    ? "\n#1798 round 5 provider store budget keeps terminal classification on both kinds: all assertions passed"
    : "\n#1798 round 5 provider store budget: FAILURES above",
);
process.exit(exitCode);
