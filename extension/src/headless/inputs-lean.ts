/**
 * headless/inputs-lean — the `PI_ENSEMBLE_LEAN_*` rows of the `HEADLESS_INPUTS`
 * list, imported and spliced into place by `inputs-b.ts`.
 *
 * Split out along the same alphabetical seam the inventory is sorted on, for the
 * §12 file-size cap, and following the precedent `inputs-c.ts` sets: `inputs.ts`
 * and `inputs-b.ts` hold the inventory in order and this module holds one
 * contiguous family of rows, spliced at the position the list's own collation
 * puts them so the exported array stays sorted by name. Every row is judged
 * identically by `test-headless-inputs.ts` whichever module carries it.
 *
 * The rows live together because they share a reader convention as well as a
 * prefix: each is one exported predicate in `extension/src/lean/`, read at CALL
 * time, whose only off value is the literal `"0"` (`LEAN_DETECT_VERIFY` alone is
 * off by default and on only at `"1"`). A name goes here when its
 * reader lives under `lean/`; the builders are `entry.ts`'s.
 */

import { type HostInput, flag, input, int } from "./entry.ts";

/** The lean switches, in the list's order. */
export const HEADLESS_INPUTS_LEAN: readonly HostInput[] = [
  // A build child whose recorded turn ended at the model's output-token limit with no tool call — or
  // one clean turn with no tool call and nothing for the change fold to commit — is asked for ONE more
  // turn in its own session, through the same continuation seam the review fixer's wave uses, before
  // the step writes `exhausted: the developer produced no change`. The detector reads the child's own
  // recorded `stopReason`, its own tool calls and the FOLD's answer, never its prose; a kill cause, an
  // error stop, a budget the step's ceiling already fired, any tool call, or a child whose session path
  // is gone takes today's path. `0` restores today's behaviour byte for byte — no detection, no ask,
  // and the exhausted reason keeps its bytes. The ask is one extra developer cost row and no bound,
  // budget or ceiling changes. The reader is `leanBuildReaskEnabled` in build-reask.ts.
  flag("LEAN_BUILD_REASK", true),
  // Default OFF, on only at `1`: a repo with neither `.pi/work.json` nor `.pi/verify-cmd`
  // gets verify tiers detected at the base (pytest, or a package.json test script) instead
  // of `ready`'s setup refusal — the refusal a host's driver fallback keys on. The shared
  // loader also hands it to classic /work's command-criteria tier. The reader is
  // `leanDetectVerifyEnabled` in lean/config-detect.ts.
  flag("LEAN_DETECT_VERIFY", false),
  // A review fixer whose last turn ended at the model's output-token limit with no edit made is
  // continued ONCE, in its own session, in its own tree behind the same write fence, before the wave
  // is judged "produced no change". The detector reads the child's own recorded `stopReason` and its
  // own recorded tool calls, never its prose; a kill cause, a fired budget, or a result that cannot
  // say either way takes today's path. `0` restores today's behaviour byte for byte — no detection,
  // no continuation, and the no-change cause, the handback body and the headless `failure.message`
  // unchanged. The continuation is one extra fixer cost row inside the same wave; no bound, budget or
  // token cap changes. The reader is `leanFixerTruncationReaskEnabled` in
  // fixer-truncation.ts.
  flag("LEAN_FIXER_TRUNCATION_REASK", true),

  // How wide the roster's head run reaches over the project's `verify.full` tier: on, the tier may end in
  // one directory of the tree the roster scanned, sparing a duplicate whole-suite run. The reader is
  // lean/full-tier-operand-switch.ts; the comparison is lean/verify-suite-command.ts.
  flag("LEAN_FULL_TIER_OPERAND", true),
  // The share of the cell budget the steps BEFORE the first verify may spend together. The
  // number is a whole percent, 0 to 100, and the shipped default is 40; `0` is the ONLY off
  // value — the rule short-circuits there, so it puts the pair back on its per-child ceilings
  // alone rather than bounding it at zero. Anything that is not a whole
  // percent in range (`40.5`, `101`, `abc`, empty) reads as the default, not as off. The reader
  // is `leanPreVerifySharePercent` in lean/pre-verify-share-switch.ts; the bound it feeds — the
  // no-dispatch stop on `specify`'s retry and the `challenge` skip with its recorded reason — is
  // lean/pre-verify-share.ts. It never cuts a child already running.
  // A blocked build report the driver PROVED buys ONE blind specify-adversary round to correct the frozen
  // test before the run hands back. `0` restores the handback byte for byte. The reader is
  // `leanOracleRepairEnabled` in lean-oracle-repair-switch.ts, read once at run creation.
  flag("LEAN_ORACLE_REPAIR", true),
  int("LEAN_PRE_VERIFY_SHARE", 40),
  // A review fix wave saves the head it starts from before the fixer runs, and the
  // range rides the step's reason, a PR comment, the handback and `issues[].preFixHead`. `0`
  // saves and names nothing. The reader is `leanPrefixHeadEnabled` in lean/review-log.ts.
  flag("LEAN_PREFIX_HEAD", true),
  // #2202 — containment for the probe's parent directory: `"0"` skips the realpath
  // check that the folder the write goes into lies inside `realpath(worktree)`, so a
  // base-committed `verify.testDir` that is really a symlink out of the checkout
  // receives the probe. On, such a parent is refused and the probe falls back to the
  // worktree root (itself containment-checked, and infrastructure if THAT fails).
  // The reader is `leanPreflightProbeContainEnabled` in the same module.
  flag("LEAN_PREFLIGHT_PROBE_CONTAIN", true),
  // The project's OWN pre-existing tests as a fourth thing `verify` judges: the suite the
  // config's `verify.testDir` + `verify.testGlob` name is run at HEAD and at the run's base
  // commit, its per-test verdicts read from the runner's report, and the BASE version of every
  // pre-existing test file the run edited re-run against the head code. The verdict outranks the
  // whole-line baseline excuse, and the land gate reads the roster off the record rather than
  // trusting the verdict kind. `0` runs none of it and restores the pre-roster pass byte for byte.
  // The reader is `leanProjectRosterEnabled` in lean/project-roster-switch.ts; the enumeration,
  // both runs and the comparison are lean/verify-roster.ts.
  flag("LEAN_PROJECT_ROSTER", true),
  // The bound on ONE model request inside a lean step. The engine checks the cycle deadline only
  // BETWEEN steps, so a request hung INSIDE one outlives it and the harness's outer wall takes the
  // cell. Quiet for the window with no tool call in flight is aborted through the same
  // `AbortController` the turns/tokens levers use, and reads back as their `budget` verdict
  // (`limit: "stall"`). The window is derived — the handoff allowance plus the review reserve,
  // clamped to what the deadline leaves — and never configured. `0` is the ONLY off value, which
  // returns a hung request to the outer wall alone. The reader is `leanRequestStallEnabled` in
  // request-stall-policy.ts, which also derives the window; lean-step-bound.ts pins the lean
  // reserve into it (`stepDispatchArms`) and lean/step-budget.ts arms it.
  flag("LEAN_REQUEST_STALL", true),
  // The executed acceptance table in front of the lean review seats and on the run's
  // PR: each criterion, the frozen test the run recorded for it, and what the
  // newest green `verify` reported for it at the certified head. The table is READ,
  // never executed, and is composed once per attempt by `lean/review-acceptance.ts`.
  // #2212 — #2179's runner preflight and the reset's submodule init, both off
  // only on `"0"`, which restores v0.14.71's specify (no probe, no submodule
  // call, exit 11 where the preflight would have handed back at 10).
  flag("LEAN_RUNNER_PREFLIGHT", true),
  // Where a lean run's contract comes from when its issue carries no `pi-spec v1`
  // block: `require` (the default) declines, exactly as every run before this knob
  // existed; `derive` sends the prose to one bounded read-only child, which returns
  // a block the run then validates as though an author had written it. An invalid
  // value is a refusal, never the default — a typo that quietly fell back to
  // `require` would decline tickets the operator meant to run. The reader is
  // `resolveSpecIntake` in lean/spec-intake-switch.ts.
  input("LEAN_SPEC_INTAKE", "enum", null, "cycle", { values: ["require", "derive"] }),
  // A criterion `specify`'s own child could not prove red hands the run back (exit 10,
  // `failure.kind: "red-test-gap"`) instead of declining the spec (exit 11). `0` restores the
  // decline byte for byte. The reader is `leanSpecifyGapHandbackEnabled` in
  // lean/specify-gap-switch.ts.
  flag("LEAN_SPECIFY_GAP_HANDBACK", true),
  // A `specify` child may declare a criterion it intends to KEEP working — `submit_tests` carries
  // `preserves: true` — and the file the step froze for it is then a must-pass file rather than the
  // coverage gap that ended the run: a criterion that states behaviour which already holds has no red
  // test to write. The declaration is untrusted like every other submitted field, a run whose every
  // criterion is preserved still hands back, and the ids are disclosed by name in the handback and the
  // PR body. `0` is the ONLY off value: the `submit_tests` schema, the specify prompt and the step's
  // recorded outcome are then the bytes from before the field existed, so the declaration is neither
  // offered nor read. The reader is `leanSpecifyPreservesEnabled` in
  // lean-specify-preserves-switch.ts; the rule is specify-preserves.ts.
  flag("LEAN_SPECIFY_PRESERVES", true),
  // A specify child that submitted some test criteria and not others is asked once, on its
  // own session, for the rest before readiness is judged. `0` dispatches as before: the
  // unsubmitted criteria end the run. The reader is `leanSpecifyReaskEnabled` in
  // lean/specify-reask.ts.
  flag("LEAN_SPECIFY_REASK", true),
  // #2660 — the bound a lean step's CHILD may be given, read against the run's cycle
  // deadline. The engine consults the deadline only BETWEEN steps and the cycle clock
  // `spawn-child-bound.ts` clamps against is recorded by `/work` alone, so a step still
  // running and still emitting when the deadline passed bounded itself by nothing: the
  // panel's cells overran the line past the child grace until the outer wall took the
  // cell. At arm time the child gets the smaller of its configured minutes and what the
  // deadline leaves outside the handoff allowance, so the kill lands before the line and
  // the handback keeps its allowance. Inert — and it says which on the trace — with no
  // deadline, with `PI_ENSEMBLE_DISPATCH_CAPS=0`, or at this switch's `0`, the ONLY off
  // value, which leaves the bound exactly the configured minutes. The reader is
  // `leanStepDeadlineBoundEnabled` in lean-step-deadline-bound-switch.ts; the derivation
  // is lean-step-bound.ts and lean/step-budget.ts arms it.
  flag("LEAN_STEP_DEADLINE_BOUND", true),
];
