/**
 * work-driver-explain-toolchain — the operator sentence for the
 * `toolchain-unsound` cap (#1879), split out of work-driver-explain.ts so that
 * file stays under the AGENTS.md §12 size cap. Same shape as every sibling
 * `work-driver-explain-*.ts`: one cap family, one pure formatter.
 */

import { TOOLCHAIN_UNSOUND_ADVICE } from "./work-driver-toolchain-canary.ts";
import { lastCapHit } from "./workflow-state-cap.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * The compiler was PROVEN unsound, so every green typecheck this cycle
 * reported is void. The operator's action is a reinstall, not a diff: naming
 * the diff would send them to code the gate never judged.
 */
export function explainToolchainUnsound(state: WorkState): string {
  const hit = lastCapHit(state, "toolchain-unsound");
  const ev = hit?.evidence ?? TOOLCHAIN_UNSOUND_ADVICE;
  return `the pinned type-checker failed its canary — ${ev}`;
}
