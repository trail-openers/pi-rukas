#!/usr/bin/env bun
/**
 * The failure-cause (S3) and security-open-point (S4) seams run in SHADOW
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
 *   - at most five open points per issue are asked.
 *
 * The clip/redact order and the never-throws contract live in
 * test-decision-shadow-redaction.ts and test-decision-shadow-nothrow.ts; the
 * in-flight counter in test-decision-shadow-inflight.ts. All four files share
 * this one prelude's fixtures.
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
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import { STUB_MODEL, llmReply, makeAssert, stubRegistry, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function records(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

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

const spec = (): NormalisedSpec => ({
  intent: "Apply the change.",
  deliverables: [{ id: "d1", description: "apply the change", paths: [] }],
  acceptanceCriteria: ["it works"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "actionable",
});
const issueWith = (...points: string[]) =>
  `## Open points (unresolved at the gap-gate cap)\n\n${points.map((p) => `- [CRITICAL] ${p}`).join("\n")}\n`;
const ordinary = issueWith("Which retry backoff to use \u2014 proposal: 5s");
const security = issueWith("Who may call the endpoint \u2014 authentication is undecided");

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
      const text = String(ctx.messages[0]?.content ?? "");
      prompts.push(text);
      const label = text.includes("open point") ? "true" : "rate-limited";
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
  let recs = await awaitRecords(log, 1);
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
    records(log).find(
      (r) => r.exactRuleMatch === true && String(r.ruleAnswer) === cause,
    ) as Record<string, unknown> | undefined;
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
  await awaitRecords(log, 2);
  const wordsRec = (
    records(log).filter((r) => r.mode !== undefined && Array.isArray(r.backends)).at(-1) ?? {}
  ) as {
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
    // Its own window, because the throttle is keyed by SEAM, not by repoRoot, and
    // every block above shares this seam.
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
    // #1393 — skip records are throttled per seam: the four classes land inside
    // one window, so they produce ONE record, not four.
    const outRecs = await awaitRecords(outLog, 1);
    await sleep(100);
    assert(
      calls.llm === before && records(outLog).length === 1,
      "four provider-outage classes invoke no backend and write ONE throttled skip record, not four",
    );
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

  // Security: an ordinary point the model calls security still proceeds.
  const specs = [ordinary, security].map((b) => finaliseSpecVerdict(spec(), b, where));
  assert(
    specs.every((s, i) => JSON.stringify(s) === JSON.stringify(baselineSpecs[i])),
    "a model that calls every point security does not change the verdict",
  );
  // The two appends are concurrent, so they are selected by seam and sorted by
  // the rule's answer rather than read by position (#1393).
  for (let i = 0; i < 200; i++) {
    if (records(log).filter((x) => x.seam === "security-open-point").length >= 2) break;
    await sleep(10);
  }
  const sec = records(log).filter((x) => x.seam === "security-open-point") as {
    seam?: string;
    ruleAnswer?: string;
    final?: { answer?: string };
  }[];
  sec.sort((a, b) => String(a.ruleAnswer).localeCompare(String(b.ruleAnswer)));
  assert(
    sec.length === 2 &&
      sec.every((x) => x.seam === "security-open-point") &&
      sec[0]?.ruleAnswer === "false" &&
      sec[0]?.final?.answer === "false" &&
      sec[1]?.ruleAnswer === "true",
    "each open point logs one security record; the rule's answer is final",
  );
  assert(
    prompts.every((p) => !p.includes("rate-limited:") && !p.includes("ruleAnswer")),
    "the model is not told the rule's answer",
  );

// ------------------------------------------------ no session: exactly the rule

{
  const root = tmpDir("shadow-nosession");
  const where = { repoRoot: root, issues: [7] };
  const same = failures.every(
    (f, i) => JSON.stringify(act(f, where)) === JSON.stringify(baseline[i]),
  );
  assert(same, "no session model: classifyFailureCause returns exactly the rule's answer");
  const specsSame = [ordinary, security].every(
    (b, i) =>
      JSON.stringify(finaliseSpecVerdict(spec(), b, where)) === JSON.stringify(baselineSpecs[i]),
  );
  assert(specsSame, "no session model: finaliseSpecVerdict returns exactly the rule's verdict");
  assert(
    baselineSpecs[0]?.verdict === "proceed-with-assumptions" &&
      baselineSpecs[1]?.parkReason === "security-open-point",
    "the fixtures exercise the gate: an ordinary point proceeds, a security point parks",
  );
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





  // Secrets in the error text are redacted before any model sees them.
  const key = `sk-ant-api03-${"A".repeat(40)}`;
  act({ kind: "dispatch-failed", errorTail: `failed with key ${key}` }, where);
  await awaitRecords(log, 5);
  assert(
    !prompts.some((p) => p.includes(key)),
    "a credential in the error text never reaches the model",
  );

  // The kill switch: rule-only, no backend.
  process.env.PI_ENSEMBLE_DECISIONS = "0";
  const n = calls.llm;
  act({ kind: "dispatch-failed", errorTail: "exit 1" }, where);
  let off: { mode?: string } | undefined;
  for (let i = 0; i < 200; i++) {
    off = records(log).find((x) => x.mode === "off") as { mode?: string } | undefined;
    if (off) break;
    await sleep(10);
  }
  assert(
    calls.llm === n && off?.mode === "off",
    "PI_ENSEMBLE_DECISIONS=0: rule-only, no backend called, still one record",
  );
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISIONS");

  // An env override to enforce cannot make a fire-and-forget call act — and the
  // refusal still writes a record, UNTHROTTLED: an outage burst that opened this
  // seam's skip window must not silence a configuration refusal (#1393).
  const beforeRefuse = calls.llm;
  process.env.PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE = "enforce";
  const skipped = await shadowDecide(
    "failure-cause",
    { question: "q", state: {}, rule: "unknown" },
    where,
  );
  assert(skipped === undefined, "a shadow call refuses an enforce override");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE");
  let refuse: { skipped?: string; state?: unknown; ruleAnswer?: string } | undefined;
  for (let i = 0; i < 200; i++) {
    refuse = records(log).find((x) =>
      String(x.skipped ?? "").startsWith("configured to enforce"),
    ) as { skipped?: string; state?: unknown; ruleAnswer?: string } | undefined;
    if (refuse) break;
    await sleep(10);
  }
  assert(
    typeof refuse?.skipped === "string" &&
      refuse.state === undefined &&
      refuse.ruleAnswer === "unknown" &&
      calls.llm === beforeRefuse,
    `a refused shadow call still writes one stateless record saying why, and asks no model (${calls.llm - beforeRefuse} calls)`,
  );

  // A long Open points list is capped: at most five points are asked.
  const many = issueWith(
    ...Array.from(
      { length: 7 },
      (_, i) => `Which retry backoff for queue ${i} \u2014 proposal: 5s`,
    ),
  );
  const secBefore = records(log).filter((x) => x.seam === "security-open-point").length;
  const asked = calls.llm;
  const capped = finaliseSpecVerdict(spec(), many, where);
  assert(
    JSON.stringify(capped) === JSON.stringify(finaliseSpecVerdict(spec(), many)),
    "the capped list's verdict is the rule's",
  );
  for (let i = 0; i < 200; i++) {
    if (records(log).filter((x) => x.seam === "security-open-point").length >= secBefore + 5) break;
    await sleep(10);
  }
  await sleep(100);
  assert(
    records(log).filter((x) => x.seam === "security-open-point").length === secBefore + 5 &&
      calls.llm - asked === 5,
    "seven open points: five asked in shadow, the rest traced",
  );

  detach();
}

// ------------------------------------------------ skip records are throttled per seam

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
    for (let i = 0; i < 500; i++)
      await shadowSkip("failure-cause", req, where, "skipped: burst");
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

    // The throttle is per seam: the security seam's burst is not silenced by the
    // failure-cause seam's open window.
    t += 10;
    for (let i = 0; i < 20; i++)
      await shadowSkip("security-open-point", req, where, "skipped: other seam");
    const secRecs = records(log).filter((r) => r.seam === "security-open-point");
    assert(
      secRecs.length === 1,
      "a burst on one seam does not suppress the other seam's first skip record",
    );
  } finally {
    restore();
    __resetShadowForTests();
  }
}

process.exit(state.exit);
