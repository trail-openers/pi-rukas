/**
 * work-driver-verify-base-health — #1765: ask the base commit before paying
 * for a develop round, and let a red base win a mixed failure set.
 *
 * Two defects, one module.
 *
 * (1) The cycle learned a red base only AFTER develop. `compareWithBaseline`
 * is paid for by the develop gate's post-run half
 * (`work-driver-verify-aggregate.ts`), so a base whose verify command is
 * already red cost tehas three develop rounds of 4909 s, 6883 s and 8211 s
 * before one probe said "no change can pass it". So the branch step — the
 * earliest step whose state carries `baseSha` — probes the base ONCE and
 * parks `verify-baseline-red:branch` with zero developer dispatches. The
 * green verdict is cached across cycles, keyed by (baseSha, command, tier
 * bound): the probe is a full suite run (7 m 24 s on this repo), so per-cycle
 * probing would tax every healthy cycle, and tehas ran several cycles and
 * attempts against one base. A RED verdict is never cached across cycles —
 * each cycle that would park re-probes first, so a flaky red cannot park
 * cycles it did not run in.
 *
 * (2) A mixed failure set mislabelled the red base as a code failure. The
 * develop gate fired `onBaselineRedOnly` only when the `[baseline-red]` entry
 * was the gate's ONLY failure (`failures.length === verifyCmdEnd`), so a
 * scope-fence or ratchet entry beside it produced `verify-failed:develop` —
 * the one cap a corrective round may earn. The rule here is attribution, not
 * position: a `[baseline-red]` entry that names the verify command the probe
 * re-ran wins the cap, and every other entry stays a failure on the change,
 * listed as secondary evidence. The no-verdict families (timeout, host
 * exhaustion, build residue) keep their precedence — see `verifyCapFor`.
 *
 * Both halves have one caller: `probeBaseAtBranch` (the branch step's only
 * base-health entry point) asks `applyBaseHealthProbe` and, when the outcome
 * carries a `park`, returns it. The park already carries the verdict recorded
 * on the state, so the caller cannot drop it. Nothing else reaches in, so
 * nothing else can park on a verdict the probe did not earn.
 *
 * What this module never does: it never turns a failure into a pass, never
 * parks on `unknown`, and never reads a malformed cache as green. The whole
 * seam is wrapped: an executor or a `fs` read that THROWS is the same
 * `unknown` as a probe that reached no verdict, because a probe that could not
 * run has not established anything about the base commit — and parking a cycle
 * on it would be the driver failing a cycle for its own plumbing.
 *
 * How long a GREEN is trusted: indefinitely, for its exact
 * (baseSha, command, tier bound) key. There is no age term and none is
 * needed. The commit a green was earned on is an immutable commit, so only a
 * different command or a different bound can judge it differently, and both
 * are in the key. What a green actually skips is only the branch probe: the
 * develop step runs its own verify gate on the change regardless, so a base
 * that went red under some other influence after the probe is caught there,
 * at the point where it costs a develop round rather than a whole cycle. An
 * expiry would re-pay a full suite run to re-learn a fact about a commit that
 * cannot change.
 *
 * The switch reads (`baseHealthProbeEnabled`) are exported from
 * `work-driver-verify-pr17.ts` rather than here: `verifyGateEnabled` — the
 * `PI_ENSEMBLE_VERIFY=0` read — lives there, and a second copy of that read
 * in a second module is how one gate grows two switches.
 *
 * Import direction (#1765 lens round 1): this module imports
 * `work-driver-verify-baseline.ts` and NOTHING imports this module from there.
 * The verdict record and its read rules (`BaseHealthVerdict`, `matchingVerdict`)
 * sit in the schema leaf both sides import, because a cycle between the probe
 * and the comparison it feeds is a module graph no reader can follow, and one
 * that loads differently depending on which seam is entered first.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { CycleContext, DriverExecFn } from "./work-driver-context.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import {
  baseHealthPark,
  baselineRedForCmd,
  baselineRedForCommand,
} from "./work-driver-verify-base-park.ts";
import {
  type RedBaselineVerdict,
  isRedBaseline,
  probeBaselineVerify,
} from "./work-driver-verify-baseline.ts";
import { developTierTimeouts } from "./work-driver-verify-budget.ts";
import { verifyChildEnv, verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { isValidSha } from "./work-driver-verify-develop-helpers.ts";
import { baseHealthProbeEnabled } from "./work-driver-verify-pr17.ts";
import type { BaseHealthKey, BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
import { matchingVerdict } from "./workflow-state-schema-base-health.ts";
import { type WorkState, appendEvent, workStateDir } from "./workflow-state.ts";

// The record type and the key's own reader have their home in the schema leaf
// (it is what the state file carries, and what the develop gate's reuse
// reads); re-exported so every consumer of the probe reads one name.
export type { BaseHealthKey, BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
export { baseHealthKey, matchingVerdict } from "./workflow-state-schema-base-health.ts";
// The two prose readers are re-exported so the develop gate and the cause seams
// read them from the probe module they already know.
export { baselineRedForCmd, baselineRedForCommand } from "./work-driver-verify-base-park.ts";

/** The repo-level cache file: driver-written runtime state beside the cycle files. */
export function baseHealthCacheFile(repoRoot: string): string {
  return path.join(workStateDir(repoRoot), "base-health.json");
}

