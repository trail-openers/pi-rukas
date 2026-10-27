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
 *  2. **The bound is the WRITER's job, not the validator's.** `readState`'s
 *     untyped cast is the only runtime gate on what a state file holds (#533),
 *     so `validateDiscriminants` keeps the TYPE rule on `providerMessage`. It
 *     deliberately has NO length rule: a bound in the validator refuses state an
 *     OLDER version wrote legitimately — the `dispatch-failed-provider` writer
 *     stored the provider body raw and unbounded until round 4 — and a cycle
 *     that merely survived an upgrade halts on resume with "unrecognised
 *     value". Both kinds are now written through `boundedProviderText`, so the
 *     bound holds by construction at the write site and legacy longs validate.
 *
 * The token is ASSEMBLED AT RUNTIME (`credential()`), exactly as
 * `test-work-driver-lens-fix-kill-provider-queue.ts` does, so this file's own
 * bytes never carry a credential-class string that a hygiene scan would (rightly)
 * flag.
 */
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import { PROVIDER_MAX } from "../src/provider-text-budget.ts";
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

/** The kill clause + note prefix the composite `errorTail` is built from, hoisted
 *  so the fixture's arithmetic and its assertions read the same numbers. */
const killClauseLength =
  "[pi-rukas] killed after 2700000ms timeout (override: PI_ENSEMBLE_SPAWN_TIMEOUT_MS)".length;
const notePrefix = " · provider error-stop: ";

/** A provider body LONGER than the reason budget, with the credential placed
 *  just INSIDE the store budget but far past `FAILURE_REASON_CHARS` — the one
 *  position that tests both bounds at once.
 *
 *  #1798 round 5 widened the stored `providerMessage` to `PROVIDER_MAX`, so a
 *  token parked at ~240 now sits early enough to survive every clip. Its
 *  position is therefore DERIVED, not hardcoded: the token is placed just inside
 *  the window the composed `errorTail` keeps (the reason budget, less the kill
 *  clause and the note's own prefix), which is where a truncating seam can still
 *  pass as a redaction and only `redactClip` saves it. Past that window the
 *  assertion below would be vacuous — the note's tail is simply gone.
 *  429 wording up front keeps the shape the classifier reads. */
function longBodyWithCredentialAfterTheBudget(): string {
  const head = "429 status code — request rejected, see the request header below; ";
  const noteHead = " · provider error-stop: ";
  // The longest kill clause this file's fixture produces, measured rather than
  // guessed, so the credential lands where the composite note still shows it.
  const killClause = "[pi-rukas] killed after 2700000ms timeout (override: PI_ENSEMBLE_SPAWN_TIMEOUT_MS)";
  const noteBudget = FAILURE_REASON_CHARS - killClause.length - noteHead.length;
  const leadIn = " invalid api key ";
  // Token starts `leadIn.length` before the end of the kept note window, so the
  // marker is IN the tail rather than clipped out of it.
  const offset = noteBudget - leadIn.length - 12;
  const filler = "x".repeat(Math.max(offset - head.length, 1));
  return `${head}${filler}${leadIn}${SECRET} in request header`;
}

// ───────────────────────── 1. the redaction reaches past the budget ─────────
{
  const body = longBodyWithCredentialAfterTheBudget();
  assert(
    body.length > 150 && body.includes(SECRET),
    `the fixture is a provider body carrying the credential (len=${body.length}, token at ${body.indexOf(SECRET)})`,
  );
  assert(
    body.indexOf(SECRET) < FAILURE_REASON_CHARS - killClauseLength - notePrefix.length,
    `the token sits INSIDE the provider note's slice of the reason budget — the window the composite clip keeps, so the seam must REDACT it rather than rely on the cut dropping it (token at ${body.indexOf(SECRET)}, note window ${FAILURE_REASON_CHARS - killClauseLength - notePrefix.length})`,
  );
  assert(
    body.length > FAILURE_REASON_CHARS - killClauseLength - notePrefix.length,
    "…and the body reaches PAST that window, so a plain clip would have hidden the token instead of redacting it — the distinction this file exists to keep honest",
  );
  assert(
    body.indexOf(SECRET) < PROVIDER_MAX,
    `…and inside the widened store budget, so the stored providerMessage still holds it when the seam redacts it (token at ${body.indexOf(SECRET)}, budget=${PROVIDER_MAX})`,
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

// ──────────── 2. the writer bounds BOTH kinds; the validator only types ────
{
  const withProviderMessage = (providerMessage: unknown, kind: string) => {
    const s = initialState(1798, NOW) as unknown as Record<string, unknown>;
    s.eventLog = [
      {
        kind,
        step: "lens-fix",
        role: "developer",
        jobId: "lens-fix:x:1:1",
        label: "lens-fix",
        ms: MIN,
        at: NOW,
        ...(kind === "dispatch-failed"
          ? { killCause: "timeout", exitCode: null }
          : { transcriptPath: "/tmp/pi-rukas-1798/x.json" }),
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
    validateDiscriminants(withProviderMessage(real.providerMessage, "dispatch-failed")).length ===
      0,
    `the writer's own providerMessage validates at ${String(real.providerMessage?.length)} chars`,
  );
  // #1798 round 4 — the PROVIDER kind used to store `result.errorStop.message`
  // RAW: no redaction, no bound. Through the real builder it now gets the same
  // `boundedProviderText` treatment as the kill branch.
  const providerBody = longBodyWithCredentialAfterTheBudget();
  const provEv = (await buildCompletionEvent(
    lensFixCtx({
      ok: false,
      role: "developer",
      ms: MIN,
      exitCode: 0,
      text: "",
      toolUses: [],
      errorStop: { reason: "error", message: providerBody },
    }) as never,
    "lens-fix",
    "developer",
    "lens-fix",
    {
      ok: false,
      role: "developer",
      ms: MIN,
      exitCode: 0,
      text: "",
      toolUses: [],
      errorStop: { reason: "error", message: providerBody },
    } as never,
  )) as Extract<WorkEvent, { kind: "dispatch-failed-provider" }>;
  assert(
    provEv.kind === "dispatch-failed-provider",
    "a dispatch whose only failure is an error-stop is a dispatch-failed-provider event",
  );
  assert(
    provEv.providerMessage !== undefined &&
      provEv.providerMessage.length <= PROVIDER_MAX + "[REDACTED]".length &&
      !provEv.providerMessage.includes(SECRET) &&
      provEv.providerMessage.includes("[REDACTED]"),
    `the provider-kind providerMessage is CLIPPED and REDACTED too (len=${provEv.providerMessage?.length}, budget=${PROVIDER_MAX})`,
  );
  // The validator's tolerance, which is the resume-halt fix: a long value from a
  // pre-#1798 state file must NOT refuse the file.
  const legacyLong = "y".repeat(FAILURE_REASON_CHARS * 4);
  assert(
    validateDiscriminants(withProviderMessage(legacyLong, "dispatch-failed-provider")).length === 0,
    `a legacy long provider-kind providerMessage (${legacyLong.length} chars) validates — the writer is the bound, not the validator`,
  );
  assert(
    validateDiscriminants(withProviderMessage("y".repeat(FAILURE_REASON_CHARS + 1), "dispatch-failed")).length === 0,
    "…and the same tolerance on the killed kind (no length rule at all now)",
  );
  assert(
    (validateDiscriminants(withProviderMessage({ message: "429" }, "dispatch-failed"))[0] ?? "").includes(
      "providerMessage",
    ),
    "a non-string is still refused (the type rule is untouched)",
  );
  assert(
    (validateDiscriminants(withProviderMessage(42, "dispatch-failed-provider"))[0] ?? "").includes(
      "providerMessage",
    ),
    "…on the provider kind as well",
  );
}

console.log(
  exitCode === 0
    ? "\n#1798 round 4 provider redaction (both kinds) + tolerant resume validation: all assertions passed"
    : "\n#1798 round 4 provider redaction + resume validation: FAILURES above",
);
process.exit(exitCode);
