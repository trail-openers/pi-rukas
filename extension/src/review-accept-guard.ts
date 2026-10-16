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
 * ADVISORY, not a security boundary. The OPERATOR'S TERMINAL is the boundary:
 * every rule here is a string match on the command text or the target path,
 * and a string match is not a fence.
 *
 * WHAT IT COVERS:
 *   - a JS runtime (bun/node/npx/tsx/deno…) naming the operator script, the
 *     write module, the store module or the findings file, whether the name
 *     sits on the same line as the runtime or on a later one — a here-doc body
 *     or a piped stdin program counts, because the command is scanned line by
 *     line and the runtime only has to appear somewhere in it (#1125);
 *   - `bun -` / `node -` reading a program from stdin, and the `-e` / `--print`
 *     eval forms, in a command that also names the store: the program body
 *     never appears in the command string, so the runtime plus the store route
 *     is refused on its own (#1125);
 *   - any command that names the findings data file outright (cat, cp, sed, a
 *     heredoc, a redirect);
 *   - plain git/gh commands that carry `--output` / `-o` or `-c`. Those
 *     arguments make git itself write a file or run a shell alias, so the
 *     exemption below does not extend to them: the command is scanned like any
 *     other and naming the store decides the verdict (#1125);
 *   - an edit / write / multiedit whose target basename is the findings file
 *     or one of its `.tmp` / `.corrupt` siblings.
 *
 * WHAT IT DOES NOT COVER: quote-splitting, a variable expanded later, a shell
 * redirect, an obfuscated or composed path, or any of the ways a shell reaches
 * a file that never spells it out in the command string. It also cannot see a
 * here-doc or stdin body except for what the command itself names. In trust
 * mode an agent with a shell can always reach the file. It exists to stop an
 * agent that is not trying to bypass it.
 *
 * A match requires an invocation shape (a JS runtime naming a protected file,
 * or the script run directly) or the findings data file itself. Plain git/gh
 * commands (no shell operator, no line break, no file-writing argument) are
 * never matched, so a commit message or PR body naming the feature is left
 * alone; a test run is matched only when it carries an eval flag or names the
 * operator script. The raw command is scanned, not
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
 *
 * #1125: the optional `.ts` is matched, not rejected. The old form was
 * `name(?:\.ts)?(?![\w.-])`, whose lookahead refused a name followed by
 * `.ts` — so the `.ts` branch could never match and a path-qualified module
 * import (`import "./src/review-findings-store.ts"`) was invisible to the
 * guard. That is precisely the route a here-doc or stdin program uses. The
 * bare name still must not match the tail of a longer one, which is what the
 * lookbehind's `-` is for; a slash is the separator an import always carries,
 * so a slashed name still names the module.
 */
const NAMES = String.raw`(?<![-\w])(?:(?:review-accept-row|review-accept|review-findings-store|review-findings\.json)(?:\.ts)?|review-findings\.json)(?![\w-])`;
const RUNTIME_NAME = new RegExp(`${RUNTIME}${NAMES}`);
/** The findings data file, named in any command (cat, cp, sed, a heredoc). */
const DATA_FILE = /(?<![-\w])review-findings\.json/;
/**
 * #1125 — the runtime, anywhere in the command. The old scan required the
 * runtime and the store name on one line, so a here-doc body (runtime on line
 * one, `import` on line two) and a piped `bun -` both walked through. Paired
 * with STORE_MENTION below: the runtime may be on any line, so long as the
 * command also names the store.
 */
const RUNTIME_WORD = /\b(?:bun|bunx|node|npx|tsx|ts-node|deno)\b/;
/**
 * #1125 — the store module or its data file, anywhere in the command: the
 * other half of the cross-line runtime test, and the whole test for a
 * runtime that reads its program from stdin. Same trailing rule as NAMES —
 * the `.ts` suffix is matched, not rejected.
 */
const STORE_MENTION = /(?<![-\w])(?:review-findings\.json|review-findings-store(?:\.ts)?)(?![\w-])/;
/** The script run directly by path as the first word, e.g. `./review-accept.ts`. */
const DIRECT_RUN = /^\s*(?:\S*\/)?review-accept(?:\.ts)?(?=\s|$)/;
/**
 * Plain git/gh: no shell operator and no line break, so the whole command is one
 * git/gh invocation whose arguments are text (a commit message may name the store).
 */
const PLAIN_VCS = /^\s*(?:git|gh)\s[^;&|`$<>\n\r]*$/;
/**
 * #1125 — a git/gh argument that makes git itself write a file, or run
 * arbitrary code: `--output` / `-o` redirect the object git prints to disk
 * (`git show HEAD:x --output=review-findings.json`) and `-c` sets a config
 * value, including `alias.x='!…'`, which executes a shell command
 * (`git -c alias.x='!cat review-findings.json' x`). The plain-vcs exemption
 * exists so prose arguments — a commit message, a PR body — are left alone.
 * Those arguments cannot write anything; an argument that can does not get the
 * exemption. The command is scanned like any other, and naming the store is
 * what decides the verdict — a git command with these flags that names no
 * store path stays allowed.
 */
const VCS_WRITES = /(?:^|\s)(?:--output(?:=\S*)?|-o\b|-c\b)/;
/** A test run (bun test / verify-loop): no shell operator and no line break. */
const TEST_RUN = /^\s*(?:bun\s+test|bash\s+\S*verify-loop\.sh)\s[^;&|`$<>\n\r]*$/;
/**
 * An eval flag: the runtime then executes code named on the command line. A
 * preload (`--preload`, `-r`, `--require`) runs a named module before the test
 * run, so it is the same route round the guard and is treated the same way.
 */
const EVAL = /(?:^|\s)(?:-e|--eval|-r|--require|--preload)(?=\s|=|$)/;
/**
 * The operator script or its write module, named in a command. Same trailing
 * rule as NAMES: `review-accept.ts` matches, and the `.ts` suffix is not the
 * thing that disqualifies a name (#1125).
 */
const SCRIPT = /(?<![-\w])review-accept(?:-row)?(?:\.ts)?(?![\w-])/;
/** Edit tools whose `path` argument is checked against the findings file. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/** The findings file and its tmp / corrupt-copy siblings, by basename. */
const FINDINGS_BASENAME = /^review-findings\.json(?:\.|$)/;

/** The matched invocation when a command runs review-accept or names the store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  // #1125 — the plain-git/gh exemption is revoked by an argument that makes
  // git write a file or run an alias; everything else about the command is
  // judged by the ordinary scan below.
  if (PLAIN_VCS.test(command) && !VCS_WRITES.test(command)) return undefined;
  // A test run may name the store's files by glob (a read-only suite); it may not
  // name the operator's script, and it may not carry an eval flag.
  if (TEST_RUN.test(command) && !EVAL.test(command) && !SCRIPT.test(command)) return undefined;
  const m = RUNTIME_NAME.exec(command) ?? DIRECT_RUN.exec(command) ?? DATA_FILE.exec(command);
  if (m) return m[0].trim();
  // #1125 — the cross-line route. The scan above keeps the runtime and the
  // protected name on one line, which is what a here-doc body and a program
  // piped into `bun -` walk around: the runtime is on the first line and the
  // `import` of the store is on a later one (or, for stdin, arrives from
  // somewhere the command string never shows). So when the command both runs
  // a JS runtime and names the store, it is refused whichever line each half
  // sits on. A plain `git`/`gh` never satisfies the runtime half, so a commit
  // message naming the store stays allowed.
  if (RUNTIME_WORD.test(command) && STORE_MENTION.test(command)) {
    return RUNTIME_WORD.exec(command)?.[0];
  }
  return undefined;
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
