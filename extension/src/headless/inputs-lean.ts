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
  // `0` takes the section out of the build prompt only; `LEAN_ISSUE_PROSE=0`
  // also takes it out, since one renderer serves all three seats.
  // The reader is `leanBuildIssueProseEnabled` in lean/issue-prose.ts.
  flag("LEAN_BUILD_ISSUE_PROSE", true),
  // The two handback switches: the deadline stop's route to the report, and the
  // no-head handback's record. Readers in lean/deadline-handback.ts and
  // lean/verified-handback-switch.ts.
  flag("LEAN_DEADLINE_HANDBACK", true),
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
  // The publishable-branch guard's fail-closed arm: a mainline neither the clone
  // nor origin will name refuses the push instead of passing it. The reader is
  // `leanGuardFailClosed` in lean/guard-fail-closed-switch.ts.
  flag("LEAN_GUARD_FAIL_CLOSED", true),
  // #2279 — the handback's four origin reads (`ls-remote` for the record's head, the held
  // head, and the branch/keeping-ref pair that decide success) go through the driver's
  // network-git wrapper: non-interactive env, process-group kill, bounded wait. `0` puts
  // every one of them back on the executor in its pre-fix shape — caller's env, no group
  // kill — for an origin that needs an interactive credential helper. The reader is
  // `leanHandbackNetGitEnabled` in lean/handback-net-git-switch.ts; the push is not in
  // scope, `LEAN_REWIND_LEASE_BINDS` owns that argv.
  flag("LEAN_HANDBACK_NET_GIT", true),
  flag("LEAN_HANDBACK_NOHEAD_RECORD", true),
  // #2171 — show the specify/challenge adversary the issue prose its frozen
  // tests were written from. 0 takes the section back out of both prompts.
  // The reader is `leanIssueProseEnabled` in lean/issue-prose.ts.
  flag("LEAN_ISSUE_PROSE", true),
  // #2202 — the runner probe's shape and the reading of ONE of its answers. `"0"`
  // puts both back exactly as the shipped release has them: the probe is the hidden
  // `.lean-runner-probe.test` outside the configured `verify.testDir`, and an exit 4
  // on it is the `the test runner could not run a test file` hand-back rather than a
  // disclosure. On, a project whose `verify.testGlob` names `.py` is probed with a
  // visible, importable `_lean_runner_probe.py` INSIDE that folder (a hidden file
  // cannot be imported, so the dotfile probe refused every pytest repo), and an exit
  // 4 there is recorded as the runner rejecting the probe file — the bench is sound,
  // the probe is the thing that was refused, so the run goes on to the adversary.
  // The reader is `leanPreflightProbeCollectableEnabled` in
  // lean/preflight-probe-switch.ts; the name itself is `specify-preflight.ts`.
  flag("LEAN_PREFLIGHT_PROBE_COLLECTABLE", true),
  // #2202 — containment for the probe's parent directory: `"0"` skips the realpath
  // check that the folder the write goes into lies inside `realpath(worktree)`, so a
  // base-committed `verify.testDir` that is really a symlink out of the checkout
  // receives the probe. On, such a parent is refused and the probe falls back to the
  // worktree root (itself containment-checked, and infrastructure if THAT fails).
  // The reader is `leanPreflightProbeContainEnabled` in the same module.
  flag("LEAN_PREFLIGHT_PROBE_CONTAIN", true),
  // #2365 — the project's OWN protected paths. `.pi/work.json` `lean.protectedPaths`
  // names repo-relative gitignore-style globs whose paths the `build` fold and the
  // review fixer's fold revert, and name in the step reason, as the built-in protected
  // list is. `"0"` takes the CONFIGURED globs out and nothing else: the built-in reverts
  // (`.pi/`, `.github/`, `agents.json`, `CODEOWNERS`, `.gitmodules`) are enforced by
  // `work-driver-doctrine.ts`, which this knob never reads, and the process-wide
  // `PI_ENSEMBLE_PROTECTED_PATHS` is not consulted here either. With the configured list
  // out, every fold's report and step reason is byte-identical to the fold before the
  // field existed. The reader is `leanProtectedPathsEnabled` in
  // lean/protected-paths-switch.ts; the list itself is `protectedPathsOf` in
  // lean/config.ts and the matcher is lean/protected-globs.ts.
  flag("LEAN_PROTECTED_PATHS", true),
  // #2334 — whether `loadRun` rebuilds the ready step's own `derivedSpec` and `baseSha`.
  // `buildOutcome` is the whitelist that rebuilds every step outcome field by field and
  // had no clause for either, so the ready step's copy of the contract the run executed
  // read back absent while the raw record carried it (the run-level copy survived, which
  // is why derive mode worked). `0` puts the shipped release back byte for byte — the
  // two fields drop on load exactly as v0.14.87 drops them — for an operator comparing
  // a record against one written before the fix. The step's copy is an audit record: no
  // production reader reads it off a step today. The reader is
  // `leanReadyFactsOnLoadEnabled` in lean/ready-facts-switch.ts.
  flag("LEAN_READY_FACTS_ON_LOAD", true),
  // The routed deadline report's own wall: the report is the step the deadline's stop
  // test exempts, so without this it is the one step nothing bounds. `0` puts the
  // unbounded await back byte for byte. The reader is `leanReportBoundEnabled` in
  // lean/handback-report-bound-switch.ts; the bound itself is `handoffReportBoundMs()`
  // in lean/engine-report.ts — `handoffAllowanceMs()` plus REPORT_BOUND_HEADROOM_RATIO.
  flag("LEAN_REPORT_BOUND", true),
  // #2416 — `publish` re-pushes to the PR its OWN run opened, instead of handing back.
  // A red `ci` routes the run back into `publish` with origin holding the sha its own
  // last publish wrote and the forge's one unsettled row being the PR that publish made;
  // the lease check refused on any unsettled row, so the round always ended at exit 10.
  // On, the step compares origin's ref against the newest decided `publish`'s
  // `publishedHead`/`prUrl` and the forge's rows, and pushes only when origin still holds
  // that sha, it is an ANCESTOR of the head (so nothing is rewritten), and the single
  // unsettled row is this branch's own PR. `0` restores the pre-fix refusal byte for
  // byte — same origin read, one `prList`, no `merge-base` call. `isSettled` stays
  // fail-closed on either arm. The reader is `leanRepublishOwnPrEnabled` in
  // lean/republish-own-pr-switch.ts; the check itself is lean/publish-republish.ts.
  flag("LEAN_REPUBLISH_OWN_PR", true),
  // The gate events on the host's result document (`issues[].gates`). `"0"` writes the
  // document exactly as it read before the object existed — no key, no placeholder — which
  // is what makes the object safe to ship on by default. Unset or any other value leaves
  // it in. The reader is `leanResultGatesEnabled` in lean/result-gates-switch.ts.
  flag("LEAN_RESULT_GATES", true),
  // The executed acceptance table in front of the lean review seats and on the run's
  // PR: each criterion, the frozen test the run recorded for it, and what the
  // newest green `verify` reported for it at the certified head. `0` renders none
  // of it — both reviewer briefs are byte-identical to the render before the table,
  // no comment is posted, and the entry guard that refuses a head the gate never
  // certified does not run. The reader is `leanReviewAcceptanceEnabled` in
  // lean/review-acceptance-switch.ts.
  flag("LEAN_REVIEW_ACCEPTANCE", true),
  // Whether a lean run whose review stopped with lanes unjudged gets its own cap: on (the
  // default) such a `ready` PR reports `review-incomplete` and `issues[].reviewComplete:
  // false`; `"0"` writes today's `awaiting-human-merge` and no field at all. The reader is
  // `leanReviewIncompleteCapEnabled` in lean/review-incomplete-cap-switch.ts.
  flag("LEAN_REVIEW_INCOMPLETE_CAP", true),
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
  // Where a lean run's contract comes from when its issue carries no `pi-spec v1`
  // block: `require` (the default) declines, exactly as every run before this knob
  // existed; `derive` sends the prose to one bounded read-only child, which returns
  // a block the run then validates as though an author had written it. An invalid
  // value is a refusal, never the default — a typo that quietly fell back to
  // `require` would decline tickets the operator meant to run. The reader is
  // `resolveSpecIntake` in lean/spec-intake-switch.ts.
  input("LEAN_SPEC_INTAKE", "enum", null, "cycle", { values: ["require", "derive"] }),
  // #2319 — where a lean worktree's submodules are initialised FROM. On (the default)
  // each first level is seeded from the superproject — its module store under
  // `.git/modules/<path>`, else its populated checkout — through a per-path URL this
  // harness computes, and one this host never held is disclosed rather than fetched;
  // `0` puts the release's own `git submodule update --init --recursive` back byte for
  // byte, listing probe included, for an operator whose submodule lives on a remote.
  // The outer gate is `LEAN_RUNNER_PREFLIGHT`, which wins: with it at `0` no submodule
  // code runs at all. The reader is `leanSubmodulesLocalEnabled` in
  // lean/submodules-local-switch.ts.
  flag("LEAN_SUBMODULES_LOCAL", true),
  // The rewind rule itself: reader `leanVerifiedHandbackEnabled`, same module.
  flag("LEAN_VERIFIED_HANDBACK", true),
];
