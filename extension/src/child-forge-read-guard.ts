/**
 * child-forge-read-guard.ts — the mode-independent `tool_call` hook that refuses a
 * helper child's read of the operator's forge config directories (#2638).
 *
 * The field report: a developer child told to make one small forge write found its
 * `glab` unauthenticated (its config roots pointed at the per-child empty dir, as
 * designed), worked around it by UNSETTING `GLAB_CONFIG_DIR`, and read the
 * operator's glab config file — which put a plaintext token, including for
 * unrelated hosts, into the agent context and the transcript. The env strip
 * (`child-forge-env.ts`) removes the ambient login and never claimed to be a
 * fence; a child that edits its own env was always able to walk back the redirect.
 * Nothing refused the READ. This hook does, in the same shape as its siblings
 * (`memory-write-guard.ts`, `write-fence-reviewer.ts`): registered in the shared
 * mode-independent block, ahead of every trust/sandbox bypass, because a guard
 * placed after them never runs in the modes that are the default.
 *
 * Who is judged: every role EXCEPT ops (decision 12). `ops` is the role that keeps
 * its login and runs `gh`/`glab` itself, so it is exempt. An ABSENT or
 * unrecognised role is treated as non-ops and judged — the rule fails closed, so a
 * spawn that forgot to stamp a role gets protection rather than a pass.
 *
 * What is judged: a bash command's words and a `read` tool's path, each in both
 * its lexical and its OS-resolved form (a symlink onto a protected directory is
 * refused whichever name was spelled), its heredoc bodies, its option values
 * (`--file=…`, `if=…`), the directory an earlier `cd` / `git -C` / `env -C` moved
 * it to, a `file://` URL, an interpreter's program word wherever it sits, and a
 * copy or archive whose SOURCE is a PARENT of a protected root. The judge is
 * `child-forge-read-judge.ts` and the refusal text is the one constant in
 * `forge-read-refusal.ts`, shared with the CLI wrapper.
 *
 * The path set is NOT read from this process's env (decision 4): it arrives as
 * harness-owned data, `PI_ENSEMBLE_FORGE_PROTECTED_PATHS`, which the parent
 * computed from the PARENT's env plus the passwd home. Unsetting or re-pointing
 * `GH_CONFIG_DIR`/`GLAB_CONFIG_DIR` in the child therefore changes nothing this
 * hook sees. A child whose env carries no set is refused (see
 * `protectedForgePathsFromChild`), because "no set" and "no rule" must not read
 * the same.
 *
 * A symlink a CHILD CREATES at a protected path is not this hook's to catch — the
 * glab and gh config files now sit in the operator-config snapshot
 * (`spawn-operator-config.ts`), which restores whatever the child left there.
 *
 * A guardrail against a child's own bad judgement, not a security boundary. The
 * classes it does not cover, stated rather than left to be discovered: a direct
 * `node:fs` read inside a codemode SCRIPT (a script call is not a tool call, so no
 * child hook sees it — only a codemode call ROUTED with `parentToolCallId` reaches
 * this hook, and it is covered like any other); a path assembled at run time inside
 * an interpreter; any read made outside the child's tool calls. A child determined
 * to disclose a credential can reach it, and rotating tokens an operator's forge
 * account exposed is the operator's remedy.
 */

import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ForgeReadHit,
  type ProtectedDir,
  commandNamesForgePath,
  firstForgeReadInCommand,
  firstForgeReadInToolCall,
} from "./child-forge-read-judge.ts";
import {
  FORGE_PROTECTED_HOMES_ENV,
  FORGE_PROTECTED_PATHS_ENV,
  protectedForgeHomesFromChild,
  protectedForgePathsFromChild,
} from "./child-forge-read-roots.ts";
import { forgeReadRefusalText, roleKeepsForgeLogin } from "./forge-read-refusal.ts";
import { bashCommandOf } from "./memory-write-guard.ts";
import { traceWarn } from "./trace.ts";

/** The log token: the rule's record never carries the path it refused. */
export const FORGE_READ_LOG_TOKEN = "(forge config read)";

/**
 * The refusal one child sees. `available` is the caller's answer to "does this
 * child have `forge_read`?" — `undefined` asks the child's own env through the
 * tool's single availability predicate.
 */
export function forgeReadGuardRefusal(available?: boolean): { block: true; reason: string } {
  return { block: true, reason: forgeReadRefusalText(available) };
}

