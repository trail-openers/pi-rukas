/**
 * decision-seam — the one interface every judged decision in the drivers goes
 * through (#1308).
 *
 *   decide(seam, { state, question, rule, evidence? }, ctx) → Decision
 *
 * A seam asks one typed question about JSON state. The caller always computes
 * the deterministic rule's answer; `decide()` then tries the model backends in
 * order — a configured classifier (`PI_ENSEMBLE_DECISION_MODEL`), then the
 * session's default LLM (decision-backends.ts) — or the seam owner's own
 * backends via `ctx.backends`. The first valid answer wins; an unavailable
 * backend, an error, a non-stop result, a timeout, an over-budget call or an
 * answer outside the seam's labels abstains and falls to the next. The model
 * answer is then combined with the rule by the seam's declared composition
 * (decision-compose.ts), which is where the fail-closed invariant lives.
 *
 * With no decision model and no usable LLM, every seam returns exactly its
 * rule answer — pi-rukas never depends on a model being configured.
 *
 * `decide()` never throws and always writes one decision-log record
 * (decision-log.ts). Oversized state is abstained, never truncated, and the
 * reason is logged.
 */

import { createHash } from "node:crypto";
import {
  type Backend,
  type BackendInput,
  type BackendResult,
  type DecisionRegistry,
  type DecisionUsage,
  defaultBackends,
} from "./decision-backends.ts";
import { compose } from "./decision-compose.ts";
import { type EvidenceCheck, type EvidenceResult, verifyEvidence } from "./decision-evidence.ts";
import {
  LOG_STRING_CHARS,
  appendDecisionRecord,
  boundField,
  redactDeep,
  redactSecrets,
} from "./decision-log.ts";
import {
  type DecisionMode,
  SEAMS,
  type SeamId,
  type SeamSpec,
  UNDECIDED,
  isGrandfathered,
  seamConfig,
  seamContractViolations,
} from "./decision-seam-registry.ts";
import { traceWarn } from "./trace.ts";

export interface DecideRequest {
  /** The data the question is about. Untrusted: fenced, bounded, never instructions. */
  state: unknown;
  /** This call's question, in prose. The labels are the seam's, not the caller's. */
  question: string;
  /** The deterministic rule's answer — a seam label, or `UNDECIDED` on a tie-break seam. */
  rule: string;
  /** Required for a `replace` seam's model answer to count. */
  evidence?: EvidenceCheck;
}

