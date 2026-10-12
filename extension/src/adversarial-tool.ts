/**
 * adversarial-tool — the `adversarial_loop` tool registration (async gate).
 *
 * Split out of adversarial.ts (500-line cap). The loop itself lives in
 * adversarial.ts; this file only wraps it as an async PM-facing tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runAdversarialLoop } from "./adversarial.ts";
import { startJob } from "./async-jobs.ts";
import { computeRangeDiff } from "./review-diff.ts";

/**
 * Async adversarial gate: the orchestrator does sequential rounds internally
 * (adversarial → developer fix → re-adversarial, up to 3 rounds). From the PM's
 * POV the whole saga is one async dispatch: a job handle returns immediately,
 * and one consolidated report ("APPROVED after round N" or "REJECTED after 3
 * rounds") arrives as an [ensemble:async] user message when the loop ends.
 */
export function registerAdversarialTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "adversarial_loop",
    label: "Adversarial Loop",
    description:
      "Async adversarial gate: review → developer fix → re-review, up to 3 rounds. Returns a job handle immediately; the final verdict (APPROVED or REJECTED + findings) arrives as an [ensemble:async] message. End your turn after dispatching. `reportOnly: true` runs exactly one review: no developer dispatch, no file changes, verdict recorded as usual. Otherwise a round that needs a fix REQUIRES `workCwd` (the worktree fixes are applied in) — without it the loop stops after the verdict with an error naming workCwd, dispatching no developer. Fix developers always run in workCwd; changes to the calling repository during a fix round are reported as a violation.",
    parameters: Type.Object({
      diff: Type.Optional(
        Type.String({
          description:
            "Current diff to review (git diff output). Optional when base+head are given — then the diff is computed from the ref range; when both are given, this string wins.",
        }),
      ),
      context: Type.String({
        description: "Brief description of what changed and why; passed to adversarial.",
      }),
      base: Type.Optional(
        Type.String({
          description:
            "With head: ref for the diff computed as `git diff <base>...<head>` (three-dot, merge-base) in workCwd — preferred over pasting a large diff.",
        }),
      ),
      head: Type.Optional(
        Type.String({
          description:
            "Ref for the diff the tool computes itself (see base). Recomputed before every review round, so rounds 2+ see fixes.",
        }),
      ),
      workCwd: Type.Optional(
        Type.String({
          description:
            "Worktree/repo path where developer applies fixes and `git diff <base>...<head>` runs (defaults to process cwd). Required before any fix round (not needed with reportOnly).",
        }),
      ),
      reportOnly: Type.Optional(
        Type.Boolean({
          description:
            "When true: exactly one reviewer dispatch, zero fix-developer dispatches, zero file changes. Records the verdict and ledger entry as usual.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as {
        diff?: string;
        context: string;
        base?: string;
        head?: string;
        workCwd?: string;
        reportOnly?: boolean;
      };
      const { jobId } = startJob(pi, {
        label: "adversarial_loop",
        role: "adversarial-loop",
        // Each round spawns its own deck entry (adversarial review → developer
        // fix → re-review). A single umbrella row would just flicker between
        // sub-states; per-round entries show the actual child running now.
        skipDeck: true,
        work: (signal, hooks) =>
          runAdversarialLoop(
            { ...params, pi, guardFixRounds: true },
            signal,
            hooks.jobId,
            computeRangeDiff,
          ),
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async adversarial_loop job ${jobId}. Verdict will arrive as a [ensemble:async] user message. End your turn.`,
          },
        ],
        details: { jobId, role: "adversarial-loop", async: true },
      };
    },
  });
}
