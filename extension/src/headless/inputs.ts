/**
 * headless/inputs — every input this build honours, for the `--capabilities`
 * answer (#1326): each `PI_ENSEMBLE_*` environment variable read under
 * `extension/src/`, and each `.pi/*` file a cycle reads from the project.
 *
 * A host compares the names it sets against this list and fails closed on a
 * name the build does not list. The list is data, not a parse of the source,
 * so it costs nothing at `--capabilities` time; `test-headless-inputs.ts`
 * scans `src/` for env reads and fails when one is missing here (or when an
 * entry here is no longer read anywhere).
 *
 * Value conventions a host can rely on:
 *
 *   - `boolean`     — `"1"` turns it on, `"0"` turns it off. `default` is the
 *                     behaviour when the variable is unset.
 *   - `integer` / `number` — a decimal number; an invalid value falls back
 *                     to `default`. `duration-ms` is a number of milliseconds.
 *   - `list`        — values joined by `separator`.
 *   - `enum`        — one of `values` (case-insensitive where the reader folds case).
 *   - `default: null` — unset by default; the behaviour without it is the
 *                     documented fallback (docs/configuration.md).
 *   - a name containing `<ROLE>` or `<SEAM>` is a family: `<ROLE>` is a role
 *     name and `<SEAM>` a decision-seam id, upper-cased with `-` → `_`.
 *
 * `scope` says who sets it: `cycle` (changes what a /work cycle does),
 * `sandbox` (set by the sandbox wrapper), `interactive` (the Pi UI only),
 * `install` (path overrides for an installation), `internal` (pi-rukas sets
 * it on its own children; a host must not), `test` (smoke tests only).
 */

export type InputType =
  | "boolean"
  | "integer"
  | "number"
  | "duration-ms"
  | "string"
  | "path"
  | "list"
  | "enum";

export type InputScope = "cycle" | "sandbox" | "interactive" | "install" | "internal" | "test";

export interface HostInput {
  name: string;
  type: InputType;
  default: string | number | boolean | null;
  scope: InputScope;
  /** `enum` only: the accepted values. */
  values?: readonly string[];
  /** `list` only: the separator between values. */
  separator?: string;
  /** `number` / `integer`: the unit, when not obvious from the name. */
  unit?: "s" | "days" | "tokens" | "turns" | "epoch-ms";
  /** The issue-image manifest format version the input reads (#1306). */
  manifestVersion?: number;
}

type Opt = Partial<Pick<HostInput, "values" | "separator" | "unit" | "manifestVersion">>;
const E = "PI_ENSEMBLE_";

function input(
  name: string,
  type: InputType,
  dflt: HostInput["default"],
  scope: InputScope = "cycle",
  opt: Opt = {},
): HostInput {
  return { name: `${E}${name}`, type, default: dflt, scope, ...opt };
}
const flag = (name: string, dflt: boolean | null, scope?: InputScope) =>
  input(name, "boolean", dflt, scope);
const ms = (name: string, dflt: number | null, scope?: InputScope) =>
  input(name, "duration-ms", dflt, scope);
const int = (name: string, dflt: number | null, scope?: InputScope, opt?: Opt) =>
  input(name, "integer", dflt, scope, opt);
const str = (name: string, dflt: string | null, scope?: InputScope) =>
  input(name, "string", dflt, scope);
const dir = (name: string, dflt: string | null, scope: InputScope = "install") =>
  input(name, "path", dflt, scope);
const list = (name: string, separator: string, dflt: string | null, scope?: InputScope) =>
  input(name, "list", dflt, scope, { separator });

