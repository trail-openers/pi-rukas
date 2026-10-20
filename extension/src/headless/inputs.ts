/**
 * headless/inputs — every input this build honours, for the `--capabilities`
 * answer (#1326): each `PI_ENSEMBLE_*` environment variable read under
 * `extension/src/` or by the sandbox wrapper (`bin/`, the image entrypoint),
 * and each `.pi/*` file a cycle reads from the project.
 *
 * A host compares the names it sets against this list and fails closed on a
 * name the build does not list. The list is data, not a parse of the source,
 * so it costs nothing at `--capabilities` time; `test-headless-inputs.ts`
 * scans `src/` and the wrapper for env reads and fails when one is missing
 * here (or when an entry here is no longer read anywhere).
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
 *   - a name containing `<ROLE>`, `<SEAM>` or `<LENS>` is a family: `<ROLE>`
 *     is a role name, `<SEAM>` a decision-seam id and `<LENS>` a code-review
 *     lens name (`SECURITY`, `ERROR_HANDLING`), upper-cased with `-` → `_`.
 *     `members` lists the ids the build reads (#1369), derived from the role
 *     list, the seam registry and the bundled lens roster, so it cannot
 *     drift; any other member is ignored. A seam that takes no env config
 *     (grandfathered) is not a member.
 *
 * `scope` says who sets it: `cycle` (changes what a /work cycle does),
 * `sandbox` (set by the sandbox wrapper), `interactive` (the Pi UI only),
 * `install` (path overrides for an installation), `wrapper` (read only by
 * the `bin/pi-rukas` sandbox wrapper on the host, before the container
 * starts; the extension never reads it, so it has no effect on a cycle run
 * without the wrapper), `internal` (pi-rukas sets it on its own children or
 * the wrapper on its container; a host must not), `test` (smoke tests only).
 */

import { SEAMS, isGrandfathered } from "../decision-seam-registry.ts";
import { LENS_ROSTER } from "../lens-roster.ts";
import { SHUTDOWN_SETTLE_MS } from "../pending-jobs-signal.ts";
import { SUBAGENT_ROLE_NAMES } from "../roles.ts";

export type InputType =
  | "boolean"
  | "integer"
  | "number"
  | "duration-ms"
  | "string"
  | "path"
  | "list"
  | "enum";

export type InputScope =
  | "cycle"
  | "sandbox"
  | "interactive"
  | "install"
  | "wrapper"
  | "internal"
  | "test";

export interface HostInput {
  name: string;
  type: InputType;
  default: string | number | boolean | null;
  scope: InputScope;
  /** `enum` only: the accepted values. */
  values?: readonly string[];
  /** A family only: the ids its placeholder takes (#1369). */
  members?: readonly string[];
  /** `list` only: the separator between values. */
  separator?: string;
  /** `number` / `integer`: the unit, when not obvious from the name. */
  unit?: "s" | "days" | "tokens" | "turns" | "epoch-ms";
  /** The issue-image manifest format version the input reads (#1306). */
  manifestVersion?: number;
}

type Opt = Partial<
  Pick<HostInput, "values" | "members" | "separator" | "unit" | "manifestVersion">
>;
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
const family = (entry: HostInput, members: readonly string[]): HostInput => ({
  ...entry,
  members,
});

/** A role, seam or lens name as it appears in an env name. */
const envId = (id: string) => id.toUpperCase().replaceAll("-", "_");
/** `<ROLE>`: every spawned role; the parent session takes no per-role env. */
export const ROLE_MEMBERS: readonly string[] = SUBAGENT_ROLE_NAMES.map(envId);
/** `<SEAM>`: every registered seam that reads its env config. */
export const SEAM_MEMBERS: readonly string[] = Object.values(SEAMS)
  .filter((s) => !isGrandfathered(s))
  .map((s) => envId(s.id))
  .sort();
/** `<LENS>`: the bundled lenses (lens-roster.ts), in roster order. */
export const LENS_MEMBERS: readonly string[] = [...new Set(LENS_ROSTER.map((e) => e.name))];

