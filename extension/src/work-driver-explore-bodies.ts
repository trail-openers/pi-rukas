/**
 * work-driver-explore-bodies — the issue bodies the explore prompt is built
 * from, split out of `work-driver-explore-run.ts` for module-size hygiene
 * (AGENTS.md §12).
 *
 * For each settled body fetch this records one of three things: a blank body, a
 * rejected fetch, or a body to inline. A blank or rejected body is a hard
 * pre-condition failure — the driver halts rather than send explore a prompt
 * with a hole in it — so both are returned as `emptyBodyIssues` with the reason
 * the operator will read in the handoff. A fulfilled body is additionally written
 * as a claim-check artifact and truncated to the inline cap, so a long body still
 * reaches the prompt with a pointer to its full text.
 */
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { inlineBody } from "./work-driver-issue-spec.ts";
import { type WorkState, appendEvent, writeDispatchArtifact } from "./workflow-state.ts";

/** The cap on one inlined body — covers virtually every real-world issue body. */
const INLINE_BODY_CAP = 16 * 1024;

/** One issue whose body never arrived, with the reason the handoff will name. */
export interface EmptyBodyIssue {
  issue: number;
  reason: string;
}

/** What the bodies are ready to be used for: inline content, or a halt. */
export interface ExploreBodies {
  state: WorkState;
  bodies: Array<{ issue: number; body: string; truncated: boolean }>;
  emptyBodyIssues: EmptyBodyIssue[];
}

/**
 * Reduce the settled body fetches to prompt content, or to the halt. Returns the
 * state it recorded into (the primary issue's artifact path is stored on the
 * pipeline state for the back-compat readers that look there).
 */
export async function prepareExploreBodies(args: {
  ctx: CycleContext;
  state: WorkState;
  issues: number[];
  bodySettled: Array<PromiseSettledResult<{ stdout: string }>>;
}): Promise<ExploreBodies> {
  const { ctx, issues, bodySettled } = args;
  let next = args.state;
  const bodies: ExploreBodies["bodies"] = [];
  const emptyBodyIssues: EmptyBodyIssue[] = [];

  for (let i = 0; i < issues.length; i++) {
    const n = issues[i];
    if (n === undefined) continue;
    const result = bodySettled[i];
    if (result?.status === "fulfilled") {
      const body = result.value.stdout;
      if (!body.trim()) {
        emptyBodyIssues.push({
          issue: n,
          reason:
            "gh issue view returned empty stdout on every attempt (possible projectCards GraphQL deprecation, gh extension hijack, or auth lapse)",
        });
        continue;
      }
      // Claim-check artifact (best-effort). A single-issue cycle keeps the legacy
      // "issue-body" name so back-compat readers still find it.
      let artifactPath: string | undefined;
      try {
        const artifactName = issues.length === 1 ? "issue-body" : `issue-body-${n}`;
        artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, artifactName, body);
        if (n === ctx.issue) {
          next = {
            ...next,
            pipelineState: { ...next.pipelineState, issueBodyArtifact: artifactPath },
          };
        }
      } catch (err) {
        trace(
          `work-driver: failed to persist issue-body artifact for #${n}: ${(err as Error).message}`,
        );
      }
      const { text, truncated } = inlineBody(body, INLINE_BODY_CAP);
      const shown = truncated
        ? `${text}\n[... truncated; full body at ${artifactPath ?? "(artifact write failed)"}]`
        : text;
      bodies.push({ issue: n, body: shown, truncated });
    } else if (result?.status === "rejected") {
      const reason = (result.reason as Error).message?.slice(0, 200) ?? "(no error message)";
      trace(`work-driver: gh issue view ${n} failed after every attempt: ${reason}`);
      emptyBodyIssues.push({
        issue: n,
        reason: `gh issue view rejected on every attempt: ${reason}`,
      });
    }
  }
  return { state: next, bodies, emptyBodyIssues };
}

/** The halt every failed body earns: the cycle stops before any explore dispatch. */
export function appendBodiesEmpty(state: WorkState, emptyBodyIssues: EmptyBodyIssue[]): WorkState {
  return appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, emptyBodyIssues } },
    {
      kind: "cap-hit",
      at: Date.now(),
      cap: "explore-bodies-empty",
      reviewRound: 0,
      nextStep: "handoff",
    },
  );
}
