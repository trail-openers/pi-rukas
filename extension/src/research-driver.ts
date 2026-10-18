/**
 * research-driver — the compiled /research pipeline (orchestrator).
 *
 * Compiles the deterministic spine the landscape review found missing
 * (outputs/research-driver-landscape.md §4 verdict: "light compiled driver,
 * plan-driver shape"): inventory → parallel angle retrieval → deterministic
 * verification (URL liveness + commit-pinned code grounding) → durable
 * dated artifact + provenance sidecar → typed vipune write. Judgement stays
 * with PM: it chooses tier and (optionally) the angle prompts, and it owns
 * the conversation after the artifact — the driver never auto-advances into
 * /plan.
 *
 * Phases (all timed, the plan-driver pattern):
 *   1 Inventory  — vipune keyword search + context param → prior block
 *   2 Retrieve   — ONE parallel barrier of explore children, each carrying
 *                  the research-reporter extension (report_research_claim);
 *                  fail-closed per angle; all-angles-empty halts
 *   3 Verify     — driver-side, deterministic (research-verify.ts)
 *   4 Artifact   — outputs/research-<slug>.md + .provenance.md
 *                  (research-artifact.ts; abstention shape when zero
 *                  verified findings)
 *   5 Memory     — one typed candidate row with supersession
 *                  (research-memory.ts); a memory failure never fails a run
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { dispatchCore } from "./dispatch.ts";
import { execp } from "./exec.ts";
import {
  VIPUNE_PRECEDENCE_NOTE,
  VIPUNE_PRIOR_SOURCE,
  codeIdentifiersIn,
  priorContextHasVipune,
  renderPriorContext,
} from "./plan-draft.ts";
import { PLAN_DISPATCH_TIMEOUT_MS, PLAN_MARKER_CHILD_ARGS } from "./plan-investigate.ts";
import { OPERATOR_SOURCE } from "./plan-prior-context.ts";
import { reporterPathFromArgs, statReporterPath } from "./reporter-preflight.ts";
import { runResearchAngle } from "./research-angle.ts";
import { anglesForTier } from "./research-angles.ts";
import {
  type MemoSections,
  memoSynthesisPrompt,
  parseMemoSections,
  resolveArtifactPaths,
  slugify,
  writeArtifact,
} from "./research-artifact.ts";
import { killedBy } from "./research-cancel.ts";
import { dedupResearchClaims } from "./research-dedup.ts";
import {
  type ParallelOutcome,
  classifyParallelOutcome,
  researchFallbackLine,
  selectFallback,
  surfaceForAngle,
  wigoloAnglePrompt,
} from "./research-fallback.ts";
import { researchTakeawayText, writeResearchMemory } from "./research-memory.ts";
import { PhaseTimer } from "./research-timings.ts";
import {
  type AngleRun,
  RESEARCH_TIERS,
  type ResearchClaim,
  type ResearchDriverInput,
  type ResearchResult,
  type ResearchTier,
  extractResearchClaims,
} from "./research-types.ts";
import {
  type FetchLike,
  entailableClaims,
  entailmentPrompt,
  isVerifiedFinding,
  parseClaimSupport,
  pinnedCommit,
  verifyClaims,
} from "./research-verify.ts";
import { trace } from "./trace.ts";
import { vipuneSearch } from "./vipune.ts";
import type { DriverHost } from "./work-driver-host.ts";
import type { ExecFn } from "./worktree.ts";

const defaultExec: ExecFn = async (cmd, opts) => {
  const { stdout, stderr } = await execp(cmd, { cwd: opts?.cwd, timeout: opts?.timeout ?? 15_000 });
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** Same bound as the plan children — single source of the 30-min number. */
export const RESEARCH_DISPATCH_TIMEOUT_MS = PLAN_DISPATCH_TIMEOUT_MS;

/** Companion-extension path (report_research_claim), plan-reporter pattern. */
export const RESEARCH_REPORTER_PATH = `${__dirname}/research-reporter.ts`;
export const RESEARCH_EXTRA_ARGS: string[] = ["--no-skills", "--extension", RESEARCH_REPORTER_PATH];