/** Every honoured `PI_ENSEMBLE_*` environment input, sorted by name. */
export const HEADLESS_INPUTS: readonly HostInput[] = [
  flag("ACCEPTANCE_COVERAGE", true),
  flag("ADVERSARIAL_EMPTY_SKIP", true),
  ms("ADVERSARIAL_PHASE_BUDGET_MS", 1_800_000),
  flag("ALLOW_DESTRUCTIVE_GIT", false),
  flag("ALLOW_DEVELOPER_PUSH", false),
  flag("ALLOW_DIRECT_ISSUE_CREATE", false),
  flag("ALLOW_LIVE_SPAWN", false, "test"),
  flag("ALLOW_UNREVIEWED_MERGE", false),
  list("ALLOWED_ROOTS", ":", null, "sandbox"),
  flag("AUTO_STEER", true),
  flag("AUTOSAVE", false, "interactive"),
  ms("CAP_KILL_GRACE_MS", 300_000),
  // #1560 — the per-child run bound: wrap-up steer at the bound, kill this long after.
  ms("CHILD_BOUND_GRACE_MS", 600_000),
  flag("CHILD_CODEMODE", true),
  ms("CI_WATCH_TIMEOUT_MS", 1_800_000),
  flag("CLAIM_SCAN", true),
  // #1454 — how long a claim whose claimant state file cannot be read may
  // still park a sibling. The reader is CLAIM_STALE_MS in
  // work-driver-path-claims.ts; a non-finite/non-positive value falls back to
  // the 1 h default there, which is the default recorded here.
  ms("CLAIM_STALE_MS", 3_600_000, "cycle"),
  flag("COMMENT_RETENTION", true),
  list("COMMENT_RETENTION_PATHS", ",", "extension/src,extension/smoke-tests,agents-base"),
  // #1240 — 0 restores the pre-#1240 shape: the consolidated verify always runs,
  // even when its probe tree is provably the tree the per-worktree verify just
  // judged. Default ON.
  flag("CONSOLIDATED_VERIFY_SKIP", true),
  flag("CONVERGE", true),
  flag("CROSS_GROUP_CONFLICTS", true),
  ms("CYCLE_BUDGET_MS", null),
  // An absolute deadline; a value below 1e12 (epoch seconds) is ignored. #1593 —
  // where step work ends: a host sets it to its kill minus HANDOFF_TIMEOUT_MS.
  int("CYCLE_DEADLINE", null, "cycle", { unit: "epoch-ms" }),
  flag("DEBUG", false),
  family(int("DECISION_BUDGET_<SEAM>", null, "cycle", { unit: "tokens" }), SEAM_MEMBERS),
  input("DECISION_MODE_<SEAM>", "enum", "shadow", "cycle", {
    values: ["off", "shadow", "enforce"],
    members: SEAM_MEMBERS,
  }),
  str("DECISION_MODEL", null),
  family(ms("DECISION_TIMEOUT_MS_<SEAM>", null), SEAM_MEMBERS),
  flag("DECISIONS", true),
  int("DECK_MAX_ROWS", 20, "interactive"),
  ms("DEVELOP_BOUND_MS", 5_400_000),
  dir("DIR", null),
  flag("DISABLE_EXTENSION_FORWARD", false),
  flag("DISABLE_SUBAGENT_GUARD", false),
  flag("DISPATCH_CAPS", true),
  // Unset: a headless cycle opens its PR as a draft, an interactive one does not.
  flag("DRAFT_PR", null),
  ms("EXPLORE_BOUND_MS", 1_800_000),
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
  flag("HANDOFF_DRAFT_PR", true),
  flag("HANDOFF_POST_RETRY", true),
  ms("HANDOFF_POST_RETRY_BACKOFF_MS", 1_000),
  ms("HANDOFF_TIMEOUT_MS", 480_000),
  // The headless supervisor marks its `work` child (#1591); "1" runs `work` unsupervised.
  flag("HEADLESS_SUPERVISED", false, "internal"),
  // `name:ip` pairs passed to the container as `--add-host`.
  list("HOST_ALIASES", ",", "fieldbox:192.0.2.10", "wrapper"),
  // #1528 — the host-wide child bound, shared by processes using one slot dir.
  int("HOST_SPAWN_CAP", 64),
  dir("HOST_SPAWN_DIR", null),
  ms("HOST_SPAWN_WAIT_MS", 1_800_000),
  str("IMAGE", "ghcr.io/trail-openers/pi-rukas:latest", "wrapper"),
  // Host directories bind-mounted read-only; EXTRA_IMAGE_DIRS appends to them.
  list("IMAGE_DIRS", ":", "~/Downloads:~/Desktop:~/Pictures", "wrapper"),
  ms("INACTIVITY_TIMEOUT_MS", 1_800_000),
  // #1404 — 0 skips the commit-pr baseline probe, so a consolidated verify
  // failure parks exactly as it did before the feature. The probe can only ever
  // EXCUSE failures, so this knob only ever makes the gate stricter.
  flag("INTEGRATION_VERIFY_BASELINE_PROBE", true),
  ms("INTEGRATION_VERIFY_TIMEOUT_MS", 900_000),
  flag("INTENT", true),
  flag("INTENT_CRITICALITY", true),
  flag("INVARIANT_MEMORY", true),
  input("ISSUE_IMAGES", "boolean", true, "cycle", { manifestVersion: 1 }),
  // Unset: derived from the host budget (CPUs, memory, pids.max); 0 = unbounded.
  // #1564 — a lens child's run bound (spawn-child-bound.ts).
  ms("LENS_BOUND_MS", 1_800_000),
  int("LENS_CONCURRENCY", null),
  flag("LENS_EVIDENCE", true),
  // Unset or 0: no bound on concurrent lens children per model.
  int("LENS_MODEL_CONCURRENCY", null),
  int("LENS_ROUND_CAP", 3),
  flag("LENS_ROUND_CAP_MERGE", true),
  flag("LENS_ROUND_CAP_OVERRIDE", false),
  flag("LOOP_DETECTOR", true),
  int("MAX_WORKSTREAMS", 6),
  flag("MERGE_AUTHORITY", true),
  family(str("MODEL_<ROLE>", null), ROLE_MEMBERS),
  family(str("MODEL_LENS_<LENS>", null), LENS_MEMBERS),
  dir("MODELS_CONFIG", "~/.pi/agent/ensemble-models.json"),
  // The host docker socket and SSH agent are mounted unless these are "1".
  flag("NO_DOCKER_SOCKET", false, "wrapper"),
  flag("NO_SSH", false, "wrapper"),
  str("NOTIFY_CMD", null),
  int("PARALLEL_GROUPS", 3),
  flag("PARALLEL_WORK", true),
  // How long the pending-reports signal defers its "0" at session_shutdown for a
  // killed PM job's report still in flight; `SHUTDOWN_SETTLE_MS` in the reader.
  ms("PENDING_SHUTDOWN_MS", SHUTDOWN_SETTLE_MS),
  dir("PERM_SOCKET", null, "internal"),
  dir("PI_BIN", null),
  dir("PI_PROMPTS_DIR", null),
  flag("PLAN_CACHE", true),
  dir("PLAN_CACHE_DIR", null, "cycle"),
  ms("PLAN_CACHE_TTL_MS", 7_200_000),
  flag("PLAN_CONTRACT", true),
  int("PLAN_ISSUE", null),
  flag("PLAN_QUALITY", true),
  dir("PLAN_SESSION_DIR", null, "cycle"),
  ms("PLAN_TIMEOUT_MS", 1_800_000),
  // #1167 — 0 leaves the planner's out-of-scope fences exactly as written
  // (the pre-#1167 shape, develop gate included) and traces that it was off.
  flag("PLAN_UNFENCE", true),
  flag("PM_BASH_GUARD", true, "interactive"),
  dir("PM_PROMPT", null),
  flag("POLICY_JUDGE", true),
  flag("PR_PREFLIGHT", true),
  dir("PROMPTS_DIR", null),
  flag("PROTECTED_PATHS", true),
  family(str("PROVIDER_<ROLE>", null), ROLE_MEMBERS),
  family(str("PROVIDER_LENS_<LENS>", null), LENS_MEMBERS),
  // #1243 — the provider-class backoff. A transient retry used to wait 5s then
  // 10s, so every re-spawn landed inside the same endpoint outage (measured: the
  // three orchard cycles 45/61/63 parked within 30 minutes with sub-second waits).
  // A provider-class failure now waits at least FLOOR, scaled by the attempt;
  // MAX_WAIT is the clamp on EACH wait, not a budget across the cycle. `0`
  // restores the pre-#1243 shape.
  // Sorted after PROVIDER_LENS_*: "PROVIDER_R" > "PROVIDER_L".
  ms("PROVIDER_RETRY_FLOOR_MS", 60_000),
  ms("PROVIDER_RETRY_MAX_WAIT_MS", 1_800_000),
  // #1101 — how long a group may wait on a sibling it depends on before the
  // queue caps the wait (`dependency-timeout`).
  ms("QUEUE_DEFER_CAP_MS", 1_800_000),
  flag("QUEUE_HALT_ON_FAILURE", false),
  // #1101 escape hatch: `0` drops the cross-group ordering edge, so groups
  // dispatch under the #676 overlap rule alone (the pre-#1101 shape).
  flag("QUEUE_ORDERING", true),
  flag("QUIET_LIFECYCLE", false, "interactive"),
  flag("QUIET_STATUS", false, "interactive"),
  input("RATE_LIMIT_BURST_MAX_S", "number", 300, "cycle", { unit: "s" }),
  flag("RESEARCH_FALLBACK", true, "interactive"),
  flag("RESUME", true),
  // The ceiling the `check_review_cap` tool answers against (#1429). Separate
  // from REVIEW_WALL_CLOCK_MS: different ceiling, different consumer.
  ms("REVIEW_CAP_MS", 5_400_000),
  // The 90-min review-loop budget is enforced at the fix dispatch, not just displayed.
  flag("REVIEW_ENFORCE", true),
  dir("REVIEW_LEDGER_FILE", null, "cycle"),
  input("REVIEW_THRESHOLD", "enum", null, "cycle", {
    values: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  }),
  // The driver's review-loop wall clock: what the fixer dispatch is bound by
  // and what the widget and `/work-status` print (#1429).
  ms("REVIEW_WALL_CLOCK_MS", 5_400_000),
  str("ROLE", null, "internal"),
  dir("RUNS_DIR", "~/.pi/agent/ensemble-runs"),
  flag("SAFETY_NET_COMMIT", true),
  flag("SANDBOX_MODE", false, "sandbox"),
  input("SCOPE_FANOUT_FACTOR", "number", 3),
  int("SCOPE_FANOUT_MIN", 6),
  flag("SCOPE_GATE", true),
  flag("SEAM_ESCALATION", true),
  flag("SESSION_REATTACH", false),
  // #1521 — how long a child that reported may linger before it is reaped.
  ms("SETTLED_REAP_MS", 60_000),
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
  // #1454 r2 — a TEST-ONLY fault injection: force the path-claims lock
  // unreachable so `test-work-driver-claims-concurrent-writers.ts` can prove its
  // own positive assertion can fail. Listed (not exempted) because the gate
  // sweeps every `PI_ENSEMBLE_*` read in src/ regardless of who sets it: an
  // operator who exports it gets an UNSERIALISED claim registry, which is
  // exactly the kind of outcome-changing knob this table exists to surface.
  flag("TEST_CLAIMS_LOCK_BLOCKED", false, "internal"),
  // #1454 r2 — a TEST-ONLY knob: widen the read-modify-write window of a claim
  // writer by this many ms, so the mutation arm of
  // `test-work-driver-claims-concurrent-writers.ts` loses a claim
  // DETERMINISTICALLY instead of only when eight children happen to overlap.
  // Read ONLY while `PI_ENSEMBLE_TEST_CLAIMS_LOCK_BLOCKED=1` is also set —
  // `resolveClaimsWindowMs` returns 0 without it — so a production cycle never
  // waits here and the delay cannot reach a real run.
  ms("TEST_CLAIMS_WINDOW_MS", 0, "internal"),
  int("TEST_DELETE_TOLERANCE", 0),
  // Unset: no budget for any role (#1642); an explicit value arms a ceiling.
  family(int("TOKEN_BUDGET_<ROLE>", null, "cycle", { unit: "tokens" }), ROLE_MEMBERS),
  ms("TOOL_INACTIVITY_TIMEOUT_MS", 3_600_000),
  input("TRANSCRIPT_RETENTION_DAYS", "number", 5, "cycle", { unit: "days" }),
  flag("TRANSIENT_RETRY", true),
  ms("TRANSIENT_RETRY_BACKOFF_MS", 5_000),
  flag("TRUST_MODE", false, "internal"),
  // 0 = off; 1 = nudge at turn 80; any other positive integer is the turn.
  int("TURN_NUDGE", 0, "cycle", { unit: "turns" }),
  str("USER_EXTENSION", null),
  flag("VERIFY", true),
  // Unset: derived from the host budget (CPUs, memory, cgroup limits); 0 = unbounded.
  int("VERIFY_CONCURRENCY", null),
  // #1509 — the verify wall clock is resolved PER TIER. Each tier reads its own
  // knob first, then PI_ENSEMBLE_VERIFY_TIMEOUT_MS, then its `.pi/*-timeout-ms`
  // file, then the default listed here. The SUITE tier's default is the one that
  // moved: it is the 641-file offline suite, and the shared 10-minute number is
  // what parked healthy cycles at `verify-failed:develop`.
  //
  // POSITION: this list is sorted by the `__`-to-space localeCollate that
  // `test-headless-inputs.ts` enforces, and that collation is NOT ASCII order —
  // it largely ignores the separators, so `VERIFY_FULL` compares as `VERIFY
  // FULL` and sorts before `VERIFY_FULL_TIMEOUT_MS`, and `FAST` < `FULL` puts
  // the fast tier's knob above both. Reading it as plain ASCII order puts these
  // entries in the wrong place and the gate fails on ordering alone.
  ms("VERIFY_FAST_TIMEOUT_MS", 600_000),
  flag("VERIFY_FULL", true),
  ms("VERIFY_FULL_TIMEOUT_MS", 1_800_000),
  // #1415 — reuse of a verify gate the cycle already passed: same tree, same
  // command, same bound → the whole develop pass runs nothing. Default on; `0`
  // restores the pre-#1415 "run it every round" behaviour.
  flag("VERIFY_GATE_REUSE", true),
  flag("VERIFY_SELECT", true),
  ms("VERIFY_SMOKE_TIMEOUT_MS", 600_000),
  ms("VERIFY_SUITE_TIMEOUT_MS", 1_800_000),
  ms("VERIFY_TIMEOUT_MS", 600_000),
  // The wrapper tells the image entrypoint which mounts are named volumes.
  list("VOLUME_MOUNTS", ":", null, "internal"),
  flag("WIDENING_SCAN", true),
  dir("WORKSPACE_ROOT", "/workspace", "sandbox"),
  flag("WORKTREE_SWEEP", true),
  flag("WORKTREE_TEARDOWN", true),
  // #1655 — the write fence: the escape hatch, then the worktree and scratch the driver sets on a fenced child.
  flag("WRITE_FENCE", true),
  str("WRITE_REPO", null, "internal"),
  str("WRITE_ROOT", null, "internal"),
  str("WRITE_SCRATCH", null, "internal"),
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
  // #1509 — the per-tier verify budgets a project may declare (#1041). Read
  // like every other `.pi/` config file; an unparseable value is ignored with a
  // trace and the next precedence level answers.
  {
    path: ".pi/smoke-cmd-timeout-ms",
    kind: "config",
    whenAbsent: "smoke tier uses PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS or its default",
  },
  { path: ".pi/smoke-cmd", kind: "command", whenAbsent: "no product smoke gate" },
  { path: ".pi/verify-cmd", kind: "command", whenAbsent: "verify command derived from the repo" },
  {
    path: ".pi/verify-cmd-fast",
    kind: "command",
    whenAbsent: "no fast verify tier",
  },
  {
    path: ".pi/verify-cmd-fast-timeout-ms",
    kind: "config",
    whenAbsent: "fast tier uses PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS or its default",
  },
  { path: ".pi/verify-cmd-full", kind: "command", whenAbsent: "verify-full tier skipped" },
  {
    path: ".pi/verify-timeout-ms",
    kind: "config",
    whenAbsent: "suite tier uses PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS or its default",
  },
  {
    path: ".pi/worktree-setup",
    kind: "hook",
    whenAbsent: "dependencies are symlinked into each worktree",
  },
];
