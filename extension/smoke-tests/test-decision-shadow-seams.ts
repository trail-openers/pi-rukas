#!/usr/bin/env bun
/**
 * The failure-cause (S3) seam runs in SHADOW
 * (#1308): the rule's answer is always the acted-on outcome, the model's is
 * only logged. Offline: the session model is a stub registry.
 *
 *   - with no session attached, and with a model that disagrees, every
 *     migrated call returns exactly the rule's answer;
 *   - the call stays synchronous: no backend has run when it returns;
 *   - an acting caller gets one decision-log record per call, carrying the
 *     model's answer with the rule's answer as the final one;
 *   - exact rule matches (killCause, a 429 on the provider's own message) ask
 *     no model and each write ONE record whose `exactRuleMatch` field is set
 *     (#1393); provider-derived outage classes (provider-severed, a 429 /
 *     spend-cap / quota class from a provider error stop) ask no model and write
 *     skip records that are THROTTLED per seam per window, the suppressed count
 *     carried into the next record after the window closes and nothing written
 *     when no later skip arrives; a configuration refusal (an `enforce` seam) is
 *     NOT throttled, so an outage burst cannot silence it; a 429 read only from
 *     the subagent's own words is inferred, so it IS asked (#1262);
 *   - `classifyFailureCause` alone stays pure: only `shadowFailureCause` asks;
 *   - PI_ENSEMBLE_DECISIONS=0 is rule-only: no backend is called;
 *   - an env override to `enforce` cannot make a shadow call act, and a
 *     call that is not fired still leaves one stateless record;
 *   - secrets in the error text never reach the model.
 *
 * The clip/redact order, the never-throws contract, the configuration refusals
 * (kill switch, enforce override) and the in-flight counter each have their own
 * file: test-decision-shadow-redaction.ts, -nothrow.ts, -config.ts and
 * -inflight.ts, and one record per forced failure with the session attached is
 * test-decision-shadow-wiring.ts. All share this prelude's fixtures.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  SKIP_WINDOW_MS,
  __resetShadowForTests,
  __setSkipClockForTests,
  attach,
  detach,
  shadowDecide,
  shadowSkip,
} from "../src/decision-shadow.ts";
import { classifyFailureCause, shadowFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { STUB_MODEL, llmReply, fixtureSpec, makeAssert, records, registerFixture, stubRegistry, tmpDir } from "./lib/decision-fixtures.ts";
import type { SeamId } from "../src/decision-seam-registry.ts";

const { assert, state } = makeAssert();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `file` holds `n` records (the shadow call is fire-and-forget). */
async function awaitRecords(file: string, n: number): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 200 && records(file).length < n; i++) await sleep(10);
  return records(file);
}

type Tail = Parameters<typeof classifyFailureCause>[0];
type Where = Parameters<typeof shadowFailureCause>[2];

/** What an acting caller (the step router) does: classify, then ask in shadow. */
function act(tail: Tail, where: Where) {
  const cls = classifyFailureCause(tail);
  shadowFailureCause(tail, cls, where);
  return cls;
}

const failures: Tail[] = [
  { kind: "dispatch-failed", errorTail: "exit 1" },
  { kind: "dispatch-failed-provider", providerMessage: "socket hang up" },
  { kind: "dispatch-failed", killCause: "timeout" },
  { kind: "dispatch-failed", killCause: "inactivity" },
  { kind: "dispatch-failed-provider", providerMessage: "429 status code, retry delay 30s" },
  { kind: "dispatch-failed-provider", providerMessage: "429 status: spend cap reached" },
  { kind: "dispatch-failed", errorTail: "tests for the 429 status path pass" },
  { kind: "something-else" },
];

// The rule's answers, captured with NO session attached. Every block below
// compares a shadowed call against these: a shadow decision must never move
// the acted-on outcome, so "identical to the baseline" is the assertion.
const baseline = failures.map((f) => classifyFailureCause(f));

// ------------------------------------------------ no session: exactly the rule