/** Judge one tool call for a non-ops child; `dirs` is the harness-owned protected set. */
export function forgeReadVerdict(
  toolName: string,
  input: unknown,
  dirs: readonly ProtectedDir[] | undefined,
  cwd: string = process.cwd(),
  homes: readonly string[] = [],
): ForgeReadHit | "no-set" | undefined {
  if (dirs === undefined) return "no-set";
  if (toolName === "bash") {
    const command = bashCommandOf(input);
    if (command === "") return undefined;
    return firstForgeReadInCommand(command, cwd, dirs, homes);
  }
  return firstForgeReadInToolCall(toolName, input, cwd, dirs, homes);
}

/**
 * Register the rule for this child. Registered for EVERY child except the role
 * that keeps its login, with no env switch of its own: the sibling guards'
 * hatches (`PI_ENSEMBLE_WRITE_FENCE`, `PI_ENSEMBLE_CHILD_ROLE_ENV`) belong to
 * other rules, and an escape hatch here would reopen the credential disclosure
 * by way of a debugging flag.
 *
 * `dirs`/`env`/`cwd` are injectable so the suite can point the rule at a fixture
 * home; production reads the harness-owned set and the child's own cwd.
 */
export function registerForgeReadGuard(
  pi: ExtensionAPI,
  deps: {
    dirs?: readonly ProtectedDir[] | undefined;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** The homes a leading `~` may stand for (the parent published them; see `tildeForms`). */
    homes?: readonly string[];
    /** The directory the child's own `HOME` names, for a `~` a harness never redirected. */
    childHome?: string;
  } = {},
): void {
  const env = deps.env ?? process.env;
  const role = env.PI_ENSEMBLE_ROLE;
  if (roleKeepsForgeLogin(role)) {
    traceWarn(`child-forge-read-guard: exempt role (${role}) — no rule registered`);
    return;
  }
  // A direct array is the suite's lever; production leaves it undefined and the set
  // comes from the child's env, as the parent left it. An array with NO entries in
  // it is not a judgement with nothing in it — it is the rule having silently stopped
  // protecting, so it refuses the same way an absent set does.
  const dirs = deps.dirs ?? protectedForgePathsFromChild(env);
  const protectedSet = dirs !== undefined && dirs.length === 0 ? undefined : dirs;
  const cwd = deps.cwd ?? process.cwd();
  // The homes a `~` could mean. A reviewer or explore child's `HOME` is a scratch
  // tree the harness itself redirects, so the child's own env cannot answer this
  // question on its own — the parent's set does. The child's own home is included
  // as well: where no redirect happened, `~` genuinely means it, and a rule that
  // forgot it would refuse to judge the one home that is honestly named.
  const own = env.HOME;
  const ownHome = own !== undefined && own !== "" && path.isAbsolute(own) ? [own] : [os.homedir()];
  const homes = [...(deps.homes ?? protectedForgeHomesFromChild(env)), ...ownHome];
  // The refusal's route clause is decided at registration: the tool's presence in
  // this child's roster does not change mid-session, and asking once means the
  // guard and the wrapper answer from one reading of the predicate.
  const refusal = forgeReadGuardRefusal();
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash" && event.toolName !== "read") return;
    let verdict: ForgeReadHit | "no-set" | undefined;
    try {
      verdict = forgeReadVerdict(event.toolName, event.input, protectedSet, cwd, homes);
    } catch (err) {
      // An internal fault is a refusal too: the call was not judged, so it does not run.
      const why = (err as Error).message;
      traceWarn(`child-forge-read-guard: could not judge this call: ${why}`);
      return {
        block: true,
        reason: `Refused: the forge-config read rule could not judge this call (${why}), and an unjudged read of a credential tree does not run. ${forgeReadRefusalText()}`,
      };
    }
    if (verdict === undefined) return;
    if (verdict === "no-set") {
      // The fail-closed reading is scoped to the command that actually names a
      // config-directory spelling. Judging nothing and then refusing EVERY call
      // would break every helper (and every test) whose spawn carried no set;
      // judging nothing and then passing the call through would be the silent pass
      // this rule exists to close. So: the set is missing, and this call could have
      // been the read, so it does not run. A call that names no such path is not
      // the thing the rule protects and is left alone.
      const names = commandNamesForgePath(event.toolName, event.input, cwd, homes);
      if (!names) return;
      traceWarn(
        "child-forge-read-guard: no harness-owned protected set in this child's env — refusing a call that names a forge config path",
      );
      return {
        block: true,
        reason: `Refused: this child carries no harness-owned forge-config protection set, and this call names a forge config directory, so it cannot be judged and does not run. Ask the PM to re-dispatch. ${refusal.reason}`,
      };
    }
    traceWarn(`child-forge-read-guard: refused a read of the ${verdict.forge} config directory`);
    return refusal;
  });
}
