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
 *     ask no model; a 429 only in the subagent's own words is asked (#1262);
 *   - render-only callers (no `shadow`) ask nothing;
 *   - PI_ENSEMBLE_DECISIONS=0 is rule-only: no backend is called;
 *   - an env override to `enforce` cannot make a shadow call act;
 *   - secrets in the error text never reach the model.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { attach, detach, shadowDecide } from "../src/decision-shadow.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
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

const failures = [
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
    (f, i) => JSON.stringify(classifyFailureCause(f, where)) === JSON.stringify(baseline[i]),
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
  attach({ modelRegistry: registry, model: STUB_MODEL, cwd: root } as never);

  const out = classifyFailureCause({ kind: "dispatch-failed", errorTail: "exit 1" }, where);
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
    if (f) classifyFailureCause(f, where);
  }
  await sleep(100);
  assert(
    records(log).length === 1,
    "killCause and provider-message 429/spend-cap matches ask no model",
  );

  // #1262 — a 429 only in the subagent's own words is not exact: asked, rule kept.
  const words = classifyFailureCause(failures[6] as never, where);
  assert(words.cause === baseline[6]?.cause, "an errorTail-only 429 keeps the rule's cause");
  recs = await awaitRecords(log, 2);
  assert(
    (recs[1] as { ruleAnswer?: string }).ruleAnswer === "rate-limited",
    "an errorTail-only 429 is asked about, with the rule's label logged",
  );

  // Render-only callers ask nothing.
  const before = calls.llm;
  for (const f of failures) classifyFailureCause(f);
  await sleep(100);
  assert(calls.llm === before, "a caller without `shadow` asks no model");

  // Security: an ordinary point the model calls security still proceeds.
  const specs = [ordinary, security].map((b) => finaliseSpecVerdict(spec(), b, where));
  assert(
    specs.every((s, i) => JSON.stringify(s) === JSON.stringify(baselineSpecs[i])),
    "a model that calls every point security does not change the verdict",
  );
  recs = await awaitRecords(log, 4);
  const sec = recs.slice(2) as {
    seam?: string;
    ruleAnswer?: string;
    final?: { answer?: string };
  }[];
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
  classifyFailureCause({ kind: "dispatch-failed", errorTail: `failed with key ${key}` }, where);
  await awaitRecords(log, 5);
  assert(
    !prompts.some((p) => p.includes(key)),
    "a credential in the error text never reaches the model",
  );

  // The kill switch: rule-only, no backend.
  process.env.PI_ENSEMBLE_DECISIONS = "0";
  const n = calls.llm;
  classifyFailureCause({ kind: "dispatch-failed", errorTail: "exit 1" }, where);
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

  detach();
}

process.exit(state.exit);
