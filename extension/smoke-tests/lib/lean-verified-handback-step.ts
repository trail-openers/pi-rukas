/**
 * lib/lean-verified-handback-step — the STEP half of the verified-handback rig.
 *
 * The log half (`lean-verified-handback-fixture.ts`) drives the engine and hands back
 * the step log a run wrote; the git half (`lean-verified-handback-repo.ts`) moves and
 * re-reads a real origin. This module joins them to the reporting step: the three
 * seams the handback is driven through — the real rewind, the real origin read, and
 * the post that captures the comment body.
 *
 * They live here, rather than duplicated in each of the two test files that drive the
 * step, because those files pin one rig's two surfaces: a second copy of "how the real
 * rewind is built" is a second definition of what the cases drove, and only the copy
 * the case happens to call would ever be checked.
 */

import {
  originBranchHead,
  type Rewind,
  rewindToVerified,
} from "../../src/lean/handback-rewind.ts";
import { handbackOutcome } from "../../src/lean/handback.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import {
  BRANCH,
  ISSUE,
  exec,
  handbackCtx,
} from "./lean-verified-handback-fixture.ts";

/**
 * The rewind seam the step-level cases drive: the real rewind over the real origin,
 * with the caller's executor and env — so a case watches git refuse, not a stub.
 */
export function rewinder(repoRoot: string): (verifiedHead: string) => Promise<Rewind> {
  return (verifiedHead) =>
    rewindToVerified(
      exec,
      { repoRoot, issue: ISSUE, run: { branch: BRANCH } } as never,
      verifiedHead,
    );
}

/**
 * The read seam the handback step is driven with: the real origin read over the real
 * executor, so the head the comment names is the head origin really holds.
 */
export function originReader(repoRoot: string) {
  return (ctx: { repoRoot: string; issue: number; run: { branch: string } }) =>
    originBranchHead(exec, ctx as never);
}

/**
 * Run the handback step, capturing every body its post seam was handed.
 *
 * One seam, both surfaces: the body the forge is handed and the body the host channel
 * publishes are the same string, so a case that captured only the outcome could pass
 * while printing nothing about heads.
 */
export async function driveHandback(
  steps: Step[],
  repoRoot: string,
  rewind: (verifiedHead: string) => Promise<Rewind>,
  readOrigin: (
    ctx: { repoRoot: string; issue: number; run: { branch: string } },
  ) => Promise<string | undefined> = originReader(repoRoot),
): Promise<{ outcome: Outcome; posts: string[] }> {
  const posts: string[] = [];
  const outcome = await handbackOutcome(
    handbackCtx(steps, repoRoot),
    async (_repoRoot, _issue, body) => {
      posts.push(body);
    },
    rewind,
    readOrigin,
  );
  return { outcome, posts };
}

/** One rendered line of the comment, for a failure message that shows the truth. */
export function bodyLine(body: string, prefix: string): string {
  return (
    body
      .split("\n")
      .find((l) => l.startsWith(prefix)) ?? `<no ${prefix} line>`
  );
}

/** What one rewind attempt settled on, spelled out for a failure message. */
export function showRewind(r: Rewind): string {
  return `${String(r.shipped)}${r.reason === undefined ? "" : `: ${r.reason}`}`;
}
