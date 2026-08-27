/**
 * lens-review-child — one lens's spawn + retry loop + result shaping,
 * split from lens-review.ts (AGENTS.md §12 file-size limit).
 *
 * `runLensReview` (lens-review.ts) maps `LENSES` over this; the batch
 * deck, dedup, verdict and cap-kill summary live in the parent.
 */

import path from "node:path";
import * as dispatchDeck from "./dispatch-deck.ts";
import { extractFindings, lensPromptFor } from "./lens-review-format.ts";
import { LENS_REPORTER_PATH, type LensDef } from "./lens-review.ts";
import type { LensRunResult } from "./lens-review.ts";
import { spawnSpecialist } from "./spawn.ts";
import type { DispatchResult } from "./types.ts";
import { jitteredMs } from "./work-driver-failure-taxonomy.ts";

export const MAX_LENS_ATTEMPTS = 4;
const LENS_RETRY_BACKOFF_MS = 2_000;

export async function runLensChild(opts: {
  lens: LensDef;
  runId: string;
  skillsDir: string;
  context: string;
  opts: {
    diff: string;
    cwd?: string;
    signal?: AbortSignal;
    evidence?: string;
  };
  bumpBatch: () => void;
}): Promise<LensRunResult> {
  const { lens, runId, skillsDir, context, bumpBatch } = opts;
  const runOpts = opts.opts;
  // #456 — the moment this lens began dispatching, so a serialised pass
  // (spawn cap 1) is diagnosable: sequential startMs mean queueing.
  const startMs = Date.now();
  const skillPath = path.join(skillsDir, lens.skill);
  const prompt = lensPromptFor(lens, runOpts.diff, context, runOpts.evidence);
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

  // Retry loop (#3). Up to MAX_LENS_ATTEMPTS attempts on transient
  // failure (spawn error OR non-zero exit). User abort (opts.signal)
  // breaks out immediately — that's the operator saying stop, not a
  // transient failure. Backoff between retries gives the provider /
  // local process spawner room to recover.
  let attempts = 0;
  let result: DispatchResult | undefined;
  let lastError: string | undefined;
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
          // No timeoutMs override — inherits per-role default from
          // spawn.ts:roleTimeoutMs(spec.role). For code-review-specialist
          // that's 15 min (PR5 — was a 30 min global pre-PR5).
          signal: runOpts.signal,
          onProgress: (state) => dispatchDeck.updateEntry(deckKey, state),
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

  dispatchDeck.clearEntry(deckKey);
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