/** The dispatch seam, injectable for the smoke tests (setPlanDispatch pattern). */
export type ResearchDispatchFn = typeof dispatchCore;

let _dispatchOverride: ResearchDispatchFn | null = null;

/** Set a dispatch stub for the next run (tests). Pass `null` to clear. */
export function setResearchDispatch(fn: ResearchDispatchFn | null): void {
  _dispatchOverride = fn;
}

/**
 * Injectable side-effect seams (the FsOps-style DI the smoke tests need to
 * run offline: no git, no HTTP, no vipune binary). Production passes none.
 */
export interface ResearchDeps {
  execFn?: ExecFn;
  fetchFn?: FetchLike;
  vipuneSearchFn?: typeof vipuneSearch;
  memoryWriteFn?: typeof writeResearchMemory;
  /**
   * #893 — the pre-spawn stat of the reporter extension path, injectable
   * for the offline tests (mirrors execFn/fetchFn). Rejecting it makes
   * every angle fail with the named "reporter extension missing" error
   * before any dispatch happens.
   */
  statFn?: (p: string) => Promise<unknown>;
}

export async function runResearchPipeline(
  pi: DriverHost,
  input: ResearchDriverInput,
  repoRoot: string,
  deps: ResearchDeps = {},
  // #1541 review (MEDIUM) — the tool path passes the async job's own signal so
  // dispatch_kill / session shutdown stop the run at a phase boundary. Optional
  // so the direct-pipeline tests keep their four-argument calls.
  opts: { signal?: AbortSignal } = {},
): Promise<ResearchResult> {
  const signal = opts.signal;
  const dispatch: ResearchDispatchFn = _dispatchOverride ?? dispatchCore;
  const execFn = deps.execFn ?? defaultExec;
  const statFn = deps.statFn ?? (stat as (p: string) => Promise<unknown>);
  const searchFn = deps.vipuneSearchFn ?? vipuneSearch;
  const memoryWriteFn = deps.memoryWriteFn ?? writeResearchMemory;
  const topic = input.topic.trim();
  const tier: ResearchTier = RESEARCH_TIERS.includes(input.tier as ResearchTier)
    ? (input.tier as ResearchTier)
    : "standard";
  const date = new Date().toISOString().slice(0, 10);
  const timer = new PhaseTimer();
  const timed = <T>(phase: string, fn: () => Promise<T>) => timer.run(phase, fn);
  // #1541 review (MEDIUM) — the cancellation halt. `angles` is in scope only
  // after the retrieval barrier, so the pre-retrieval checks pass an empty set;
  // the phase name says how far the run got.
  const cancelledResult = (phase: string, atAngles: AngleRun[] = []): ResearchResult => ({
    topic,
    tier,
    angles: atAngles,
    claims: [] as ResearchClaim[],
    pinnedCommit: "unknown",
    abstained: false,
    memory: { outcome: "skipped", detail: "run cancelled — nothing durable to point at" },
    cancelled: { by: killedBy(signal), phase },
    timings: timer.finish(),
  });

  // Phase 1 — inventory (vipune keywords + context param), briefing only:
  // children are told what is already established so they dive deeper
  // instead of re-walking known ground.
  const priorContext = await timed("inventory", async () => {
    const keywords = topic
      .replace(/[()]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .slice(0, 4);
    const terms = keywords.length > 0 ? keywords.join(" ") : topic.slice(0, 60);
    const res = await searchFn(terms, { cwd: repoRoot, limit: 5 });
    const prior: { source: string; fact: string }[] =
      res.kind === "hits"
        ? res.hits.map((h) => ({ source: VIPUNE_PRIOR_SOURCE, fact: h.content.slice(0, 200) }))
        : [];
    if (input.context?.trim()) {
      for (const line of input.context.trim().split("\n")) {
        if (line.trim()) prior.push({ source: OPERATOR_SOURCE, fact: line.trim() });
      }
    }
    return prior;
  });
  // #1541 review (MEDIUM) — phase boundary: every await below is a vipune
  // read, a fan-out, or an HTTP liveness check. A kill between two of them must
  // not pay for the next one.
  if (signal?.aborted) return cancelledResult("inventory");

  const priorBlock =
    priorContext.length > 0
      ? `PM has already established (DO NOT re-investigate; dig deeper instead):\n${renderPriorContext(priorContext)}\n${priorContextHasVipune(priorContext) ? `${VIPUNE_PRECEDENCE_NOTE}\n` : ""}\n`
      : "";

  // Phase 2 prep — the dispatch-time fallback line (#773). Read HOST-side:
  // unset = enabled, `0` = disabled. Never forwarded to the sandbox (the
  // PI_ENSEMBLE_* pattern is blocklisted in bin/pi-rukas), so the explore
  // recipe stays static and this single line is the only per-run difference.
  const fallbackEnabled = process.env.PI_ENSEMBLE_RESEARCH_FALLBACK !== "0";
  const fallbackLine = researchFallbackLine(fallbackEnabled);

  // Phase 2 — one parallel retrieval barrier. Fail-closed per angle: an
  // angle is ok only when the dispatch succeeded AND produced ≥1 structured
  // claim (the plan driver's D8 rule). A failed angle whose child classified
  // the Parallel failure as retryable (credit/auth/network) is re-dispatched
  // ONCE, wigolo-framed (#773) — never more, and never for an empty result.
  const angleSpecs = anglesForTier(tier, topic, codeIdentifiersIn(topic), input.angles);
  // #893 — pre-spawn stat of the reporter extension. Every angle child
  // carries RESEARCH_EXTRA_ARGS, so the check runs once before the fan-out
  // and fails the whole retrieval phase with the named error when the path
  // is missing — no spawn, no silent empty artifact.
  const reporterPath = reporterPathFromArgs(RESEARCH_EXTRA_ARGS);
  if (reporterPath) {
    try {
      await statReporterPath(reporterPath, statFn);
    } catch (err) {
      return {
        topic,
        tier,
        angles: angleSpecs.map((a) => ({
          name: a.name,
          ok: false,
          summary: "not dispatched — reporter extension missing",
          claims: [] as ResearchClaim[],
          backend: "parallel" as const,
          failure: (err as Error).message,
        })),
        claims: [] as ResearchClaim[],
        pinnedCommit: "unknown",
        abstained: false,
        memory: {
          outcome: "skipped" as const,
          detail: "reporter preflight failed — nothing to remember",
        },
        halt: { reason: "reporter-missing" as const, detail: (err as Error).message },
        timings: timer.finish(),
      };
    }
  }
  const angles: AngleRun[] = await timed("retrieve", () =>
    Promise.all(
      angleSpecs.map(async (a) => {
        // Built once: both legs (the primary and the wigolo re-dispatch) take the
        // same prior block, fallback line, cwd and signal — a second literal copy
        // is a second chance for the two to drift.
        const ctx = { priorBlock, fallbackLine, repoRoot, signal };
        let run = await runResearchAngle(dispatch, pi, a, "parallel", undefined, ctx);
        // #1541 review (MEDIUM) — one re-dispatch per angle, and each is a full
        // child. A kill mid-barrier must not spend the second one.
        if (!run.ok && fallbackEnabled && !signal?.aborted) {
          // The markers sit at the END of the reply, so classify on the
          // full text — a 500-char summary silently drops them.
          const outcome: ParallelOutcome = classifyParallelOutcome(run.fullText);
          const decision = selectFallback(outcome, surfaceForAngle(a.name), fallbackEnabled);
          if (decision === "fall-back-to-wigolo") {
            // Re-dispatch ONCE: a second failure is not retried — the angle
            // stays failed and its summary carries both attempts' text.
            const retry = await runResearchAngle(dispatch, pi, a, "wigolo", outcome, ctx);
            const merged = retry.ok
              ? `${run.summary}\n[wigolo fallback: ${retry.summary}]`
              : `${run.summary}\n[wigolo fallback failed: ${classifyParallelOutcome(retry.fullText)}]`;
            run = {
              ...retry,
              fullText: retry.fullText,
              summary: merged.length > 500 ? `${merged.slice(0, 500)}…` : merged,
            };
          } else {
            run.summary =
              `${run.summary}\n[parallel-outcome: ${outcome}; decision: ${decision}]`.slice(0, 500);
          }
        }
        const { fullText: _fullText, ...bare } = run;
        return bare;
      }),
    ),
  );

  // Cross-angle dedup AFTER extraction, BEFORE verification (#896): a
  // merged claim verifies its survivor's source once, and its `angles`
  // attribute the provenance; the raw vs unique counts land in the
  // artifact + provenance headers.
  if (signal?.aborted) return cancelledResult("retrieve", angles);
  const rawClaimCount = angles.reduce((sum, a) => sum + a.claims.length, 0);
  const claims = dedupResearchClaims(angles.flatMap((a) => a.claims));
  const base: Omit<ResearchResult, "halt" | "abstained" | "memory"> = {
    topic,
    tier,
    angles,
    claims,
    pinnedCommit: "unknown",
    timings: [],
  };
  if (claims.length === 0) {
    // #893 — whole-run signal: distinguish "every angle was silent" (0 raw
    // report_research_claim calls from every dispatched angle → the
    // reporting channel appears broken) from "calls existed but were
    // schema-invalid" (the existing no-structured-claims path). Keyed off
    // rawClaimCalls: an angle that was never dispatched (dispatch rejection,
    // preflight failure) has rawClaimCalls undefined and is excluded from
    // the all-silent check — it already has its own failure message.
    const dispatched = angles.filter((a) => a.rawClaimCalls !== undefined);
    const allSilent = dispatched.length > 0 && dispatched.every((a) => a.rawClaimCalls === 0);
    const rawCalls = angles.reduce((sum, a) => sum + (a.rawClaimCalls ?? 0), 0);
    trace(
      `research-driver: all ${angles.length} angles produced zero structured claims — halting (allSilent=${allSilent}, rawCalls=${rawCalls})`,
    );
    return {
      ...base,
      abstained: false,
      memory: { outcome: "skipped", detail: "no claims — nothing to remember" },
      halt: allSilent
        ? {
            reason: "reporter-silent",
            detail:
              'the reporting channel appears broken — 0 report_research_claim calls from every angle (the tool was never called, so this is not "nothing found"). ' +
              "Check pi version / --extension / RESEARCH_REPORTER_PATH. Re-run start_research_driver; if this recurs, the reporter extension may not be loading.",
          }
        : {
            reason: "no-structured-claims",
            detail: `all ${angles.length} angles returned zero report_research_claim calls (prose-only or schema-invalid). Re-run start_research_driver; if this recurs, check the research-reporter extension registration (RESEARCH_REPORTER_PATH).`,
          },
      timings: timer.finish(),
    };
  }

  // Phase 3 — deterministic verification, driver-side.
  if (signal?.aborted) return cancelledResult("retrieve", angles);
  const commit = await pinnedCommit(execFn, repoRoot);
  let verified = await timed("verify", () =>
    verifyClaims(claims, repoRoot, execFn, deps.fetchFn, { pinnedSha: commit }),
  );

  // Phase 3b — deep tier only: ONE scoped entailment dispatch. Annotation,
  // never a silent upgrade; a "none" verdict demotes the finding out of the
  // abstention count (research-verify.ts: isVerifiedFinding).
  let entailment: ResearchResult["entailment"];
  if (tier === "deep" && !signal?.aborted) {
    const targets = entailableClaims(verified);
    if (targets.length === 0) {
      entailment = "ran"; // nothing to entail is a completed pass, not a failure
    } else {
      const reviewer = await timed("entail", () =>
        dispatch(
          pi,
          { role: "explore", prompt: entailmentPrompt(targets), cwd: repoRoot },
          {
            label: "research-entailment",
            timeoutMs: RESEARCH_DISPATCH_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
            extraArgs: PLAN_MARKER_CHILD_ARGS,
          },
        ),
      );
      if (reviewer.ok && !reviewer.errorStop) {
        entailment = "ran";
        const verdicts = parseClaimSupport(reviewer.text, targets.length);
        const bySlot = new Map(targets.map((c, i) => [c, verdicts.get(i + 1)]));
        verified = verified.map((c) => {
          const support = bySlot.get(c);
          return support ? { ...c, support } : c;
        });
      } else {
        // The artifact says so explicitly — absence of annotations must
        // never read as "everything checked out".
        entailment = "unavailable";
      }
    }
  }
  const abstained = !verified.some(isVerifiedFinding);

  // Phase 3c — adoption tier only: ONE synthesis dispatch whose
  // recommendation/comparison sections embed VERBATIM in the memo. The
  // child sees only the verified claims; a failed synthesis leaves the
  // memo's decision to the operator — the driver never fabricates one.
  let memo: MemoSections | undefined;
  if (tier === "adoption" && !signal?.aborted) {
    const synth = await timed("memo", () =>
      dispatch(
        pi,
        { role: "explore", prompt: memoSynthesisPrompt(topic, verified), cwd: repoRoot },
        {
          label: "research-memo-synthesis",
          timeoutMs: RESEARCH_DISPATCH_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          extraArgs: PLAN_MARKER_CHILD_ARGS,
        },
      ),
    );
    memo = synth.ok && !synth.errorStop ? parseMemoSections(synth.text) : {};
  }

  // Phase 4 — artifact + provenance.
  // #1541 review (MEDIUM) — the last boundary that matters: past this point the
  // run writes files, and a killed run must not leave a half-written artifact
  // the operator believes is a completed report.
  if (signal?.aborted) return cancelledResult("verify", angles);
  let artifactPath: string | undefined;
  let provenancePath: string | undefined;
  try {
    const paths = await timed("artifact", async () => {
      const p = await resolveArtifactPaths(repoRoot, slugify(topic));
      return writeArtifact(
        repoRoot,
        {
          topic,
          tier,
          date,
          pinnedCommit: commit,
          angles,
          claims: verified,
          abstained,
          provenanceBasename: path.basename(p.provenancePath),
          entailment,
          memo,
          rawClaimCount,
          timings: timer.finish(),
        },
        p,
      );
    });
    artifactPath = paths.artifactPath;
    provenancePath = paths.provenancePath;
  } catch (err) {
    trace(`research-driver: artifact write failed: ${(err as Error).message}`);
    return {
      ...base,
      claims: verified,
      pinnedCommit: commit,
      abstained,
      memory: { outcome: "skipped", detail: "artifact write failed — nothing durable to point at" },
      halt: { reason: "artifact-write-failed", detail: (err as Error).message },
      timings: timer.finish(),
    };
  }

  // Phase 5 — memory (never fails the run). The takeaway counts the
  // POST-ENTAILMENT verified findings — on the deep tier the entail pass has
  // already demoted "none" verdicts out of this set (isVerifiedFinding), so
  // "N verified" reflects the demotion, not the raw claim count.
  const verifiedFindings = verified.filter(isVerifiedFinding);
  const takeaway = researchTakeawayText(verifiedFindings, claims.length, angles.length);
  const memory = await timed("memory", () =>
    memoryWriteFn({
      topic,
      takeaway,
      artifactRelPath: path.relative(repoRoot, artifactPath as string),
      date,
      cwd: repoRoot,
    }).catch((err) => ({ outcome: "error" as const, detail: (err as Error).message })),
  );

  trace(
    `research-driver: tier=${tier} angles=${angles.length} claims=${verified.length} abstained=${abstained} commit=${commit.slice(0, 8)}`,
  );
  return {
    ...base,
    claims: verified,
    pinnedCommit: commit,
    artifactPath,
    provenancePath,
    abstained,
    entailment,
    memory,
    timings: timer.finish(),
  };
}
