/**
 * /work workflow state — the verify-gate run event pair (#1415).
 *
 * tehas cycle 261 ran 15,159 s and ~67 of its minutes went to the driver's own
 * consolidated verify — ~22 minutes after EACH develop round — with nothing
 * written to the console while it ran. Between the developer's `Task complete`
 * and `step 4/9 develop done in 2491s` the operator watched a stall that was
 * not one. The gate's slowness is a separate, already-filed problem
 * (janit/tehas#247); that it is INVISIBLE while it runs is this one.
 *
 * So the gate announces itself: `verify-started` when the command is about to
 * be executed and `verify-completed` when it returns, carrying the duration,
 * the command, and the tree it ran against. Three surfaces read the pair, and
 * all three are renderings of the SAME two events — this module only defines
 * them:
 *
 *   - the chat scrollback (`lifecycle-events.ts` / `lifecycle-scrollback.ts`)
 *     — the line the operator sees DURING the 22 minutes rather than after;
 *   - `/work-status` and the state file's event log (`work-status-events.ts`);
 *   - the headless NDJSON stream (`headless/host.ts` → `headless/ndjson.ts`),
 *     which emits every `WorkEvent` kind, so declaring the pair here is what
 *     puts it on the host's stderr at all. The two kinds are in the stable
 *     subset (`NDJSON_STABLE_FIELDS`) because a host must be able to time the
 *     gate, not merely tolerate the line.
 *
 * **Who emits them.** This module defines and renders; it does not execute.
 * The emit call sites belong to the verify-gate files (`work-driver-verify-
 * verify-cmd.ts`, `work-driver-consolidated-verify.ts`) — the code that
 * awaits the exec and therefore holds the wall-clock. A duration reconstructed
 * anywhere else is an estimate.
 *
 * Same fragment pattern as the sibling `workflow-state-events-*.ts` modules:
 * pure event types (types only, no value imports) composed into the closed
 * `WorkEvent` union in `workflow-state-events.ts` by name, so the union stays
 * exhaustive and additive — older readers ignore the kind, and the schema
 * validator knows it.
 *
 * Deliberately NOT in `workflow-state-events-verify-flake.ts`, which is
 * chartered for verify-TIER-OUTCOME events (`verify-flake-recovered`,
 * `verify-full-status`, `consolidated-verify-skipped`): those record what a
 * run concluded. These record that a run happened and what it cost. And
 * `verify-completed` is not `consolidated-verify-skipped`: a skip is the
 * absence of a run and carries the tree identity that justified it, whereas a
 * `skipped` status here is a gate that decided not to execute one command it
 * had been asked to run.
 */

import type { WorkStep } from "./workflow-state-events.ts";

/**
 * Which run of the project's gate this is.
 *
 * - `full`              — `.pi/verify-cmd` (or the package-manager / Cargo
 *   fallback the resolver derives when the project ships no file).
 * - `fast`              — `.pi/verify-cmd-fast` (#1324), the quick tier the
 *   driver runs before every full run.
 * - `full-second-tier`  — `.pi/verify-cmd-full` (#279), the deeper suite the ci
 *   step runs once before the CI watch.
 *
 * OPTIONAL by design: a caller that does not classify its command (an injected
 * executor, an older caller) leaves it absent, and readers must not infer a
 * tier from the command text.
 */
export type VerifyTier = "full" | "fast" | "full-second-tier";

/**
 * The tree the gate executed against. `path` is absolute so the operator can
 * `git -C <path>` it; the renderers print the basename.
 *
 * Derive this at the emit site from the workstream map the caller already
 * holds — a hand-typed target is how a duration gets attributed to the wrong
 * tree, which is worse than no duration at all.
 */
export type VerifyTarget =
  /** One workstream's own worktree — the per-worktree leg of the develop gate. */
  | { kind: "worktree"; id: string; path: string }
  /** The consolidated probe the develop gate builds at repoRoot, or the
   * integration tree commit-pr verifies before the push. */
  | { kind: "consolidated" };

/** The verdict of one gate run. */
export type VerifyStatus = "success" | "failure" | "skipped" | "timeout";

/**
 * The gate is about to execute the project's verify command.
 *
 * Emitted BEFORE the exec, not alongside the completion: a pair that only
 * lands when the command returns says nothing during the 22 minutes the event
 * exists to fill. A cycle killed mid-run (the tehas `docker stop` shape)
 * therefore leaves a `verify-started` with no `verify-completed`, which is
 * itself the finding — it localises the kill to the gate rather than to the
 * step at large.
 */
