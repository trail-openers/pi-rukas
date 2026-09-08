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
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
import { trace } from "./trace.ts";

const execp = promisify(exec);

export const ATTENTION_LABEL = "needs-human-attention";

/**
 * Resolve the forge adapter for the attention gate (#612 S4 task-b).
 *
 * The gate runs before any dispatch is paid for, so there is no cycle
 * context to carry a `Forge` in — build one per check (detection is a
 * cached-free, cheap local git read; the check itself is one `issue view`
 * per issue in the group). `PI_ENSEMBLE_FORGE=none` refuses the forge
 * path; unknown detection falls back to raw `gh` exec, which is the
 * pre-migration behaviour — the gate keeps working on every repo shape.
 */
export async function attentionForge(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  try {
    const det = await detectForge(repoRoot, {});
    if (det.forge === "unknown") return undefined;
    return createForge(det, { cwd: repoRoot });
  } catch {
    return undefined;
  }
}

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
      `pi-rukas: /work for issue #${issue} refused — it is labelled \`${ATTENTION_LABEL}\`.`,
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
  opts: { restart?: boolean; issues?: number[]; forge?: Forge } = {},
): Promise<AttentionVerdict> {
  if (opts.restart === true) return { refuse: false, checked: true };
  // EVERY issue in the group, not just the primary. `claimCycle` keys the
  // in-process registry on all of them — this check was written on the
  // adjacent line and keyed on one, so a grouped cycle for #10+#11 where #11
  // carried the label proceeded anyway, which is the exact case the label
  // exists to stop.
  const all = [...new Set([issue, ...(opts.issues ?? [])])];
  const forge = opts.forge ?? (await attentionForge(repoRoot));
  if (!forge) return { refuse: false, checked: false };
  let anyUnchecked = false;
  for (const n of all) {
    try {
      const labels = (await forge.issueView(n)).labels ?? [];
      const names = labels.map((l) => l.name).filter((x): x is string => typeof x === "string");
      const verdict = judgeAttention(n, names, opts);
      if (verdict.refuse) return verdict;
    } catch (err) {
      trace(`work-driver: could not read labels for #${n}: ${(err as Error).message}`);
      anyUnchecked = true;
    }
  }
  return { refuse: false, checked: !anyUnchecked };
}
