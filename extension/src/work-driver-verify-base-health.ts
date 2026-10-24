/**
 * work-driver-verify-base-health — the base-commit probe the develop gate
 * attributes a red base from, and the rules that make it affordable.
 *
 * Why the probe exists (#1765). A cycle learned a red base only AFTER develop:
 * `compareWithBaseline` is paid for by the develop gate's post-run half
 * (`work-driver-verify-aggregate.ts`), so a base whose verify command is already
 * red cost one measured cycle three develop rounds of 4909 s, 6883 s and 8211 s
 * before one probe said "no change can pass it". The probe runs the project's
 * verify command once on a clean checkout of `baseSha`; its GREEN verdict is
 * cached across cycles keyed by (baseSha, command, tier bound), because the probe
 * is a full suite run (7 m 24 s on this repo) and per-cycle probing would tax
 * every healthy cycle. A RED is never cached — each cycle re-probes, so one flaky
 * red cannot speak for cycles it did not run in.
 *
 * Where it runs now. The green cache's key is the EXACT (baseSha, command, bound)
 * triple and the file holds ONE record, so on a mainline that merges 10-20 PRs a
 * day it is cold on essentially every cycle: awaiting the probe in the branch step
 * paid a full verify run — measured median 711 s — to buy a zero-developer park on
 * the ~2 % of runs whose base is red. So the branch step now REGISTERS the probe
 * (`startBaseHealthProbeAtBranch`, through the single-flight registry in
 * `work-driver-base-health-inflight.ts`) and returns without awaiting it. The
 * develop gate consults it only when its own verify has already failed — the same
 * condition that already pays for `compareWithBaseline` — and a red base is
 * attributed there as `verify-baseline-red:develop`, which already carries the
 * right handoff prose. No new cap; a passing cycle pays the probe nothing.
 *
 * `applyBaseHealthProbe` is a PURE VERDICT PRODUCER: it takes the command and the
 * key, writes only the repo-level cache file, and touches no workflow state. The
 * state-mutating form the branch step used to await is gone, because a background
 * task appending to the cycle's state would race the develop step's own writes. The
 * operator-visible record of a probe therefore lives where the verdict is consumed:
 * `recordDevelopGateEvents` (in `work-driver-verify-events.ts`) appends the note and
 * the driver-completed event for the consultation the develop gate performed, and a
 * probe nobody consulted is reported by a trace line.
 *
 * Mixed failure sets (#1765, unchanged). A `[baseline-red]` entry that names the
 * verify command the probe re-ran wins the cap whatever else sits beside it; every
 * other entry stays a failure on the change. The no-verdict families (timeout,
 * host exhaustion, build residue) keep precedence — see `verifyCapFor`.
 *
 * What this module never does: it never turns a failure into a pass, never parks
 * on `unknown`, and never reads a malformed cache as green. The whole seam is
 * wrapped: an executor or `fs` read that THROWS is the same `unknown` as a probe
 * that reached no verdict — a probe that could not run established nothing, and
 * parking on it would be the driver failing a cycle for its own plumbing.
 *
 * How long a GREEN is trusted: indefinitely, for its exact key — an immutable
 * commit, so only a different command or bound could judge it differently, and both
 * are in the key. What a green skips is the probe; the develop step still judges the
 * change. An expiry would re-pay a full suite run to re-learn a fixed fact.
 *
 * The switch reads (`baseHealthProbeEnabled`) are exported from
 * `work-driver-verify-pr17.ts`, beside `verifyGateEnabled` — a second copy of that
 * read in a second module is how one gate grows two switches. With
 * `PI_ENSEMBLE_DEVELOP_BASELINE_PROBE=0` the branch step registers nothing and the
 * develop gate's post-failure `compareWithBaseline` answers for the base: the
 * pre-#1765 cost model.
 *
 * Import direction (#1765 lens round 1): this module imports
 * `work-driver-verify-baseline.ts` and NOTHING imports this module from there. The
 * verdict record and its read rules sit in the schema leaf both sides import
 * (`workflow-state-schema-base-health.ts`), because a cycle in the module graph
 * loads differently depending on which seam is entered first.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./secret-patterns.ts";
import { trace } from "./trace.ts";
import { peekBaseHealthProbe, startBaseHealthProbe } from "./work-driver-base-health-inflight.ts";
import type { CycleContext, DriverExecFn } from "./work-driver-context.ts";
import { developTierTimeouts } from "./work-driver-verify-budget.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { isValidSha } from "./work-driver-verify-develop-helpers.ts";
import { baseHealthProbeEnabled } from "./work-driver-verify-pr17.ts";
import type { BaseHealthKey, BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
import { matchingVerdict } from "./workflow-state-schema-base-health.ts";
import { type WorkState, workStateDir } from "./workflow-state.ts";

// The record type and the key's own reader have their home in the schema leaf
// (it is what the state file carries, and what the develop gate's reuse reads);
// re-exported so every consumer of the probe reads one name.
export type { BaseHealthKey, BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
export { baseHealthKey, matchingVerdict } from "./workflow-state-schema-base-health.ts";
// The registry is the probe's other half: the branch step registers through it and
// the develop gate reads through it, so neither has to know the other exists.
export {
  awaitInflightBaseHealth,
  type BaseHealthInFlight,
} from "./work-driver-base-health-inflight.ts";
// The two prose readers are re-exported so the develop gate and the cause seams
// read them from the probe module they already know.
export { baselineRedForCmd, baselineRedForCommand } from "./work-driver-verify-base-park.ts";
// The arms a probe can reach live in the run leaf (the file-size split); the
// outcome shape is re-exported so every consumer still reads one name. The run
// leaf owns the `unknown` outcome too — it is module-private there now, because
// the only honest producer of an `unknown` is the arm that reached no verdict.
import {
  type BaseHealthProbeOutcome,
  runBaseHealthProbe,
  skippedProbeOutcome,
} from "./work-driver-verify-base-health-run.ts";
export type { BaseHealthProbeOutcome } from "./work-driver-verify-base-health-run.ts";

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
 * produces a key that matches nothing rather than throwing, which is what keeps
 * "could not read" and "does not match" the same answer.
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
 * Write the cross-cycle cache. True when the record landed, false when the write
 * faulted — a failed write costs a later re-probe and nothing else, which is why
 * the fault is swallowed. The boolean keeps that swallowing honest: a GREEN the
 * probe could not record is no verdict, because the verdict the develop gate
 * holds answers for the cycle's key exactly as the file would.
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
 * `baselineRedForCmd`) and the evidence an established RED carries
 * (`baseHealthRedEvidence`) live in `work-driver-verify-base-park.ts`, a leaf the
 * probe imports; the probe module re-exports the two readers so every consumer
 * still reads one name.
 */

