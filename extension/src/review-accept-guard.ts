/**
 * review-accept-guard — the mode-independent refusal of agent-run review
 * acceptance and of agent writes to the review findings store (#1105).
 *
 * Accepting a recorded review finding suppresses it from every later round, so
 * it must stay a human act: the operator runs `extension/scripts/review-accept.ts`
 * in a terminal. This hook refuses, in every mode and for every role:
 *   - a bash command that runs that script (JS runner or `/review-accept` path);
 *   - a bash command that mentions the findings file (`review-findings.json`),
 *     the store module (`review-findings-store`) or the write module
 *     (`review-accept-row`) — the eval and heredoc routes around the script;
 *   - an edit / write / multiedit whose target is the findings file (or one of
 *     its `.tmp` / `.corrupt` siblings).
 *
 * ADVISORY, not a security boundary. Every rule is a string match on the
 * command or the target path. Quote-splitting, a variable expanded later, or a
 * shell redirect can still reach the file, and in trust mode an agent with a
 * shell can always do so. It exists to stop an agent that is not trying to
 * bypass it. The real boundary is the operator's terminal.
 *
 * A match requires an invocation shape or a store mention. A bare word in
 * prose — a commit message or PR body naming the feature — is not an
 * invocation and is left alone. The raw command is scanned, not the
 * quote-stripped one, so quoting the path does not hide it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

const RUNNER_INVOCATION =
  /\b(?:bun|bunx|tsx|node|npx|ts-node)\s+(?:run\s+)?(?:--?\S+\s+)*["'`]?(?:[^\s"'`;&|]*\/)?review-accept(?:\.ts)?(?=[\s'"`;&|]|$)/;
const SCRIPT_PATH = /\/review-accept(?:\.ts)?(?=[\s'"`;&|]|$)/;
/** Any mention of the store, its findings file or the write module. */
const STORE_MENTION = /review-findings\.json|review-findings-store|review-accept-row/;
/** Edit tools whose `path` argument is checked against the findings file. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/** The findings file and its tmp / corrupt-copy siblings, by basename. */
const FINDINGS_BASENAME = /^review-findings\.json(?:\.|$)/;

/** The matched invocation when a command runs review-accept or names the store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  const m =
    RUNNER_INVOCATION.exec(command) ?? SCRIPT_PATH.exec(command) ?? STORE_MENTION.exec(command);
  return m?.[0].trim();
}

/** The target path when an edit-style call would write the findings file, else undefined. */
export function editsFindingsFile(toolName: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const target = (input as { path?: unknown } | null)?.path;
  if (typeof target !== "string") return undefined;
  const base = target.split(/[\\/]/).pop() ?? "";
  return FINDINGS_BASENAME.test(base) ? target : undefined;
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string })?.command ?? "";
      if (!runsReviewAccept(command)) return;
      trace("review-accept-guard: BLOCKED agent-run finding acceptance (mode-independent)");
      return {
        block: true,
        reason:
          "Accepting a review finding is an operator act. Agents may not run extension/scripts/review-accept.ts or touch the review findings store; the operator runs review-accept.ts in a terminal with `--reason`.",
      };
    }
    const target = editsFindingsFile(event.toolName, event.input);
    if (!target) return;
    trace(`review-accept-guard: BLOCKED ${event.toolName} of the review findings file`);
    return {
      block: true,
      reason: `The review findings file (${target}) is written only by the operator's review-accept.ts. Agents may not edit it.`,
    };
  });
}
