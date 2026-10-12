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
 * A match requires an invocation shape (a JS runtime naming a protected file,
 * or the script run directly) or the findings data file itself. Plain git/gh
 * commands (no shell operator, no line break) are never matched, so a commit
 * message or PR body naming the feature is left alone; a test run is matched
 * only when it carries an eval flag or names the operator script. The raw command is scanned, not
 * the quote-stripped one, so quoting the path does not hide it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

/** A JS runtime, then anything, then a protected name. */
const RUNTIME = String.raw`\b(?:bun|bunx|node|npx|tsx|ts-node|deno)\b[^\n]*?`;
/**
 * The operator script, the write module, the store module or the findings
 * file, by name. A name that is only the tail of a longer one (`test-review-
 * accept.ts`, `test-review-findings-store.ts`) does not count.
 */
const NAMES = String.raw`(?<![\w-])(?:review-accept-row|review-accept|review-findings-store|review-findings\.json)(?:\.ts)?(?![\w.-])`;
const RUNTIME_NAME = new RegExp(`${RUNTIME}${NAMES}`);
/** The findings data file, named in any command (cat, cp, sed, a heredoc). */
const DATA_FILE = /(?<![\w-])review-findings\.json/;
/** The script run directly by path as the first word, e.g. `./review-accept.ts`. */
const DIRECT_RUN = /^\s*(?:\S*\/)?review-accept(?:\.ts)?(?=\s|$)/;
/**
 * Plain git/gh: no shell operator and no line break, so the whole command is one
 * git/gh invocation whose arguments are text (a commit message may name the store).
 */
const PLAIN_VCS = /^\s*(?:git|gh)\s[^;&|`$<>\n\r]*$/;
/** A test run (bun test / verify-loop): no shell operator and no line break. */
const TEST_RUN = /^\s*(?:bun\s+test|bash\s+\S*verify-loop\.sh)\s[^;&|`$<>\n\r]*$/;
/**
 * An eval flag: the runtime then executes code named on the command line. A
 * preload (`--preload`, `-r`, `--require`) runs a named module before the test
 * run, so it is the same route round the guard and is treated the same way.
 */
const EVAL = /(?:^|\s)(?:-e|--eval|-r|--require|--preload)(?=\s|=|$)/;
/** The operator script or its write module, named in a command. */
const SCRIPT = /(?<![\w-])review-accept(?:-row)?(?:\.ts)?(?![\w.-])/;
/** Edit tools whose `path` argument is checked against the findings file. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/** The findings file and its tmp / corrupt-copy siblings, by basename. */
const FINDINGS_BASENAME = /^review-findings\.json(?:\.|$)/;

/** The matched invocation when a command runs review-accept or names the store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  if (PLAIN_VCS.test(command)) return undefined;
  // A test run may name the store's files by glob (a read-only suite); it may not
  // name the operator's script, and it may not carry an eval flag.
  if (TEST_RUN.test(command) && !EVAL.test(command) && !SCRIPT.test(command)) return undefined;
  const m = RUNTIME_NAME.exec(command) ?? DIRECT_RUN.exec(command) ?? DATA_FILE.exec(command);
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