/** The verdict a cycle holds already, read through the key's one shape rule. */
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
 * The probe itself, as a PURE VERDICT PRODUCER: it takes the command and the key,
 * consults the cache, runs the project's command at the base commit when the cache
 * cannot answer, and writes ONLY the repo-level cache file. It never touches
 * workflow state — that is what lets the branch step run it in the background
 * without racing the develop step's writes.
 *
 * Everything it cannot establish is a note, never a verdict; an established red
 * comes back with its rendered evidence and is NEVER cached. The added suite run is
 * disclosed in a trace line. A probe already running for this exact key (another
 * cycle on the same base got there first) is JOINED rather than duplicated: one
 * suite run, one cache write.
 */
export async function applyBaseHealthProbe(
  execFn: DriverExecFn,
  ctx: CycleContext,
  state: WorkState,
  cmd: string | undefined,
  /**
   * The key the probe answers for. The branch step resolves it once (command +
   * tier bound) and registers under it; the develop gate looks up by its OWN key,
   * and a mismatch means "a different run", which takes the re-probe arm.
   */
  key: BaseHealthKey,
): Promise<BaseHealthProbeOutcome> {
  if (cmd === undefined || cmd === "") {
    // `cmd` is only ever undefined when `applyBaseHealthProbe` is called directly
    // (a test, or the develop gate's own re-probe). The branch-step path refuses to
    // register without one, so a probe that got this far always has a command.
    return skippedProbeOutcome("no verify command — nothing to probe");
  }
  if (!baseHealthProbeEnabled()) {
    return skippedProbeOutcome(
      "pre-develop probe disabled (PI_ENSEMBLE_DEVELOP_BASELINE_PROBE=0 or PI_ENSEMBLE_VERIFY=0)",
    );
  }
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
        tierBoundMs: key.tierBoundMs,
        reason: "no readable baseSha on the state",
      },
      notes: ["base-health: baseSha unreadable — probe not run, the cycle proceeds"],
    };
  }
  // Joined rather than duplicated: a probe for this identical key is already in
  // flight, so its verdict — the same one the cache read below would have returned
  // once it landed — is awaited instead of a second suite run.
  const shared = peekBaseHealthProbe(key);
  if (shared !== undefined) {
    return await shared;
  }
  const hit = await cachedBaseHealth(state, ctx.repoRoot, key);
  if (hit.verdict !== undefined && hit.verdict.status === "green") {
    // Only a GREEN verdict crosses cycles. A cached red never answers for a cycle
    // it did not run in, so it is not read here at all.
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
  return await runBaseHealthProbe(execFn, ctx, baseSha, cmd, key);
}

/**
 * Register the base probe for this cycle without awaiting it — the branch step's
 * only base-health work, reached by BOTH branch paths (mechanized, ops fallback)
 * through `probeBaseAtBranch` and nothing else, so the two cannot drift into two
 * probe policies.
 *
 * The command and the tier bound together are the probe's IDENTITY, so both are
 * resolved here, on the caller's thread: they are cheap (one small file, one tier
 * resolution), and resolving them up front is what lets the branch step register
 * under an EXACT key the develop gate can compare its own against. Everything that
 * can take minutes happens inside the thunk below.
 *
 * The promise this returns NEVER rejects — the registry folds every fault into an
 * unknown-shaped outcome — so a caller may register and drop it without an
 * unhandled rejection, which is exactly what the branch step does.
 *
 * Nothing is registered when there is nothing to probe (#1809 fix round). With no
 * verify command, or an unusable `baseSha`, the old shape registered a SENTINEL —
 * `{command: "", tierBoundMs: 0}` — which no gate's own key could ever match, so it
 * sat in the registry for the length of a settle answering for no run at all. The
 * reason is traced instead and the registry keeps only probes that exist.
 */