/** Every honoured `PI_ENSEMBLE_*` environment input, sorted by name. */
export const HEADLESS_INPUTS: readonly HostInput[] = [
  flag("ACCEPTANCE_COVERAGE", true),
  flag("ADVERSARIAL_EMPTY_SKIP", true),
  ms("ADVERSARIAL_PHASE_BUDGET_MS", 1_800_000),
  flag("ALLOW_DESTRUCTIVE_GIT", false),
  flag("ALLOW_DIRECT_ISSUE_CREATE", false),
  flag("ALLOW_LIVE_SPAWN", false, "test"),
  flag("ALLOW_UNREVIEWED_MERGE", false),
  list("ALLOWED_ROOTS", ":", null, "sandbox"),
  flag("AUTO_STEER", true),
  flag("AUTOSAVE", false, "interactive"),
  ms("CAP_KILL_GRACE_MS", 300_000),
  flag("CHILD_CODEMODE", true),
  ms("CI_WATCH_TIMEOUT_MS", 1_800_000),
  flag("CLAIM_SCAN", true),
  flag("COMMENT_RETENTION", true),
  list("COMMENT_RETENTION_PATHS", ",", "extension/src,extension/smoke-tests,agents-base"),
  flag("CONVERGE", true),
  flag("CROSS_GROUP_CONFLICTS", true),
  ms("CYCLE_BUDGET_MS", null),
  // An absolute deadline; a value below 1e12 (epoch seconds) is ignored.
  int("CYCLE_DEADLINE", null, "cycle", { unit: "epoch-ms" }),
  flag("DEBUG", false),
  int("DECISION_BUDGET_<SEAM>", null, "cycle", { unit: "tokens" }),
  input("DECISION_MODE_<SEAM>", "enum", "shadow", "cycle", {
    values: ["off", "shadow", "enforce"],
  }),
  str("DECISION_MODEL", null),
  ms("DECISION_TIMEOUT_MS_<SEAM>", null),
  flag("DECISIONS", true),
  int("DECK_MAX_ROWS", 20, "interactive"),
  dir("DIR", null),
  flag("DISABLE_EXTENSION_FORWARD", false),
  flag("DISABLE_SUBAGENT_GUARD", false),
  flag("DISPATCH_CAPS", true),
  // Unset: a headless cycle opens its PR as a draft, an interactive one does not.
  flag("DRAFT_PR", null),
  input("EXTRA_IMAGE_DIRS", "list", null, "cycle", { separator: ":", manifestVersion: 1 }),
  flag("FORBID_LIVE_SPAWN", false, "test"),
  input("FORGE", "enum", null, "cycle", { values: ["github", "gitlab"] }),
  // Unset: probe an unknown forge host unless CI is set.
  flag("FORGE_PROBE", null),
  list("FRONTEND_ONLY_GLOBS", ",", null),
  ms("GIT_NET_TIMEOUT_MS", 300_000),
  // forge: the driver posts the handoff comment and label; host: the result carries it instead.
  input("HANDOFF_CHANNEL", "enum", "forge", "cycle", { values: ["forge", "host"] }),
  flag("HANDOFF_CONSOLIDATE", true),
  flag("HANDOFF_POST_RETRY", true),
  ms("HANDOFF_POST_RETRY_BACKOFF_MS", 1_000),
  ms("HANDOFF_TIMEOUT_MS", 480_000),
  ms("INACTIVITY_TIMEOUT_MS", 1_800_000),
  ms("INTEGRATION_VERIFY_TIMEOUT_MS", 900_000),
  flag("INTENT", true),
  flag("INTENT_CRITICALITY", true),
  flag("INVARIANT_MEMORY", true),
  input("ISSUE_IMAGES", "boolean", true, "cycle", { manifestVersion: 1 }),
  flag("LENS_EVIDENCE", true),
  int("LENS_ROUND_CAP", 3),
  flag("LENS_ROUND_CAP_MERGE", true),
  flag("LENS_ROUND_CAP_OVERRIDE", false),
  flag("LOOP_DETECTOR", true),
  int("MAX_WORKSTREAMS", 6),
  flag("MERGE_AUTHORITY", true),
  str("MODEL_<ROLE>", null),
  dir("MODELS_CONFIG", "~/.pi/agent/ensemble-models.json"),
  str("NOTIFY_CMD", null),
  int("PARALLEL_GROUPS", 3),
  flag("PARALLEL_WORK", true),
  dir("PERM_SOCKET", null, "internal"),
  dir("PI_BIN", null),
  dir("PI_PROMPTS_DIR", null),
  flag("PLAN_CACHE", true),
  dir("PLAN_CACHE_DIR", null, "cycle"),
  ms("PLAN_CACHE_TTL_MS", 7_200_000),
  flag("PLAN_CONTRACT", true),
  int("PLAN_ISSUE", null),
  flag("PLAN_QUALITY", true),
  ms("PLAN_TIMEOUT_MS", 1_800_000),
  flag("PM_BASH_GUARD", true, "interactive"),
  dir("PM_PROMPT", null),
  flag("POLICY_JUDGE", true),
  flag("PR_PREFLIGHT", true),
  dir("PROMPTS_DIR", null),
  flag("PROTECTED_PATHS", true),
  str("PROVIDER_<ROLE>", null),
  flag("QUEUE_HALT_ON_FAILURE", false),
  flag("QUIET_LIFECYCLE", false, "interactive"),
  flag("QUIET_STATUS", false, "interactive"),
  input("RATE_LIMIT_BURST_MAX_S", "number", 300, "cycle", { unit: "s" }),
  flag("RESEARCH_FALLBACK", true, "interactive"),
  flag("RESUME", true),
  dir("REVIEW_LEDGER_FILE", null, "cycle"),
  input("REVIEW_THRESHOLD", "enum", null, "cycle", {
    values: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  }),
  str("ROLE", null, "internal"),
  dir("RUNS_DIR", "~/.pi/agent/ensemble-runs"),
  flag("SAFETY_NET_COMMIT", true),
  flag("SANDBOX_MODE", false, "sandbox"),
  input("SCOPE_FANOUT_FACTOR", "number", 3),
  int("SCOPE_FANOUT_MIN", 6),
  flag("SCOPE_GATE", true),
  flag("SEAM_ESCALATION", true),
  flag("SESSION_REATTACH", false),
  dir("SKILLS_DIR", "~/.pi/agent/skills"),
  flag("SKIP_RATCHET", true),
  flag("SLOW_NOTICE", true),
  ms("SLOW_NOTICE_MS", 1_200_000),
  int("SLOW_NOTICE_TOKENS", 20_000_000, "cycle", { unit: "tokens" }),
  int("SLOW_NOTICE_TURNS", 150, "cycle", { unit: "turns" }),
  flag("SMOKE", true),
  int("SPAWN_CAP", 64),
  ms("SPAWN_TIMEOUT_MS", 7_200_000),
  flag("SPECULATIVE_EXPLORE", false),
  ms("STALE_THRESHOLD_MS", 900_000, "interactive"),
  ms("STEP_NOTICE_MS", 5_400_000),
  flag("STRICT_PERMISSIONS", false),
  flag("SUBAGENT_MODE", false, "internal"),
  str("SUBAGENT_MODEL", null),
  str("SUBAGENT_PROVIDER", null),
  flag("SYMBOL_MERGE_RETRY", true),
  int("TEST_DELETE_TOLERANCE", 0),
  // Unset: no budget, except code-review-specialist (8,000,000).
  int("TOKEN_BUDGET_<ROLE>", null, "cycle", { unit: "tokens" }),
  ms("TOOL_INACTIVITY_TIMEOUT_MS", 3_600_000),
  input("TRANSCRIPT_RETENTION_DAYS", "number", 5, "cycle", { unit: "days" }),
  flag("TRANSIENT_RETRY", true),
  ms("TRANSIENT_RETRY_BACKOFF_MS", 5_000),
  flag("TRUST_MODE", false, "internal"),
  // 0 = off; 1 = nudge at turn 80; any other positive integer is the turn.
  int("TURN_NUDGE", 0, "cycle", { unit: "turns" }),
  str("USER_EXTENSION", null),
  flag("VERIFY", true),
  flag("VERIFY_FULL", true),
  ms("VERIFY_FULL_TIMEOUT_MS", 1_800_000),
  ms("VERIFY_TIMEOUT_MS", 600_000),
  flag("WIDENING_SCAN", true),
  dir("WORKSPACE_ROOT", "/workspace", "sandbox"),
  flag("WORKTREE_SWEEP", true),
  flag("WORKTREE_TEARDOWN", true),
];

