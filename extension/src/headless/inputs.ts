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

import { HEADLESS_INPUTS_B } from "./inputs-b.ts";

// The HostInput shape, the row builders and the family member lists live in
// `entry.ts` (§12 size cap): both halves of the list declare their rows with
// them, and a module that held them would sit in a cycle with the other half.
// Re-exported so every existing importer still resolves them from here.
export {
  type HostInput,
  type InputScope,
  type InputType,
  type Opt,
  dir,
  family,
  flag,
  input,
  int,
  list,
  ms,
  str,
  ROLE_MEMBERS,
  SEAM_MEMBERS,
  LENS_MEMBERS,
} from "./entry.ts";
import {
  type HostInput,
  LENS_MEMBERS,
  ROLE_MEMBERS,
  SEAM_MEMBERS,
  dir,
  family,
  flag,
  input,
  int,
  list,
  ms,
  str,
} from "./entry.ts";

/**
 * The first half of the honoured `PI_ENSEMBLE_*` inputs — every name before
 * `PI_ENSEMBLE_DECK_MAX_ROWS`. The rest lives in `inputs-b.ts` (§12 size cap)
 * and `HEADLESS_INPUTS` below is the two halves concatenated, sorted by name.
 */
export const HEADLESS_INPUTS_A: readonly HostInput[] = [
  flag("ACCEPTANCE_COVERAGE", true),
  // #1827 — the adversarial reviewer's OWN per-child run bound. The generic
  // child bound does not reach it (the loop passes no `childBoundMs`), which is
  // how a reviewer that kept working after `VERDICT:` reached 476 turns and 80M
  // tokens with no cap firing.
  ms("ADVERSARIAL_BOUND_MS", 1_800_000),
  flag("ADVERSARIAL_DIFF_CAP", true),
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
  // #1730 A — the PM's private-backlog reminder. `0` stops the per-turn probe
  // from ever reaching the filesystem; the reminder itself is documented in
  // docs/configuration.md. `interactive`: like the other PM-session knobs, it
  // is the operator's switch in a running session, not a cycle setting.
  flag("BACKLOG_REMINDER", true, "interactive"),
  ms("CAP_KILL_GRACE_MS", 300_000),
  // #1560 — the per-child run bound: wrap-up steer at the bound, kill this long after.
  ms("CHILD_BOUND_GRACE_MS", 600_000),
  flag("CHILD_CODEMODE", true),
  // #2200 — the ONE temp directory a child may delete into: the spawn layer's own
  // per-child dir (`writeRolePromptFile`). The shared temp root is never a delete
  // target. Alongside it the deletion rule also allows the worktree and the cycle's
  // scratch dir (both named by the fence's own variables); this one is read here and
  // not through `loadFenceConfig`, so a reviewer (no write root) and the
  // `PI_ENSEMBLE_WRITE_FENCE=0` case still get judged.
  dir("CHILD_TMP", null, "internal"),
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
];

// The rest of the list — every name from PI_ENSEMBLE_DECK_MAX_ROWS on — lives
// in `inputs-b.ts` (§12 size cap), imported at the top of this file.

/** Every honoured `PI_ENSEMBLE_*` environment input, sorted by name. */
export const HEADLESS_INPUTS: readonly HostInput[] = [...HEADLESS_INPUTS_A, ...HEADLESS_INPUTS_B];

// The `.pi/*` half of the capabilities answer lives in `files.ts` (§12 size
// cap) and is re-exported here so every existing importer keeps resolving
// `HEADLESS_FILES` / `HostFile` from this module.
export { type FileKind, type HostFile, HEADLESS_FILES } from "./files.ts";
