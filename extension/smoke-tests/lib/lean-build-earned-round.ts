/**
 * smoke-tests/lib/lean-build-earned-round — the one log knob the build fixture cannot hold itself:
 * a run whose `repair` round was already spent.
 *
 * Split from `lib/lean-build-fixture.ts` for the 500-line gate (AGENTS.md §12), along the seam that
 * module already states — the fixture BUILDS the repo and drives the step, this is the log shape a
 * case asks for before the build round it runs. `lean-build-fixture.ts` imports it and declares the
 * option on `RunOpts` / `buildFixture`'s own opts, so a case still imports one module, exactly as
 * the git / artifacts / re-ask splits do.
 */
import type { Step } from "../../src/lean/state.ts";

/**
 * `buildFixture`'s own opts mirror the same-named `RunOpts` fields; the three whose reasoning is
 * longest are restated here so a caller of `buildFixture` directly reads them at the call site.
 *
 * `extraFrozen`: extra frozen files (path -> bytes) to commit on the run's head, hash to, and record
 * in the step log under a `challenge:new-tests` step — a case asking for the adversary's files gets
 * blobs git really holds, so the step's frozen-integrity check passes for the right reason.
 *
 * `baseFiles`: files committed into the BASE commit only, as `path -> bytes` — never hashed, never in
 * the frozen record. A case whose subject is the base tree uses this rather than `extraFrozen`, which
 * also puts its files on the hashed head and into the record.
 *
 * `worktreeIssue`: build the run's worktree under `lean-<this>` rather than `lean-<issue>`. The run's
 * `issue`, branch and step-log keys stay `issue`, so only the tree directory moves. It is what lets a
 * second fixture for another issue share THIS repo without the two runs landing in one worktree —
 * `challenge`/`specify` derive their tree path from `repoRoot` plus their own issue number.
 */
export type BuildFixtureOpts = {
  frozenSha?: string;
  frozenText?: string | Buffer;
  extraFrozen?: Record<string, string>;
  childOwnsBranch?: boolean;
  earned?: EarnedRoundOpts;
  buildStartedAt?: number;
  baseFiles?: Record<string, string>;
  worktreeIssue?: number;
};

/**
 * What a case passes to ask for a spent round: a plain `true` for the canonical shape, or the
 * round's own fields when the case asserts what the round recorded. The fixture spreads this over
 * the minimum decided round, so a case names only what its claim is about.
 */
export type EarnedRoundOpts = boolean | { reason?: string; [field: string]: unknown };

/**
 * The decided `repair` round for a run the round already ran on — the only log shape whose blocked
 * record carries the judged head and the executed red (`build-repair-fields.ts`). Its outcome is the
 * minimum a decided round holds: the reason the step itself writes for a one-file round.
 *
 * Empty when the case asked for nothing: absent leaves the log the release wrote, which is what keeps
 * an off arm from quietly widening its record.
 */
export function earnedRepairStep(issue: number, earned: EarnedRoundOpts | undefined): Step[] {
  if (!earned) return [];
  const over = typeof earned === "object" ? earned : {};
  return [
    {
      key: `${issue}:repair:0`,
      state: "repair",
      startedAt: 3,
      outcome: {
        kind: "repaired",
        reason: "repaired 1 frozen test file(s)",
        ...over,
      } as Step["outcome"],
    },
  ];
}
