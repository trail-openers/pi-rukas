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
 * time, whose only off value is the literal `"0"`. A name goes here when its
 * reader lives under `lean/`; the builders are `entry.ts`'s.
 */

import { type HostInput, flag, input } from "./entry.ts";

/** The lean switches, in the list's order. */
export const HEADLESS_INPUTS_LEAN: readonly HostInput[] = [
  // #2228 — show the BUILDER the issue prose its frozen tests were written from.
  // `0` takes the section out of the build prompt only. The oracle seats have no
  // switch: one renderer serves all three and the section ships on.
  // The reader is `leanBuildIssueProseEnabled` in lean/issue-prose.ts.
  flag("LEAN_BUILD_ISSUE_PROSE", true),
  // Derive sets ticket lines that only ask existing checks to keep passing beside
  // the criteria as regression guards, which need no red test; `0` restores the
  // derive output with no guards. The reader is
  // `leanDeriveRegressionGuardsEnabled` in lean/derive-guards.ts.
  flag("LEAN_DERIVE_REGRESSION_GUARDS", true),
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
  // #2279 — the handback's four origin reads (`ls-remote` for the record's head, the held
  // head, and the branch/keeping-ref pair that decide success) go through the driver's
  // network-git wrapper: non-interactive env, process-group kill, bounded wait. `0` puts
  // every one of them back on the executor in its pre-fix shape — caller's env, no group
  // kill — for an origin that needs an interactive credential helper. The reader is
  // `leanHandbackNetGitEnabled` in lean/handback-net-git-switch.ts; the push's argv is
  // not in scope — its `--atomic` and its unforced lease-bound refspec ship with the rule.
  flag("LEAN_HANDBACK_NET_GIT", true),
  // The lean lens ledger row is bound to the reviewed head, so a round the step ran is
  // recorded although the run checkout it hands the layer sits at the base commit. `0`
  // computes the identity from that checkout's working tree, as before: nothing recorded.
  // The reader is `leanLensLedgerAtHeadEnabled` in lean/review-deps.ts.
  flag("LEAN_LENS_LEDGER_AT_HEAD", true),
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
  // The executed acceptance table in front of the lean review seats and on the run's
  // PR: each criterion, the frozen test the run recorded for it, and what the
  // newest green `verify` reported for it at the certified head. The table is READ,
  // never executed, and is composed once per attempt by `lean/review-acceptance.ts`.
  // Show the lean review seats (six lenses, adversarial reviewer, review fixer)
  // the issue's prose and the spec's criteria as two sections, so a long
  // statement cannot cut the criteria by competing with its own block for one
  // bound. 0 restores the single bounded block. The reader is
  // `leanReviewSpecSplitEnabled` in lean/review-spec-split.ts.
  flag("LEAN_REVIEW_SPEC_SPLIT", true),
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
  // A specify child that submitted some test criteria and not others is asked once, on its
  // own session, for the rest before readiness is judged. `0` dispatches as before: the
  // unsubmitted criteria decline the run. The reader is `leanSpecifyReaskEnabled` in
  // lean/specify-reask.ts.
  flag("LEAN_SPECIFY_REASK", true),
];