/** Read the cross-cycle cache. Anything unreadable or malformed is "no entry". */
export async function readBaseHealthCache(
  read: (file: string) => Promise<string>,
  repoRoot: string,
): Promise<BaseHealthVerdict | undefined> {
  let raw: string;
  try {
    raw = await read(baseHealthCacheFile(repoRoot));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    trace(`work-driver: base-health cache is not JSON — re-probing ${repoRoot}`);
    return undefined;
  }
  const record = parsed as { verdict?: unknown } | null;
  if (typeof record !== "object" || record === null) return undefined;
  // The one shape rule is `matchingVerdict`'s; applied to the `verdict` member
  // with the key read back off that same member, so a cache this build cannot
  // read is "no entry" rather than a throw, and never a green.
  return matchingVerdict(record.verdict, keyOf(record.verdict));
}

/**
 * The key a stored record carries, read defensively: a malformed record
 * produces a key that matches nothing rather than throwing, which is what
 * keeps "could not read" and "does not match" the same answer.
 */
function keyOf(raw: unknown): BaseHealthKey {
  const v = raw as { baseSha?: unknown; command?: unknown; tierBoundMs?: unknown } | null;
  return {
    baseSha: typeof v?.baseSha === "string" ? v.baseSha : "",
    command: typeof v?.command === "string" ? v.command : "",
    tierBoundMs: typeof v?.tierBoundMs === "number" ? v.tierBoundMs : 0,
  };
}

/**
 * The one `unknown` this probe raises when it never got an answer from the
 * gate: the verdict that records the attempt, and the note that says so. Never
 * a park — a probe that could not run has established nothing, and the whole
 * cost model of this seam rests on that being cheap.
 */
function unknownVerdict(
  baseSha: string,
  cmd: string,
  tierBoundMs: number,
  why: string,
): BaseHealthProbeOutcome {
  const reason = `probe could not run (${why})`;
  return {
    ran: false,
    verdict: { status: "unknown", baseSha, command: cmd, tierBoundMs, reason },
    notes: [`base-health: ${reason}; the cycle proceeds`],
  };
}

/**
 * Write the cross-cycle cache. True when the record landed, false when the write
 * faulted — a failed write costs a later re-probe and nothing else, which is why
 * the fault is swallowed. The boolean keeps that swallowing honest: a GREEN the
 * probe could not record is no verdict, because the in-state copy answers for the
 * cycle's key exactly as the file would.
 */
export async function writeBaseHealthCache(
  write: (file: string, contents: string) => Promise<void>,
  repoRoot: string,
  verdict: BaseHealthVerdict,
): Promise<boolean> {
  try {
    await write(baseHealthCacheFile(repoRoot), `${JSON.stringify({ verdict }, null, 2)}\n`);
    return true;
  } catch (err) {
    trace(`work-driver: base-health cache write failed: ${(err as Error).message?.slice(0, 160)}`);
    return false;
  }
}

