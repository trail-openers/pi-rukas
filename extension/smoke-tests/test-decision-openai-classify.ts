#!/usr/bin/env bun
/**
 * The `openai-logprobs-classify` classifier API (decision-openai-classify.ts).
 *
 *   - the request is one generated token with `top_logprobs`, sent to
 *     `<baseUrl>/chat/completions` with the model id and the bearer key;
 *   - the answer is the softmax over the label tokens, matched by trimmed text
 *     (a leading-space token counts), and a label outside the readout gets the
 *     floor rather than vanishing;
 *   - no label in the readout, an HTTP error and a body without logprobs are
 *     `stopReason: "error"` — the function never rejects;
 *   - registration needs `PI_ENSEMBLE_DECISION_MODEL` and
 *     `PI_ENSEMBLE_DECISION_BASE_URL`, and registers that provider's one
 *     classifier model; the key goes in as an env reference, never a literal.
 *
 * Offline: the endpoint is a local Bun server.
 */

import { classify, registerDecisionClassifier } from "../src/decision-openai-classify.ts";
import { makeAssert } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

type Top = { token: string; logprob: number }[];
let reply: { status: number; top?: Top } = { status: 200, top: [] };
let seen: { path: string; auth: string | null; body: Record<string, unknown> } | undefined;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen = {
      path: new URL(req.url).pathname,
      auth: req.headers.get("authorization"),
      body: (await req.json()) as Record<string, unknown>,
    };
    if (reply.status !== 200) return new Response("overloaded", { status: reply.status });
    const content = reply.top ? [{ token: "x", logprob: 0, top_logprobs: reply.top }] : undefined;
    return Response.json({
      choices: [{ logprobs: content ? { content } : null }],
      usage: { prompt_tokens: 300, completion_tokens: 1 },
    });
  },
});

const model = {
  api: "openai-logprobs-classify",
  provider: "mesh",
  id: "small-3b",
  baseUrl: `http://127.0.0.1:${server.port}/v1/`,
} as Parameters<typeof classify>[0];
const context = {
  state: { kind: "dispatch-failed", providerMessage: "503 overloaded" },
  questions: {
    cause: {
      type: "choice" as const,
      instructions: "What caused the failure?",
      criteria: { transient: "retry may work", "rate-limited": "quota", unknown: "cannot tell" },
    },
  },
};

// 1. Request shape and a confident answer; " B" carries a leading space.
reply = {
  status: 200,
  top: [
    { token: "A", logprob: -0.05 },
    { token: " B", logprob: -3.2 },
    { token: "We", logprob: -4 },
  ],
};
let r = await classify(model, context, { apiKey: "k-123" });
assert(
  seen?.path === "/v1/chat/completions",
  `posts to <baseUrl>/chat/completions (${seen?.path})`,
);
assert(seen?.auth === "Bearer k-123", "sends the resolved key as a bearer token");
assert(
  seen?.body.model === "small-3b" &&
    seen.body.max_tokens === 1 &&
    seen.body.logprobs === true &&
    seen.body.top_logprobs === 20,
  `asks for one token with top_logprobs (${JSON.stringify(seen?.body).slice(0, 120)})`,
);
const prompt = JSON.stringify(seen?.body.messages);
assert(
  prompt.includes("A. transient") && prompt.includes("Answer with one letter."),
  "the prompt labels the options with letters",
);
let a = r.answers.cause;
assert(
  r.stopReason === "stop" && a?.type === "choice",
  `answers (${r.stopReason} ${r.errorMessage ?? ""})`,
);
if (a?.type === "choice") {
  assert(a.choice === "transient", `the highest-probability label wins (${a.choice})`);
  const p = a.probabilities;
  assert(
    (p.unknown ?? 0) > 0 && (p.unknown ?? 1) <= (p["rate-limited"] ?? 0),
    `a label outside the readout gets the floor, not zero (${JSON.stringify(p)})`,
  );
  const sum = Object.values(p).reduce((x, y) => x + y, 0);
  assert(Math.abs(sum - 1) < 1e-9, `probabilities sum to 1 (${sum})`);
}
assert(r.usage?.input === 300, "usage carries the server's token counts");

