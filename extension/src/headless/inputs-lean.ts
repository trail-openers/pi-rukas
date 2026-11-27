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
  // #2228 — show the BUILDER the issue prose its frozen tests were written from.
  // `0` takes the section out of the build prompt only. The oracle seats have no
  // switch: one renderer serves all three and the section ships on.
  // The reader is `leanBuildIssueProseEnabled` in lean/issue-prose.ts.
  flag("LEAN_BUILD_ISSUE_PROSE", true),
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
  // #2279 — the handback's four origin reads (`ls-remote` for the record's head, the held
  // head, and the branch/keeping-ref pair that decide success) go through the driver's
  // network-git wrapper: non-interactive env, process-group kill, bounded wait. `0` puts
  // every one of them back on the executor in its pre-fix shape — caller's env, no group
  // kill — for an origin that needs an interactive credential helper. The reader is
  // `leanHandbackNetGitEnabled` in lean/handback-net-git-switch.ts; the push's argv is
  // not in scope — its `--atomic` and its unforced lease-bound refspec ship with the rule.
  flag("LEAN_HANDBACK_NET_GIT", true),
  // The share of the cell budget the steps BEFORE the first verify may spend together. The
  // number is a whole percent, 0 to 100, and the shipped default is 40; `0` is the ONLY off
  // value — the rule short-circuits there, so it puts the pair back on its per-child ceilings
  // alone rather than bounding it at zero. Anything that is not a whole
  // percent in range (`40.5`, `101`, `abc`, empty) reads as the default, not as off. The reader
  // is `leanPreVerifySharePercent` in lean/pre-verify-share-switch.ts; the bound it feeds — the
  // no-dispatch stop on `specify`'s retry and the `challenge` skip with its recorded reason — is
  // lean/pre-verify-share.ts. It never cuts a child already running.
  int("LEAN_PRE_VERIFY_SHARE", 40),
  // #2202 — containment for the probe's parent directory: `"0"` skips the realpath
  // check that the folder the write goes into lies inside `realpath(worktree)`, so a
  // base-committed `verify.testDir` that is really a symlink out of the checkout
  // receives the probe. On, such a parent is refused and the probe falls back to the
  // worktree root (itself containment-checked, and infrastructure if THAT fails).
  // The reader is `leanPreflightProbeContainEnabled` in the same module.
  flag("LEAN_PREFLIGHT_PROBE_CONTAIN", true),
  // Where a lean run's contract comes from when its issue carries no `pi-spec v1`
  // block: `require` (the default) declines, exactly as every run before this knob
  // existed; `derive` sends the prose to one bounded read-only child, which returns
  // a block the run then validates as though an author had written it. An invalid
  // value is a refusal, never the default — a typo that quietly fell back to
  // `require` would decline tickets the operator meant to run. The reader is
  // `resolveSpecIntake` in lean/spec-intake-switch.ts.
  input("LEAN_SPEC_INTAKE", "enum", null, "cycle", { values: ["require", "derive"] }),
];
