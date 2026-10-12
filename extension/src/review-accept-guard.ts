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
 * A match requires an invocation shape: a JS runner (bun/bunx/tsx/node/npx)
 * directly before the script, or a `/review-accept` path. A bare word in prose —
 * a commit message or PR body naming the feature — is not an invocation and is
 * left alone. The raw command is scanned, not the quote-stripped one, so quoting
 * the path does not hide it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

const RUNNER_INVOCATION =
  /\b(?:bun|bunx|tsx|node|npx|ts-node)\s+(?:run\s+)?(?:--?\S+\s+)*["'`]?(?:[^\s"'`;&|]*\/)?review-accept(?:\.ts)?(?=[\s'"`;&|]|$)/;
const SCRIPT_PATH = /\/review-accept(?:\.ts)?(?=[\s'"`;&|]|$)/;
/**
 * A JS runner whose code calls acceptRow or names the findings file (`bun -e`,
 * `node -e`, a heredoc). This closes the eval route only; a shell write to the
 * JSON is still possible for an agent with shell access.
 */
const RUNNER_TOUCHES_STORE =
  /\b(?:bun|bunx|node|tsx|npx|ts-node)\b[\s\S]*?\b(?:acceptRow|review-findings\.json)\b/;

/** The matched invocation when a command runs review-accept, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  const m =
    RUNNER_INVOCATION.exec(command) ??
    SCRIPT_PATH.exec(command) ??
    RUNNER_TOUCHES_STORE.exec(command);
  return m?.[0].trim();
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
