/**
 * decision-seam-registry — the SEAMS registry: every judged decision the
 * drivers route through `decide()` declares itself here, once (#1308).
 *
 * A seam is a typed question with a deterministic rule behind it. The entry
 * fixes everything a model could otherwise be talked out of: the question
 * kind, the allowed labels (never taken from state), which labels count as a
 * pass, the rule's default answer, and how a model answer may combine with
 * the rule (`composition`). `test-decision-seam-contract.ts` enforces the
 * entries against `seamContractViolations`, and `decide()` refuses to consult
 * a model for an entry that fails it — a malformed seam is rule-only.
 *
 * **Fail-closed, defined** (operator decision 2): a seam is fail-closed when
 * its rule's default answer is not a passing label. It is derived from the
 * entry, never declared, so it cannot drift from the rule.
 *
 * Config is env, like every other `PI_ENSEMBLE_*` knob: per-seam
 * `PI_ENSEMBLE_DECISION_MODE_<SEAM>` (off|shadow|enforce),
 * `PI_ENSEMBLE_DECISION_TIMEOUT_MS_<SEAM>` and
 * `PI_ENSEMBLE_DECISION_BUDGET_<SEAM>` (tokens), where `<SEAM>` is the id
 * upper-cased with `-` → `_`. `PI_ENSEMBLE_DECISIONS=0` makes every seam
 * rule-only. A `grandfathered` seam ignores all of these: its registry values
 * are its behaviour, and it answers only to its own escape hatch.
 */

export type QuestionKind = "choice" | "bool" | "score";

/**
 * How a model answer combines with the rule, enforced centrally in
 * `decision-compose.ts`:
 *   - `may-add-only` — the model can only move a pass to a non-pass (add a park/flag);
 *   - `tie-break`    — the model decides only when the rule returns `UNDECIDED`;
 *   - `advisory`     — logged, never acted on;
 *   - `replace`      — the model's answer is the outcome, but only with a passing evidence check.
 */
export type Composition = "may-add-only" | "tie-break" | "advisory" | "replace";

export type DecisionMode = "off" | "shadow" | "enforce";

/** The rule's "I cannot tell" answer. Only meaningful on a `tie-break` seam. */
export const UNDECIDED = "undecided";

export interface SeamSpec {
  id: string;
  kind: QuestionKind;
  /** What the question is about, independent of any one call. */
  instructions: string;
  /**
   * Allowed answers → what each means. `bool`: exactly `true` and `false`.
   * `score`: ordered levels, lowest first (a classifier score is the level index).
   */
  labels: Readonly<Record<string, string>>;
  /** The rule's answer when it has nothing to go on. */
  ruleDefault: string;
  /** Labels that count as a pass. Everything else is the fail outcome. */
  passing: readonly string[];
  composition: Composition;
  defaultMode: DecisionMode;
  /** `quote`: the model must cite text verified in the state or a named file. */
  evidence: "quote" | "none";
  /** The module that calls `decide()` for this seam, relative to `src/`. */
  owner: string;
  timeoutMs: number;
  /** Token budget per call; an over-budget state or response abstains. */
  tokenBudget: number;
  /** Pre-dates the seam; env config and the kill switch do not apply. */
  grandfathered?: true;
}

const POLICY_LABELS = {
  permitted: "a document explicitly allows the action",
  forbidden: "a document explicitly prohibits the action",
  unstated: "the documents do not address the action",
} as const;

export const SEAMS = {
  // #407 / S2 — grandfathered as enforce + replace with the verbatim-citation
  // check: exactly the judge's behaviour before the seam existed. Its backend
  // is the judge child the owner supplies, not a classifier or the session LLM.
  "policy-judge": {
    id: "policy-judge",
    kind: "choice",
    instructions:
      "Does the project's own written policy explicitly permit or prohibit the proposed action?",
    labels: POLICY_LABELS,
    ruleDefault: "unstated",
    passing: ["permitted"],
    composition: "replace",
    defaultMode: "enforce",
    evidence: "quote",
    owner: "work-driver-policy.ts",
    // The judge child's own spawn timeout is 5 min; this bound sits above it
    // so the spawn's timeout, not this one, is what fires in practice.
    timeoutMs: 6 * 60_000,
    // The judge reads whole doctrine files; today it has no size bound short
    // of the child's context, so neither does this seam in practice.
    tokenBudget: 1_000_000,
    grandfathered: true,
  },
} as const satisfies Record<string, SeamSpec>;

export type SeamId = keyof typeof SEAMS;

export function isPassing(spec: SeamSpec, label: string): boolean {
  return spec.passing.includes(label);
}

