/**
 * work-driver-verify-gate-reuse — #1415: a passing gate result is reused until
 * the thing it judged changes.
 *
 * The problem this closes (janit/tehas#261, cycle 261): the develop step ran
 * the project's verify command once per worktree AND once more at repoRoot for
 * the consolidated probe, on EVERY develop pass. Three adversarial rounds took
 * six full gate runs — ~67 minutes of a 4-hour cycle, in a harness that prints
 * nothing while it runs, so an operator watched a stall that was a suite.
 *
 * The rule, stated once: **a verify verdict belongs to a (content, command,
 * bound) triple, and that triple does not need a second verdict until one of
 * its parts moves.** Each passing pass records what it judged and how long it
 * took; the next pass asks "has anything this verdict speaks for changed?" and
 * skips the whole gate when it has not — the per-worktree runs and the
 * consolidated probe alike.
 *
 * **The key is the triple, not the tree.** Three parts, each load-bearing:
 *
 *   - **tree** — git's own object id for the content the command read.
 *   - **command** — the gate is a shell string read from `.pi/verify-cmd`, and
 *     that file is untracked in most projects. `verifyTreeId` deliberately does
 *     not count an untracked `.pi/verify-cmd` as dirt (`DRIVER_GATE_FILES`), so
 *     git's tree id CANNOT see an operator editing the gate mid-cycle. Carrying
 *     the command verbatim closes that hole, and it is free — `cmd` is already
 *     in scope at the only caller. The fast tier rides inside it: `withFastTier`
 *     fails with the fast command's own name and `failedVerifyCmd` reports it,
 *     so a fast-tier failure's verdict is recorded under the fast command and a
 *     full run under the full one. Two different commands, two verdicts.
 *   - **bound** — `verifyTimeoutMs()` at the moment of the run. A verdict
 *     reached in 9 minutes under a 10-minute bound says nothing about whether
 *     the same tree passes under a 2-minute bound; the operator who tightens
 *     `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` gets the gate back immediately, with no
 *     stale record to invalidate.
 *
 * **Reuse is an optimisation, so every failure points at running.** No record,
 * an unreadable tree on any side, a mismatched command or bound, an entry past
 * the age ceiling, a workstream with no green of its own, or the knob off — all
 * mean a real run. A skipped gate that should have run is a silent quality
 * regression; a run that could have been skipped costs minutes.
 */

import { trace } from "./trace.ts";
import { verifyTreeId } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";

/** The tree object id a verdict was reached for. git's own 40-hex shape. */
const TREE_HASH_RE = /^[0-9a-f]{40}$/;

/**
 * How long a recorded pass may be reused at all. A generous ceiling: the
 * staleness that matters is checked structurally (tree, command, bound), not by
 * age, and a develop round can legitimately sit behind a long adversarial
 * review. What the ceiling rules out is a cycle resumed from an old state file
 * — a verdict from a different era of the repository should not license a skip
 * today.
 */
export const REUSE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How much cheaper a recorded run has to be than the bound it would face now.
 * A pass that took more than half the current bound is not evidence that
 * skipping the run is safe, because the run being skipped is exactly the run
 * the bound exists to cap.
 */
const REUSE_HEADROOM_DIVISOR = 2;

/** The record of one passing gate run, persisted on `pipelineState`. */
export interface GatePass {
  /** The git tree object id every worktree's content combined into. */
  treeHash: string;
  /** The verify command that judged it, verbatim (fast tier included). */
  cmd: string;
  /** The bound (`PI_ENSEMBLE_VERIFY_TIMEOUT_MS`) the run completed under. */
  timeoutMs: number;
  /** Epoch ms of the pass. */
  at: number;
  /**
   * Wall-clock ms the run took. Retained for the operator and the handoff —
   * the reuse decision itself keys on `timeoutMs` rather than on this, so a
   * record stays honest when the knob moves.
   */
  lastDurationMs?: number;
}

/** One workstream's recorded per-worktree green (its own command, its tree). */
export interface WorkstreamGreen {
  treeHash: string;
  cmd: string;
  timeoutMs: number;
  at: number;
}

