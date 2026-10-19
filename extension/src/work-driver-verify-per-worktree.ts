/**
 * work-driver-verify-per-worktree — the per-worktree leg of the develop verify
 * gate: runs the verify command in each worktree the reuse plan did not cover,
 * records a green for each pass and refutes the green of each failure, and
 * writes a hang report for a run the wall clock killed (#1427).
 *
 * Extracted from work-driver-verify-verify-cmd.ts (AGENTS.md §12 size cap) as a
 * pure move: the outputs are the caller's arrays, mutated in place exactly as
 * the inline loop did, so the consolidated leg reads the same values.
 */
import path from "node:path";
import { withVerifySlot } from "./host-resources.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { depsHintApplies } from "./work-driver-corrective-decide.ts";
import { missingDepsFailure } from "./work-driver-deps-gate.ts";
import { provisionDepsHint } from "./work-driver-deps-hint.ts";
import {
  type GateHangPathSink,
  type HangProcess,
  captureProcessTree,
} from "./work-driver-gate-hang.ts";
import { TIER_KNOB } from "./work-driver-verify-budget.ts";
import {
  type KilledGateRun,
  formatExecError,
  isTimedOutKill,
  verifyHangFailure,
} from "./work-driver-verify-develop-helpers.ts";
import { failedVerifyCmd } from "./work-driver-verify-fast.ts";
import { slugName, writeGateHangLog } from "./work-driver-verify-flake.ts";
import { greenForWorktree } from "./work-driver-verify-gate-reuse.ts";
import { execp } from "./work-driver-verify.ts";
import type { WorkstreamGreen } from "./workflow-state-schema-gate-reuse.ts";
import type { WorkState } from "./workflow-state.ts";