{
  const root = tmpDir("shadow-nosession");
  const where = { repoRoot: root, issues: [7] };
  const same = failures.every(
    (f, i) => JSON.stringify(act(f, where)) === JSON.stringify(baseline[i]),
  );
  assert(same, "no session model: classifyFailureCause returns exactly the rule's answer");
  const d = await shadowDecide(
    "failure-cause",
    { question: "q", state: { kind: "dispatch-failed" }, rule: "subagent-failure" },
    where,
  );
  assert(
    d?.source === "rule" && d.answer === "subagent-failure" && d.abstained,
    "no session model: the seam answers from the rule",
  );
}

// ------------------------------------------------ a disagreeing model changes nothing

{
  const root = tmpDir("shadow-model");
  const where = { repoRoot: root, issues: [7] };
  const log = path.join(root, ".pi", "work-state", "7", "decisions.jsonl");
  // #1393 — the exact-match records below are WRITES, never throttled, and the
  // log is shared with the no-session block, so it is cleared to make every
  // count absolute. Records are appended by concurrent fire-and-forget writers,
  // so throughout they are addressed by SHAPE, never by index.
  try {
    rmSync(log, { force: true });
  } catch {
    /* fresh fixture */
  }
  // This block's fixture has no model attached; the no-session block above
  // already holds the seam's skip window, so clear it to measure this one's.
  __resetShadowForTests();
  const prompts: string[] = [];
  const { registry, calls } = stubRegistry({
    llm: (ctx) => {
      prompts.push(String(ctx.messages[0]?.content ?? ""));
      // The only seam still shadowed is failure-cause, whose label set is
      // {rate-limited, provider-transient, subagent-failure, unknown}. The stub
      // always answers `rate-limited`, so where the rule says otherwise the
      // shadow split (model logged, rule final) is observable.
      const label = "rate-limited";
      return llmReply(JSON.stringify({ label, justification: "stub disagrees" }));
    },
  });
  attach({ modelRegistry: registry, model: STUB_MODEL, cwd: root });

  const out = act({ kind: "dispatch-failed", errorTail: "exit 1" }, where);
  assert(calls.llm === 0, "the call is synchronous: no backend has run when it returns");
  assert(
    JSON.stringify(out) === JSON.stringify(baseline[0]),
    "a disagreeing model does not change the classification",
  );
  const recs = await awaitRecords(log, 1);
  const r = recs[0] as {
    seam?: string;
    mode?: string;
    ruleAnswer?: string;
    final?: { answer?: string; source?: string };
    backends?: { answer?: string }[];
  };
  assert(
    recs.length === 1 &&
      r.seam === "failure-cause" &&
      r.mode === "shadow" &&
      r.ruleAnswer === "subagent-failure" &&
      r.backends?.[0]?.answer === "rate-limited" &&
      r.final?.answer === "subagent-failure" &&
      r.final?.source === "rule",
    "one record per acting call: the model's answer logged, the rule's answer final",
  );

  /**
   * A 429 / spend-cap cause is EXACT only when the text arrived on
   * `providerMessage` (the provider's own words); the same text in the
   * subagent's `errorTail` is asked (#1262). The record carries neither, so the
   * fixture decides which arm a cause belongs to.
   */
  const EXACT_CAUSES = new Set([
    "self-killed:timeout",
    "self-killed:inactivity",
    "rate-limited:429",
    "rate-limited:quota-terminal",
  ]);
  const isExact = (f: Tail, cause: string): boolean =>
    EXACT_CAUSES.has(cause) && (cause.startsWith("self-killed") || f.providerMessage !== undefined);
  const exactByCause = (cause: string) =>
    records(log).find((r) => r.exactRuleMatch === true && String(r.ruleAnswer) === cause) as
      | Record<string, unknown>
      | undefined;
  const exactsOf = () =>
    records(log).filter(
      (r) => r.exactRuleMatch === true && EXACT_CAUSES.has(String(r.ruleAnswer)),
    ) as { exactRuleMatch?: boolean; skipped?: string; state?: unknown }[];

  // Exact matches stay rule-authoritative and ask NO model, but each writes one
  // record saying the rule answered (#1393) — silence used to be the behaviour,
  // which left S5 with no sample for the causes the rule reads best.
  const exactFixtures = [failures[2], failures[3], failures[4], failures[5]].filter(
    (f): f is Tail => f !== undefined,
  );
  // `calls` is a running total for the whole file, so every "no model is asked"
  // assertion compares against the count at the start of its own call group.
  const beforeExact = calls.llm;
  for (const f of exactFixtures) act(f, where);
  for (const f of exactFixtures)
    for (let i = 0; i < 200 && !exactByCause(classifyFailureCause(f).cause); i++) await sleep(10);
  const exactCount = exactFixtures.filter((f) => isExact(f, classifyFailureCause(f).cause)).length;
  assert(
    calls.llm === beforeExact && exactsOf().length === exactCount && exactCount === 4,
    `killCause and provider-message 429/spend-cap matches ask no model and add exactly one record each (${exactsOf().length} of ${exactCount}, ${calls.llm - beforeExact} model calls)`,
  );
  const exacts = exactsOf();
  assert(
    exacts.length === 4 &&
      exacts.every((r) => r.exactRuleMatch === true && r.skipped === undefined),
    "each exact rule match writes exactly one record marked exactRuleMatch, not skipped",
  );
  assert(
    exacts.every(
      (r) =>
        !JSON.stringify(r.state).includes("providerMessage") &&
        !JSON.stringify(r.state).includes("lastOutput"),
    ),
    "an exact-match record is stateless: no providerMessage or errorTail reaches it",
  );
  assert(
    exactByCause("self-killed:timeout") !== undefined &&
      JSON.stringify(exactByCause("self-killed:timeout")?.state).includes("self-killed:timeout"),
    `the exact-match record names the rule cause it recorded (${JSON.stringify(exactByCause("self-killed:timeout")?.state)})`,
  );
  const quota = exactByCause("rate-limited:429")?.state as
    | { exactRuleCause?: string; providerMessage?: unknown }
    | undefined;
  assert(
    quota?.exactRuleCause === "rate-limited:429" && quota.providerMessage === undefined,
    `the 429 on the provider's own message is recorded with its cause and no provider text (${JSON.stringify(quota)})`,
  );

  // #1262 — a 429 only in the subagent's own words is inferred, not provider-
  // derived: the model is asked (the rule may be wrong), one record with an answer.
  // The snapshot is taken IMMEDIATELY before the call: an exact-match record
  // above may still be settling its own (zero) model calls, and a snapshot taken
  // earlier would compare against a moving baseline.
  const beforeWords = calls.llm;
  const words = act(
    { kind: "dispatch-failed", errorTail: "tests for the 429 status path pass" },
    where,
  );
  assert(words.cause === baseline[6]?.cause, "an errorTail-only 429 keeps the rule's cause");
  // The record, not the model call, is the sync point: the append lands after
  // the backend has answered. Polling `calls.llm` instead reads the counter a
  // turn before the writer flushes and intermittently sees the PREVIOUS
  // record's shape (#1393).
  for (let i = 0; i < 200; i++) {
    if (
      records(log).some(
        (x) =>
          x.mode !== undefined &&
          Array.isArray(x.backends) &&
          x.ruleAnswer === "rate-limited" &&
          (x.backends as { answer?: string }[])[0]?.answer === "rate-limited",
      )
    )
      break;
    await sleep(10);
  }
  const wordsRec = (records(log)
    .filter((r) => r.mode !== undefined && Array.isArray(r.backends))
    .at(-1) ?? {}) as {
    ruleAnswer?: string;
    skipped?: string;
    backends?: { answer?: string }[];
  };
  assert(
    wordsRec.ruleAnswer === "rate-limited" &&
      wordsRec.skipped === undefined &&
      wordsRec.backends?.[0]?.answer === "rate-limited" &&
      calls.llm === beforeWords + 1,
    "an errorTail-only 429 is asked: the model's answer logged, the rule's kept",
  );

  // Provider-outage classes (transport severance, 429 burst/quota, spend cap):
  // no backend is invoked even with a live session model; each writes one skip.
  {
    const outRoot = tmpDir("shadow-outage");
    const outLog = path.join(outRoot, ".pi", "work-state", "7", "decisions.jsonl");
    const outWhere = { repoRoot: outRoot, issues: [7] };
    // A 429 on the provider's own message is an exact match (silent, above);
    // a 429 in the error stop's text is provider-derived: these are the classes
    // that reach the seam as a skip record.
    const outage: Tail[] = [
      { kind: "dispatch-failed-provider", providerMessage: "socket hang up" },
      { kind: "dispatch-failed-provider", errorTail: "429 status code, retry delay 30s" },
      { kind: "dispatch-failed-provider", errorTail: "429 status: spend cap reached" },
      { kind: "dispatch-failed-provider", errorTail: "429 status code, retry delay 86400s" },
    ];
    // #1393 — skip records are throttled per seam: the four classes land inside
    // one window, so they produce ONE record, not four. The window is keyed by
    // seam and its clock is the module's, so this block drives its own fake
    // clock and starts from a fixed point rather than inheriting whichever
    // window a previous block left open.
    const outT = 1_000_000;
    const restoreOutClock = __setSkipClockForTests(() => outT);
    let outRecs: Record<string, unknown>[] = [];
    try {
      __resetShadowForTests();
      const before = calls.llm;
      for (const f of outage) {
        const cls = classifyFailureCause(f);
        assert(
          cls.cause === "provider-severed" || cls.cause.startsWith("rate-limited:"),
          `fixture is a provider-outage class (${cls.cause})`,
        );
        act(f, outWhere);
      }
      for (let i = 0; i < 200; i++) {
        if (records(outLog).length >= 1) break;
        await sleep(10);
      }
      outRecs = records(outLog);
      assert(
        calls.llm === before && outRecs.length === 1,
        `four provider-outage classes invoke no backend and write ONE throttled skip record, not four (${outRecs.length})`,
      );
    } finally {
      restoreOutClock();
      __resetShadowForTests();
    }
    assert(
      (outRecs[0] as { skipped?: string }).skipped === "skipped: provider-outage class",
      "the provider-outage skip records the reason",
    );
  }

  // Render-only callers (classifyFailureCause alone) ask nothing.
  const before = calls.llm;
  for (const f of failures) classifyFailureCause(f);
  await sleep(100);
  assert(calls.llm === before, "classifyFailureCause alone is pure: it asks no model");

  // Secrets in the error text are redacted before any model sees them. The
  // record count is keyed to THIS call by shape (a credential redaction in the
  // log), not to a positional total: the file's record sequence changed when the
  // configuration refusals moved to their own file, and a hardcoded count then
  // stopped waiting for this append and read the prompt before it had landed.
  const key = `sk-ant-api03-${"A".repeat(40)}`;
  const redactedBefore = records(log).filter((x) => (x.redactions as number) > 0).length;
  act({ kind: "dispatch-failed", errorTail: `failed with key ${key}` }, where);
  for (let i = 0; i < 200; i++) {
    if (records(log).filter((x) => (x.redactions as number) > 0).length > redactedBefore) break;
    await sleep(10);
  }
  const sawRedaction = records(log).some((x) => (x.redactions as number) > 0);
  assert(
    sawRedaction && !prompts.some((p) => p.includes(key)),
    "a credential in the error text never reaches the model (and the log counted a redaction)",
  );

  // The kill switch and the enforce refusal are CONFIGURATION refusals with
  // their own file (test-decision-shadow-config.ts), where each gets an
  // unshared seam window, is awaited by SHAPE rather than by positional index,
  // and cannot be silenced by this block's outage burst.

  detach();
}