/** Why reuse was refused — carried so the caller's note and trace can say so. */
export type ReuseRefusal =
  | "disabled"
  | "no-record"
  | "tree-unreadable"
  | "command-changed"
  | "bound-changed"
  | "stale"
  | "bound-too-tight"
  | "workstream-not-green";

/**
 * Escape hatch: `PI_ENSEMBLE_VERIFY_GATE_REUSE` set to `0`, `false`, `off` or
 * `no` (trimmed, case-insensitive — the vocabulary the repo's other gates
 * accept) restores the pre-#1415 behaviour: every develop pass runs the full
 * gate. Anything else, including a malformed value, keeps reuse available — the
 * safe side is the one that skips the duplicate.
 *
 * The #1240 sibling (`PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP`) governs only the
 * consolidated duplicate run; this knob governs the whole pass, per-worktree
 * loop included.
 *
 * A REUSE needs no integration lock. It performs no repoRoot mutation, so
 * taking the lock would queue a pure read behind every cherry-pick and verify in
 * flight for nothing; the safety instead rests on the reads themselves, which
 * consult git as of now rather than trusting what a record claims.
 */
const REUSE_DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

export function gateReuseEnabled(): boolean {
  const raw = process.env.PI_ENSEMBLE_VERIFY_GATE_REUSE;
  if (raw === undefined) return true;
  return !REUSE_DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** The whole-tree key an entry is stored under: the triple, not the tree. */
export function gatePassKey(treeHash: string, cmd: string, timeoutMs: number): string {
  return `${treeHash}\u0000${cmd}\u0000${timeoutMs}`;
}

/** The record a passing pass stores. `at` is stamped now. */
export function gatePassRecord(
  treeHash: string,
  cmd: string,
  timeoutMs: number,
  durationMs: number | undefined,
): GatePass {
  return {
    treeHash,
    cmd,
    timeoutMs,
    at: Date.now(),
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0
      ? { lastDurationMs: Math.round(durationMs) }
      : {}),
  };
}

/**
 * The combined content of every worktree the cycle is judging, or `undefined`
 * when any side could not be read.
 *
 * The consolidated probe's tree is a cherry-pick of exactly these worktrees'
 * own ranges onto `baseSha`, so when each reports its HEAD tree and they all
 * agree, the probe tree is that same tree by construction. Any disagreement
 * (two workstreams holding different trees — a genuine combination nothing
 * judged), any unreadable worktree, or a non-string path yields `undefined`,
 * which means "no reuse evidence", which means the gate runs.
 */
export async function combinedWorktreeTree(
  execFn: ExecFn,
  worktrees: Record<string, string | undefined>,
): Promise<string | undefined> {
  const ids = Object.keys(worktrees);
  if (ids.length === 0) return undefined;
  let combined: string | undefined;
  for (const id of ids) {
    const cwd = worktrees[id];
    if (typeof cwd !== "string") return undefined;
    // `verifyTreeId` is the SAME read the #1240 skip uses: it refuses to
    // report a tree when the working tree holds content no tree object
    // describes. A worktree with unstaged or untracked residue therefore has
    // no identity, and nothing built on it is reused.
    const tree = await verifyTreeId(execFn, cwd);
    if (tree === undefined || !TREE_HASH_RE.test(tree)) {
      trace(`work-driver: gate reuse — no tree identity for workstream '${id}'; the gate runs`);
      return undefined;
    }
    if (combined === undefined) combined = tree;
    else if (combined !== tree) return undefined;
  }
  return combined;
}

/** The green a per-worktree command passing in `cwd` establishes, or nothing. */
export async function greenForWorktree(
  execFn: ExecFn,
  cwd: string,
  cmd: string,
  timeoutMs: number,
): Promise<WorkstreamGreen | undefined> {
  const treeHash = await verifyTreeId(execFn, cwd);
  if (treeHash === undefined || !TREE_HASH_RE.test(treeHash)) return undefined;
  return { treeHash, cmd, timeoutMs, at: Date.now() };
}