// 2. No label anywhere in the readout → error, not a guess.
reply = { status: 200, top: [{ token: "We", logprob: -0.1 }] };
r = await classify(model, context, {});
assert(
  r.stopReason === "error" && /no answer label/.test(r.errorMessage ?? ""),
  "no label → error",
);

// 3. HTTP failure and a body without logprobs → error; never rejects.
reply = { status: 503 };
r = await classify(model, context, {});
assert(r.stopReason === "error" && /503/.test(r.errorMessage ?? ""), "HTTP 503 → error");
reply = { status: 200, top: undefined };
r = await classify(model, context, {});
assert(
  r.stopReason === "error" && /no logprobs/.test(r.errorMessage ?? ""),
  "missing logprobs → error",
);

// 4. Bool questions read Yes/No.
reply = {
  status: 200,
  top: [
    { token: "No", logprob: -0.2 },
    { token: "Yes", logprob: -1.8 },
  ],
};
r = await classify(
  model,
  { state: {}, questions: { b: { type: "bool", instructions: "Ok?", criteria: {} } } },
  {},
);
a = r.answers.b;
assert(a?.type === "bool" && a.probability < 0.5, `bool reads Yes/No (${JSON.stringify(a)})`);

server.stop(true);

// 5. Registration needs both PI_ENSEMBLE_DECISION_MODEL and _BASE_URL, and
// registers that provider's one classifier model with this API.
type Cfg = {
  baseUrl?: string;
  apiKey?: string;
  models?: { type?: string; api?: string; id: string }[];
  classifiers?: Record<string, unknown>;
};
const calls: { name: string; cfg: Cfg }[] = [];
const fakePi = {
  registerProvider: (name: string, cfg: Cfg) => calls.push({ name, cfg }),
} as unknown as Parameters<typeof registerDecisionClassifier>[0];
const KEYS = [
  "PI_ENSEMBLE_DECISION_MODEL",
  "PI_ENSEMBLE_DECISION_BASE_URL",
  "PI_ENSEMBLE_DECISION_API_KEY",
] as const;
const saved = KEYS.map((k) => process.env[k]);
const setEnv = (model?: string, url?: string, key?: string) => {
  [model, url, key].forEach((v, i) => {
    const k = KEYS[i] as string;
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  });
};
setEnv("decision/small-3b", "http://mesh:8086/v1");
registerDecisionClassifier(fakePi);
setEnv("decision/small-3b", undefined);
registerDecisionClassifier(fakePi);
setEnv(undefined, "http://mesh:8086/v1");
registerDecisionClassifier(fakePi);
setEnv("no-slash", "http://mesh:8086/v1");
registerDecisionClassifier(fakePi);
setEnv("decision/small-3b", "http://mesh:8086/v1", "k-1");
registerDecisionClassifier(fakePi);
setEnv(...(saved as [string?, string?, string?]));
const [first, keyed] = calls;
const m = first?.cfg.models?.[0];
assert(calls.length === 2, `registers only when both are set and valid (${calls.length} calls)`);
assert(
  first?.name === "decision" &&
    first.cfg.baseUrl === "http://mesh:8086/v1" &&
    first.cfg.models?.length === 1 &&
    m?.type === "classifier" &&
    m.api === "openai-logprobs-classify" &&
    m.id === "small-3b" &&
    Object.keys(first.cfg.classifiers ?? {}).join() === "openai-logprobs-classify",
  `registers the named provider with one classifier model (${JSON.stringify(first)})`,
);
assert(
  first?.cfg.apiKey === "none" && keyed?.cfg.apiKey === "$PI_ENSEMBLE_DECISION_API_KEY",
  "the key is an env reference when set, a placeholder otherwise — never the literal value",
);

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