function redactedProbeFault(err: unknown): string {
  // Bounded, and bounded HERE: this text lands in an operator-visible trace, and
  // an executor message is untrusted child output. Redaction runs BEFORE the
  // slice, so a secret cut in half by the bound cannot survive the cut.
  return redactSecrets(String((err as Error)?.message ?? err)).text.slice(0, 200);
}

export function startBaseHealthProbeAtBranch(
  execFn: DriverExecFn,
  ctx: CycleContext,
  state: WorkState,
): Promise<BaseHealthProbeOutcome | undefined> {
  // Resolved on THIS thread and handed to the thunk, so the promise the branch
  // step drops has no synchronous filesystem step in front of it: a caller that
  // never awaits cannot observe a rejection from one.
  const cmdAtEntry = verifyCmdFor(ctx.repoRoot);
  const baseSha = state.pipelineState.baseSha ?? "";
  const register = (cmd: string | undefined) => {
    if (cmd === undefined || cmd === "" || !isValidSha(baseSha)) {
      // Nothing to register (#1809 fix round): no command, or no base to check
      // out. The old shape registered a SENTINEL key no gate could ever match, so
      // the reason was reported from the probe's own skipped outcome — which is
      // what `applyBaseHealthProbe` still produces, and what this returns rather
      // than `undefined`. The registry, which is the only thing that must stay
      // free of keys answering for no run, gets nothing; the caller still reads
      // why. `applyBaseHealthProbe` never runs here, so a skipped outcome costs no
      // filesystem read and no suite run.
      const why =
        cmd === undefined || cmd === ""
          ? "no verify command — nothing to probe"
          : "no readable baseSha on the state";
      trace(`work-driver: base-health — ${why} for issue ${ctx.issue}; no base probe registered`);
      return Promise.resolve(skippedProbeOutcome(why));
    }
    return developTierTimeouts(ctx.repoRoot)
      .then((tiers) => {
        // The bound this key carries IS the kill bound the probe's own exec runs
        // under: it reaches `runBaseHealthProbe` as `key.tierBoundMs` and from
        // there `probeBaselineVerify`'s `timeoutMs` (work-driver-verify-baseline.ts
        // passes it as the exec's `timeout`). Producer and consumer cannot disagree.
        const key: BaseHealthKey = { baseSha, command: cmd, tierBoundMs: tiers.suite };
        return startBaseHealthProbe(key, () => applyBaseHealthProbe(execFn, ctx, state, cmd, key));
      })
      .catch((err: unknown): BaseHealthProbeOutcome => {
        const message = redactedProbeFault(err);
        trace(`work-driver: base-health — probe could not start: ${message}`);
        return {
          ran: false,
          notes: [`base-health: probe could not start (${message})`],
        };
      })
      .then((outcome) => {
        if (outcome === undefined) return undefined;
        // The probe's own report, for the case nobody consulted it (a passing
        // develop): a trace line, never state, because writing state from here
        // would race the develop step. The verdict a consulted probe produced is
        // recorded by `aggregateVerifyOutcome`, which is the only writer.
        trace(
          `work-driver: base-health — background probe for issue ${ctx.issue} settled: ran=${String(outcome.ran)}, verdict=${outcome.verdict?.status ?? "none"}${outcome.ms === undefined ? "" : `, ms=${outcome.ms}`}`,
        );
        return outcome;
      });
  };
  return cmdAtEntry
    .then((cmd) => register(cmd))
    .catch((err: unknown): BaseHealthProbeOutcome => {
      const message = redactedProbeFault(err);
      trace(`work-driver: base-health — probe could not start: ${message}`);
      return {
        ran: false,
        notes: [`base-health: probe could not start (${message})`],
      };
    });
}

/**
 * The branch step's whole base-health seam, in one call: register the probe
 * beside develop and return. Both branch paths (mechanized, ops fallback) call
 * this and nothing else, so the two cannot drift into two probe policies.
 *
 * The step does NOT await the probe — its wall clock is two cheap config reads,
 * not a suite run — and it no longer parks on a red base, which the develop gate
 * attributes as `verify-baseline-red:develop` instead. The operator's record of
 * what the probe found therefore does NOT live here (nobody knows it yet); the
 * develop gate records it when it consults the verdict, and a probe nobody
 * consulted is reported by the trace line `startBaseHealthProbeAtBranch` leaves
 * on settle.
 *
 * Nor can this throw: `startBaseHealthProbeAtBranch` folds its own faults into
 * the promise it returns, so a background fault can neither take the step down
 * nor stop the step recording that it kicked a probe off.
 */
export function probeBaseAtBranch(
  execFn: DriverExecFn,
  ctx: CycleContext,
  state: WorkState,
): WorkState {
  startBaseHealthProbeAtBranch(execFn, ctx, state);
  return state;
}
