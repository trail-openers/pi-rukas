/**
 * headless/inputs-b — the second half of the `HEADLESS_INPUTS` list, from
 * `PI_ENSEMBLE_DECK_MAX_ROWS` on, for the `--capabilities` answer (#1326).
 *
 * Split out of `inputs.ts` along the alphabetical seam the list is already
 * sorted on, the same way `files.ts` carries `HEADLESS_FILES` (AGENTS.md §12:
 * split, never compress). `inputs.ts` concatenates the two halves in order, so
 * the exported array is unchanged: sorted by name, one entry per honoured
 * `PI_ENSEMBLE_*` name. A new input goes in whichever half its name sorts
 * into; the boundary row is `DECK_MAX_ROWS`.
 *
 * The entry builders and the family member lists live in `entry.ts` — this
 * module holds data only, so the conventions stated in `inputs.ts`'s header
 * (value shapes, `scope` meanings, family placeholders) apply here
 * unchanged, and `test-headless-inputs.ts` judges both halves identically.
 */

import { SHUTDOWN_SETTLE_MS } from "../pending-jobs-signal.ts";
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

export const HEADLESS_INPUTS_B: readonly HostInput[] = [
  // #1765 — 0 skips the branch step's pre-develop base-health probe (the
  // project's verify command at `baseSha`, before any developer is dispatched).
  // The develop gate's POST-failure baseline comparison is untouched, so `0`
  // restores the pre-#1765 cost model rather than a stricter gate. The gate's
  // own switch, PI_ENSEMBLE_VERIFY=0, skips the probe too.
  flag("DEVELOP_BASELINE_PROBE", true),
  ms("DEVELOP_BOUND_MS", 5_400_000),
  dir("DIR", null),
  flag("DISABLE_EXTENSION_FORWARD", false),
  flag("DISABLE_SUBAGENT_GUARD", false),
  flag("DISPATCH_CAPS", true),
  // Unset: a headless cycle opens its PR as a draft, an interactive one does not.
  flag("DRAFT_PR", null),
  ms("EXPLORE_BOUND_MS", 1_800_000),
  input("EXTRA_IMAGE_DIRS", "list", null, "cycle", { separator: ":", manifestVersion: 1 }),
  // #1846 — the driver's one-shot revert of a fix pass's out-of-fence files. Off,
  // a first stray set parks on its refusal exactly as it did before #1849 and the
  // operator reverts by hand; nothing else about the pass changes. Reader:
  // `fixPassStrayRevertEnabled` in work-driver-fix-pass-revert-step.ts.
  flag("FIX_PASS_STRAY_REVERT", true),
  flag("FORBID_LIVE_SPAWN", false, "test"),
  input("FORGE", "enum", null, "cycle", { values: ["github", "gitlab"] }),
  // Unset: probe an unknown forge host unless CI is set.
  flag("FORGE_PROBE", null),
  // #2160 — the parent's per-spawn `forge_read` broker pair, both set by the
  // spawn layer and both read by the child's tool. `internal`: the parent mints
  // them, so a host never sets either, and an absent pair means the child has no
  // broker to reach (which is what the child's tool reports). The socket's NAME
  // is minted by `mkdtempSync`, so the value is unpredictable rather than derived
  // from anything the host knows; the secret is the key its broker checks and
  // never travels on the wire.
  str("FORGE_READ_SECRET", null, "internal"),
  dir("FORGE_READ_SOCKET", null, "internal"),
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
  // name:ip pairs passed to the container as --add-host; none unless the operator sets it.
  list("HOST_ALIASES", ",", "", "wrapper"),
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
  // #2228 — show the BUILDER the issue prose its frozen tests were written from.
  // `0` takes the section out of the build prompt only; `LEAN_ISSUE_PROSE=0`
  // also takes it out, since one renderer serves all three seats.
  // The reader is `leanBuildIssueProseEnabled` in lean/issue-prose.ts.
  flag("LEAN_BUILD_ISSUE_PROSE", true),
  // The two handback switches: the deadline stop's route to the report, and the
  // no-head handback's record. Readers in lean/deadline-handback.ts and
  // lean/verified-handback-switch.ts.
  flag("LEAN_DEADLINE_HANDBACK", true),
  // The publishable-branch guard's fail-closed arm: a mainline neither the clone
  // nor origin will name refuses the push instead of passing it. The reader is
  // `leanGuardFailClosed` in lean/guard-fail-closed-switch.ts.
  flag("LEAN_GUARD_FAIL_CLOSED", true),
  flag("LEAN_HANDBACK_NOHEAD_RECORD", true),
  // #2171 — show the specify/challenge adversary the issue prose its frozen
  // tests were written from. 0 takes the section back out of both prompts.
  // The reader is `leanIssueProseEnabled` in lean/issue-prose.ts.
  flag("LEAN_ISSUE_PROSE", true),
  // The gate events on the host's result document (`issues[].gates`). `"0"` writes the
  // document exactly as it read before the object existed — no key, no placeholder — which
  // is what makes the object safe to ship on by default. Unset or any other value leaves
  // it in. The reader is `leanResultGatesEnabled` in lean/result-gates-switch.ts.
  flag("LEAN_RESULT_GATES", true),
  // #2265 — open the review seats' criteria section with the spec's `problem`, so
  // a statement whose tail sits past the prose bound still reaches every seat.
  // `0` takes the statement out and leaves every brief byte-identical to the
  // render before it existed; the statement renders only when the split is on too.
  // The reader is `leanReviewProblemEnabled` in lean/review-problem-switch.ts.
  flag("LEAN_REVIEW_PROBLEM", true),
  // Show the lean review seats (six lenses, adversarial reviewer, review fixer)
  // the issue's prose and the spec's criteria as two sections, so a long
  // statement cannot cut the criteria by competing with its own block for one
  // bound. 0 restores the single bounded block. The reader is
  // `leanReviewSpecSplitEnabled` in lean/review-spec-split.ts.
  flag("LEAN_REVIEW_SPEC_SPLIT", true),
  // #2262 — the rewind's lease: `"0"` puts the leading `+` back on the branch refspec,
  // which makes git skip the lease and force-update a branch somebody else moved.
  // Unset or any other value leaves the refspec unforced so the lease binds. The reader
  // is `leanRewindLeaseBinds` in lean/rewind-lease-switch.ts.
  flag("LEAN_REWIND_LEASE_BINDS", true),
  // #2212 — #2179's runner preflight and the reset's submodule init, both off
  // only on `"0"`, which restores v0.14.71's specify (no probe, no submodule
  // call, exit 11 where the preflight would have handed back at 10).
  flag("LEAN_RUNNER_PREFLIGHT", true),
  // The rewind rule itself: reader `leanVerifiedHandbackEnabled`, same module.
  flag("LEAN_VERIFIED_HANDBACK", true),
  // Unset: derived from the host budget (CPUs, memory, pids.max); 0 = unbounded.
  // #1564 — a lens child's run bound (spawn-child-bound.ts).
  ms("LENS_BOUND_MS", 1_800_000),
  int("LENS_CONCURRENCY", null),
  flag("LENS_EVIDENCE", true),
  // #1742 — caller ceiling on ONE lens-fix dispatch (review-budget.ts), so a
  // single fixer cannot outlive the loop even when the wall clock leaves more.
  ms("LENS_FIX_BOUND_MS", 2_700_000),
  // #1779 — the escape hatch for the lens-fix partial-fix conversion: a bound
  // kill that had already committed HALTs with `step-failed:lens-fix` instead of
  // converting to a partial fix the adversarial gate reviews.
  flag("LENS_FIX_LAND_AHEAD", true),
  // Unset or 0: no bound on concurrent lens children per model.
  int("LENS_MODEL_CONCURRENCY", null),
  // The reader's default is the driver's MAX_REVIEW_ROUNDS (lens-round-cap.ts);
  // the leaf here cannot import it without a cycle, so the literal is pinned
  // against that constant by test-headless-inputs.ts.
  int("LENS_ROUND_CAP", 2),
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
  // #1854 — the ONLY channel by which `start_plan_driver`'s `targetRepository` may
  // be satisfied by a checkout outside the session's own clone and its registered
  // worktrees. Each listed directory still has to prove (by its `origin` URL) that it
  // clones the requested `host/owner/repo`, so an agent cannot aim a filing at an
  // arbitrary path by writing one. Unset: resolution consults the session's clones
  // only, exactly as before the parameter existed. Reader: `overrideClone` in
  // plan-target.ts.
  input("PLAN_TARGET_DIRS", "list", null, "cycle", { separator: ",", manifestVersion: 1 }),
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
  // three measured cycles parked within 30 minutes with sub-second waits).
  // A provider-class failure now waits at least FLOOR, scaled by the attempt;
  // MAX_WAIT is the clamp on EACH wait, not a budget across the cycle. `0`
  // restores the pre-#1243 shape.
  // Sorted after PROVIDER_LENS_*: "PROVIDER_R" > "PROVIDER_L".
  ms("PROVIDER_RETRY_FLOOR_MS", 60_000),
  ms("PROVIDER_RETRY_MAX_WAIT_MS", 1_800_000),
  // #1788 — the path of the PRIVATE denylist the hygiene guard matches public
  // text against. Outside every repository on purpose (a cycle that could edit
  // the list could delete its own entry); absent is a normal state, because the
  // guard's generic set applies whether or not the file exists.
  dir("PUBLIC_DENYLIST", null),
  // #1788 — the public repository hygiene guard. `0` disables the `tool_call`
  // hook that refuses a publish carrying a private term; only `0` is an off
  // switch. Documented in docs/configuration.md and docs/troubleshooting.md.
  // Sorted here because the name comparator folds `_` to a space, so "PUBLIC "
  // (space, not underscore) sorts after every "PROVIDER_" prefix.
  flag("PUBLIC_HYGIENE", true),
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
  // #1743 — the repeat-park guard: a third start of an issue that two earlier
  // cycles already parked for the same reason against the same issue text is
  // refused before any step runs. `0` turns the refusal off; the park records
  // under `.pi/work-state/<N>/park-<cap>.json` are still written either way.
  flag("REPEAT_PARK", true),
  flag("RESEARCH_FALLBACK", true, "interactive"),
  flag("RESUME", true),
  // The ceiling the `check_review_cap` tool answers against (#1429). Separate
  // from REVIEW_WALL_CLOCK_MS: different ceiling, different consumer.
  // #2140 — the wall-clock bound on ONE bash call of a reviewer child, lowered
  // into the call by a child-side `tool_call` hook: Pi's bash enforces it and
  // answers the child with its own timeout error, so nothing is killed.
  ms("REVIEW_BASH_TIMEOUT_MS", 600_000),
  ms("REVIEW_CAP_MS", 5_400_000),
  // The 90-min review-loop budget is enforced at the fix dispatch, not just displayed.
  flag("REVIEW_ENFORCE", true),
  dir("REVIEW_LEDGER_FILE", null, "cycle"),
  // #1827 — how many times a reviewer may open its OWN skill file before the
  // run is steered and then ended (`review-skill-reread`). Counts reads, not
  // tool calls: grep/rg name a path without opening it.
  int("REVIEW_SKILL_READS", 3),
  input("REVIEW_THRESHOLD", "enum", null, "cycle", {
    values: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  }),
  // The driver's review-loop wall clock: what the fixer dispatch is bound by
  // and what the widget and `/work-status` print (#1429).
  ms("REVIEW_WALL_CLOCK_MS", 5_400_000),
  // #1975 — the reviewer tree: every reviewer child runs in a throwaway
  // detached worktree at the reviewed head. `0` is the operator's opt-out and
  // puts the child back in the reviewed tree itself.
  flag("REVIEWER_ISOLATION", true),
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
  // #1879 — the compiler-integrity canary. 0 skips it and every guarded tier
  // then says "compiler integrity not checked" rather than going silent.
  flag("TOOLCHAIN_CANARY", true),
  input("TRANSCRIPT_RETENTION_DAYS", "number", 5, "cycle", { unit: "days" }),
  flag("TRANSIENT_RETRY", true),
  ms("TRANSIENT_RETRY_BACKOFF_MS", 5_000),
  flag("TRUST_MODE", false, "internal"),
  // 0 = off; 1 = nudge at turn 80; any other positive integer is the turn.
  int("TURN_NUDGE", 0, "cycle", { unit: "turns" }),
  // #1250 — 0 disables ONLY the N=1 docs/test unfence, so a single-workstream
  // plan keeps the planner's docs and test fences and the develop gate parks on
  // them as it did before #1250. Distinct from PLAN_UNFENCE, which turns off
  // the whole pass including the issue-named half.
  flag("UNFENCE_DOCS_TESTS", true),
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
