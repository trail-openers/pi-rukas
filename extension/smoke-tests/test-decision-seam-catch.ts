#!/usr/bin/env bun
/**
 * `decide()`'s catch path writes a record with the SAME core fields a success
 * does (#1393), so S5 can count an error-path call as a sample.
 *
 * The catch block used to build a record of `{seam, question, rule, ruleAnswer,
 * error}` only: no `mode`, no `composition`, no `stateHash`, no `state`. A
 * reader aggregating the log by mode or comparing a model answer against the
 * state that produced it silently skipped exactly the calls that had failed —
 * the ones whose reliability S5 exists to measure. The unified record carries
 * every core field on both paths; `stateHash` is over whatever was serialised
 * before the throw (the empty string when nothing was) and `composition` over
 * the registry's declared policy, which a throw does not change.
 *
 * The throw is induced through a throwing `evidence.texts` accessor: the getter
 * runs inside `verifyEvidence`, after the state has been serialised and after
 * the backend has answered, so the record is populated when the catch fires —
 * which is what makes this the shape that distinguishes a unified record from
 * the old sparse one. It also proves a rejection raised *inside* the try, not
 * merely a backend that returned `ok: false`, is what the catch handles.
 *
 *   - exactly ONE record for the failed call, carrying the unified fields;
 *   - the fields carry the real values computed before the throw, not stubs;
 *   - `decide()` still returns the rule answer and never throws.
 *
 * Offline: the backend is a closure; nothing touches the network.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Backend } from "../src/decision-backends.ts";
import { SEAMS, type SeamSpec } from "../src/decision-seam-registry.ts";
import { decide } from "../src/decision-seam.ts";
import { makeAssert, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

const seam = "fixture-catch";
// A tests-only seam, and deliberately `replace` + `quote`: those are the only
// settings that make `decide()` run the evidence check, which is where the
// induced throw lands. `shadow` mode keeps the rule as the acted-on answer.
(SEAMS as Record<string, SeamSpec>)[seam] = {
  id: seam,
  kind: "choice",
  instructions: "Is the thing ok?",
  labels: { ok: "fine", flag: "needs a human" },
  ruleDefault: "flag",
  passing: ["ok"],
  composition: "replace",
  defaultMode: "shadow",
  evidence: "quote",
  owner: "test-decision-seam-catch.ts",
  timeoutMs: 5_000,
  tokenBudget: 8_000,
};

const STATE = { keep: "plain value", doc: "The change is approved by the maintainers." };
const QUOTE = "approved by the maintainers";

/** A backend that answers with the quote the evidence check is then asked about. */
function answeringBackend(): Backend & { calls: number } {
  const b = {
    name: "answers",
    source: "llm" as const,
    calls: 0,
    run: async () => {
      b.calls++;
      return { ok: true as const, answer: "ok", quote: QUOTE, cited: "the doc" };
    },
  };
  return b;
}

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

{
  const root = tmpDir("seam-catch");
  const log = path.join(root, ".pi", "decisions.jsonl");
  const backend = answeringBackend();

  // The throw: reading `texts` — which `verifyEvidence` does, after the backend
  // has answered — raises instead of returning an array.
  const evidence = {
    get texts(): never {
      throw new Error("evidence reader exploded");
    },
  };

  let threw = false;
  let d: Awaited<ReturnType<typeof decide>> | undefined;
  try {
    d = await decide(
      seam as never,
      { state: STATE, question: "q", rule: "ok", evidence },
      {
        backends: [backend],
        repoRoot: root,
      },
    );
  } catch {
    threw = true;
  }
  assert(!threw && d !== undefined, "a throw inside decide() does not escape to the caller");
  assert(
    backend.calls === 1 && d?.answer === "ok" && d?.source === "rule",
    "the backend ran, then the throw fell through to the rule answer",
  );
  assert(
    /evidence reader exploded/.test(d?.reason ?? ""),
    `the reason carries the thrown message (${JSON.stringify(d?.reason)})`,
  );

  const recs = records(log);
  assert(
    recs.length === 1,
    `the catch path writes EXACTLY ONE record — not zero, not two (${recs.length})`,
  );
  const r = recs[0] ?? {};

  // The unified field set: everything a success's record carries, plus `error`.
  // The old sparse catch record had none of mode/composition/stateHash/state.
  const CORE = [
    "ts",
    "seam",
    "question",
    "rule",
    "mode",
    "composition",
    "stateHash",
    "stateChars",
    "state",
    "ruleAnswer",
    "backends",
    "final",
    "redactions",
    "error",
  ] as const;
  const missing = CORE.filter((k) => r[k] === undefined);
  assert(
    missing.length === 0,
    `the catch record carries the unified core fields (missing: ${missing.join(", ") || "none"})`,
  );

  // The values are the ones computed before the throw, not placeholders.
  const expectedHash = createHash("sha256").update(JSON.stringify(STATE)).digest("hex");
  assert(
    r.seam === seam && r.question === "q" && r.rule === "ok",
    "the identity fields name the seam, the question and the caller's rule",
  );
  assert(
    r.mode === "shadow",
    `mode is the seam's effective mode, not absent (${JSON.stringify(r.mode)})`,
  );
  assert(
    r.composition === "replace",
    `composition is the registry's declared policy, which the throw does not change (${JSON.stringify(r.composition)})`,
  );
  assert(
    r.state === JSON.stringify(STATE) && r.stateChars === JSON.stringify(STATE).length,
    "state is the serialised text that reached the backend, not an empty placeholder",
  );
  assert(
    r.stateHash === expectedHash,
    "stateHash is the sha256 of exactly the state text the log carries",
  );
  assert(
    r.ruleAnswer === "ok" && (r.final as { answer?: string })?.answer === "ok",
    "ruleAnswer and final.answer agree on the answer the caller actually got",
  );
  assert(
    typeof r.error === "string" && /evidence reader exploded/.test(r.error),
    `the record says why it failed (${JSON.stringify(String(r.error)).slice(0, 90)})`,
  );
  assert(
    (r.backends as { name?: string; answer?: string }[])?.[0]?.answer === "ok",
    "the backend's answer survives the catch, so a late failure still shows what the model said",
  );
  assert(
    r.exactRuleMatch === undefined && r.skipped === undefined,
    "a catch record is neither an exact-rule-match nor a skip — S5 counts the three apart",
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
