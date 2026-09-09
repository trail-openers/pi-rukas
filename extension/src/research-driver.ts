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
import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchCore } from "./dispatch.ts";
import {
  VIPUNE_PRECEDENCE_NOTE,
  VIPUNE_PRIOR_SOURCE,
  codeIdentifiersIn,
  priorContextHasVipune,
  renderPriorContext,
} from "./plan-draft.ts";
import { PLAN_DISPATCH_TIMEOUT_MS, PLAN_MARKER_CHILD_ARGS } from "./plan-investigate.ts";
import type { PlanPhaseTiming } from "./plan-types.ts";
import { anglesForTier } from "./research-angles.ts";
import {
  type MemoSections,
  memoSynthesisPrompt,
  parseMemoSections,
  resolveArtifactPaths,
  slugify,
  writeArtifact,
} from "./research-artifact.ts";
import { writeResearchMemory } from "./research-memory.ts";
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
import type { ExecFn } from "./worktree.ts";

const execp = promisify(exec);
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
}

export async function runResearchPipeline(
  pi: ExtensionAPI,
  input: ResearchDriverInput,
  repoRoot: string,
  deps: ResearchDeps = {},
): Promise<ResearchResult> {
  const dispatch: ResearchDispatchFn = _dispatchOverride ?? dispatchCore;
  const execFn = deps.execFn ?? defaultExec;
  const searchFn = deps.vipuneSearchFn ?? vipuneSearch;
  const memoryWriteFn = deps.memoryWriteFn ?? writeResearchMemory;
  const topic = input.topic.trim();
  const tier: ResearchTier = RESEARCH_TIERS.includes(input.tier as ResearchTier)
    ? (input.tier as ResearchTier)
    : "standard";
  const date = new Date().toISOString().slice(0, 10);

  const timings: PlanPhaseTiming[] = [];
  const pipelineStart = Date.now();
  const timed = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings.push({ phase, ms: Date.now() - t0 });
    }
  };
  const finishTimings = (): PlanPhaseTiming[] => [
    ...timings,
    { phase: "total", ms: Date.now() - pipelineStart },
  ];

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
        if (line.trim()) prior.push({ source: "context param", fact: line.trim() });
      }
    }
    return prior;
  });
  const priorBlock =
    priorContext.length > 0
      ? `PM has already established (DO NOT re-investigate; dig deeper instead):\n${renderPriorContext(priorContext)}\n${priorContextHasVipune(priorContext) ? `${VIPUNE_PRECEDENCE_NOTE}\n` : ""}\n`
      : "";

  // Phase 2 — one parallel retrieval barrier. Fail-closed per angle: an
  // angle is ok only when the dispatch succeeded AND produced ≥1 structured
  // claim (the plan driver's D8 rule).
  const angleSpecs = anglesForTier(tier, topic, codeIdentifiersIn(topic), input.angles);
  const angles: AngleRun[] = await timed("retrieve", () =>
    Promise.all(
      angleSpecs.map((a) =>
        dispatch(
          pi,
          { role: "explore", prompt: `${priorBlock}${a.prompt}`, cwd: repoRoot },
          {
            label: `research-${a.name}`.slice(0, 24),
            timeoutMs: RESEARCH_DISPATCH_TIMEOUT_MS,
            extraArgs: RESEARCH_EXTRA_ARGS,
          },
        ).then((r) => {
          const claims = extractResearchClaims(r.toolUses, a.name);
          return {
            name: a.name,
            ok: r.ok && !r.errorStop && claims.length > 0,
            summary: r.text.trim().slice(0, 500),
            claims,
          };
        }),
      ),
    ),
  );

  const claims = angles.flatMap((a) => a.claims);
  const base: Omit<ResearchResult, "halt" | "abstained" | "memory"> = {
    topic,
    tier,
    angles,
    claims,
    pinnedCommit: "unknown",
    timings: [],
  };
  if (claims.length === 0) {
    trace(`research-driver: all ${angles.length} angles produced zero structured claims — halting`);
    return {
      ...base,
      abstained: false,
      memory: { outcome: "skipped", detail: "no claims — nothing to remember" },
      halt: {
        reason: "no-structured-claims",
        detail: `all ${angles.length} angles returned zero report_research_claim calls (prose-only or schema-invalid). Re-run start_research_driver; if this recurs, check the research-reporter extension registration (RESEARCH_REPORTER_PATH).`,
      },
      timings: finishTimings(),
    };
  }

  // Phase 3 — deterministic verification, driver-side.
  const commit = await pinnedCommit(execFn, repoRoot);
  let verified = await timed("verify", () => verifyClaims(claims, repoRoot, execFn, deps.fetchFn));

  // Phase 3b — deep tier only: ONE scoped entailment dispatch. Annotation,
  // never a silent upgrade; a "none" verdict demotes the finding out of the
  // abstention count (research-verify.ts: isVerifiedFinding).
  let entailment: ResearchResult["entailment"];
  if (tier === "deep") {
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
  if (tier === "adoption") {
    const synth = await timed("memo", () =>
      dispatch(
        pi,
        { role: "explore", prompt: memoSynthesisPrompt(topic, verified), cwd: repoRoot },
        {
          label: "research-memo-synthesis",
          timeoutMs: RESEARCH_DISPATCH_TIMEOUT_MS,
          extraArgs: PLAN_MARKER_CHILD_ARGS,
        },
      ),
    );
    memo = synth.ok && !synth.errorStop ? parseMemoSections(synth.text) : {};
  }

  // Phase 4 — artifact + provenance.
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
      timings: finishTimings(),
    };
  }

  // Phase 5 — memory (never fails the run).
  const firstVerified = verified.find(isVerifiedFinding);
  const takeaway = firstVerified
    ? firstVerified.text.slice(0, 120)
    : "no reliably verified findings";
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
    timings: finishTimings(),
  };
}