/** A green still describes `cwd` for this command under this bound? */
async function greenStillHolds(
  execFn: ExecFn,
  cwd: string,
  cmd: string,
  timeoutMs: number,
  green: WorkstreamGreen | undefined,
): Promise<boolean> {
  if (green === undefined) return false;
  if (green.cmd !== cmd || green.timeoutMs !== timeoutMs) return false;
  if (!Number.isFinite(green.at) || Date.now() - green.at > REUSE_MAX_AGE_MS) return false;
  // Re-read the tree from git rather than trusting the record: the record is
  // evidence of a past run, not a claim about the files on disk now.
  const current = await verifyTreeId(execFn, cwd);
  return current !== undefined && current === green.treeHash;
}

/**
 * Which changed worktrees may stand on a recorded green instead of re-running
 * the command. Returns the ids that may, and the ids that may not — the caller
 * runs the command in exactly the second set.
 *
 * A worktree with no recorded green is not a failure of this function; it is
 * the ordinary first pass, and it belongs in `run`.
 */
export async function worktreesWithGreen(
  execFn: ExecFn,
  opts: {
    cmd: string;
    timeoutMs: number;
    worktrees: Record<string, string | undefined>;
    changedWorktrees: readonly string[];
    greens: Record<string, WorkstreamGreen> | undefined;
  },
): Promise<{ reuse: string[]; run: string[] }> {
  const reuse: string[] = [];
  const run: string[] = [];
  const enabled = gateReuseEnabled();
  for (const cwd of opts.changedWorktrees) {
    if (!enabled) {
      run.push(cwd);
      continue;
    }
    const id = Object.entries(opts.worktrees).find(([, w]) => w === cwd)?.[0];
    const green = id === undefined ? undefined : opts.greens?.[id];
    if (await greenStillHolds(execFn, cwd, opts.cmd, opts.timeoutMs, green)) reuse.push(cwd);
    else run.push(cwd);
  }
  return { reuse, run };
}

/**
 * May this whole gate pass be skipped? `undefined` means run it; the refusal
 * naming the reason is what makes a fast `develop` explainable rather than
 * mysterious.
 *
 * Every condition is a conjunction, and every one of them is checked against
 * git and the environment AS OF NOW, not against what the record claims.
 */
export async function reusableGatePass(
  execFn: ExecFn,
  opts: {
    cmd: string;
    /** The bound the run WOULD get now — normally `verifyTimeoutMs()`. */
    timeoutMs: number;
    worktrees: Record<string, string | undefined>;
    changedWorktrees: readonly string[];
    recorded: Record<string, GatePass> | undefined;
    greens: Record<string, WorkstreamGreen> | undefined;
    maxAgeMs?: number;
  },
): Promise<{ reuse: GatePass; refusal: undefined } | { reuse: undefined; refusal: ReuseRefusal }> {
  const no = (refusal: ReuseRefusal) => ({ reuse: undefined as undefined, refusal });
  if (!gateReuseEnabled()) return no("disabled");
  const recorded = opts.recorded;
  if (recorded === undefined || Object.keys(recorded).length === 0) return no("no-record");
  const combined = await combinedWorktreeTree(execFn, opts.worktrees);
  if (combined === undefined) return no("tree-unreadable");
  const pass = recorded[gatePassKey(combined, opts.cmd, opts.timeoutMs)];
  if (pass === undefined) {
    // Distinguish "the command moved" from "the bound moved" from "no such
    // tree": the operator reading the trace needs to know which part of the
    // triple changed, and each has a different remedy.
    const sameTree = Object.values(recorded).filter((p) => p.treeHash === combined);
    if (sameTree.length === 0) return no("no-record");
    return no(sameTree.some((p) => p.cmd === opts.cmd) ? "bound-changed" : "command-changed");
  }
  const age = Date.now() - pass.at;
  if (age > (opts.maxAgeMs ?? REUSE_MAX_AGE_MS)) return no("stale");
  // A run that took more than half the bound it faced is not a cheap skip.
  if (
    pass.lastDurationMs === undefined ||
    !Number.isFinite(pass.lastDurationMs) ||
    pass.lastDurationMs <= 0 ||
    pass.lastDurationMs > opts.timeoutMs / REUSE_HEADROOM_DIVISOR
  ) {
    return no("bound-too-tight");
  }
  const greens = opts.greens;
  if (greens === undefined) return no("workstream-not-green");
  for (const cwd of opts.changedWorktrees) {
    const id = Object.entries(opts.worktrees).find(([, w]) => w === cwd)?.[0];
    const green = id === undefined ? undefined : greens[id];
    if (
      green === undefined ||
      green.treeHash !== combined ||
      green.cmd !== opts.cmd ||
      green.timeoutMs !== opts.timeoutMs ||
      Date.now() - green.at > (opts.maxAgeMs ?? REUSE_MAX_AGE_MS)
    ) {
      return no("workstream-not-green");
    }
  }
  trace(
    `work-driver: gate reuse — tree ${combined.slice(0, 12)} already passed \`${opts.cmd}\` under a ${opts.timeoutMs}ms bound ${Math.round(age / 1000)}s ago (${pass.lastDurationMs}ms run); this pass runs nothing`,
  );
  return { reuse: pass, refusal: undefined };
}

