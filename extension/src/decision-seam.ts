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
import { type EvidenceCheck, verifyEvidence } from "./decision-evidence.ts";
import { appendDecisionRecord, redactState } from "./decision-log.ts";
import {
  SEAMS,
  type SeamId,
  type SeamSpec,
  UNDECIDED,
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
  signal?: AbortSignal;
}

/** Where a seam's decision log goes: the cycle's repo root and issues. */
export type DecisionWhere = Pick<DecideCtx, "repoRoot" | "issues">;

export interface Decision {
  answer: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  source: "classifier" | "llm" | "rule";
  /** The backend whose answer is the outcome, or `rule`. */
  backend: string;
  /** No backend produced a valid answer. */
  abstained: boolean;
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
  try {
    if (outer?.aborted) throw new Error("aborted");
    const timeout = new Promise<BackendResult>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve({ ok: false, error: `timed out after ${input.timeoutMs}ms` });
      }, input.timeoutMs);
    });
    const result = await Promise.race([b.run(input, ac.signal), timeout]);
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

/** Ask one seam's question. Never throws; always logs one record. */
export async function decide(
  seam: SeamId,
  req: DecideRequest,
  ctx: DecideCtx = {},
): Promise<Decision> {
  const t0 = Date.now();
  const spec = (SEAMS as Record<string, SeamSpec>)[seam];
  const attempts: Attempt[] = [];
  const notes: string[] = [];
  let decision: Decision;
  let stateRedactions = 0;
  let record: Record<string, unknown> = {
    seam,
    question: req.question,
    rule: req.rule,
  };
  try {
    if (!spec) throw new Error(`unknown seam '${seam}'`);
    const violations = seamContractViolations(spec);
    const cfg = seamConfig(spec);
    const mode = violations.length > 0 ? "off" : cfg.mode;
    if (violations.length > 0) {
      notes.push(`contract violations, rule only: ${violations.join("; ")}`);
      traceWarn(
        `decision-seam: '${seam}' violates its contract, rule only: ${violations.join("; ")}`,
      );
    }
    const labels = Object.keys(spec.labels);
    const undecided = req.rule === UNDECIDED;
    let rule = undecided ? spec.ruleDefault : req.rule;
    if (!labels.includes(rule)) {
      notes.push(`rule answer '${rule}' is not a label; using the seam default`);
      rule = spec.ruleDefault;
    }

    // Serialise first (a cyclic state fails here, not in the redactor), then
    // redact: no backend, hash or log line ever sees a credential-shaped span.
    const raw = serialise(req.state);
    const clean = raw === undefined ? undefined : redactState(JSON.parse(raw));
    stateRedactions = clean?.count ?? 0;
    const serialised = clean ? serialise(clean.state) : undefined;
    const stateText = serialised ?? "";
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
          state: clean?.state,
          stateText,
          timeoutMs: cfg.timeoutMs,
          tokenBudget: cfg.tokenBudget,
        };
        const backends = ctx.backends ?? defaultBackends(ctx.modelRegistry, ctx.model);
        if (backends.length === 0) notes.push("no model backend available");
        for (const b of backends) {
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
    // A rule answer that is not a label falls to the seam default, as above.
    const fallback =
      spec && !Object.keys(spec.labels).includes(req.rule) ? spec.ruleDefault : req.rule;
    decision = {
      answer: fallback,
      source: "rule",
      backend: "rule",
      abstained: true,
      reason: `decide failed, rule answer used: ${(err as Error)?.message ?? String(err)}`,
      latencyMs: Date.now() - t0,
    };
    // The same core fields as a successful record, so S5 can count error-path calls.
    record = { ...record, ruleAnswer: fallback, error: decision.reason };
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
