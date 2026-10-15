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
 *   - exact rule matches (killCause, a 429 on the provider's own message)
 *     ask no model; provider-derived outage classes (provider-severed, a 429 /
 *     spend-cap / quota class from a provider error stop) ask no model and
 *     write one skip record; a 429 read only from the subagent's own words is
 *     inferred, so it IS asked (#1262);
 *   - `classifyFailureCause` alone stays pure: only `shadowFailureCause` asks;
 *   - PI_ENSEMBLE_DECISIONS=0 is rule-only: no backend is called;
 *   - an env override to `enforce` cannot make a shadow call act, and a
 *     call that is not fired still leaves one stateless record;
 *   - at most five open points per issue are asked;
 *   - secrets in the error text never reach the model.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { attach, detach, shadowDecide } from "../src/decision-shadow.ts";
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
const ordinary = issueWith("Which retry backoff to use — proposal: 5s");
const security = issueWith("Who may call the endpoint — authentication is undecided");

// ------------------------------------------------ no session: exactly the rule

const baseline = failures.map((f) => classifyFailureCause(f));
const baselineSpecs = [ordinary, security].map((b) => finaliseSpecVerdict(spec(), b));
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

// ------------------------------------------------ a disagreeing model changes nothing

{
  const root = tmpDir("shadow-model");
  const where = { repoRoot: root, issues: [7] };
  const log = path.join(root, ".pi", "work-state", "7", "decisions.jsonl");
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

  // Exact matches stay rule-authoritative: no model is asked, no record.
  for (const f of [failures[2], failures[3], failures[4], failures[5]]) {
    if (f) act(f, where);
  }
  await sleep(100);
  assert(
    records(log).length === 1,
    "killCause and provider-message 429/spend-cap matches ask no model",
  );

  // #1262 — a 429 only in the subagent's own words is inferred, not provider-
  // derived: the model is asked (the rule may be wrong), one record with an answer.
  const beforeWords = calls.llm;
  const words = act(
    { kind: "dispatch-failed", errorTail: "tests for the 429 status path pass" },
    where,
  );
  assert(words.cause === baseline[6]?.cause, "an errorTail-only 429 keeps the rule's cause");
  recs = await awaitRecords(log, 2);
  const wordsRec = recs[1] as {
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
    const before = calls.llm;
    for (const f of outage) {
      const cls = classifyFailureCause(f);
      assert(
        cls.cause === "provider-severed" || cls.cause.startsWith("rate-limited:"),
        `fixture is a provider-outage class (${cls.cause})`,
      );
      act(f, outWhere);
    }
    const outRecs = await awaitRecords(outLog, outage.length);
    await sleep(100);
    assert(
      calls.llm === before && records(outLog).length === outage.length,
      "provider-outage classes invoke no backend and write one skip record each",
    );
    assert(
      outRecs.every(
        (r) => (r as { skipped?: string }).skipped === "skipped: provider-outage class",
      ),
      "each provider-outage skip records the reason",
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
  recs = await awaitRecords(log, 4);
  // The two appends are concurrent, so their order is not fixed: sort by the rule's answer.
  const sec = (
    recs.slice(2) as { seam?: string; ruleAnswer?: string; final?: { answer?: string } }[]
  ).sort((a, b) => String(a.ruleAnswer).localeCompare(String(b.ruleAnswer)));
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
  recs = await awaitRecords(log, 6);
  assert(
    calls.llm === n && (recs[5] as { mode?: string }).mode === "off",
    "PI_ENSEMBLE_DECISIONS=0: rule-only, no backend called, still one record",
  );
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISIONS");

  // An env override to enforce cannot make a fire-and-forget call act.
  process.env.PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE = "enforce";
  const skipped = await shadowDecide(
    "failure-cause",
    { question: "q", state: {}, rule: "unknown" },
    where,
  );
  assert(skipped === undefined, "a shadow call refuses an enforce override");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE");
  recs = await awaitRecords(log, 7);
  const skip = recs[6] as { skipped?: string; state?: unknown; ruleAnswer?: string };
  assert(
    typeof skip?.skipped === "string" && skip.state === undefined && skip.ruleAnswer === "unknown",
    "a refused shadow call still writes one stateless record saying why",
  );

  // A long Open points list is capped: at most five points are asked.
  const many = issueWith(
    ...Array.from(
      { length: 7 },
      (_, i) => `Which retry backoff for queue ${i} \u2014 proposal: 5s`,
    ),
  );
  const asked = calls.llm;
  const capped = finaliseSpecVerdict(spec(), many, where);
  assert(
    JSON.stringify(capped) === JSON.stringify(finaliseSpecVerdict(spec(), many)),
    "the capped list's verdict is the rule's",
  );
  recs = await awaitRecords(log, 12);
  await sleep(100);
  assert(
    records(log).length === 12 && calls.llm - asked === 5,
    "seven open points: five asked in shadow, the rest traced",
  );

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
  assert(calls.llm === 1 && recs.length === 1, "fixture: the failure-cause call reached the backend");
  assert(
    !prompts.some((p) => leaksKey(p, SHADOW_KEY)),
    "tail clip: no 12+ char run of the key reaches the backend",
  );
  assert(
    !leaksKey(readFileSync(log, "utf8"), SHADOW_KEY),
    "tail clip: no 12+ char run of the key reaches the decision log",
  );

  // The 1000-char open-point clip, same placement from the start.
  const point = `${"p".repeat(989)} ${SHADOW_KEY} ${"q".repeat(49)}`;
  finaliseSpecVerdict(spec(), issueWith(point), where);
  await awaitRecords(log, 2);
  await sleep(50);
  assert(
    !prompts.some((p) => leaksKey(p, SHADOW_KEY)),
    "open-point clip: no 12+ char run of the key reaches the backend",
  );
  assert(
    !leaksKey(readFileSync(log, "utf8"), SHADOW_KEY),
    "open-point clip: no 12+ char run of the key reaches the decision log",
  );
  detach();
}

// ------------------------------------------------ the shadow call never throws

{
  const root = tmpDir("shadow-nothrow");
  const where = { repoRoot: root, issues: [11] };
  // A request-less enforce-mode call takes the synchronous skip path, which
  // throws on the missing request; the caller must get a resolved undefined.
  process.env.PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE = "enforce";
  let threw = false;
  let out: unknown = "pending";
  try {
    out = await shadowDecide("failure-cause", undefined as never, where);
  } catch {
    threw = true;
  }
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE");
  assert(!threw && out === undefined, "a throwing synchronous prefix resolves undefined, never throws");

  const unknownSeam = await shadowDecide("no-such-seam" as never, { question: "q", state: {}, rule: "x" }, where).catch(() => "rejected");
  assert(unknownSeam === undefined, "an unknown seam id is not fired and does not reject");
}

process.exit(state.exit);