export type VerifyStartedEvent = {
  kind: "verify-started";
  at: number;
  /** The step whose gate is running. */
  step: WorkStep;
  /** The verify command, verbatim as the project configured it. */
  command: string;
  /** The tree the command is about to run against. */
  target: VerifyTarget;
  tier?: VerifyTier;
  /** True for the #782 single bounded re-run of the SAME command. */
  retried?: boolean;
};

/**
 * A verify run reached its end.
 *
 * The shape follows `verify-full-status` (`status` + `ms` + `evidenceTail`) so
 * the two gate tiers render alike and a reader learns one vocabulary.
 * `timeout` is kept separate from `failure` because a run killed at its bound
 * judged nothing — the same distinction the `verify-timeout:<step>` cap makes
 * (#1324).
 *
 * `reused` is additive for the gate-reuse track: when a passing result is
 * carried across a develop round instead of being executed again, the
 * completion says so, and a fast `develop` is explained from the log rather
 * than inferred from a missing run.
 */
export type VerifyCompletedEvent = {
  kind: "verify-completed";
  at: number;
  /** The step whose gate ran — matches its `verify-started`. */
  step: WorkStep;
  /** The verify command that ran — matches its `verify-started`. */
  command: string;
  /** The tree the command ran against. */
  target: VerifyTarget;
  tier?: VerifyTier;
  status: VerifyStatus;
  /**
   * `status === "success"`. Released in 0.13.0 as a stable NDJSON field of this
   * kind (docs/headless.md, the stable subset), so it stays alongside `status`:
   * renaming a stable field is a contract break, adding one is not.
   */
  ok: boolean;
  /** Wall-clock ms for the run. Absent when `status` is `skipped` (nothing ran). */
  ms?: number;
  /** The verdict came from a previous passing run of the same tree, not a new exec. */
  reused?: boolean;
  /** True for the #782 single bounded re-run of the SAME command. */
  retried?: boolean;
  /** Bounded output tail for the handoff / status line (failure paths only). */
  evidenceTail?: string;
};

/** The verify-run event kinds, referenced by name in the composed union's doc. */
export type VerifyRunEventFragment = VerifyStartedEvent | VerifyCompletedEvent;

/** The arguments both halves of the pair share — the identity a reader joins them on. */
export type VerifyRunArgs = {
  step: WorkStep;
  command: string;
  target: VerifyTarget;
  tier?: VerifyTier;
  retried?: boolean;
};

/**
 * Build the pair for one executed run, given the run's outcome.
 *
 * A factory (rather than two literals at each emit site) so a `started` and
 * its `completed` can never disagree on `step`, `command`, `target`, `tier` or
 * `retried` — the five fields a reader matches them on — and so the optional
 * fields stay ABSENT rather than `undefined`-present, which is what lets a
 * pre-#1415 reader and a post-#1415 reader render the same object byte-for-
 * byte. `ms` is supplied by the caller that timed the exec.
 */
export function makeVerifyRunEvents(
  args: VerifyRunArgs & {
    status: VerifyStatus;
    ms?: number;
    reused?: boolean;
    evidenceTail?: string;
  },
): { started: VerifyStartedEvent; completed: VerifyCompletedEvent } {
  const at = Date.now();
  const shared = {
    step: args.step,
    command: args.command,
    target: args.target,
    ...(args.tier !== undefined ? { tier: args.tier } : {}),
    ...(args.retried === true ? { retried: true } : {}),
  };
  return {
    started: { kind: "verify-started", at, ...shared },
    completed: {
      kind: "verify-completed",
      at,
      ...shared,
      status: args.status,
      ok: args.status === "success",
      ...(args.ms !== undefined ? { ms: args.ms } : {}),
      ...(args.reused === true ? { reused: true } : {}),
      ...(args.evidenceTail !== undefined ? { evidenceTail: args.evidenceTail } : {}),
    },
  };
}

/** The basename a console or status line shows for one target. */
export function verifyTargetLabel(target: VerifyTarget): string {
  return target.kind === "worktree" ? (target.path.split("/").pop() ?? target.id) : "consolidated";
}

/**
 * The `verify-started` awaiting its `verify-completed`, if any — a gate the
 * cycle died inside. `appendEvent` is the only writer of the log, so a started
 * with no completion after it is a run that never returned, and renderers use
 * this to say WHERE the kill landed instead of leaving the last word to a
 * step boundary that never came.
 */
export function pendingVerifyRun(
  events: readonly { kind: string; step?: string }[],
): { step?: string } | undefined {
  let open: { step?: string } | undefined;
  for (const e of events) {
    if (e.kind === "verify-started") open = { step: e.step };
    else if (e.kind === "verify-completed") open = undefined;
  }
  return open;
}
