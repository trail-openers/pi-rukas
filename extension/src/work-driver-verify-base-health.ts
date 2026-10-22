/**
 * work-driver-verify-base-health — #1765: ask the base commit before paying
 * for a develop round, and let a red base win a mixed failure set.
 *
 * Two defects, one module.
 *
 * (1) The cycle learned a red base only AFTER develop. `compareWithBaseline`
 * is paid for by the develop gate's post-run half
 * (`work-driver-verify-aggregate.ts`), so a base whose verify command is
 * already red cost orchard three develop rounds of 4909 s, 6883 s and 8211 s
 * before one probe said "no change can pass it". So the branch step — the
 * earliest step whose state carries `baseSha` — probes the base ONCE and
 * parks `verify-baseline-red:branch` with zero developer dispatches. The
 * green verdict is cached across cycles, keyed by (baseSha, command, tier
 * bound): the probe is a full suite run (7 m 24 s on this repo), so per-cycle
 * probing would tax every healthy cycle, and orchard ran several cycles and
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
 * parks on `unknown`, and never reads a malformed cache as green.
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
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { CycleContext, DriverExecFn } from "./work-driver-context.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import {
  BASELINE_RED_MARKER,
  type RedBaselineVerdict,
  baselineRedMessage,
  isRedBaseline,
  probeBaselineVerify,
} from "./work-driver-verify-baseline.ts";
import { developTierTimeouts } from "./work-driver-verify-budget.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { isValidSha } from "./work-driver-verify-develop-helpers.ts";
import { summaryCount } from "./work-driver-verify-names.ts";
import { baseHealthProbeEnabled } from "./work-driver-verify-pr17.ts";
import type { BaseHealthVerdict, TierBoundMs } from "./workflow-state-schema-base-health.ts";
import { type WorkState, appendEvent, workStateDir } from "./workflow-state.ts";

// The record type has its home in the schema module (it is what the state file
// carries); re-exported so every consumer of the probe reads one name.
export type { BaseHealthVerdict, TierBoundMs } from "./workflow-state-schema-base-health.ts";

/**
 * The probe's identity: the three things that must all match before a verdict
 * recorded earlier may be trusted. A moved base, a different command or a
 * different bound each judge a different run, so each forces a re-probe.
 */
export function baseHealthKey(v: {
  baseSha: string;
  command: string;
  tierBoundMs: TierBoundMs;
}): string {
  return `${v.baseSha}\u0000${v.command}\u0000${v.tierBoundMs}`;
}

/**
 * A verdict whose shape we can reason about. Anything else is re-probe, never
 * green. An `at` field on an older cache file is IGNORED, not required: the
 * record no longer carries one (see the module header's trust rule), and a
 * cache written by an earlier build must stay readable rather than force a
 * suite re-run for a field nothing reads.
 */
function usableVerdict(raw: unknown): BaseHealthVerdict | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.status !== "green" && v.status !== "red" && v.status !== "unknown") return undefined;
  if (typeof v.baseSha !== "string" || v.baseSha === "") return undefined;
  if (typeof v.command !== "string" || v.command === "") return undefined;
  if (typeof v.tierBoundMs !== "number" || !Number.isFinite(v.tierBoundMs) || v.tierBoundMs <= 0)
    return undefined;
  const verdict: BaseHealthVerdict = {
    status: v.status,
    baseSha: v.baseSha,
    command: v.command,
    tierBoundMs: v.tierBoundMs,
  };
  if (typeof v.reason === "string") verdict.reason = v.reason;
  return verdict;
}

/**
 * The one read rule for the in-state copy: a verdict that still describes the
 * run we would perform. `undefined` means "re-probe", including for a record
 * this build cannot read.
 */
export function matchingVerdict(
  raw: unknown,
  key: { baseSha: string; command: string; tierBoundMs: TierBoundMs },
): BaseHealthVerdict | undefined {
  const v = usableVerdict(raw);
  return v !== undefined && baseHealthKey(v) === baseHealthKey(key) ? v : undefined;
}

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
  const record = parsed as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null) return undefined;
  return usableVerdict(record.verdict);
}

/** Write the cross-cycle cache. A failed write costs a later re-probe, nothing else. */
export async function writeBaseHealthCache(
  write: (file: string, contents: string) => Promise<void>,
  repoRoot: string,
  verdict: BaseHealthVerdict,
): Promise<void> {
  try {
    await write(baseHealthCacheFile(repoRoot), `${JSON.stringify({ verdict }, null, 2)}\n`);
  } catch (err) {
    trace(`work-driver: base-health cache write failed: ${(err as Error).message?.slice(0, 160)}`);
  }
}