export interface DecideCtx {
  modelRegistry?: DecisionRegistry;
  /** The session's default chat model, for the llm backend. */
  model?: Parameters<DecisionRegistry["streamSimple"]>[0];
  /** The seam owner's backends, replacing the default classifier → llm order. */
  backends?: readonly Backend[];
  /** Where the decision log is written; without it the record is only traced. */
  repoRoot?: string;
  /** The /work cycle's issues; the lowest one names the log directory. */
  issues?: readonly number[];
  /** A tighter bound for this call. It can only shorten the seam's own timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Where a seam's decision log goes, and how long its backends may run. */
export type DecisionWhere = Pick<DecideCtx, "repoRoot" | "issues" | "timeoutMs">;

export interface Decision {
  answer: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  source: "classifier" | "llm" | "rule";
  /** The backend whose answer is the outcome, or `rule`. */
  backend: string;
  /** No backend produced a valid answer. */
  abstained: boolean;
  /**
   * The valid model answer and what it cited, whether or not composition let
   * it stand. Callers read a refused answer here, never from a side channel.
   */
  model?: { answer: string; quote?: string; cited?: string };
  /** The evidence check, when the seam ran one on the model's answer. */
  evidence?: EvidenceResult;
  reason?: string;
  latencyMs: number;
  usage?: DecisionUsage;
}

interface Attempt {
  backend: string;
  source: Backend["source"];
  latencyMs: number;
  result: BackendResult;
}

function sumUsage(attempts: readonly Attempt[]): DecisionUsage | undefined {
  const us = attempts.map((a) => a.result.usage).filter((u): u is DecisionUsage => !!u);
  if (us.length === 0) return undefined;
  return us.reduce((a, b) => ({
    input: a.input + b.input,
    output: a.output + b.output,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: (a.cost ?? 0) + (b.cost ?? 0),
  }));
}

/** Out-of-schema answers abstain: the label set is the seam's, nobody else's. */
function invalid(spec: SeamSpec, r: BackendResult, budget: number): string | undefined {
  if (!r || typeof r !== "object") return "the backend returned no result";
  if (r.ok !== true) return String((r as { error?: unknown }).error || "the backend failed");
  const labels = Object.keys(spec.labels);
  if (!labels.includes(r.answer))
    return `answer '${String(r.answer).slice(0, 60)}' is not a seam label`;
  if (r.confidence !== undefined && !(r.confidence >= 0 && r.confidence <= 1)) {
    return "confidence out of range";
  }
  if (r.probabilities) {
    for (const [k, p] of Object.entries(r.probabilities)) {
      if (!labels.includes(k) || !(p >= 0 && p <= 1))
        return "probabilities outside the seam's labels";
    }
  }
  if (r.usage && r.usage.totalTokens > budget) {
    return `token budget exceeded (${r.usage.totalTokens} > ${budget})`;
  }
  return undefined;
}

async function runBounded(
  b: Backend,
  input: BackendInput,
  outer: AbortSignal | undefined,
): Promise<Attempt> {
  const t0 = Date.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  // #1393 — the outer signal must END the race, not merely signal the backend.
  // A backend that ignores its own AbortSignal and never settles used to hold
  // `await Promise.race` open for the whole seam timeout, so an aborted caller
  // waited out a bound it had already cancelled. The abort is now a third racer.
  const aborted =
    outer === undefined
      ? undefined
      : new Promise<BackendResult>((resolve) => {
          if (outer.aborted) resolve({ ok: false, error: "aborted before the backend ran" });
          else
            outer.addEventListener("abort", () => resolve({ ok: false, error: "aborted" }), {
              once: true,
            });
        });
  // A run that settles after the bound is discarded, but traced: a judge that
  // answers late is exactly the event an operator needs to be able to see.
  const late = () =>
    traceWarn(`decision-seam: ${b.name} settled after its ${input.timeoutMs}ms bound; discarded`);
  try {
    if (outer?.aborted) throw new Error("aborted");
    const timeout = new Promise<BackendResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        resolve({ ok: false, error: `timed out after ${input.timeoutMs}ms` });
      }, input.timeoutMs);
    });
    const run = b.run(input, ac.signal).then(
      (r) => {
        if (timedOut) late();
        return r;
      },
      (e) => {
        if (timedOut) late();
        throw e;
      },
    );
    const result = await Promise.race([run, timeout, aborted ?? new Promise<never>(() => {})]);
    return { backend: b.name, source: b.source, latencyMs: Date.now() - t0, result };
  } catch (err) {
    const error = `threw: ${(err as Error)?.message ?? String(err)}`.slice(0, 300);
    return {
      backend: b.name,
      source: b.source,
      latencyMs: Date.now() - t0,
      result: { ok: false, error },
    };
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/** Undefined when the state is not JSON (cyclic, BigInt): a model must not be handed a placeholder. */
function serialise(state: unknown): string | undefined {
  try {
    return JSON.stringify(state) ?? "null";
  } catch {
    return undefined;
  }
}

/**
 * Apply the seam's declared per-field bounds (#1393), BEFORE the token-budget
 * check and before redaction: the input is bounded first, so a whole-document
 * field is never regex-scanned end to end, and each field is then redacted over
 * its complete text by `boundField` rather than at the call site. A non-string
 * or absent value, and a field the seam did not declare, pass through for the
 * record-level bound in `appendDecisionRecord` to handle.
 */
/**
 * Bound the seam's declared fields and redact every span, in one pass per
 * field: the input is bounded BEFORE redaction, so a whole-document field is
 * never regex-scanned end to end, and `boundField` redacts over the complete
 * text it keeps, so a clip can never cut a credential into a fragment the
 * patterns no longer recognise. Lives on the seam, not at the call site (#1393).
 *
 * A non-object state has no fields to bound but is still redacted; a field the
 * seam did not declare keeps only the record-level bound `appendDecisionRecord`
 * applies to every string.
 */
export function boundedState(state: unknown, spec: SeamSpec): { state: unknown; count: number } {
  const counter = { n: 0 };
  const redactOne = (v: string, bound: { max: number; from?: "start" | "end" }): string => {
    // Counted over the whole value, then bounded: `boundField` redacts the text
    // it keeps, so a credential the bound cut off still counts as a redaction
    // the log already made rather than vanishing from the tally.
    counter.n += redactSecrets(v).count;
    return boundField(v, bound);
  };
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return typeof state === "string"
      ? { state: redactOne(state, { max: LOG_STRING_CHARS }), count: counter.n }
      : { state, count: 0 };
  }
  const out: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  const declared = spec.fields ?? {};
  // A field the seam DECLARED gets its own bound (redact the whole text, then
  // clip). Everything else — an undeclared string, a string nested in an object
  // or array — is redacted recursively at the record-wide bound. Both must
  // happen HERE, in front of the model: the record-level redactor in
  // `appendDecisionRecord` runs on the log line only, so leaving an undeclared
  // string alone would redact the record and leak the secret to the backend —
  // which is the one consumer this issue is about (#1393).
  //
  // A cyclic state makes `redactDeep` throw, exactly as `serialise()` below
  // would; letting it propagate is deliberate — `decide` catches it and records
  // "state is not serialisable as JSON", the same outcome the JSON round-trip
  // produces, with no second copy of that judgement here.
  for (const [name, value] of Object.entries(out)) {
    const bound = declared[name];
    out[name] =
      bound !== undefined && typeof value === "string"
        ? redactOne(value, bound)
        : redactDeep(value, counter, LOG_STRING_CHARS);
  }
  return { state: out, count: counter.n };
}

