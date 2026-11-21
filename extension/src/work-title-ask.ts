/**
 * work-title-ask — the one follow-up a spec title gets: a short child resumed
 * on the explore child's own session, so the model that read the issue and the
 * code answers with the title alone.
 *
 * It is the adversarial verdict re-ask's child (same argv, env, bound and tool
 * fence), given the explore role; only the question differs. The answer's
 * length is checked by the caller (`settleSpecTitle`), never trusted.
 */

import { spawnVerdictReaskChild } from "./adversarial-verdict-reask-child.ts";
import { assertLiveSpawnAllowed } from "./spawn-support.ts";
import { trace } from "./trace.ts";

/** A one-line answer needs little time; a wedged provider must not hold explore open. */
const TITLE_ASK_BOUND_MS = 120_000;

/** The ask for one explore reply, or `undefined` when that reply left no session to resume. */
export function exploreTitleAsk(
  transcriptPath: string | undefined,
  cwd: string,
): ((prompt: string) => Promise<string | undefined>) | undefined {
  if (transcriptPath === undefined || transcriptPath === "") return undefined;
  return async (prompt) => {
    assertLiveSpawnAllowed("explore");
    const out = await spawnVerdictReaskChild({
      transcriptPath,
      role: "explore",
      cwd,
      boundMs: TITLE_ASK_BOUND_MS,
      prompt,
    });
    if (!out.ok) trace(`work-driver: spec title re-ask got no answer (${out.reason})`);
    return out.ok ? out.text : undefined;
  };
}
