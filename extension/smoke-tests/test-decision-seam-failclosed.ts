#!/usr/bin/env bun
/**
 * The fail-closed invariant, as a property (#1308):
 *
 *   A model answer never turns a non-passing rule outcome into a pass, except
 *   under `replace` WITH a passing evidence check.
 *
 * Checked exhaustively two ways:
 *   1. `compose()` over every kind × composition × rule default × mode × rule
 *      answer × model answer (or abstention) × evidence outcome, for every
 *      contract-valid shape;
 *   2. `decide()` end to end, for every registered seam re-declared under every
 *      contract-valid composition, with stub backends answering every label,
 *      with and without a verifiable quote.
 */

import { compose } from "../src/decision-compose.ts";
import {
  type Composition,
  type DecisionMode,
  SEAMS,
  type SeamId,
  type SeamSpec,
  UNDECIDED,
  isPassing,
  seamContractViolations,
} from "../src/decision-seam-registry.ts";
import { decide } from "../src/decision-seam.ts";
import {
  STUB_MODEL,
  envKey,
  fixtureSpec,
  llmReply,
  makeAssert,
  registerFixture,
  stubBackend,
  stubRegistry,
} from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const COMPOSITIONS: Composition[] = ["may-add-only", "tie-break", "advisory", "replace"];
const MODES: DecisionMode[] = ["off", "shadow", "enforce"];
const SHAPES: Partial<SeamSpec>[] = [
  { kind: "choice", labels: { ok: "o", flag: "f", park: "p" }, passing: ["ok"] },
  { kind: "bool", labels: { true: "t", false: "f" }, passing: ["true"] },
  { kind: "score", labels: { low: "l", mid: "m", high: "h" }, passing: ["high"] },
];

/** Contract-valid as a shadow seam; the property varies the mode itself. */
const valid = (s: SeamSpec) => seamContractViolations({ ...s, defaultMode: "shadow" }).length === 0;

