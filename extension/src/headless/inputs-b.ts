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
import { HEADLESS_INPUTS_C } from "./inputs-c.ts";
import { HEADLESS_INPUTS_D } from "./inputs-d.ts";
import { HEADLESS_INPUTS_LEAN } from "./inputs-lean.ts";

export const HEADLESS_INPUTS_B: readonly HostInput[] = [
  // #1765 — 0 skips the branch step's pre-develop base-health probe (the
  // project's verify command at `baseSha`, before any developer is dispatched).
  // The develop gate's POST-failure baseline comparison is untouched, so `0`
  // restores the pre-#1765 cost model rather than a stricter gate. The gate's
  // own switch, PI_ENSEMBLE_VERIFY=0, skips the probe too.
  flag("DEVELOP_BASELINE_PROBE", true),
  ms("DEVELOP_BOUND_MS", 5_400_000),
  // #2377 — the wall-clock bound on ONE bash call of a DEVELOPER child, the twin
  // of REVIEW_BASH_TIMEOUT_MS with its own default. Same child-side `tool_call`
  // hook, same never-raise rule, same Pi enforcement (nothing is killed). A
  // measured lean `specify` call sat 41 min until the step bound killed the step.
  // The default sits BELOW the `timeout 1200` suite wrapper the developer prompt
  // types and below the lean `specify` step budget, so a suite is run in shards
  // or backgrounded with its own `timeout` and a never-returning call ends well
  // before the step bound. `0` is the operator's opt-out and warns nothing.
  ms("DEVELOPER_BASH_TIMEOUT_MS", 900_000),
  dir("DIR", null),
  flag("DISABLE_EXTENSION_FORWARD", false),
  flag("DISABLE_SUBAGENT_GUARD", false),
  flag("DISPATCH_CAPS", true),
  // Unset: a headless cycle opens its PR as a draft, an interactive one does not.
  flag("DRAFT_PR", null),
  ms("EXPLORE_BOUND_MS", 1_800_000),
  // #2611 — the wall clock on the ONE same-session follow-up an explore reply
  // that ended on a status line gets before the step pays for a fresh child
  // (work-driver-explore-reask.ts). Read per call; zero, a negative or a value
  // the parser cannot read falls back to the 3-minute default rather than
  // unbounding the ask or killing it the instant it starts.
  ms("EXPLORE_REASK_BOUND_MS", 180_000),
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
  // #2284 — the parent's `forge_read` broker honours `PI_ENSEMBLE_FORGE=none`: a
  // proved read comes back `the forge is off: PI_ENSEMBLE_FORGE=none` and the
  // parent runs no `gh`/`glab` and no remote read for a child. `0` puts the
  // pre-fix broker back, where the read goes on to `detectForge` whatever the
  // environment says — for the operator who set `none` to stop the DRIVER's forge
  // work and still wants a helper child to read through the parent. The reader is
  // `forgeReadOffGuardEnabled` in forge-read-off-switch.ts; the off decision
  // itself is `forgeEnvIsOff` in forge-off.ts, which the driver shares.
  flag("FORGE_READ_OFF_GUARD", true),
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
  // The adapter's `glab mr create` transport: on, argv of the flags that
  // subcommand lists with the body as one argv element; "0" puts the pre-fix
  // shell string back byte for byte (a known-broken baseline — see the
  // configuration.md row). The reader is `glabMrCreateArgvEnabled` in
  // gl-mr-create-switch.ts; the flags themselves are judged against
  // `glab mr create --help` by smoke-tests/test-glab-flags.ts.
  flag("GLAB_MR_CREATE", true),
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
  ...HEADLESS_INPUTS_LEAN,
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
  // #2223 — an incomplete lens round is no evidence its head was reviewed, so its
  // row is skipped as the automatic delta base and the next round is full. `0`
  // restores the pre-fix reading (the reader is `!== "0"`, so the default is on).
  flag("LENS_INCOMPLETE_FULL", true),
  // #2261 — the large-diff arm of the lens review: reads a base+head range up to
  // REVIEW_DIFF_READ_MAX_BYTES and bound every lens prompt instead of inlining
  // the whole diff. `0` is the only off value and restores the pre-#2261 shape
  // byte-for-byte (1 MiB reads that failed unnamed, unbounded prompts).
  flag("LENS_LARGE_DIFF", true),
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
  // 0 = off: no child is ended for lack of progress (ChildProgress.stall).
  ms("PROGRESS_SILENCE_MS", 0),
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
  ...HEADLESS_INPUTS_C,
  str("ROLE", null, "internal"),
  dir("RUNS_DIR", "~/.pi/agent/ensemble-runs"),
  ...HEADLESS_INPUTS_D,
  // #1250 — 0 disables ONLY the N=1 docs/test unfence, so a single-workstream
  // plan keeps the planner's docs and test fences and the develop gate parks on
  // them as it did before #1250. Distinct from PLAN_UNFENCE, which turns off
  // the whole pass including the issue-named half.
  flag("UNFENCE_DOCS_TESTS", true),
  str("USER_EXTENSION", null),
  flag("VERIFY", true),
  // #2283 — the classic /work command-criteria tier: the spec's verify:"command" criteria,
  // run beside the ratchet and smoke gates and independently of the discovered verify
  // command. 0 restores the pre-#2283 behaviour, where a /work cycle ran none of them.
  flag("VERIFY_COMMAND_CRITERIA", true),
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
  // #2283 — the develop gate's data-provenance check: an added JSON/NDJSON record whose
  // provenance key names a path absent from the workstream's pinned commit fails the step.
  // 0 skips it; tokens this gate cannot see are disclosed on both arms, never failed.
  flag("VERIFY_PROVENANCE", true),
  // #2295 — the prose arm of that same gate: a whitespace-bearing provenance value is split
  // into path-shaped fragments and each is judged, so a claim wrapped in a sentence fails like
  // a bare path. On by default; `0` restores the v0.14.85 walk byte for byte — the seven-name
  // key set and whole values only — which is what
  // `test-verify-develop-provenance-prose-v85.ts` compares against a shipped copy.
  flag("VERIFY_PROVENANCE_PROSE", true),
  // #2295 — the one host directory this gate may consult, for a bare basename the commit cannot
  // answer. Absolute or unused; a regular file of that name under it (within the depth the root
  // module bounds) answers the claim, and a root that cannot be read is a could-not-tell note,
  // never a verdict. Unset is the shipped behaviour: the gate is git-only.
  flag("VERIFY_PROVENANCE_ROOT", true),
  // #2282 — the Python arm of `verifyCmdFor`'s discovery: a `pyproject.toml`
  // that names pytest yields `uv run pytest -q` (a `uv.lock` is present) or
  // `python3 -m pytest -q`, each prefixed with its ruff half when ruff is
  // configured. `"0"` is the only off value and restores the pre-#2282
  // discovery byte for byte — same resolved command, same no-command note — so
  // a Python repo goes back to running nothing in the develop gate. Read at
  // call time by `verifyPytestDisabled`.
  flag("VERIFY_PYTEST", true),

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
