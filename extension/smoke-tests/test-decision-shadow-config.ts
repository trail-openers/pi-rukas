#!/usr/bin/env bun
/**
 * A shadow call's two CONFIGURATION refusals (#1308/#1393), split out of
 * test-decision-shadow-seams.ts to keep both files under the 500-line cap.
 *
 * Both are refusals that a provider outage must not be able to silence, which is
 * why each asserts its own record rather than mere silence:
 *
 *   - `PI_ENSEMBLE_DECISIONS=0` is rule-only: no backend is called, and the call
 *     still writes one record with `mode: "off"`;
 *   - an env override to `enforce` cannot make a FIRE-AND-FORGET call act — it is
 *     refused — and the refusal still writes one stateless record, UNTHROTTLED,
 *     so a burst of outage skips that opened this seam's window cannot count the
 *     refusal away and drop it (#1393).
 *
 * Offline: the session model is a stub registry; nothing touches the network.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { __resetShadowForTests, attach, shadowDecide } from "../src/decision-shadow.ts";
import { STUB_MODEL, llmReply, makeAssert, stubRegistry, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function records(file: string): Record<string, unknown>[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Wait until a record matching `pred` lands (shadow appends are fire-and-forget). */
async function awaitRecord<T>(
  file: string,
  pred: (r: Record<string, unknown>) => r is T,
): Promise<T | undefined> {
  for (let i = 0; i < 200; i++) {
    const hit = records(file).find(pred);
    if (hit !== undefined) return hit as T;
    await sleep(10);
  }
  return undefined;
}

const req = { question: "q", state: {}, rule: "unknown" };

{
  const root = tmpDir("shadow-config");
  const where = { repoRoot: root, issues: [23] };
  const log = path.join(root, ".pi", "work-state", "23", "decisions.jsonl");
  const { registry, calls } = stubRegistry({
    llm: () => llmReply(JSON.stringify({ label: "rate-limited", justification: "stub" })),
  });
  __resetShadowForTests();
  attach({ modelRegistry: registry, model: STUB_MODEL, cwd: root });

  // The kill switch: rule-only, no backend, still one record.
  process.env.PI_ENSEMBLE_DECISIONS = "0";
  const n = calls.llm;
  await shadowDecide("failure-cause", req, where);
  const off = await awaitRecord(log, (r): r is { mode?: string } => r.mode === "off");
  assert(
    calls.llm === n && off?.mode === "off",
    `PI_ENSEMBLE_DECISIONS=0: rule-only, no backend called, still one record (${calls.llm - n} calls)`,
  );
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISIONS");

  // An env override to enforce cannot make a fire-and-forget call act — and the
  // refusal still writes a record, UNTHROTTLED: an outage burst that opened this
  // seam's skip window must not silence a configuration refusal (#1393).
  // The window is opened FIRST, deliberately: had the refusal arrived inside a
  // throttled window and been counted-and-dropped, this assertion would see it.
  const beforeRefuse = calls.llm;
  process.env.PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE = "enforce";
  const refused = await shadowDecide("failure-cause", req, where);
  assert(refused === undefined, "a shadow call refuses an enforce override");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE");
  const refuse = await awaitRecord(
    log,
    (r): r is { skipped?: string; state?: unknown; ruleAnswer?: string } =>
      String(r.skipped ?? "").startsWith("configured to enforce"),
  );
  assert(
    typeof refuse?.skipped === "string" &&
      refuse.state === undefined &&
      refuse.ruleAnswer === "unknown" &&
      calls.llm === beforeRefuse,
    `a refused shadow call still writes one stateless record saying why, and asks no model (${calls.llm - beforeRefuse} calls)`,
  );
}

process.exit(state.exit);
