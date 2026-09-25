/**
 * lens-review-child — one lens's spawn + retry loop + result shaping,
 * split from lens-review.ts (AGENTS.md §12 file-size limit).
 *
 * `runLensReview` (lens-review.ts) maps `LENSES` over this; the batch
 * deck, dedup, verdict and cap-kill summary live in the parent.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { childHandles, registerChildHandle } from "./async-jobs-registry.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { extractFindings, lensPromptFor } from "./lens-review-format.ts";
import { LENS_REPORTER_PATH, type LensDef } from "./lens-review.ts";
import type { LensRunResult } from "./lens-review.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { readEnumMarker } from "./reply-markers.ts";
import type { SlowWatchInput } from "./slow-notice.ts";
import { feedSlowProgress, watchSlowDispatch } from "./slow-notice.ts";
import { spawnSpecialist } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { jitteredMs } from "./work-driver-failure-taxonomy.ts";

export const MAX_LENS_ATTEMPTS = 4;
const LENS_RETRY_BACKOFF_MS = 2_000;

export async function runLensChild(opts: {
  lens: LensDef;
  runId: string;
  skillsDir: string;
  context: string;
  /** #873 — the full parsed roster, so the prompt's other-lenses list is
   * derived from the data (a seventh lens appears with no code change). */
  roster: RosterEntry[];
  opts: {
    diff: string;
    cwd?: string;
    signal?: AbortSignal;
    evidence?: string;
  };
  bumpBatch: () => void;
  /** #799 — the parent pi for the slow-run watch's PM notice (the driver
   * threads its own; PM-driven lens runs pass nothing — the PM's
   * dispatch_peek already sees the lens's progress there). */
  pi?: SlowWatchInput["pi"];
}): Promise<LensRunResult> {
  const { lens, runId, skillsDir, context, bumpBatch } = opts;
  const runOpts = opts.opts;
  const roster = opts.roster;
  // #456 — the moment this lens began dispatching, so a serialised pass
  // (spawn cap 1) is diagnosable: sequential startMs mean queueing.
  const startMs = Date.now();
  const skillPath = path.join(skillsDir, lens.skill);
  // #872 — executed evidence the skill exists BEFORE spending a spawn on it.
  // `statSync` follows symlinks (the real skills dir holds symlinks into the
  // repo's skill/ per install.sh), so a dangling symlink throws ENOENT and
  // counts as missing. A missing skill is a setup failure, not a transient
  // one — spawning 4x would just burn timeouts on the same dead path.
  try {
    statSync(skillPath);
  } catch {
    bumpBatch();
    return {
      lens: lens.name,
      ok: false,
      ms: 0,
      startMs,
      findings: [],
      attempts: 0,
      blocked: true,
      parseError: `skill not installed: ${skillPath} (not spawned)`,
    };
  }
  const prompt = lensPromptFor(lens, runOpts.diff, context, runOpts.evidence, roster);
  const tag = lens.name.toLowerCase().replaceAll("_", "-");
  // Per-lens deck key. The dispatch deck (#117) is now the single live
  // surface — there used to be a parallel onUpdate callback rendering an
  // inline tool block, but the deck displays the same data so the inline
  // path was duplicative (#119).
  const deckKey = `${runId}/${tag}`;
  dispatchDeck.startEntry(deckKey, {
    label: `code-review-specialist[${tag}]`,
    role: "code-review-specialist",
    tag,
    batchKey: `${runId}/batch`,
  });
  // #799 — the slow-run watch for this lens child. The deck key is the id
  // dispatch_peek shows, so the PM notice names it and the operator can
  // peek/steer from the notice. `stopSlow` + handle cleanup land in the
  // finally at the bottom of this function.
  const slowRole = "code-review-specialist";
  const slowLabel = `code-review-specialist[${tag}]`;
  const stopSlow = watchSlowDispatch({
    id: deckKey,
    role: slowRole,
    label: slowLabel,
    ...(opts.pi ? { pi: opts.pi } : {}),
  });

  // Retry loop (#3). Up to MAX_LENS_ATTEMPTS attempts on transient
  // failure (spawn error OR non-zero exit). User abort (opts.signal)
  // breaks out immediately — that's the operator saying stop, not a
  // transient failure. Backoff between retries gives the provider /
  // local process spawner room to recover. The loop body is wrapped in
  // try/finally so `stopSlow()` + the deck/handle cleanup below run on
  // EVERY exit path — the comment above claims it, and a spawn-layer
  // throw used to skip all three of them.
  let attempts = 0;
  let result: DispatchResult | undefined;
  let lastError: string | undefined;
  try {
    while (attempts < MAX_LENS_ATTEMPTS) {
      attempts++;
      if (runOpts.signal?.aborted) {
        lastError = "aborted by user";
        break;
      }
      try {
        result = await spawnSpecialist(
          { role: "code-review-specialist", prompt, cwd: runOpts.cwd },
          {
            runId,
            tag,
            // Pin to this lens's skill + load the report_finding tool. `--no-extensions`
            // (set in spawn.ts) disables auto-discovery; `--extension <path>` still
            // loads explicit paths, so the reporter is the only extension in the child.
            extraArgs: ["--no-skills", "--skill", skillPath, "--extension", LENS_REPORTER_PATH],
            // No timeoutMs override — inherits spawn.ts's bounds: the 2h
            // wall-clock backstop (spawnBackstopMs, spawn-support.ts) and the
            // 25-min inactivity watchdog (inactivityTimeoutMs). No per-role
            // timeout exists; liveness, not wall clock, is the real signal.
            signal: runOpts.signal,
            onProgress: (state) => {
              dispatchDeck.updateEntry(deckKey, state);
              feedSlowProgress(deckKey, state);
            },
            onStdin: (stdin) =>
              // #799 — register the stdin against the DECK KEY (the id
              // dispatch_peek shows) so the child is steerable directly,
              // not only through the orchestrator's active-child path.
              registerChildHandle(deckKey, stdin, slowLabel, slowRole),
          },
        );
        if (result.ok) {
          lastError = undefined;
          break; // success
        }
        lastError = `attempt ${attempts}/${MAX_LENS_ATTEMPTS}: exit ${result.exitCode ?? "?"}`;
      } catch (err) {
        lastError = `attempt ${attempts}/${MAX_LENS_ATTEMPTS}: spawn failed: ${(err as Error).message}`;
      }
      // #543 no-retry-on-cap-kill: a loop / token-budget killed child is a
      // SELF-inflicted cap, never a transient failure. Re-spawning it would
      // just re-loop (the kill is the cap; the retry would undo it 4x).
      if (result && (result.killCause === "loop" || result.killCause === "token-budget")) {
        break;
      }
      // Backoff before next retry (skipped on last attempt to keep total
      // wall-clock bounded).
      if (attempts < MAX_LENS_ATTEMPTS) {
        // Jittered, not flat. Six lenses fail in lockstep whenever the cause
        // is a provider blip — which is the common case — so a fixed delay
        // retries all six at the same instant, i.e. a self-inflicted
        // thundering herd against the endpoint that just rate-limited us.
        // Reuses the driver's canonical jitter (#366) rather than adding a
        // second formula.
        await new Promise((r) => setTimeout(r, jitteredMs(LENS_RETRY_BACKOFF_MS)));
      }
    }
  } finally {
    // #799 — the slow watch + deck entry + child handle are released on
    // every exit path, as the comment above claims (success, cap-kill,
    // abort, or a throw from the spawn layer).
    dispatchDeck.clearEntry(deckKey);
    stopSlow();
    childHandles.delete(deckKey);
  }

  bumpBatch();

  // All attempts failed (or user aborted) — lens is blocked, no findings.
  if (!result || !result.ok) {
    return {
      lens: lens.name,
      ok: false,
      ms: result?.ms ?? 0,
      startMs,
      findings: [],
      attempts,
      blocked: true,
      parseError: lastError ?? "unknown failure",
      // #534 — a failed lens still flushes usage from whatever turns
      // completed before it died; count it like any other dispatch-failed.
      usage: result?.usage,
      ...(result?.killCause ? { killCause: result.killCause } : {}),
      ...(result?.killCause === "loop" && result.loopEvidence
        ? { loopEvidence: result.loopEvidence }
        : {}),
      ...(result?.killCause === "token-budget" && result.tokenBudget
        ? { tokenBudget: result.tokenBudget }
        : {}),
    };
  }

  const { findings, skipped } = extractFindings(result.toolUses, lens.name);
  // #872 — the child self-reports its skill load in the closing reply
  // (`Skill Load Status: SUCCESS|FAILED`, code-review-specialist.md). An
  // explicit FAILED blocks this lens — its verdict can never be APPROVED —
  // with its findings KEPT (the CRITICAL RULE in the role prompt allows a
  // FAILED-skill child to have reported content; that content is still
  // evidence). Absent or unknown does NOT block: the pre-spawn stat above
  // is the executed evidence that the skill existed; absence is traced
  // (PI_ENSEMBLE_DEBUG=1) so the operator can see the honor system was
  // simply not exercised.
  const skillLoadStatus = readEnumMarker(result.text ?? "", "Skill Load Status", [
    "SUCCESS",
    "FAILED",
  ]);
  if (skillLoadStatus === "FAILED") {
    return {
      lens: lens.name,
      ok: result.ok,
      ms: result.ms,
      startMs,
      findings,
      attempts,
      blocked: true,
      summary: result.text?.trim() || undefined,
      model: result.model,
      transcriptPath: result.transcriptPath,
      parseError: `skill load reported FAILED by the child (${lens.skill})`,
      usage: result.usage,
    };
  }
  traceSkillLoadAbsence(lens.skill, skillLoadStatus);
  return {
    lens: lens.name,
    ok: result.ok,
    ms: result.ms,
    startMs,
    findings,
    attempts,
    blocked: false,
    // The prompt asks for a closing summary. Keeping it is what lets a
    // silent lens be told apart from a clean one.
    summary: result.text?.trim() || undefined,
    model: result.model,
    transcriptPath: result.transcriptPath,
    parseError: skipped > 0 ? `${skipped} malformed report_finding call(s) skipped` : undefined,
    // #534 — was previously dropped at this return; the cycle total needs it.
    usage: result.usage,
  };
}

// #872 — honor-system absence is traced, not blocked: the marker was not
// emitted, but the pre-spawn statSync in `runLensChild` is the executed
// evidence the skill exists, so only an explicit FAILED ever blocks.
function traceSkillLoadAbsence(lensSkill: string, status: string | undefined): void {
  if (status === undefined) {
    trace(`skill load status absent (${lensSkill}) — pre-spawn stat passed; marker not emitted`);
  }
}