// ------------------------------------------------ redact the WHOLE text, then clip

/** True when any 12-char run of `key` appears in `s` (a fragment that could still leak). */
function leaksKey(s: string, key: string): boolean {
  for (let i = 0; i + 12 <= key.length; i++) {
    if (s.includes(key.slice(i, i + 12))) return true;
  }
  return false;
}

const SHADOW_KEY = `sk-ant-api03-${"aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d"}`;
{
  // The key's prefix sits ~10 chars before the 600-char tail boundary: a clip
  // before redaction would leave a fragment no pattern matches.
  const root = tmpDir("shadow-redact-tail");
  const where = { repoRoot: root, issues: [9] };
  const log = path.join(root, ".pi", "work-state", "9", "decisions.jsonl");
  const prompts: string[] = [];
  const { registry, calls } = stubRegistry({
    llm: (ctx) => {
      prompts.push(String(ctx.messages[0]?.content ?? ""));
      return llmReply(JSON.stringify({ label: "subagent-failure", justification: "stub" }));
    },
  });
  attach({ modelRegistry: registry, model: STUB_MODEL, cwd: root });
  // Spaces around the key: the pattern needs word boundaries at both ends.
  const errorTail = `${"f".repeat(99)} ${SHADOW_KEY} ${"t".repeat(556)}`;
  assert(
    errorTail.length - 600 === 100 + 10,
    "fixture: the 600-char tail boundary falls 10 chars into the key",
  );
  act({ kind: "dispatch-failed", errorTail }, where);
  const recs = await awaitRecords(log, 1);
  assert(
    calls.llm === 1 && recs.length === 1,
    "fixture: the failure-cause call reached the backend",
  );
  assert(
    !prompts.some((p) => leaksKey(p, SHADOW_KEY)),
    "tail clip: no 12+ char run of the key reaches the backend",
  );
  assert(
    !leaksKey(readFileSync(log, "utf8"), SHADOW_KEY),
    "tail clip: no 12+ char run of the key reaches the decision log",
  );
  detach();
}

