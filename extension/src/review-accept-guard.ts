/**
 * review-accept-guard — the mode-independent refusal of agent-run review
 * acceptance (#1105).
 *
 * Accepting a recorded review finding suppresses it from every later round, so
 * it must stay a human act: the operator runs `extension/scripts/review-accept.ts`
 * in a terminal. No agent may run that script. The permission layers cannot say
 * so — the `oo bun *` allowlist entry would permit it — so this hook refuses any
 * bash command that names the script, in every mode, the way the issue-creation
 * guard refuses `gh issue create`.
 *
 * The raw command is scanned, not the quote-stripped one: a quoted path is still
 * a path that runs the script, and a false positive on `echo review-accept` is a
 * cheap price for not being bypassable with quotes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

/** The matched script name when a command runs review-accept, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  return /(?:^|[\s;&|/'"`(])review-accept(?:\.ts)?(?=[\s'"`);&|]|$)/.exec(command)?.[0].trim();
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    const hit = runsReviewAccept(command);
    if (!hit) return;
    trace("review-accept-guard: BLOCKED agent-run finding acceptance (mode-independent)");
    return {
      block: true,
      reason:
        "Accepting a review finding is an operator act. Agents may not run extension/scripts/review-accept.ts; the operator runs it in a terminal with `--reason`.",
    };
  });
}
