import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type RunningState, renderSingle } from "./progress.ts";
import { spawnSpecialist } from "./spawn.ts";
import type { AdversarialVerdict } from "./types.ts";

const MAX_ROUNDS = 3;

type ToolUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}) => void;

/**
 * Runs an adversarial review loop:
 *   1. Spawn adversarial-developer on the diff
 *   2. If APPROVED → return ok
 *   3. Otherwise dispatch developer for fix, refetch diff, re-adversarial
 *   4. Max 3 rounds; on round 4, escalate to user.
 *
 * The caller is responsible for producing the diff string (the prompt template
 * obtains it via `git diff` in the appropriate worktree). The loop does NOT
 * refetch the diff itself — that's the prompt's job — but it does feed each
 * round's findings into the next developer dispatch.
 */
export function registerAdversarialTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "adversarial_loop",
    label: "Adversarial Loop",
    description:
      "Run the mandatory adversarial gate: adversarial review → developer fix → re-review, up to 3 rounds. Returns APPROVED or escalates.",
    parameters: Type.Object({
      diff: Type.String({ description: "Current diff to review (git diff output)." }),
      context: Type.String({
        description: "Brief description of what changed and why; passed to adversarial.",
      }),
      workCwd: Type.Optional(
        Type.String({
          description: "Worktree or repo path where developer should apply fixes.",
        }),
      ),
    }),
    async execute(_id, raw, signal, onUpdate) {
      const params = raw as { diff: string; context: string; workCwd?: string };
      const rounds: Array<{ round: number; verdict: AdversarialVerdict; ms: number }> = [];
      const currentDiff = params.diff;
      const update = onUpdate as ToolUpdateCallback | undefined;
      const emit = (round: number, phase: "adversarial" | "developer", state: RunningState) => {
        if (!update) return;
        const header = `adversarial_loop · round ${round}/${MAX_ROUNDS} · ${phase}`;
        update({
          content: [{ type: "text", text: `${header}\n${renderSingle(state)}` }],
          details: { round, phase, state: { ...state, usage: { ...state.usage } } },
        });
      };

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (signal?.aborted) break;
        const adv = await spawnSpecialist(
          {
            role: "adversarial-developer",
            prompt: buildAdversarialPrompt(currentDiff, params.context, round),
          },
          { signal, onProgress: (state) => emit(round, "adversarial", state) },
        );

        const verdict = parseVerdict(adv.text);
        rounds.push({ round, verdict, ms: adv.ms });

        if (verdict.status === "APPROVED") {
          return {
            content: [
              {
                type: "text",
                text: `Adversarial APPROVED after round ${round}.`,
              },
            ],
            details: { ok: true, finalRound: round, rounds },
          };
        }

        if (round === MAX_ROUNDS) break;

        // Dispatch developer to fix
        await spawnSpecialist(
          {
            role: "developer",
            prompt: buildFixPrompt(verdict.findings, params.context),
            cwd: params.workCwd,
          },
          { signal, onProgress: (state) => emit(round, "developer", state) },
        );

        // NOTE: caller must refetch diff between rounds; for P1 we re-use the
        // passed-in diff as developer is expected to update in place. P2 will
        // refetch via a worktree-aware helper.
      }

      const lastRound = rounds[rounds.length - 1];
      return {
        content: [
          {
            type: "text",
            text: `❌ Adversarial rejected after ${MAX_ROUNDS} rounds. Last verdict: ${lastRound?.verdict.status}\n\n${lastRound?.verdict.findings}\n\nHalt workflow and ask user for guidance.`,
          },
        ],
        details: { ok: false, finalRound: MAX_ROUNDS, rounds },
      };
    },
  });
}

function buildAdversarialPrompt(diff: string, context: string, round: number): string {
  return `You are reviewing the diff below. Context: ${context}\nRound: ${round} of ${MAX_ROUNDS}.

Attack this implementation. Find edge cases, security holes, race conditions, API misuse, flawed assumptions. Run lint/type/test if any. Return a verdict line at the end exactly matching one of:
  VERDICT: APPROVED
  VERDICT: ISSUES_FOUND
  VERDICT: CRITICAL_ISSUES_FOUND

Diff:
\`\`\`diff
${diff}
\`\`\``;
}

function buildFixPrompt(findings: string, context: string): string {
  return `Fix the following adversarial review findings. Original context: ${context}\n\nFindings:\n${findings}\n\nMake the minimal changes needed to address every finding. Run local quality gates before returning.`;
}

function parseVerdict(text: string): AdversarialVerdict {
  const m = text.match(/VERDICT:\s*(APPROVED|ISSUES_FOUND|CRITICAL_ISSUES_FOUND)/);
  const status = (m?.[1] ?? "ISSUES_FOUND") as AdversarialVerdict["status"];
  return { status, findings: text, raw: text };
}