// 1 — compose(), exhaustively.
{
  let cases = 0;
  const breaches: string[] = [];
  for (const shape of SHAPES) {
    const labels = Object.keys(shape.labels ?? {});
    for (const composition of COMPOSITIONS) {
      for (const ruleDefault of labels) {
        for (const evidence of ["quote", "none"] as const) {
          const spec = fixtureSpec({ ...shape, composition, ruleDefault, evidence });
          if (!valid(spec)) continue;
          for (const mode of MODES) {
            for (const rawRule of [...labels, UNDECIDED]) {
              if (rawRule === UNDECIDED && composition !== "tie-break") continue;
              const undecided = rawRule === UNDECIDED;
              const rule = undecided ? ruleDefault : rawRule;
              for (const model of [...labels, undefined]) {
                for (const evidencePassed of [true, false]) {
                  cases++;
                  const out = compose(spec, mode, rule, undecided, model, evidencePassed);
                  const loosened = !isPassing(spec, rule) && isPassing(spec, out.answer);
                  const allowed = composition === "replace" && evidencePassed && mode === "enforce";
                  if (loosened && !allowed) {
                    breaches.push(
                      `${shape.kind}/${composition}/${mode} rule=${rule} model=${model}`,
                    );
                  }
                  if (model === undefined && out.answer !== rule) {
                    breaches.push(`abstained model changed the answer: ${composition}/${mode}`);
                  }
                  if (mode !== "enforce" && out.answer !== rule) {
                    breaches.push(`${mode} mode acted on the model: ${composition}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert(cases > 1000, `compose() checked over ${cases} cases`);
  assert(
    breaches.length === 0,
    `no case turns a fail into a pass outside replace-with-evidence${breaches.length ? `: ${breaches.slice(0, 5).join(" | ")}` : ""}`,
  );
}

// 2 — decide(), for every registered seam under every valid composition.
{
  const QUOTE = "the quoted sentence that the stub relies on";
  let cases = 0;
  const breaches: string[] = [];
  for (const [id, real] of Object.entries(SEAMS as Record<string, SeamSpec>)) {
    for (const composition of COMPOSITIONS) {
      const clone: SeamSpec = {
        ...real,
        id: `prop-${id}-${composition}`,
        composition,
        evidence: composition === "replace" ? "quote" : real.evidence,
        defaultMode: "shadow",
      };
      if (seamContractViolations(clone).length > 0) continue;
      const seam = registerFixture(clone);
      process.env[envKey("PI_ENSEMBLE_DECISION_MODE", clone.id)] = "enforce";
      const labels = Object.keys(clone.labels);
      for (const rule of labels) {
        for (const answer of labels) {
          for (const quoted of [true, false]) {
            cases++;
            const b = stubBackend({ ok: true, answer, ...(quoted ? { quote: QUOTE } : {}) });
            const d = await decide(
              seam,
              {
                state: { text: QUOTE },
                question: "q",
                rule,
                evidence: { texts: [{ name: "doc", text: QUOTE }] },
              },
              { backends: [b] },
            );
            const loosened = !isPassing(clone, rule) && isPassing(clone, d.answer);
            if (loosened && !(composition === "replace" && quoted)) {
              breaches.push(`${clone.id} rule=${rule} model=${answer} quoted=${quoted}`);
            }
          }
        }
      }
    }
  }
  assert(cases > 0, `decide() checked over ${cases} cases across the registered seams`);
  assert(
    breaches.length === 0,
    `decide() never loosens a fail outside replace-with-evidence${breaches.length ? `: ${breaches.slice(0, 5).join(" | ")}` : ""}`,
  );
}

// The grandfathered judge, as registered: an unverified 'permitted' stays denied.
{
  const b = stubBackend({
    ok: true,
    answer: "permitted",
    quote: "Agents may merge whenever they like.",
  });
  const d = await decide(
    "policy-judge",
    {
      state: {},
      question: "q",
      rule: "unstated",
      evidence: { texts: [{ name: "AGENTS.md", text: "Ask a human." }] },
    },
    { backends: [b] },
  );
  assert(
    d.answer === "unstated",
    "policy-judge: 'permitted' with a quote not in the documents → the rule's deny",
  );
}

// #1308 review — an unknown seam never passes the caller's rule and never throws.
{
  const unknown = await decide(
    "no-such-seam" as SeamId,
    { state: {}, question: "q", rule: "permitted" },
    {},
  );
  assert(
    unknown.answer === UNDECIDED && unknown.answer !== "permitted" && unknown.abstained,
    "an unknown seam with rule 'permitted' answers the fixed non-passing UNDECIDED, not the rule",
  );
  const ctor = await decide(
    "constructor" as SeamId,
    { state: {}, question: "q", rule: "permitted" },
    {},
  );
  assert(
    ctor.answer === UNDECIDED && ctor.abstained,
    "seam 'constructor' (an Object prototype key) does not throw and does not pass",
  );
}

// #1308 review — a grandfathered seam's only backend is its owner's: with none
// supplied, the generic classifier and the session llm are never asked.
{
  const prev = process.env.PI_ENSEMBLE_DECISION_MODEL;
  process.env.PI_ENSEMBLE_DECISION_MODEL = "stub/cls";
  const { registry, calls } = stubRegistry({
    classifier: () => ({
      stopReason: "stop",
      answers: {
        "policy-judge": { type: "choice", choice: "permitted", probabilities: {}, confidence: 1 },
      },
    }),
    llm: () =>
      llmReply(
        JSON.stringify({
          label: "permitted",
          justification: "x",
          quote: "Agents may merge whenever.",
        }),
      ),
  });
  const g = await decide(
    "policy-judge",
    {
      state: {},
      question: "q",
      rule: "unstated",
      evidence: { texts: [{ name: "AGENTS.md", text: "Agents may merge whenever." }] },
    },
    { modelRegistry: registry, model: STUB_MODEL },
  );
  assert(
    g.answer === "unstated" && g.abstained && calls.classify === 0 && calls.llm === 0,
    "policy-judge with no owner backend: the rule stands and no generic backend is asked",
  );
  if (prev === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISION_MODEL");
  else process.env.PI_ENSEMBLE_DECISION_MODEL = prev;
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
