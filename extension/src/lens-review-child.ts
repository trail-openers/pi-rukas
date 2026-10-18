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
import { lensPromptFor } from "./lens-review-format.ts";
import { NO_TEXT_PLACEHOLDER } from "./lens-review-incomplete.ts";
import { LENS_REPORTER_PATH, type LensDef } from "./lens-review.ts";
import type { LensRunResult } from "./lens-review.ts";
import type { RosterEntry } from "./lens-roster.ts";
import { skillLoadProof } from "./lens-skill-load-proof.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";
import { reporterPathFromArgs, statReporterPath } from "./reporter-preflight.ts";
import type { SlowWatchInput } from "./slow-notice.ts";
import { feedSlowProgress, watchSlowDispatch } from "./slow-notice.ts";
import { lensChildBoundMs } from "./spawn-child-bound.ts";
import { spawnSpecialist } from "./spawn.ts";
import { trace, traceWarn } from "./trace.ts";
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
    childBoundMs?: number; // #1242 — the round's lens bound (default: lensChildBoundMs)
    evidence?: string;
    /** #1105 — the branch's prior-findings DATA block (lens-residuals.ts). */
    priorFindings?: string;
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
  // #893 — pre-spawn stat of the lens-reporter extension. The extraArgs for
  // every lens child include `--extension LENS_REPORTER_PATH`, so a missing
  // path means the child would run with no report_finding tool and the
  // silence diagnostic in lensProducedEvidence would fire on every lens in
  // lockstep — indistinguishable from a genuinely clean review. Failing here
  // with a named error is cheaper and unambiguous.
  const lensExtraArgs = ["--no-skills", "--skill", skillPath, "--extension", LENS_REPORTER_PATH];
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
  );
  const boundMs = runOpts.childBoundMs ?? lensChildBoundMs();
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
  const stopSlow = watchSlowDispatch({
    id: deckKey,
    role: slowRole,
    label: slowLabel,
    ...(opts.pi ? { pi: opts.pi } : {}),
    onRawEvent: slowRaw,
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
            // #1564 — the lens's own run bound (spawn-child-bound.ts): a lens
            // that never answers is steered to wrap up, then ended, instead of
            // holding the round until the 2-h spawn backstop.
            childBoundMs: boundMs,
            signal: kill.signal,
            processGroup: runOpts.processGroup,
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
            onSteer: (message) => {
              // #952 — write the RPC steer envelope to the captured stdin
              // (the same handle onStdin registers). If the child has
              // already exited, the #932 closed-stdin guard makes this a
              // traced no-op — no throw, no EPIPE.
              if (!lensStdin) {
                trace(`lens steer skipped (${deckKey}): stdin not yet captured`);
                return;
              }
              if (
                lensStdin.destroyed === true ||
                lensStdin.writable === false ||
                lensStdin.writableEnded === true
              ) {
                trace(`lens steer skipped (${deckKey}): stdin closed`);
                return;
              }
              try {
                lensStdin.write(`${JSON.stringify({ type: "steer", message })}\n`, () => {
                  /* #932 — the write callback swallows the write's own error; the
                      stdin `error` listener at spawn time traces it. */
                });
              } catch (err) {
                trace(`lens steer write failed (${deckKey}): ${(err as Error).message}`);
              }
            },
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
      if (
        result &&
        (result.killCause === "loop" ||
          result.killCause === "token-budget" ||
          result.killCause === "child-bound")
      ) {
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
  if (!result || !result.ok) {
    // #534 — a failed lens still flushes usage from whatever turns
    // completed before it died; count it like any other dispatch-failed.
    const findings = result ? extractFindings(result.toolUses, lens.name).findings : [];
    const summary = result?.text?.trim() || undefined;
    const capKill = result?.killCause === "loop" || result?.killCause === "token-budget";
    // #966 — one source for the placeholder: NO_TEXT_PLACEHOLDER
    // (lens-review-incomplete.ts, where `collapseEvents` declares it).
    const textIsReviewOutput =
      !!summary && summary !== NO_TEXT_PLACEHOLDER && (result?.thinkingOnly === true || capKill);
    const hasEvidence = findings.length > 0 || (!!summary && textIsReviewOutput);
    // #1564 — a lens ended at its run bound never gave a verdict: its lane is
    // not reviewed (blocked → REVIEW_INCOMPLETE) even when it reported some
    // findings first, which are kept.
    const bounded = result?.killCause === "child-bound";
    return {
      lens: lens.name,
      ok: false,
      ms: result?.ms ?? 0,
      startMs,
      findings: hasEvidence ? findings : [],
      attempts,
      blocked: !hasEvidence || bounded,
      parseError: bounded
        ? `not reviewed — no verdict within its ${Math.max(1, Math.round(boundMs / 60_000))}-min lens bound (PI_ENSEMBLE_LENS_BOUND_MS, never past the review budget); ended, not retried`
        : hasEvidence
          ? undefined
          : (lastError ?? "unknown failure"),
      summary: hasEvidence ? summary : undefined,
      usage: result?.usage,
      ...(hasEvidence && result ? { model: result.model } : {}),
      ...(hasEvidence && result?.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
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
  //
  // PR #1530 / #995 added a cross-check of a claimed SUCCESS against the
  // child's recorded tool calls (`skillLoadProof`). As of round 3 of that
  // review it runs in SHADOW: the proof is computed and a disagreement is
  // traced, but it does NOT change the outcome. The child's own marker is the
  // only thing that blocks, exactly as before the proof existed.
  //
  // Why shadow rather than a block. A false `unproven` blocks every lens
  // review on every PR, and two false-refutation classes were still open:
  //   - `observedToolCalls` is only consulted when it EXCEEDS `toolUses.length`,
  //     so an under-recovered-but-non-empty replay (live 5, recovered 2, the
  //     read among the 3 that were dropped) refutes a lens that read its skill;
  //   - the directory resolution (`realpathOr`) can mismatch when the skills
  //     dir is a symlink tree that resolves differently at check time than the
  //     child saw at read time.
  // Both are judgement calls about another module's records, and the repo rule
  // for a new judgement seam is shadow first, enforce once the log earns it.
  // FOLLOW-UP: promote `unproven` to a block once the shadow log shows no
  // false refutations — the line below is the log, and the enforcement is one
  // `blocked: true` branch on `case "unproven"` here.
  const skillLoadStatus = readEnumMarker(result.text ?? "", "Skill Load Status", [
    "SUCCESS",
    "FAILED",
  ]);
  if (skillLoadStatus === "SUCCESS") {
    // `observedToolCalls` is passed so a replay that is EMPTY on the array but
    // non-empty on the live count abstains outright (`unverifiable`): the child
    // made calls the replay did not carry, so the absence of a read from
    // `toolUses` says nothing about whether it read the skill.
    const proof = skillLoadProof(result.toolUses, skillPath, result.observedToolCalls);
    switch (proof) {
      case "proven":
        // The marker and the records agree; nothing to say.
        break;
      case "unproven":
        // SHADOW: warn, do not block. traceWarn (not trace) so the line shows
        // without PI_ENSEMBLE_DEBUG and the operator can see — in a normal run
        // log — the lens, the verdict it claimed, and the tool names/paths the
        // proof looked at. That is the evidence the promotion decision needs.
        traceWarn(
          `skill load SHADOW: SUCCESS not corroborated (${lens.skill}): no read of ${skillPath} among ${describeToolCalls(result.toolUses)} — NOT blocking (shadow mode; the child's own marker decides)`,
        );
        break;
      case "unverifiable":
        trace(
          `skill load SUCCESS unverifiable (${lens.skill}): the child recorded no usable tool calls; treated as absent, not refuted`,
        );
        break;
    }
  }
  // The child's own marker is the gate. A `FAILED` self-report blocks with its
  // findings kept — unchanged from before #995's proof.
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

/** A compact, bounded summary of what the proof actually looked at, for the
 * SHADOW warning: the tool names it saw and the path-shaped arguments those
 * calls carried. Nothing is executed and no argument content beyond paths is
 * echoed; the list is capped so a chatty child cannot make the warning the
 * longest line in the run. Both the `read` and `file_path` spellings are
 * collected — this line reports what the child NAMED, so the operator can see
 * why the proof disagreed with it, including when the model used a spelling
 * the tool would have rejected. */
function describeToolCalls(toolUses: readonly unknown[]): string {
  const names: string[] = [];
  const paths: string[] = [];
  for (const tu of toolUses ?? []) {
    if (!tu || typeof tu !== "object") continue;
    const call = tu as Record<string, unknown>;
    const name = typeof call.name === "string" ? call.name : "?";
    if (names.length < 8 && !names.includes(name)) names.push(name);
    const args =
      call.arguments && typeof call.arguments === "object"
        ? (call.arguments as Record<string, unknown>)
        : {};
    for (const key of ["path", "file_path"]) {
      const v = args[key];
      if (typeof v === "string" && v.trim() && paths.length < 8 && !paths.includes(v)) {
        paths.push(v);
      }
    }
  }
  const seen = names.length > 0 ? names.join(", ") : "(none)";
  const withPaths = paths.length > 0 ? `; paths ${paths.join(", ")}` : "";
  return `${toolUses?.length ?? 0} tool call(s) [tools ${seen}]${withPaths}`;
}

// #872 — honor-system absence is traced, not blocked: the marker was not
// emitted, but the pre-spawn statSync in `runLensChild` is the executed
// evidence the skill exists, so an absent marker never blocks — and a SUCCESS
// whose read the child did not perform is downgraded to FAILED above rather
// than reaching this line.
function traceSkillLoadAbsence(lensSkill: string, status: string | undefined): void {
  if (status === undefined) {
    trace(`skill load status absent (${lensSkill}) — pre-spawn stat passed; marker not emitted`);
  }
}