/**
 * Whether a probe entry attributes to `cmd`: it LEADS with the `[baseline-red]`
 * marker AND names the verify command the probe re-ran, in backticks, from
 * either arm of `baselineRedMessage`. The marker is required, not decorative:
 * the `red-timed-out` arm leads with `[baseline-red] [verify-timeout]`, so a
 * bare `[verify-timeout]` entry — a fast-tier, smoke or consolidated run the
 * gate itself killed at its bound — names no base at all and must not read as
 * the base being red. Position of the COMMAND decides nothing (the timed-out
 * arm puts it after both labels); position of the MARKER decides everything.
 * `verifyCapFor` still routes a killed run's own timeout, host-exhaustion or
 * residue entry ahead of this claim, so its precedence is untouched.
 */
export function baselineRedForCommand(failure: string, cmd: string): boolean {
  return failure.startsWith(BASELINE_RED_MARKER) && failure.includes(`\`${cmd}\``);
}

/**
 * The develop gate's mixed-set rule, over the whole failure list: at least one
 * `[baseline-red]` entry names `cmd`. Position decides nothing; the entries
 * beside it are the caller's business (secondary evidence), and `verifyCapFor`
 * still routes a timeout, host-exhaustion or residue entry ahead of this one —
 * so a `[baseline-red]` beside a `[verify-timeout]` stays `verify-timeout`.
 */
export function baselineRedForCmd(failures: readonly string[], cmd: string): boolean {
  return failures.some((f) => baselineRedForCommand(f, cmd));
}

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

type BaseHealthKey = { baseSha: string; command: string; tierBoundMs: TierBoundMs };

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
  const notes: string[] = [];
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
  const tierBoundMs = (await developTierTimeouts(ctx.repoRoot)).suite;
  const key = { baseSha, command: cmd, tierBoundMs };
  const hit = await cachedBaseHealth(state, ctx.repoRoot, key);
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
  const verdict: BaseHealthVerdict = {
    status: isRedBaseline(probe) ? "red" : probe.status === "green" ? "green" : "unknown",
    baseSha,
    command: cmd,
    tierBoundMs,
    ...(probe.status === "unknown" ? { reason: probe.reason } : {}),
  };
  if (isRedBaseline(probe)) {
    // Deliberately NOT cached across cycles: the next cycle re-probes before it
    // parks, so one flaky red cannot park cycles it never ran in.
    //
    // The verdict is recorded on the state HERE, in the same append that raises
    // the park: a red is the one verdict whose record must survive the park,
    // because `probeBaseAtBranch` returns this state as the step's state and
    // the handoff names the verdict it parked on. A `red` that reached the
    // caller without it would be a park with no record behind it.
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
    await writeBaseHealthCache(
      async (file, contents) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents, "utf8");
      },
      ctx.repoRoot,
      verdict,
    );
    return { ran: true, verdict, notes: [`base-health: base ${baseSha.slice(0, 12)} is GREEN`] };
  }
  return {
    ran: true,
    verdict,
    notes: [
      `base-health: not established — ${verdict.reason ?? "the probe reached no verdict"}; the cycle proceeds`,
    ],
  };
}

/**
 * The branch step's whole base-health seam, in one call: resolve the project's
 * verify command, probe it at `baseSha`, record the verdict on the state, and
 * park `verify-baseline-red:branch` on an established red. Both branch paths
 * (mechanized, ops fallback) call this and nothing else, so the two cannot
 * drift into two probe policies. Notes land in the event log as the step's
 * `step-completed` summary tail rather than as a new event kind.
 */
export async function probeBaseAtBranch(
  execFn: DriverExecFn,
  ctx: CycleContext,
  state: WorkState,
): Promise<WorkState> {
  const cmd = await verifyCmdFor(ctx.repoRoot);
  const outcome = await applyBaseHealthProbe(execFn, ctx, state, cmd);
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
        startedAt: Date.now(),
        now: Date.now(),
      }),
    );
  }
  return next;
}

/**
 * The branch step's park on a red base: `verify-baseline-red:branch`, cause
 * class environment (the cause table routes on the marker in the evidence),
 * and NO develop dispatch — the probe builds it and `probeBaseAtBranch`
 * returns it as the step's state, so the router reads the trailing cap-hit as
 * its own routing to `handoff`. The probe tree is already gone:
 * `probeBaselineVerify` removes it in its own `finally`. The evidence carries
 * the gate's own tally when the loop printed one, so the operator sees which
 * suite broke rather than only that it did.
 */
function baseHealthPark(
  state: WorkState,
  verdict: BaseHealthVerdict,
  arm: RedBaselineVerdict,
): WorkState {
  const message = baselineRedMessage(arm, {
    cmd: verdict.command,
    baseSha: verdict.baseSha,
    timeoutMs: verdict.tierBoundMs,
    changeFailure: "",
  });
  const tally = arm.status === "red" ? summaryCount(arm.rawStream) : undefined;
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "verify-baseline-red:branch",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: `${message}${tally === undefined ? "" : `\nFailing at base: ${tally} test(s)`}`,
  });
}