/**
 * What the develop gate should do with the per-worktree loop, given a whole-gate
 * reuse decision and the greens each worktree holds.
 *
 * Lives here rather than inline in the gate because the two decisions it joins
 * are one argument, not two: reuse of the WHOLE pass is only sound when the
 * per-worktree loop would have had nothing to run anyway. The loop is what
 * establishes the greens the reused verdict rests on, so skipping it while any
 * changed worktree lacks one would skip the only thing that could have caught a
 * defect. Kept apart from `reusableGatePass` because the two answer different
 * questions — the first asks "does a verdict for this triple exist?", this one
 * asks "and does every worktree still hold its half of it?" — and collapsing
 * them would let a caller skip the loop on half the argument.
 */
/**
 * #1415 — the gate's reuse bookkeeping handed to whoever owns `WorkState`. A
 * caller that ignores it loses memoisation, never correctness.
 */
export type GateRecorded = (
  gatePass: GatePass | undefined,
  greens: ReadonlyArray<readonly [string, WorkstreamGreen]>,
  refuted: readonly string[],
) => void;

/** One `GateRecorded` call, as data — what `verifyStepOutcome` hands its caller. */
export interface DevelopGateRecord {
  pass: GatePass | undefined;
  greens: Array<readonly [string, WorkstreamGreen]>;
  refuted: string[];
}

export async function gatePassPlan(
  execFn: ExecFn,
  opts: {
    /** A whole-gate verdict for this (tree, command, bound) triple, if one exists. */
    wholeGate: GatePass | undefined;
    cmd: string;
    timeoutMs: number;
    worktrees: Record<string, string | undefined>;
    changedWorktrees: readonly string[];
    greens: Record<string, WorkstreamGreen> | undefined;
  },
): Promise<{
  /** Changed worktrees whose own command does not need to run. */
  reuse: string[];
  /** Changed worktrees whose own command runs. */
  run: string[];
  /** The whole-gate verdict that holds, or `undefined` when the gate runs. */
  wholeGateHeld: GatePass | undefined;
}> {
  const wholeGate = opts.wholeGate;
  if (wholeGate === undefined) {
    const split = await worktreesWithGreen(execFn, opts);
    return { ...split, wholeGateHeld: undefined };
  }
  const split = await worktreesWithGreen(execFn, opts);
  // A worktree the loop would have run is a worktree whose half of the reused
  // verdict is unproven right now. Reuse collapses to a normal run.
  if (split.run.length > 0)
    return { reuse: [], run: [...opts.changedWorktrees], wholeGateHeld: undefined };
  return { reuse: split.reuse, run: [], wholeGateHeld: wholeGate };
}