/** Run the verify command in each of `run`'s worktrees (see the header). */
export async function runPerWorktreeVerify(opts: {
  run: readonly string[];
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  cmd: string;
  ctx: CycleContext;
  state: WorkState;
  worktrees: Record<string, string>;
  suiteTimeoutMs: number;
  passTimeoutMs: number;
  walkProcessTree?: (leaderPid: number) => {
    processes: HangProcess[];
    treeUnavailable?: string;
  };
  hangSink?: GateHangPathSink;
  suiteTimeoutKnob?: string;
  fastTimeoutMs?: number;
  perWorktreeVerifyFailures: string[];
  /** #1667 \u2014 the same failures, each with the cwd it ran in. */
  perWorktreeRecords: Array<{ cwd: string; text: string }>;
  greensRecorded: Array<[string, WorkstreamGreen]>;
  greensRefuted: string[];
}): Promise<void> {
  const {
    execFn,
    cmd,
    ctx,
    state,
    worktrees,
    suiteTimeoutMs,
    passTimeoutMs,
    hangSink,
    suiteTimeoutKnob,
    fastTimeoutMs,
    perWorktreeVerifyFailures,
    perWorktreeRecords,
    greensRecorded,
    greensRefuted,
  } = opts;

  // #1427 — the scratch dir a killed run's hang report is persisted to, created
  // lazily by the write. Named once here so the per-worktree loop and the
  // consolidated run below share one location (the consolidated run's own logs
  // already live there).
  const hangScratchDir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
  const hangTimestamp = new Date().toISOString();
  // The walker every hang report of this run uses — the injected one in tests,
  // the real `ps` walk in production. Read once so both seams below take the
  // same branch.
  const walker = opts.walkProcessTree ?? captureProcessTree;
  // The per-run discriminator in the report's filename: the workstream whose
  // worktree this gate ran in. `changedWorktrees` are worktree paths, so the
  // basename is the nearest stable identity, with the cwd's own slug as the
  // fallback when the map is sparse.
  const slugFor = (cwd: string): string => {
    const id = Object.keys(worktrees).find((k) => worktrees[k] === cwd);
    return slugName(id ?? path.basename(cwd));
  };
  for (const cwd of opts.run) {
    const depsMissing = await missingDepsFailure(execFn, state, ctx.repoRoot, cwd, cmd); // #1146
    if (depsMissing !== undefined) {
      perWorktreeVerifyFailures.push(depsMissing);
      perWorktreeRecords.push({ cwd, text: depsMissing });
      // Not run, so any green this worktree held proves nothing now.
      const id = Object.entries(state.pipelineState.worktrees ?? {}).find(
        ([, w]) => w === cwd,
      )?.[0];
      if (id !== undefined) greensRefuted.push(id);
      continue;
    }
    try {
      await withVerifySlot(() =>
        execFn(cmd, {
          cwd,
          timeout: suiteTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        }),
      );
      // The command passed: record the green for the tree it just read. Read
      // NOW, at the moment of the pass — a later read could describe content
      // that appeared after the command finished, and a green pointing at
      // content nothing tested is the one failure this seam must not have.
      const id = Object.entries(state.pipelineState.worktrees ?? {}).find(
        ([, w]) => w === cwd,
      )?.[0];
      if (id !== undefined) {
        const green = await greenForWorktree(ctx.verifyExecFn ?? execp, cwd, cmd, passTimeoutMs);
        if (green !== undefined) greensRecorded.push([id, green]);
      }
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        timedOutKill?: boolean;
        overflow?: string;
        treePid?: number;
        /** #1324 — set by `withFastTier` on a fast-tier rejection. */
        fastTier?: string;
      };
      // A missing `node_modules` looks like a real defect; in a fresh worktree say so.
      // #1005 — per-worktree failures stay failures; the consolidated run adds its own.
      const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      // #1667 \u2014 suppressed when assertion lines were extracted (see depsHintApplies).
      const depsHint = depsHintApplies(output) ? provisionDepsHint(state, cwd) : "";
      const ran = failedVerifyCmd(e, cmd); // #1324 — the fast tier, when it is the one that failed
      const cwdSlug = slugFor(cwd);
      // #1427 — a run the wall clock killed gets a hang report: the test names
      // the runner had already flagged, the gate's process tree, and its output
      // tail. Built ONLY for a timeout kill — an ordinary failing run pays
      // nothing, and a maxBuffer overflow (also a `killed` run) claims nothing
      // about processes it never stalled on.
      const hung = isTimedOutKill(e);
      // ONE walk per killed run: the snapshot is captured here, in the window
      // where the group may still be alive, and handed to BOTH the report and
      // the failure-string clause so they cannot disagree (#1427 fix round —
      // they used to walk separately and could report different process sets
      // for one kill).
      const killedTree = hung && typeof e.treePid === "number" ? walker(e.treePid) : undefined;
      const hang: KilledGateRun | undefined = hung
        ? {
            output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`,
            cmd: ran,
            cwd,
            timeoutMs: suiteTimeoutMs,
            ...(killedTree !== undefined ? { tree: killedTree } : {}),
          }
        : undefined;
      if (hang !== undefined) {
        const logPath = writeGateHangLog(
          hangScratchDir,
          hangTimestamp,
          {
            output: hang.output,
            cmd: hang.cmd,
            cwd: hang.cwd,
            timeoutMs: hang.timeoutMs,
            ...(typeof e.treePid === "number" ? { leaderPid: e.treePid } : {}),
            ...(killedTree !== undefined
              ? {
                  processes: killedTree.processes,
                  treeUnavailable: killedTree.treeUnavailable,
                }
              : {}),
          },
          // The name says WHICH run this report belongs to: a fan-out kills one
          // gate run per workstream and they must not overwrite each other.
          { tag: cwdSlug },
        );
        if (logPath !== undefined) {
          // #1427 round 3/4 — recorded on THIS gate call's sink, not on `ctx`:
          // the context is cycle-scoped and the three cap sites are three
          // separate gate CALLS, which is what let a late cap name an early
          // run's file. Pushed directly — the recorder it used to call had one
          // reader, a test, and no other caller.
          if (hangSink !== undefined) {
            hangSink.gateHangLogPaths = [...(hangSink.gateHangLogPaths ?? []), logPath];
          }
        }
      }
      const failureText = formatExecError(
        e,
        // #1427 round 3 — `verifyHangFailure` APPENDS the clause after the
        // whole #1324 sentence, so a wide clause costs the names rather than
        // the `[verify-timeout]` marker the cap router keys on.
        verifyHangFailure(
          ran,
          `in ${cwd}`,
          suiteTimeoutMs,
          hang,
          // #1509 — name the knob that governs the tier that actually timed
          // out. `ran` is the fast tier when the fast run is what hung, and
          // the caller resolved that tier's bound; the knob travels with the
          // tier rather than being guessed from the command string.
          e.fastTier === undefined
            ? (suiteTimeoutKnob ?? TIER_KNOB.suite)
            : fastTimeoutMs === undefined
              ? (suiteTimeoutKnob ?? TIER_KNOB.suite)
              : TIER_KNOB.fast,
        ),
        `verify command \`${ran}\` failed in ${cwd}${depsHint}`,
      );
      perWorktreeVerifyFailures.push(failureText);
      perWorktreeRecords.push({ cwd, text: failureText });
      // A green this workstream held describes the tree it had then. The
      // command just failed — on that tree or the one it holds now — so the
      // record is no evidence of anything and the next pass must run.
      const failedId = Object.entries(state.pipelineState.worktrees ?? {}).find(
        ([, w]) => w === cwd,
      )?.[0];
      if (failedId !== undefined) greensRefuted.push(failedId);
    }
  }
}
