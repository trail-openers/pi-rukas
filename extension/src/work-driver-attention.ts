/**
 * work-driver-attention — read the signal the driver has only ever written.
 *
 * When a cycle hits the review cap it hands off: posts an artifact, and labels
 * the issue `needs-human-attention`. Ten references to that label exist and all
 * ten write it. Nothing has ever read it back.
 *
 * So `/work N` on an issue a previous cycle gave up on quietly starts the whole
 * pipeline again — same issue body, same cap, same handoff — and the human the
 * label was addressed to is never consulted. In the incident that motivated
 * this, a PM noticed by hand, killed the cycle, could not restart it, and
 * reimplemented the driver by hand: no state file, no queue, no handoff, no
 * review-cap timer, and a branch the driver knew nothing about.
 *
 * `--restart` is the override, and it is the right one: it already means "I
 * have revised the issue, start clean", which is exactly what a human resolving
 * the flag would do.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";

const execp = promisify(exec);

export const ATTENTION_LABEL = "needs-human-attention";

export interface AttentionVerdict {
  /** True when the cycle must not start. */
  refuse: boolean;
  /** Operator-facing, only when `refuse`. */
  message?: string;
  /** False when the label could not be read at all — disclosed, never silent. */
  checked: boolean;
}

/** Label names from `gh issue view --json labels`. Never throws. */
export function parseLabels(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { labels?: Array<{ name?: unknown }> };
    return (parsed.labels ?? [])
      .map((l) => l?.name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/**
 * Judge a label set. Pure, so the decision is testable without a network call.
 *
 * `restart` is checked first: an operator who passed it has already answered
 * the question the label asks.
 */
export function judgeAttention(
  issue: number,
  labels: string[],
  opts: { restart?: boolean } = {},
): AttentionVerdict {
  if (opts.restart === true) return { refuse: false, checked: true };
  if (!labels.includes(ATTENTION_LABEL)) return { refuse: false, checked: true };
  return {
    refuse: true,
    checked: true,
    message: [
      `pi-ensemble: /work for issue #${issue} refused — it is labelled \`${ATTENTION_LABEL}\`.`,
      "",
      "A previous cycle hit the review cap and handed this off for a human to look at.",
      "Re-running it unchanged reproduces the same handoff: same issue body, same cap.",
      "",
      "Once you have addressed the handoff (revise the issue via /plan, or edit it",
      "directly), start a clean cycle:",
      `  /work ${issue} --restart`,
      "",
      "Or, if the label is stale:",
      `  gh issue edit ${issue} --remove-label ${ATTENTION_LABEL}`,
    ].join("\n"),
  };
}

/**
 * Read the issue's labels and judge them.
 *
 * An unreadable result does NOT refuse. The gate exists to stop repeating work
 * a human flagged, and every later step of the cycle needs `gh` anyway — a
 * `gh` that cannot answer here will fail the branch step minutes later with a
 * clearer error. But it does not silently approve either: `checked: false` is
 * returned so the caller can say the check did not run.
 */
export async function checkAttentionLabel(
  repoRoot: string,
  issue: number,
  opts: { restart?: boolean } = {},
): Promise<AttentionVerdict> {
  if (opts.restart === true) return { refuse: false, checked: true };
  try {
    const { stdout } = await execp(`gh issue view ${issue} --json labels`, { cwd: repoRoot });
    return judgeAttention(issue, parseLabels(stdout), opts);
  } catch (err) {
    trace(`work-driver: could not read labels for #${issue}: ${(err as Error).message}`);
    return { refuse: false, checked: false };
  }
}