/** Ask one seam's question. Never throws; always logs one record. */
export async function decide(
  seam: SeamId,
  req: DecideRequest,
  ctx: DecideCtx = {},
): Promise<Decision> {
  const t0 = Date.now();
  // An own-property check: `constructor` and friends are not seams.
  const spec = Object.hasOwn(SEAMS, seam) ? (SEAMS as Record<string, SeamSpec>)[seam] : undefined;
  const attempts: Attempt[] = [];
  const notes: string[] = [];
  let decision: Decision;
  let stateRedactions = 0;
  // The core fields every record carries, success or catch path alike, so S5
  // can count an error-path call as a sample (#1393). The catch path fills in
  // the ones computed before the throw and adds `error`; nothing here is
  // conditional on how far the body got.
  let mode: DecisionMode = spec === undefined ? "off" : seamConfig(spec).mode;
  let stateText = "";
  let record: Record<string, unknown> = {
    seam,
    question: req.question,
    rule: req.rule,
  };
  try {
    if (!spec) throw new Error(`unknown seam '${seam}'`);
    const violations = seamContractViolations(spec);
    const cfg = seamConfig(spec);
    mode = violations.length > 0 ? "off" : cfg.mode;
    if (violations.length > 0) {
      notes.push(`contract violations, rule only: ${violations.join("; ")}`);
      traceWarn(
        `decision-seam: '${seam}' violates its contract, rule only: ${violations.join("; ")}`,
      );
    }
    const labels = Object.keys(spec.labels);
    const timeoutMs =
      ctx.timeoutMs !== undefined && ctx.timeoutMs > 0
        ? Math.min(cfg.timeoutMs, ctx.timeoutMs)
        : cfg.timeoutMs;
    const undecided = req.rule === UNDECIDED;
    let rule = undecided ? spec.ruleDefault : req.rule;
    if (!labels.includes(rule)) {
      notes.push(`rule answer '${rule}' is not a label; using the seam default`);
      rule = spec.ruleDefault;
    }

    // Bound each declared field and redact every string, then serialise: no
    // backend, hash or log line ever sees a credential-shaped span, and no field
    // is regex-scanned past its bound. A cyclic state throws inside the redactor,
    // which is read here as the same "not serialisable" it would fail as below —
    // one judgement, not two.
    let bounded: { state: unknown; count: number } | undefined;
    let serialised: string | undefined;
    try {
      bounded = boundedState(req.state, spec);
      const raw = serialise(bounded.state);
      // JSON round-trip so the hash, the model and the log all see the same text.
      serialised = raw === undefined ? undefined : serialise(JSON.parse(raw));
    } catch {
      bounded = bounded ?? { state: req.state, count: 0 };
      serialised = undefined;
    }
    stateRedactions = bounded.count;
    stateText = serialised ?? "";
    const estTokens = Math.ceil((stateText.length + req.question.length) / 4);
    let model: (BackendResult & { ok: true }) | undefined;
    let used: Attempt | undefined;
    if (mode !== "off") {
      if (serialised === undefined) {
        notes.push("state is not serialisable as JSON; abstained");
      } else if (estTokens > cfg.tokenBudget) {
        notes.push(
          `state is oversized (~${estTokens} tokens > budget ${cfg.tokenBudget}); abstained, not truncated`,
        );
      } else {
        const input: BackendInput = {
          spec,
          question: req.question,
          state: bounded.state,
          stateText,
          timeoutMs,
          tokenBudget: cfg.tokenBudget,
        };
        // A grandfathered seam's only backend is its owner's. With none supplied it
        // answers from the rule, never from the generic classifier / session llm.
        let backends: readonly Backend[];
        if (ctx.backends) backends = ctx.backends;
        else if (isGrandfathered(spec)) {
          backends = [];
          notes.push("grandfathered seam has no owner backend; the rule stands");
          traceWarn(`decision-seam: '${seam}' has no owner backend; rule only`);
        } else backends = defaultBackends(ctx.modelRegistry, ctx.model);
        if (backends.length === 0 && !isGrandfathered(spec)) {
          notes.push("no model backend available");
        }
        for (const b of backends) {
          // An outer abort ends the whole attempt, not just this backend: the
          // remaining backends are not started and the rule answer is returned
          // now, bounded by the caller's signal rather than the seam's timeout.
          if (ctx.signal?.aborted) {
            notes.push("aborted before the backends; the rule stands");
            break;
          }
          const a = await runBounded(b, input, ctx.signal);
          attempts.push(a);
          const why = invalid(spec, a.result, cfg.tokenBudget);
          if (why) {
            a.result = { ok: false, error: why, usage: a.result?.usage };
            continue;
          }
          model = a.result as BackendResult & { ok: true };
          used = a;
          break;
        }
      }
    }

    const evidence =
      model && spec.evidence === "quote"
        ? await verifyEvidence(req.evidence, model.quote, model.cited)
        : undefined;
    const composed = compose(spec, mode, rule, undecided, model?.answer, evidence?.passed === true);
    const failures = model
      ? []
      : attempts.map((a) => `${a.backend}: ${a.result.ok ? "" : a.result.error}`);
    const reason = [
      composed.result,
      evidence ? `evidence: ${evidence.reason}` : "",
      ...notes,
      ...failures,
    ]
      .filter(Boolean)
      .join("; ");
    decision = {
      answer: composed.answer,
      model: model && { answer: model.answer, quote: model.quote, cited: model.cited },
      evidence,
      ...(composed.fromModel && model?.probabilities ? { probabilities: model.probabilities } : {}),
      ...(composed.fromModel && model?.confidence !== undefined
        ? { confidence: model.confidence }
        : {}),
      source: composed.fromModel && used ? used.source : "rule",
      backend: composed.fromModel && used ? used.backend : "rule",
      abstained: model === undefined,
      reason,
      latencyMs: Date.now() - t0,
      usage: sumUsage(attempts),
    };
    record = {
      ...record,
      mode,
      composition: spec.composition,
      stateHash: createHash("sha256").update(stateText).digest("hex"),
      stateChars: stateText.length,
      state: stateText,
      ruleAnswer: rule,
      evidence,
      compositionResult: composed.result,
    };
  } catch (err) {
    // A seam we do not know has no labels to check the rule against, so it gets
    // the fixed non-passing UNDECIDED answer — never the caller's rule. A rule
    // that is not a label falls to the seam default, as above.
    const fallback =
      spec === undefined
        ? UNDECIDED
        : Object.keys(spec.labels).includes(req.rule)
          ? req.rule
          : spec.ruleDefault;
    decision = {
      answer: fallback,
      source: "rule",
      backend: "rule",
      abstained: true,
      reason: `decide failed, ${spec === undefined ? "fixed fail-closed answer" : "rule answer"} used: ${(err as Error)?.message ?? String(err)}`,
      latencyMs: Date.now() - t0,
    };
    // The same core fields as a successful record, so S5 can count error-path
    // calls: `mode`, `composition`, `stateHash` and `state` are present on both
    // paths (`stateHash` over whatever was serialised before the throw — the
    // empty string when nothing was — and `composition` over the registry's
    // declared policy, which the throw does not change). `ruleAnswer` is the
    // fallback the caller actually got and `error` says why.
    record = {
      ...record,
      mode,
      composition: spec?.composition,
      stateHash: createHash("sha256").update(stateText).digest("hex"),
      stateChars: stateText.length,
      state: stateText,
      ruleAnswer: fallback,
      error: decision.reason,
    };
  }
  await appendDecisionRecord(
    ctx,
    {
      ts: new Date().toISOString(),
      ...record,
      backends: attempts.map((a) => ({
        name: a.backend,
        source: a.source,
        latencyMs: a.latencyMs,
        ...(a.result.ok
          ? {
              answer: a.result.answer,
              probabilities: a.result.probabilities,
              confidence: a.result.confidence,
              quote: a.result.quote,
              cited: a.result.cited,
            }
          : { error: a.result.error }),
        usage: a.result.usage,
      })),
      final: decision,
    },
    stateRedactions,
  ).catch(() => undefined);
  return decision;
}