// ------------------------------------------------ the shadow call never throws

{
  const root = tmpDir("shadow-throttle");
  const where = { repoRoot: root, issues: [21] };
  const log = path.join(root, ".pi", "work-state", "21", "decisions.jsonl");
  const req = { question: "q", rule: "unknown" };
  // A fake clock, because a real 60-second window would make the "first skip
  // after the window closes" assertion either sleep a minute or pass vacuously.
  let t = 1_000_000;
  const restore = __setSkipClockForTests(() => t);
  try {
    __resetShadowForTests();
    // A 500-failure burst: one record, and 499 suppressions counted but not written.
    for (let i = 0; i < 500; i++) await shadowSkip("failure-cause", req, where, "skipped: burst");
    assert(
      records(log).length === 1,
      "500 skips for one seam write ONE record, not 500 (the pre-#1393 shape wrote 500 lines + 500 warnings)",
    );

    // Still inside the window: nothing new.
    t += SKIP_WINDOW_MS - 1000;
    await shadowSkip("failure-cause", req, where, "skipped: burst");
    assert(records(log).length === 1, "a skip inside the open window writes nothing");

    // The window has closed. The NEXT skip writes one summary record carrying the
    // suppressed count — the count is never dropped, and never written on its own.
    t += 2000;
    await shadowSkip("failure-cause", req, where, "skipped: burst");
    const recs = records(log);
    const summary = recs.at(-1) as { suppressed?: number; skipped?: string } | undefined;
    assert(
      recs.length === 2 && summary?.skipped === "skipped: burst" && summary.suppressed === 500,
      `the first skip after the window closes carries the suppressed count (got ${JSON.stringify(summary)})`,
    );

    // A window that closes with NO later skip fabricates nothing.
    t += 10 * SKIP_WINDOW_MS;
    assert(records(log).length === 2, "a closed window with no later skip writes nothing at all");

    // The throttle is per seam: the fixture seam's burst is not silenced by the
    // failure-cause seam's open window — and it is NOT shared state either, which
    // is the half an `undefined` lookup would have hidden: before this seam was
    // registered its window was keyed while its spec was missing, and a single
    // shared throttle map would have read the same `seam` key for a seam that has
    // no entry at all. A registered fixture stands in for the caller-less S4 seam
    // main's #1395 removed from the registry.
    registerFixture(
      fixtureSpec({
        id: "fixture-throttle-other",
        kind: "bool",
        labels: { true: "t", false: "f" },
        ruleDefault: "true",
        passing: ["false"],
        composition: "may-add-only",
      }),
    );
    t += 10;
    for (let i = 0; i < 20; i++)
      await shadowSkip("fixture-throttle-other" as SeamId, req, where, "skipped: other seam");
    const secRecs = records(log).filter((r) => r.seam === "fixture-throttle-other");
    assert(
      secRecs.length === 1,
      "a burst on one seam does not suppress the other seam's first skip record",
    );
    // And the failure-cause window is still its own: the other seam's record did
    // not open a window that silences this seam's next skip (#1393, per-seam).
    t += 10 * SKIP_WINDOW_MS;
    await shadowSkip("failure-cause", req, where, "skipped: after the other seam");
    assert(
      records(log).filter((r) => r.seam === "failure-cause").length === 3,
      "the other seam's burst left this seam's own window untouched",
    );
  } finally {
    restore();
    __resetShadowForTests();
  }
}

process.exit(state.exit);
