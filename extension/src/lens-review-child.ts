/**
 * lens-review-child — one lens's spawn + retry loop + result shaping,
 * split from lens-review.ts (AGENTS.md §12 file-size limit).
 *
 * `runLensReview` (lens-review.ts) maps the parsed lens roster (the
 * `code-review-*` skill dirs — see `buildLensRoster` in lens-roster.ts)
 * over this; the batch
 * deck, dedup, verdict and cap-kill summary live in the parent.
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { childHandles, registerChildHandle } from "./async-jobs-registry.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { extractFindings } from "./lens-findings-extract.ts";
import { isProviderContextLengthFailure } from "./lens-provider-cause.ts";
import { failedLensRow } from "./lens-review-child-failure.ts";
import { deliverLensSteer } from "./lens-review-child-stdin.ts";
import { lensPromptFor } from "./lens-review-format.ts";
import { NO_TEXT_PLACEHOLDER } from "./lens-review-incomplete.ts";
import { LENS_REPORTER_PATH, type LensDef } from "./lens-review.ts";
import type { LensRunResult } from "./lens-review.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { readLensSkillBody } from "./lens-skill-inline.ts";
import { lensTurnCeilingForDiff } from "./lens-turn-ceiling.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { reporterPathFromArgs, statReporterPath } from "./reporter-preflight.ts";
import type { SlowWatchInput } from "./slow-notice.ts";
import { feedSlowProgress, watchSlowDispatch } from "./slow-notice.ts";
import { lensChildBoundMs } from "./spawn-child-bound.ts";
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
    /** #1024 — headless only: the child leads its own process group. */
    processGroup?: boolean;
    /** #1666 — a headless /work cycle's lens children run under trust. */
    workCycleTrust?: boolean;
    childBoundMs?: number; // #1242 — the round's lens bound (default: lensChildBoundMs)
    /** #2644 — the dispatching step's armed hung-request window, whole minutes. Threaded by lean's
     * review step (the only caller that arms one); absent means the child is bounded by its wall
     * clock alone. Unlike the bound above it is not clamped to an operator knob: there is none. */
    stallWindowMinutes?: number;
    evidence?: string;
    /** #1105 — the branch's prior-findings DATA block (lens-residuals.ts). */
    priorFindings?: string;
    /** #2261 — the ref range the review computed `diff` from. The bounded prompt
     * prints the command that re-reads the cut part of the diff from it, so the
     * lens can read an omitted file with its read-only tools. */
    diffRange?: { base: string; head: string };
    /** #2261 — the delta arm's full-branch orientation block, which shares the
     * prompt's ONE budget with the diff. */
    fullContext?: string;
  };
  bumpBatch: () => void;
  /** #799 — the parent pi for the slow-run watch's PM notice (the driver
   * threads its own; PM-driven lens runs pass nothing — the PM's
   * dispatch_peek already sees the lens's progress there). */
  pi?: SlowWatchInput["pi"];
  /**
   * #893 — injectable stat of the lens-reporter extension path. A rejecting
   * stat blocks this lens before ANY spawn attempt with the named
   * "reporter extension missing" error (0 attempts, no spawn). Production
   * passes none (the real `fs.stat` is used); tests pass a stub.
   */
  statFn?: (p: string) => Promise<unknown>;
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
  // #1847 — read the skill BODY here, in the parent, before spending a spawn on
  // it. An unreadable or missing SKILL.md blocks the lens with a named error
  // (the same shape as `skill not installed:` above) rather than spawning four
  // attempts of an unguided reviewer; the body is wrapped in a nonce-tagged
  // delimiter the payload cannot close, because every bundled lens skill
  // carries triple-backtick fences.
  //
  // LOAD-BEARING POSITION: this read, the wrap, and the `lensPromptFor` call
  // below all sit OUTSIDE the retry loop further down, so MAX_LENS_ATTEMPTS
  // attempts share ONE read, ONE wrap (one nonce) and ONE prompt string. Moving
  // any of them inside the loop would re-open and re-decode the same SKILL.md on
  // every retry and hand each attempt a different wrapper — the retries are
  // already the expensive path, and a per-attempt read is exactly the file
  // re-opening this change exists to remove.
  const skill = readLensSkillBody(skillPath);
  if ("error" in skill) {
    bumpBatch();
    return {
      lens: lens.name,
      ok: false,
      ms: 0,
      startMs,
      findings: [],
      attempts: 0,
      blocked: true,
      parseError: skill.error,
    };
  }
  // #1847 — `--skill` is GONE for lens children. Pi's `--skill <dir>` only
  // advertises a skill's name, description and location; the body is inlined
  // only by the `/skill:name` slash command, which no path here calls. So the
  // advertised location was the thing that manufactured the reload: every lens
  // went to open the file it had been told where to find, and the measured
  // cost was 20–80 M tokens a lens. The body now arrives in the prompt, so
  // there is nothing left to advertise.
  //
  // `--no-skills` STAYS: without it Pi loads the whole installed skills tree
  // into the child and advertises every skill in it — including the six lens
  // skills — which would re-create the reload this change deletes, from the
  // very `<available_skills>` block the role prompt used to key its mandatory
  // first action on.
  //
  // #893 — pre-spawn stat of the lens-reporter extension. The extraArgs for
  // every lens child include `--extension LENS_REPORTER_PATH`, so a missing
  // path means the child would run with no report_finding tool and the
  // silence diagnostic in lensProducedEvidence would fire on every lens in
  // lockstep — indistinguishable from a genuinely clean review. Failing here
  // with a named error is cheaper and unambiguous.
  const lensExtraArgs = ["--no-skills", "--extension", LENS_REPORTER_PATH];
  // #2644 — the step's hung-request window, on the lens's own spawn: quiet past it with no tool in
  // flight aborts the child (see `stallLever` in spawn-inflight.ts, which replaces the placeholder
  // reader below). No window armed means no option at all, never a zero-minute timer.
  const lensStall =
    runOpts.stallWindowMinutes === undefined
      ? {}
      : {
          stall: {
            windowMinutes: runOpts.stallWindowMinutes,
            silence: () => ({ sinceMs: 0, toolInFlight: false }),
          },
        };
  const lensReporterPath = reporterPathFromArgs(lensExtraArgs);
  if (lensReporterPath) {
    try {
      await statReporterPath(lensReporterPath, opts.statFn);
    } catch (err) {
      bumpBatch();
      return {
        lens: lens.name,
        ok: false,
        ms: 0,
        startMs,
        findings: [],
        attempts: 0,
        blocked: true,
        parseError: (err as Error).message,
      };
    }
  }
  const prompt = lensPromptFor(
    lens,
    runOpts.diff,
    context,
    runOpts.evidence,
    roster,
    runOpts.priorFindings,
    skillPath,
    skill.wrapped,
    runOpts.diffRange,
    runOpts.fullContext,
  );
  const boundMs = runOpts.childBoundMs ?? lensChildBoundMs();
  // #2127 — the advisory turn ceiling, computed HERE from the very diff string
  // `lensPromptFor` inlines below (R1): neither caller can compute it, and a
  // ceiling read off another string would pace the child on a diff it was never
  // shown.
  const budgetTurns = lensTurnCeilingForDiff(runOpts.diff);
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
  // #907 — the CI-wait span feed for this lens child: the watch chains its
  // span tracker in front of the raw-event hook the spawn receives.
  const slowRaw: (event: PiJsonEvent) => void = () => {};
  // #1827 — set by the spawn the first time the reviewer re-read cap arms its
  // kill. Declared before the watch so its `boundArmed` getter closes over the
  // same variable the spawn later writes (read per threshold crossing, not
  // snapshotted).
  let lensBoundArmed = false;
  const stopSlow = watchSlowDispatch({
    id: deckKey,
    role: slowRole,
    label: slowLabel,
    ...(opts.pi ? { pi: opts.pi } : {}),
    onRawEvent: slowRaw,
    // #1827 ordering — the watch stops steering a lens the cap is already
    // ending; its steer cannot change the outcome.
    boundArmed: () => lensBoundArmed,
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
  // #952 — the lens child's stdin, set by onStdin, read by the onSteer
  // closure. The closure captures the variable directly rather than looking
  // it up in childHandles, so a steer is possible from the moment onStdin
  // fires and is a no-op once the child has exited.
  let lensStdin: Writable | undefined;
  // This lens's own abort, linked to the batch signal, so dispatch_kill
  // <deckKey> stops one hung lens (and its retries) without the whole batch.
  const kill = new AbortController();
  const onBatchAbort = () => kill.abort();
  if (runOpts.signal?.aborted) kill.abort();
  else runOpts.signal?.addEventListener("abort", onBatchAbort, { once: true });
  try {
    while (attempts < MAX_LENS_ATTEMPTS) {
      attempts++;
      if (kill.signal.aborted) {
        lastError = "aborted by user";
        break;
      }
      try {
        result = await spawnSpecialist(
          { role: "code-review-specialist", prompt, cwd: runOpts.cwd, lens: lens.name },
          {
            runId,
            tag,
            // Pin to this lens's skill + load the report_finding tool. `--no-extensions`
            // (set in spawn.ts) disables auto-discovery; `--extension <path>` still
            // loads explicit paths, so the reporter is the only extension in the child.
            extraArgs: lensExtraArgs,
            // #1242 — the lens's own run bound (spawn-child-bound.ts): a lens
            // that never answers is steered to wrap up, then ended, instead of
            // holding the round until the 2-h spawn backstop.
            childBoundMs: boundMs,
            ...lensStall,
            // #2127 — the diff-scaled ADVISORY turn ceiling beside the wall
            // clock, never instead of it: it arms the 50 %/80 % progress steers
            // and cannot end the lens, so the bound above stays the only
            // lens-ending lever (see lens-turn-ceiling.ts).
            budgetTurns,
            // #1827 — the re-read cap counts only reads of THIS lens's
            // SKILL.md; a read of any other skill file never counts.
            reviewSkillPath: skillPath,
            // #1827 — the re-read cap's kill tells this watch to stand down.
            onBoundArmed: () => {
              lensBoundArmed = true;
            },
            signal: kill.signal,
            processGroup: runOpts.processGroup,
            workCycleTrust: runOpts.workCycleTrust,
            onProgress: (state) => {
              dispatchDeck.updateEntry(deckKey, state);
              feedSlowProgress(deckKey, state);
            },
            onRawEvent: stopSlow.onRawEvent ?? slowRaw,
            onStdin: (stdin) => {
              // #799 — register the stdin against the DECK KEY (the id
              // dispatch_peek shows) so the child is steerable directly,
              // not only through the orchestrator's active-child path.
              registerChildHandle(deckKey, stdin, slowLabel, slowRole, () => kill.abort());
              // #952 — capture the handle for the onSteer closure below.
              lensStdin = stdin;
            },
            onSteer: (message) => deliverLensSteer(deckKey, () => lensStdin, message),
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
      // #1564 — nor is a lens ended at its run bound: a retry would spend the
      // bound again on a child that did not answer within it.
      // #1827 — nor a lens ended for re-reading its skill file: the retry
      // would reload the same SKILL.md and re-read it, the exact shape the cap
      // exists to stop.
      // #2261 — nor a lens the PROVIDER refused for its prompt size: an HTTP 400
      // "maximum context length" is deterministic in the prompt, so three more
      // attempts spent the same refusal (measured: 12 children, ~15 minutes, and
      // ~4 M input tokens charged for nothing) and the review still returned
      // REVIEW_INCOMPLETE. The retry loop exists for transient causes; this one
      // is not transient and does not get a budget spent on it.
      if (
        result &&
        (result.killCause === "loop" ||
          result.killCause === "token-budget" ||
          result.killCause === "child-bound" ||
          result.killCause === "review-skill-reread" ||
          result.killCause === "no-progress" ||
          // #2644 — a lens whose model request hung and was ended by the step's stall lever is
          // the least transient death on this list: re-spawning it pays for the same hung request
          // up to three more times and the review still comes back incomplete.
          result.killCause === "stall")
      ) {
        break;
      }
      // ── #2261: a provider refusal of THIS prompt for its size joins the
      // never-retried classes above. Three conditions, and none is the child's
      // prose. The lens prompt orders the reviewer to quote the diff, so `text`
      // can carry diff-authored bytes — a fixture line reading `"400 status
      // code"` would otherwise cost a transient lane three of its four attempts
      // and blame the prompt size. So:
      //   - `errorStop` — the provider really refused the REQUEST (the spawn layer
      //     fills it from the final assistant message's `errorMessage`); and
      //   - the refusal carries an HTTP 400, the status for a request refused on
      //     its shape. Without the status the loop cannot tell a refusal of the
      //     prompt from a refusal of the minute, because a 429 says "too many
      //     tokens" in the same words; and
      //   - its unambiguous size wording says the PROMPT was too large, with no
      //     rate/quota wording anywhere in the body. A 400 whose body says the
      //     metered plan is exhausted is a rate refusal that a retry DOES clear,
      //     so neither the status code alone nor the token vocabulary alone ever
      //     breaks the loop.
      if (result && isProviderContextLengthFailure(result)) {
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
    stopSlow.stop();
    childHandles.delete(deckKey);
    runOpts.signal?.removeEventListener("abort", onBatchAbort);
  }

  bumpBatch();

  // #952 — a cap-killed lens that already reported findings (or wrote a
  // non-placeholder summary) counts as a completed lens: keep the findings
  // and summary, set blocked = false, and let computeVerdict judge them
  // like any other lens result. The killCause suffix in renderSummary still
  // shows the operator that the lens was cap-killed. Only a cap-killed
  // lens with NO evidence (no findings, no real summary) stays blocked.
  //
  // #966 — the evidence rule above is kill-cause aware, for two reasons:
  //   1. Stderr is not a review summary. `collapseEvents` resolves the
  //      text as `text || stderr || "(no output)"` — a killed/failed
  //      child that only emitted stderr carries it in `result.text`, and
  //      counting that prose as a "closing summary" let an all-failed
  //      review render as APPROVED (the observed #966 incident: every
  //      lens row `fail`, verdict APPROVED, a passing ledger entry).
  //      The `thinkingOnly` flag marks the one case where `result.text`
  //      is real (all-thinking) output — the #952 "already produced a
  //      genuine summary" case stays legitimate; a stderr-derived or
  //      placeholder-only text is evidence only when paired with findings
  //      (which still count — a finding is a tool call, not text).
  //   2. A cap kill (loop / token-budget) is a SELF-inflicted mid-turn
  //      stop of a child that was working — its in-progress prose is the
  //      partial review #952 preserves. A timeout / inactivity / abort /
  //      tool-inactivity kill is not: a text-only "summary" from such a
  //      child is pre-kill narration, and without findings it is not
  //      evidence — the lens is blocked, never a silent approver.
  //
  // #1827 round 1 — `review-post-verdict` is deliberately NOT in this list and
  // never will be. It is not a kill cause: a clean end rides on
  // `reviewStopReason`, which no failure path reads, so a result reaching this
  // `!result.ok` branch cannot have been stopped at its verdict. Reading it
  // here would make a stopped reviewer's narration count as a preserved
  // partial review, which is the #966 shape this guard exists to refuse.
  if (!result || !result.ok) {
    // #534 — a failed lens still flushes usage from whatever turns completed
    // before it died; count it like any other dispatch-failed. The row itself —
    // what it kept, whether the lane counts as unreviewed, and the reason the
    // operator reads — is `lens-review-child-failure.ts`'s judgement, not this
    // loop's: the classes it separates (bound-ended, provider-refused,
    // cap-killed-with-a-partial-review, silent) all arrive here as `!ok`.
    const findings = result ? extractFindings(result.toolUses, lens.name).findings : [];
    return failedLensRow({
      lens: lens.name,
      result,
      attempts,
      findings,
      startMs,
      boundMs,
      lastError,
    });
  }

  const { findings, skipped } = extractFindings(result.toolUses, lens.name);
  // #1847 — the #872 `Skill Load Status` self-report and the #995/#1530
  // skill-load PROOF that corroborated it are both RETIRED for lens children.
  //
  // They were written for a world where the child had to go and open its own
  // SKILL.md: the marker meant "the read returned content" and the proof asked
  // whether that read had actually happened. Neither question exists now — the
  // parent read the file BEFORE the spawn and put the body in the prompt, so
  // `readLensSkillBody` above is the executed evidence and a lens that never
  // called `read` is the expected outcome, not an unproven claim. Keeping the
  // proof would have fired its shadow `traceWarn` on every lens in every round
  // (an inline-loaded lens records no read, so `skillLoadProof` returns
  // `unverifiable` at best), and a marker whose FAILED branch blocked a lens
  // would now be asking a child to block itself for not doing something we told
  // it not to do. The driver records the delivery itself, in `skillDelivered`.
  const skillDelivered = `skill delivered inline (${lens.skill})`;
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
    skillDelivered,
    // #2040 — see the failed-branch site above: the child's own recorded calls
    // are the evidence the unproven-HIGH cap reads, kept per child.
    toolUses: result.toolUses,
    ...(result.toolResults ? { toolResults: result.toolResults } : {}),
  };
}