/**
 * The prose rules a probe entry is judged by (`baselineRedForCommand` /
 * `baselineRedForCmd`) and the park itself (`baseHealthPark`) live in
 * `work-driver-verify-base-park.ts`, a leaf the probe imports; the probe module
 * re-exports the two readers so every consumer still reads one name.
 */

/** What the probe did, as the branch step reports it. */
export interface BaseHealthProbeOutcome {
  /** Nothing ran (no command, a switch off, an unreadable base). */
  ran: boolean;
  verdict?: BaseHealthVerdict;
  /**
   * Set only on an established RED: the branch step's park, built here and
   * returned by `probeBaseAtBranch`, the only caller. It carries the verdict
   * the probe just earned, so a park cannot be reached from any other record.
   */
  park?: WorkState;
  /** A note for the operator: why nothing ran, or why the cache answered. */
  notes: string[];
}

/** An absent state field read as a verdict, so `matchingVerdict` can judge it. */
function inStateVerdict(state: WorkState, key: BaseHealthKey): BaseHealthVerdict | undefined {
  return matchingVerdict(state.pipelineState.baseHealthProbe, key);
}

/** A verdict recorded earlier for THIS run's key, in-state first, then the cache. */
export async function cachedBaseHealth(
  state: WorkState,
  repoRoot: string,
  key: BaseHealthKey,
): Promise<{ verdict?: BaseHealthVerdict; from: "state" | "cache" | undefined }> {
  const inState = inStateVerdict(state, key);
  if (inState !== undefined) return { verdict: inState, from: "state" };
  const cached = await readBaseHealthCache((file) => fs.readFile(file, "utf8"), repoRoot);
  const match = matchingVerdict(cached, key);
  return match !== undefined ? { verdict: match, from: "cache" } : { from: undefined };
}

/**
 * The branch step's pre-develop probe, called through ONE line from both
 * branch paths (mechanized and ops fallback) after `baseSha` and the worktrees
 * are on the state. Everything the probe cannot establish is a note, never a
 * park; only an established red reaches the caller as a `park` state it must
 * return. The added suite run is disclosed in a trace line.
 */