export type FileKind = "command" | "hook" | "config";

export interface HostFile {
  /** Path relative to the project root. */
  path: string;
  kind: FileKind;
  /** What happens when the file is absent. */
  whenAbsent: string;
}

/**
 * The `.pi/*` files a cycle reads from the project as input. Files the
 * driver writes (`.pi/work-state/`, `.pi/decisions.jsonl`, sidecars) are
 * state, not input, and are deliberately absent: they are not a host contract.
 */
export const HEADLESS_FILES: readonly HostFile[] = [
  { path: ".pi/forge", kind: "config", whenAbsent: "forge detected from the git remote" },
  { path: ".pi/permissions.json", kind: "config", whenAbsent: "~/.pi/agent/permissions.json" },
  { path: ".pi/smoke-cmd", kind: "command", whenAbsent: "no product smoke gate" },
  { path: ".pi/verify-cmd", kind: "command", whenAbsent: "verify command derived from the repo" },
  { path: ".pi/verify-cmd-fast", kind: "command", whenAbsent: "no fast verify tier" },
  { path: ".pi/verify-cmd-full", kind: "command", whenAbsent: "verify-full tier skipped" },
  {
    path: ".pi/worktree-setup",
    kind: "hook",
    whenAbsent: "dependencies are symlinked into each worktree",
  },
];
