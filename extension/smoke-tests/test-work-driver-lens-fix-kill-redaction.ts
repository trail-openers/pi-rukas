#!/usr/bin/env bun
/**
 * #1798 round 4 — a credential the REDACTION has to reach, and the bounds a
 * resumed cycle is allowed to carry.
 *
 * Two surfaces the provider text touches on its way into a state file, both
 * pinned here through the real writer (`buildCompletionEvent`) rather than a
 * hand-written event:
 *
 *  1. **The redaction edge.** A credential sitting PAST the reason budget in a
 *     long provider body is the shape a "redact then clip" seam can miss: clip
 *     first and the token is gone only because the whole window dropped it,
 *     which is not a redaction and leaves every nearby fragment intact. The
 *     writer's `boundedProviderText` redacts FIRST and clips AFTER, so the
 *     token must appear as `[REDACTED]` in BOTH stored surfaces — the
 *     structured `providerMessage` and the composite `errorTail` — and never as
 *     itself.
 *
 *  2. **The bound on a resumed value.** `readState`'s untyped cast is the only
 *     runtime gate on what a state file holds (#533), and this field decides
 *     whether the WHOLE queue halts (#1798 round 3). So `validateDiscriminants`
 *     refuses a `providerMessage` longer than the maximum the writer can
 *     actually produce — the classifier's own `FAILURE_REASON_CHARS`, plus the
 *     slack one redaction marker needs when it lands in a window already at the
 *     budget.
 *
 * The token is ASSEMBLED AT RUNTIME (`credential()`), exactly as
 * `test-work-driver-lens-fix-kill-provider-queue.ts` does, so this file's own
 * bytes never carry a credential-class string that a hygiene scan would (rightly)
 * flag.
 */
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import { FAILURE_REASON_CHARS } from "../src/work-driver-failure-taxonomy.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";
import {
  MIN,
  NOW,
  killedByProvider,
  lensFixCtx,
} from "./lib/lens-fix-kill-cause-fixtures.ts";

let exitCode = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

/** A credential-shaped token, built at runtime (see the header). */
function credential(): string {
  return ["sk-ant", "api03", "AbCdEf0123456789ghi", "jKlMnOpQrStUvwXy"].join("-");
}

const SECRET = credential();

/** A provider body LONGER than the reason budget, with the credential placed
 *  past `FAILURE_REASON_CHARS` — the position the naive clip-first seam loses.
 *  429 wording up front so the text is still the shape the classifier reads. */
function longBodyWithCredentialAfterTheBudget(): string {
  const head = "429 status code — request rejected, see the request header below; ";
  const filler = "x".repeat(FAILURE_REASON_CHARS - head.length + 40);
  return `${head}${filler} invalid api key ${SECRET} in request header`;
}

// ───────────────────────── 1. the redaction reaches past the budget ─────────
{
  const body = longBodyWithCredentialAfterTheBudget();
  assert(
    body.length > FAILURE_REASON_CHARS && body.includes(SECRET),
    `the fixture is a >${FAILURE_REASON_CHARS}-char body with the credential after that offset (len=${body.length})`,
  );

  const ev = (await buildCompletionEvent(
    lensFixCtx(killedByProvider(body)) as never,
    "lens-fix",
    "developer",
    "lens-fix",
    killedByProvider(body),
  )) as Extract<WorkEvent, { kind: "dispatch-failed" }>;

  assert(
    ev.providerMessage !== undefined && !ev.providerMessage.includes(SECRET),
    `the stored providerMessage does not carry the token (got ${JSON.stringify(ev.providerMessage)?.slice(0, 100)})`,
  );
  assert(
    ev.providerMessage?.includes("[REDACTED]") === true,
    "…and says so with the marker, rather than silently dropping the window",
  );
  assert(
    (ev.errorTail ?? "").includes("[REDACTED]") && !(ev.errorTail ?? "").includes(SECRET),
    "…and the SAME text inside errorTail is redacted too — one reading, both surfaces",
  );
  // The bound on the COMPOSITE: the kill clause now composes BEFORE the provider
  // note and the whole tail is capped, so the clause survives whole and the
  // tail cannot exceed the reason budget however long the body was.
  assert(
    (ev.errorTail ?? "").length <= FAILURE_REASON_CHARS,
    `the composed errorTail is bounded at the reason budget, clause and all (len=${ev.errorTail?.length})`,
  );
  assert(
    (ev.errorTail ?? "").includes("[pi-rukas] killed"),
    "…and the bound is kept by keeping the KILL CLAUSE, not by keeping the note",
  );
  assert(
    (ev.errorTail ?? "").includes("provider error-stop:"),
    "…and the provider note is still there to read (a long body costs it its tail, not its existence)",
  );
}

// ───────────────── 2. a resumed providerMessage is bounded, not just typed ──
{
  const withProviderMessage = (providerMessage: unknown) => {
    const s = initialState(1798, NOW) as unknown as Record<string, unknown>;
    s.eventLog = [
      {
        kind: "dispatch-failed",
        step: "lens-fix",
        role: "developer",
        jobId: "lens-fix:x:1:1",
        label: "lens-fix",
        ms: MIN,
        at: NOW,
        killCause: "timeout",
        providerMessage,
      },
    ];
    return s;
  };

  // What the writer really produces, from the case above: at or under the
  // budget + one marker of slack. It must validate — a rule that refuses the
  // writer's own output is worse than no rule.
  const real = (await buildCompletionEvent(
    lensFixCtx(killedByProvider(longBodyWithCredentialAfterTheBudget())) as never,
    "lens-fix",
    "developer",
    "lens-fix",
    killedByProvider(longBodyWithCredentialAfterTheBudget()),
  )) as Extract<WorkEvent, { kind: "dispatch-failed" }>;
  assert(
    validateDiscriminants(withProviderMessage(real.providerMessage)).length === 0,
    `the writer's own providerMessage validates at ${String(real.providerMessage?.length)} chars`,
  );
  assert(
    validateDiscriminants(
      withProviderMessage("y".repeat(FAILURE_REASON_CHARS + "[REDACTED]".length)),
    ).length === 0,
    "…and at the top of the range the writer can reach (budget + one marker of slack)",
  );
  const tooLong = validateDiscriminants(
    withProviderMessage("y".repeat(FAILURE_REASON_CHARS + "[REDACTED]".length + 1)),
  );
  assert(
    tooLong.length === 1 && (tooLong[0] ?? "").includes("providerMessage"),
    `one past that is refused and names the field (got ${JSON.stringify(tooLong)})`,
  );
  assert(
    (validateDiscriminants(withProviderMessage({ message: "429" }))[0] ?? "").includes(
      "providerMessage",
    ),
    "a non-string is still refused (the type rule is untouched)",
  );
}

console.log(
  exitCode === 0
    ? "\n#1798 round 4 provider redaction + resume bound: all assertions passed"
    : "\n#1798 round 4 provider redaction + resume bound: FAILURES above",
);
process.exit(exitCode);