/** Operator decision 2: derived from the rule's default, never declared. */
export function isFailClosed(spec: SeamSpec): boolean {
  return !isPassing(spec, spec.ruleDefault);
}

const KINDS: readonly string[] = ["choice", "bool", "score"];
const COMPOSITIONS: readonly string[] = ["may-add-only", "tie-break", "advisory", "replace"];
const MODES: readonly string[] = ["off", "shadow", "enforce"];

/**
 * Every way an entry can be unsafe or incomplete. Empty means valid.
 * Rejects: a missing field; tie-break on a fail-closed seam; replace without
 * an evidence check; a score question under may-add-only or tie-break.
 */
export function seamContractViolations(spec: Partial<SeamSpec>): string[] {
  const v: string[] = [];
  const s = spec as Record<string, unknown>;
  for (const f of [
    "id",
    "kind",
    "instructions",
    "labels",
    "ruleDefault",
    "passing",
    "composition",
    "defaultMode",
    "evidence",
    "owner",
    "timeoutMs",
    "tokenBudget",
  ]) {
    if (s[f] === undefined || s[f] === null || s[f] === "") v.push(`missing field: ${f}`);
  }
  if (v.length > 0) return v;
  const full = spec as SeamSpec;
  const labels = Object.keys(full.labels);
  if (!KINDS.includes(full.kind)) v.push(`unknown kind: ${full.kind}`);
  if (!COMPOSITIONS.includes(full.composition)) v.push(`unknown composition: ${full.composition}`);
  if (!MODES.includes(full.defaultMode)) v.push(`unknown mode: ${full.defaultMode}`);
  if (labels.length < 2) v.push("fewer than two labels");
  if (labels.includes(UNDECIDED)) v.push(`'${UNDECIDED}' is reserved, not a label`);
  if (
    full.kind === "bool" &&
    (labels.length !== 2 || !("true" in full.labels && "false" in full.labels))
  )
    v.push("a bool seam's labels are exactly true and false");
  if (!labels.includes(full.ruleDefault))
    v.push(`ruleDefault '${full.ruleDefault}' is not a label`);
  if (full.passing.length === 0) v.push("no passing label");
  for (const p of full.passing) if (!labels.includes(p)) v.push(`passing '${p}' is not a label`);
  if (full.passing.length >= labels.length) v.push("every label passes — nothing can fail");
  if (full.composition === "tie-break" && isFailClosed(full))
    v.push("tie-break on a fail-closed seam — the model would decide what the rule refuses");
  if (full.composition === "replace" && full.evidence !== "quote")
    v.push("replace without an evidence check");
  if (
    full.kind === "score" &&
    (full.composition === "may-add-only" || full.composition === "tie-break")
  )
    v.push(`a score question cannot compose as ${full.composition}`);
  if (full.defaultMode === "enforce" && !full.grandfathered)
    v.push("a new seam starts in shadow — only a grandfathered seam enforces by default");
  if (!(full.timeoutMs > 0)) v.push("timeoutMs must be positive");
  if (!(full.tokenBudget > 0)) v.push("tokenBudget must be positive");
  return v;
}

function envKey(prefix: string, id: string): string {
  return `${prefix}_${id.toUpperCase().replaceAll("-", "_")}`;
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = raw === undefined ? Number.NaN : Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The kill switch: `PI_ENSEMBLE_DECISIONS=0` → rule-only for every non-grandfathered seam. */
function decisionsEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_DECISIONS;
  return v !== "0" && v !== "false";
}

export interface SeamConfig {
  mode: DecisionMode;
  timeoutMs: number;
  tokenBudget: number;
}

/** The effective mode, timeout and budget for one call. */
export function seamConfig(spec: SeamSpec): SeamConfig {
  const base = { mode: spec.defaultMode, timeoutMs: spec.timeoutMs, tokenBudget: spec.tokenBudget };
  if (spec.grandfathered) return base;
  if (!decisionsEnabled()) return { ...base, mode: "off" };
  const mode = process.env[envKey("PI_ENSEMBLE_DECISION_MODE", spec.id)]?.trim().toLowerCase();
  return {
    mode: mode && MODES.includes(mode) ? (mode as DecisionMode) : base.mode,
    timeoutMs:
      positiveInt(process.env[envKey("PI_ENSEMBLE_DECISION_TIMEOUT_MS", spec.id)]) ??
      base.timeoutMs,
    tokenBudget:
      positiveInt(process.env[envKey("PI_ENSEMBLE_DECISION_BUDGET", spec.id)]) ?? base.tokenBudget,
  };
}