export async function applyBaseHealthProbe(
  execFn: DriverExecFn,
  ctx: CycleContext,
  state: WorkState,
  cmd: string | undefined,
): Promise<BaseHealthProbeOutcome> {
  const disabled = () =>
    ({
      ran: false,
      notes: [
        "base-health: pre-develop probe disabled (PI_ENSEMBLE_DEVELOP_BASELINE_PROBE=0 or PI_ENSEMBLE_VERIFY=0)",
      ],
    }) satisfies BaseHealthProbeOutcome;
  if (cmd === undefined || cmd === "") {
    return {
      ran: false,
      notes: ["base-health: no verify command — nothing to probe"],
    } satisfies BaseHealthProbeOutcome;
  }
  if (!baseHealthProbeEnabled()) return disabled();
  const baseSha = state.pipelineState.baseSha;
  if (!isValidSha(baseSha)) {
    // No base to check out: the probe would judge some other commit, which is
    // worse than judging nothing. Record it and let develop answer for itself.
    return {
      ran: false,
      verdict: {
        status: "unknown",
        baseSha: baseSha ?? "",
        command: cmd,
        tierBoundMs: 0,
        reason: "no readable baseSha on the state",
      },
      notes: ["base-health: baseSha unreadable — probe not run, the cycle proceeds"],
    };
  }
  // #1765 lens round 1/3 — an interrupt the cycle is already carrying is not a
  // verdict about the base commit. The runner aborts on SIGTERM / SIGINT / its
  // own `--timeout`, and a suite run started inside that window answers nothing
  // and would hold the branch step for the length of the bound. The listener is
  // registered at the top of the probe's own work — before the tier read, the
  // cache read, the suite run and the green write, each of which awaits — and
  // removed in the `finally` below, so an abort during any of them answers
  // `unknown`: never a park, never a green a later cycle would trust.
  const signal = ctx.signal;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const tierBoundMs = (await developTierTimeouts(ctx.repoRoot)).suite;
    const key = { baseSha, command: cmd, tierBoundMs };
    const hit = await cachedBaseHealth(state, ctx.repoRoot, key);
    if (aborted || signal?.aborted) {
      return unknownVerdict(baseSha, cmd, tierBoundMs, "the cycle was interrupted");
    }
    if (hit.verdict !== undefined && hit.verdict.status === "green") {
      // Only a GREEN verdict crosses cycles. A cached red never answers for a
      // cycle it did not run in, so it is not read here at all.
      trace(
        `work-driver: base-health — base ${baseSha.slice(0, 12)} GREEN (cached from ${hit.from}), no probe run`,
      );
      return {
        ran: false,
        verdict: hit.verdict,
        notes: [
          `base-health: reused the cached GREEN verdict for base ${baseSha.slice(0, 12)} (${hit.from}) — no suite run paid for`,
        ],
      };
    }
    trace(
      `work-driver: base-health — probing base ${baseSha.slice(0, 12)} with \`${cmd}\` (one extra suite run, bound ${(tierBoundMs / 60000).toFixed(0)} min)`,
    );
    const probe = await probeBaselineVerify(execFn, {
      repoRoot: ctx.repoRoot,
      baseSha,
      // A label the develop step's `baseline-verify-<issue>` tree can never
      // collide with: two seams sharing one throwaway checkout is how one step's
      // teardown removes the other's tree mid-run.
      issue: `branch-${ctx.issue}`,
      cmd,
      timeoutMs: tierBoundMs,
      env: verifyChildEnv(),
    });
    if (aborted || signal?.aborted) {
      return unknownVerdict(
        baseSha,
        cmd,
        tierBoundMs,
        "the cycle was interrupted while the probe ran",
      );
    }
    const timedOut = probe.status === "red-timed-out";
    const verdict: BaseHealthVerdict = {
      status: isRedBaseline(probe) ? "red" : probe.status === "green" ? "green" : "unknown",
      baseSha,
      command: cmd,
      tierBoundMs,
      ...(probe.status === "unknown" ? { reason: probe.reason } : {}),
      // The one field that says WHICH red this is. The develop gate's reuse
      // rebuilds its arm from this record, and a killed run has no stream, no
      // tally and no assertion to reason from — see `BaseHealthVerdict.timedOut`.
      ...(timedOut ? { timedOut: true as const } : {}),
    };
    if (isRedBaseline(probe)) {
      // Deliberately NOT cached across cycles: the next cycle re-probes before it
      // parks, so one flaky red cannot park cycles it never ran in. The verdict IS
      // recorded on the state here, in the same append that raises the park — a red
      // is the one verdict whose record must survive the park, because the handoff
      // names the verdict it parked on. The cache file stays untouched on this
      // path: one flaky red must not erase a green the same key earned, and the key
      // already says a green cannot answer for a different base, gate or budget.
      const parked = baseHealthPark(
        { ...state, pipelineState: { ...state.pipelineState, baseHealthProbe: verdict } },
        verdict,
        probe,
      );
      return {
        ran: true,
        verdict,
        park: parked,
        notes: [`base-health: base ${baseSha.slice(0, 12)} is RED — the gate was already red`],
      };
    }
    if (verdict.status === "green") {
      // The cache write is the green's EVIDENCE: it is what a later cycle reads back
      // instead of paying for the suite. `writeBaseHealthCache` swallows its own
      // fault (a failed write costs a later re-probe, nothing else), but it reports
      // whether the write landed, and a green that did not land is no verdict at
      // all — the in-state copy answers for this cycle's key exactly as the file
      // would. The canary is case 17 of `test-verify-baseline-attribution.ts`: with
      // this check removed it reports state green / cache absent.
      const recorded = await writeBaseHealthCache(
        async (file, contents) => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, contents, "utf8");
        },
        ctx.repoRoot,
        verdict,
      );
      if (!recorded) {
        return unknownVerdict(
          baseSha,
          cmd,
          tierBoundMs,
          "the green could not be recorded — the cache file was not written",
        );
      }
      // Checked AFTER the write: a green that landed while the cycle was being
      // torn down is a verdict nobody asked for, and the file behind it would
      // spare a later cycle a suite run this one never completed judging.
      if (aborted || signal?.aborted) {
        return unknownVerdict(baseSha, cmd, tierBoundMs, "the cycle was interrupted");
      }
      return { ran: true, verdict, notes: [`base-health: base ${baseSha.slice(0, 12)} is GREEN`] };
    }
    return {
      ran: true,
      verdict,
      notes: [
        `base-health: not established — ${verdict.reason ?? "the probe reached no verdict"}; the cycle proceeds`,
      ],
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The branch step's whole base-health seam, in one call: resolve the project's
 * verify command, probe it at `baseSha`, record the verdict on the state, and
 * park `verify-baseline-red:branch` on an established red. Both branch paths
 * (mechanized, ops fallback) call this and nothing else, so the two cannot
 * drift into two probe policies. Notes land in the event log as the step's
 * `step-completed` summary tail rather than as a new event kind, and that
 * event's `ms` is the probe's measured wall clock — a probe that ran the whole
 * suite must not report 0 ms as though it had run nothing.
 *
 * Nothing here may throw. `verifyCmdFor`, `developTierTimeouts` and the probe's
 * own executor each reach the filesystem or a child process, and this call sits
 * on the branch step's happy path: a throw would take the step down (and, on
 * the mechanized path, its `catch` treats a non-dirty failure as the fallback
 * decision) for a probe whose whole contract is "an extra opinion, never an
 * obstacle". So the seam is wrapped, and a failure degrades to the same note
 * an unrunnable probe already produces — state unchanged, no park, no green.
 */
export async function probeBaseAtBranch(
  execFn: DriverExecFn,
  ctx: CycleContext,
  state: WorkState,
): Promise<WorkState> {
  let outcome: BaseHealthProbeOutcome;
  // The probe's real duration: a branch step that spent seven minutes in one
  // suite run must not report 0 ms, because the event's `ms` is the only number
  // a reader of the log has for what the probe cost.
  const startedAt = Date.now();
  try {
    const cmd = await verifyCmdFor(ctx.repoRoot);
    outcome = await applyBaseHealthProbe(execFn, ctx, state, cmd);
  } catch (err) {
    // Bounded, and bounded HERE rather than through a shared helper: this text
    // lands in the event log and the handoff, and an executor message is
    // untrusted child output. A 200-char tail is the same bound the neighbouring
    // verify seams put on an exec rejection; naming `errText` here would pull the
    // whole develop-git module into the branch step's import graph for one slice.
    const message = String((err as Error)?.message ?? err).slice(0, 200);
    trace(`work-driver: base-health — probe could not run: ${message}`);
    // NO `verdict` on this outcome: the state keeps whatever it already held,
    // including a verdict from an earlier successful probe, which a synthesised
    // `unknown` would overwrite.
    outcome = {
      ran: false,
      notes: [`base-health: probe could not run (${message})`],
    };
  }
  if (outcome.park !== undefined) {
    trace(
      "work-driver: base-health — parking at verify-baseline-red:branch (no developer dispatched)",
    );
    return outcome.park;
  }
  let next: WorkState = outcome.verdict
    ? { ...state, pipelineState: { ...state.pipelineState, baseHealthProbe: outcome.verdict } }
    : state;
  if (outcome.notes.length > 0) {
    trace(`work-driver: base-health — ${outcome.notes.join("; ")}`);
    next = appendEvent(
      next,
      synthesizeDriverCompletion({
        step: "branch",
        label: "driver:base-health",
        summary: outcome.notes.join("; "),
        startedAt,
        now: Date.now(),
      }),
    );
  }
  return next;
}
