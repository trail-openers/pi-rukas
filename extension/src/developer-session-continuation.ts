/**
 * developer-session-continuation — a SECOND prompt on a developer child's own session, for the
 * step that paid for the first one and got an unfinished turn back.
 *
 * Sibling of `adversarial-verdict-reask-child.ts`, and deliberately NOT that module: a verdict
 * re-ask resumes a REVIEWER, so its child args strip `write`/`edit`/`multiedit` (`excludeToolsFor`
 * for a reviewer role) and its prompt file refuses a non-reviewer role outright. A developer
 * continuation is the opposite requirement — the resumed child has to be able to finish the edit it
 * was cut off before making — so it carries the developer's OWN tool roster, the same write fence
 * the first child ran under, and `cwd` set to the tree the first child worked in. Reusing the
 * reviewer path would hand back a child that can read the findings and cannot answer them.
 *
 * Why a continuation and not a fresh dispatch: a second child is a second opinion, and it starts
 * with nothing — no diff read, no findings weighed, no files opened. The child that ran out of
 * output tokens halfway through its plan already did that reading, and its session file is the
 * record of it. `pi --mode rpc --session <transcriptPath>` plus one prompt resumes it in its own
 * conversation, exactly as the verdict re-ask and `work-driver-resume-reattach.ts` do.
 *
 * What makes the child a follow-up rather than a new dispatch, stated as rules:
 *
 * - the SAME role, so the same prompt file, the same model resolution and the same tool roster;
 * - the same write fence, so a resumed child cannot write where the fenced one could not;
 * - `cwd` = the tree the first child ran in — a child that resumes the session but starts in the
 *   parent's directory edits a checkout nobody will integrate;
 * - **the run's own permission stamp**, carried in as `workCycleTrust` by the caller that owns the
 *   run's mode, and turned into the child env here exactly as `spawnSpecialist` does through
 *   `applyChildPermissionEnv` (`PI_ENSEMBLE_TRUST_MODE=1`, and no inherited broker socket). This is
 *   why it is a value threaded from the run and never a process-global read here: an earlier shape
 *   of the lean stamp remembered the mode on the process, so a second run in one host inherited the
 *   first's trust;
 * - **the same kill semantics as the fixer**, which `spawnSpecialist` gives its review children
 *   through `processGroup: true`: the child leads its own group and every kill goes through
 *   `killProcessTree`, so the bound's SIGTERM reaches the grandchild its `bash` tool started rather
 *   than orphaning it in the fix tree;
 * - ONE prompt and then stdin closes: no deck row, no steer seam, no skill, no forwarded extension.
 *
 * `sessionFn` is the seam a test drives; production is {@link spawnDeveloperContinuationChild},
 * which owns the spawn, the bound and the reply extraction.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeReaskPromptFile } from "./adversarial-verdict-reask-child.ts";
import { forgeReadChildEnv } from "./child-forge-env.ts";
import { childGuardsArgs } from "./child-guards.ts";
import { CHILD_ROLE_ENV, childRoleEnvEnabled, childRoleEnvValue } from "./child-role-env.ts";
import { scrubGitLocation } from "./git-env.ts";
import { resolveModel } from "./models.ts";
import { getPiInvocation } from "./pi-binary-resolve.ts";
import { excludeToolsFor } from "./role-tools.ts";
import { ROLES, type RoleName } from "./roles.ts";
import { groupSpawnOpts, killProcessTree, leadsProcessGroup, registerChild } from "./spawn-kill.ts";
import { withOperatorConfigGuard } from "./spawn-operator-config.ts";
import { attachStdinErrorGuard } from "./stdin-guard.ts";
import { trace } from "./trace.ts";
import type { DispatchUsage } from "./types.ts";
import { workCycleTrustEnabled } from "./work-cycle-trust.ts";
import type { WriteFence } from "./write-fence-contract.ts";

/** The trace tag for every line this module writes — an operator reading a log decides from it
 *  whether a continuation was asked for at all, as distinct from a verdict re-ask. */
export const CONTINUATION_SOURCE_TAG = "developer-session-continuation";

/** How a continuation failed, for the trace line. Every one of them is answered the same way by
 *  the caller (today's outcome, with the cut named), but they are different facts for an operator:
 *  a missing session file is a dispatch that never wrote one; `timeout` is a child the bound ended;
 *  `no-answer` is a child that ran and said nothing. */
export type ContinuationFailure =
  | "no-session"
  | "no-role"
  | "spawn-failed"
  | "timeout"
  | "no-answer";

/** What a continuation returned: the resumed child's own final reply, or why it did not. There is
 *  exactly ONE shape that can carry a reply, and a caller accepts one from no other — a stream cut
 *  short by the bound or a signal has nowhere to come from, so a partial reply is not an answer and
 *  no arm of this union can express one. */
export type ContinuationOutcome =
  | {
      ok: true;
      text: string;
      /** The resumed child's OWN cost and recorded stop reason, so the wave can bill it as a row
       *  rather than guess. Absent on a child that reported nothing, which is the same distinction the
       *  first child's fields make: unknown, not zero. */
      usage?: DispatchUsage;
      ms?: number;
      stopReason?: string;
      /** The resumed child's own session file — a second continuation would resume THAT one, though
       *  the one-shot flag means no wave asks twice. */
      transcriptPath?: string;
    }
  | { ok: false; reason: ContinuationFailure };

/** The seam: asks the continuation child. Tests inject this; production is
 *  {@link spawnDeveloperContinuationChild}. */
export type DeveloperContinuationFn = (args: {
  /** The first child's session file — the thing that makes this a follow-up. */
  transcriptPath: string;
  /** The role the first child ran as. A role with no prompt file continues nowhere. */
  role: string;
  /** The tree the resumed child starts in: the one the first child worked in. */
  cwd: string;
  /** The fence the first child ran behind — passed here, not re-derived, so a continuation cannot
   *  be handed a wider one than the dispatch it resumes. */
  writeFence: WriteFence;
  boundMs: number;
  prompt: string;
  /** The run's permission stamp, threaded from the caller that owns the run's mode (see
   *  `leanChildOpts`). Absent means no stamp, which is what an interactive run carries and what a
   *  harness with no mode to speak of gets; it is never inferred from the environment here. */
  workCycleTrust?: boolean;
}) => Promise<ContinuationOutcome>;

/** The LAST `agent_end`'s final assistant turn's `stopReason`, or undefined when the stream carried
 *  neither. The same replay-scanning rule `continuationReplyText` states: only the last `agent_end`
 *  describes the continuation's own turn, since a resumed session replays every earlier one.
 *
 * `usage` is read as that turn's OWN counts and never summed across turns — see `usageFromTurn`. */
export function lastAgentEndFinalTurn(rawStdout: string): {
  stopReason?: string;
  usage?: DispatchUsage;
} {
  let last: { stopReason?: string; usage?: DispatchUsage } = {};
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: { type?: string; messages?: unknown };
    try {
      event = JSON.parse(trimmed) as { type?: string; messages?: unknown };
    } catch {
      continue;
    }
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    for (const message of event.messages as Array<{
      role?: string;
      stopReason?: unknown;
      usage?: unknown;
    }>) {
      if (message?.role !== "assistant") continue;
      // The LAST assistant turn of the LAST `agent_end` is the continuation's own. Its usage is the
      // per-turn shape (`input`/`output`/…), so it is read as that and never summed: summing turns is
      // how a session that replayed twenty of them would bill twenty times the child's cost.
      const usage = usageFromTurn(message.usage);
      last = {
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(usage === undefined ? {} : { usage }),
      };
    }
  }
  return last;
}

/** The per-turn `usage` block, read as a turn's own counts, not a session's. Absent or malformed
 *  usage answers absent — the step bills a child it cannot read as zero, never as a guess. */
function usageFromTurn(usage: unknown): DispatchUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const num = (key: string): number => {
    const v = u[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  };
  if (typeof u.input !== "number" && typeof u.output !== "number") return undefined;
  return {
    input: num("input"),
    output: num("output"),
    cacheRead: num("cacheRead"),
    cacheWrite: num("cacheWrite"),
    cost: num("cost"),
    turns: 1,
    toolCalls: 0,
    toolErrors: 0,
  };
}

/** The continuation child's argv: the developer's own role, system prompt and tool roster, on the
 *  session file the first child wrote. Mirrors `reaskChildArgs` in shape, and differs in exactly
 *  one respect that matters — it carries no reviewer-role assumption, so nothing strips the write
 *  tools a fixer needs to finish its edit. */
export function continuationChildArgs(args: {
  transcriptPath: string;
  role: string;
  promptFile: string;
  model?: string;
  provider?: string;
}): string[] {
  const argv = [
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    "builtin:mcp",
    "--session",
    args.transcriptPath,
    ...childGuardsArgs(),
    "--append-system-prompt",
    args.promptFile,
  ];
  // The role's OWN exclusion list: for `developer` that is empty, so the flag is omitted and the
  // resumed child keeps `edit`/`write`. A reviewer role would get its exclusions back — which is
  // correct for that role and is why this module is not used for one.
  const excluded = excludeToolsFor(args.role);
  if (excluded) argv.push("--exclude-tools", excluded);
  if (args.provider) argv.push("--provider", args.provider);
  if (args.model) argv.push("--model", args.model);
  return argv;
}

/** The assistant text of the LAST `agent_end` the stream carried.
 *
 * Only that reply counts: a resumed session REPLAYS the earlier turns, so a reader that took any
 * assistant text would read the first child's own closing message back as the continuation's reply
 * — the same hazard `reaskReplyText` names for a reviewer, with the same answer. */
export function continuationReplyText(rawStdout: string): string {
  let last = "";
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: { type?: string; messages?: unknown };
    try {
      event = JSON.parse(trimmed) as { type?: string; messages?: unknown };
    } catch {
      continue;
    }
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    let text = "";
    for (const message of event.messages as Array<{
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>) {
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string") text += `${block.text}\n`;
      }
    }
    if (text.trim() !== "") last = text;
  }
  return last;
}

/** The role's system prompt, written the way `spawnSpecialist` does, so the resumed child is
 *  configured like the child it continues. A role with no prompt file of its own is not a role a
 *  step can continue, and gets nothing — the caller reads that as "no continuation". The temp
 *  DIRECTORY travels with the file because the caller owns its removal. */
async function writeRolePromptFileFor(
  role: string,
): Promise<{ dir: string; promptFile: string } | undefined> {
  const roleDef = ROLES[role as RoleName];
  if (roleDef === undefined) return undefined;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const systemPrompt = await fs.readFile(roleDef.promptFile, "utf8");
  return writeReaskPromptFile(role, systemPrompt, os.tmpdir(), path.join);
}

/**
 * The production continuation: one `pi` child on the first child's session, one prompt, its own
 * wall clock, and nothing else.
 *
 * The env comes from the same helper the spawn path uses, because this is the same helper role with
 * the same credentials; the strip is asked for with `args.role`, never a literal, so it matches the
 * child rather than the first caller. The fence env is applied HERE rather than left to the caller:
 * a continuation that lost the fence would be the #1655 hole reopened through the one dispatch path
 * that does not go through `spawnSpecialist`. `withOperatorConfigGuard` wraps the window for the
 * same reason the reattach path wraps its own spawn — this child runs outside `spawnSpecialist`, so
 * it guards its own operator-config window. The two remaining things `spawnSpecialist` owns for a
 * review child — the permission stamp and the process-group kill — are threaded in as arguments
 * here (`workCycleTrust`, and `spawn-kill.ts` inside `runContinuationChild`), which is what keeps
 * this dispatch path from being the one that could write anywhere the process can and die alone.
 *
 * Every failure is an OUTCOME, never a throw: the caller is a review step already deciding whether
 * its wave changed anything, and an exception from a wedged temp root would end the step where the
 * continuation only costs the continuation.
 */
export async function spawnDeveloperContinuationChild(
  args: {
    transcriptPath: string;
    role: string;
    cwd: string;
    writeFence: WriteFence;
    boundMs: number;
    prompt: string;
    /** See `DeveloperContinuationFn.workCycleTrust`. */
    workCycleTrust?: boolean;
  },
  // The one outside-world call the child needs, injected for the same reason every other one is: a
  // case asserts what the resumed child was HANDED (its argv, its env, its fence) and answers it with
  // a canned rpc stream, without a model, a token, or a real process.
  deps: { spawn?: typeof spawn } = {},
): Promise<ContinuationOutcome> {
  // Absent or unreadable, and the session holds nothing to continue: the caller's answer is today's
  // outcome, not a fresh child started in ignorance of what the first one read.
  if (!existsSync(args.transcriptPath)) return { ok: false, reason: "no-session" };
  const choice = resolveModel(args.role);
  return withOperatorConfigGuard(args.role, async () => {
    let promptDir: string | undefined;
    try {
      const written = await writeRolePromptFileFor(args.role);
      if (written === undefined) return { ok: false, reason: "no-role" };
      promptDir = written.dir;
      const invocation = getPiInvocation(
        continuationChildArgs({
          transcriptPath: args.transcriptPath,
          role: args.role,
          promptFile: written.promptFile,
          ...(choice.model === undefined ? {} : { model: choice.model }),
          ...(choice.provider === undefined ? {} : { provider: choice.provider }),
        }),
      );
      return await runContinuationChild(invocation.command, invocation.args, args, deps);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      trace(`${CONTINUATION_SOURCE_TAG}: child could not be prepared (${reason})`);
      return { ok: false, reason: "spawn-failed" };
    } finally {
      if (promptDir !== undefined) {
        const fs = await import("node:fs/promises");
        await fs.rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}

async function runContinuationChild(
  command: string,
  argv: string[],
  args: {
    role: string;
    cwd: string;
    writeFence: WriteFence;
    boundMs: number;
    prompt: string;
    workCycleTrust?: boolean;
  },
  deps: { spawn?: typeof spawn },
): Promise<ContinuationOutcome> {
  const childEnv = forgeReadChildEnv(process.env, args.role);
  // The fence the first child ran behind, re-applied: the env names the root, the repo and the
  // scratch the child-guards companion judges every write against.
  childEnv.PI_ENSEMBLE_WRITE_ROOT = args.writeFence.root;
  childEnv.PI_ENSEMBLE_WRITE_REPO = args.writeFence.repo;
  childEnv.PI_ENSEMBLE_WRITE_SCRATCH = args.writeFence.scratch;
  // The role stamp, asked through the same helper the spawn path uses — verbatim, and gated on the
  // same switch. An empty role would leave the key absent, which the child-side guards read as "no
  // role judged anything" rather than as some default role.
  const stamped = childRoleEnvValue(args.role);
  if (childRoleEnvEnabled() && stamped !== undefined) childEnv[CHILD_ROLE_ENV] = stamped;
  // The run's permission stamp, applied the way `applyChildPermissionEnv` applies it to a
  // `spawnSpecialist` child. A headless lean run's fixer is trusted through the /work-cycle stamp
  // (`isParentInTrustMode()` is false with no UI and the strict opt-in set), and this child resumes
  // that same fixer's edits — a stamp it did not carry would leave the second turn permission-denied
  // while the first ran free, which is the divergence `leanChildOpts` exists to prevent. Gated on
  // the same operator opt-in (`workCycleTrustEnabled`), so `PI_ENSEMBLE_STRICT_PERMISSIONS=1` still
  // refuses it; there is deliberately no broker socket on this path, so an inherited one must not
  // survive into a trusted child.
  if (workCycleTrustEnabled(args.workCycleTrust)) {
    childEnv.PI_ENSEMBLE_TRUST_MODE = "1";
    Reflect.deleteProperty(childEnv, "PI_ENSEMBLE_PERM_SOCKET");
  }
  scrubGitLocation(childEnv);
  // Same non-interactive git pins the spawn path stacks — a continuation child that reached a
  // credential prompt or an editor would wait for a TTY it does not have.
  childEnv.GIT_EDITOR = "true";
  childEnv.GIT_SEQUENCE_EDITOR = "true";
  childEnv.GIT_TERMINAL_PROMPT = "0";
  childEnv.GIT_PAGER = "cat";
  const startedAt = Date.now();
  // The same group decision the fixer's dispatch made (`processGroup: true` at the review seam),
  // through the one predicate and the one spawn-options helper `spawnSpecialist` uses.
  const leadsGroup = leadsProcessGroup(true);
  const child = (deps.spawn ?? spawn)(command, argv, {
    // The tree the first child ran in, never this process's directory: a resumed child that starts
    // outside the fix tree edits a checkout the step will never integrate.
    cwd: args.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    ...groupSpawnOpts(leadsGroup),
  });
  // Recorded before any kill can land, so every kill below (and the runner's group reaper) signals
  // the tree rather than the leader alone. Two guards, both about a handle this function does not
  // own: a child with no pid cannot lead a group, and `registerChild` also arms an `exit` listener,
  // so a handle that cannot carry one must not turn a continuation into a failed dispatch. A fake
  // that cannot lead a group is what `leadsProcessGroup` already answers for at every kill site.
  if (leadsGroup && child.pid !== undefined && typeof child.once === "function") {
    registerChild(child, true);
  }
  attachStdinErrorGuard(child.stdin, CONTINUATION_SOURCE_TAG);
  const stdoutChunks: Buffer[] = [];
  let stdoutSize = 0;
  const MAX_STDOUT = 4 * 1024 * 1024;
  child.stdout?.on("data", (d: Buffer) => {
    stdoutChunks.push(d);
    stdoutSize += d.length;
    while (stdoutSize > MAX_STDOUT && stdoutChunks.length > 1) {
      const evicted = stdoutChunks.shift();
      if (evicted) stdoutSize -= evicted.length;
    }
  });
  child.stderr?.on("data", () => {
    /* discarded — a continuation child's diagnostics change nothing here */
  });
  try {
    child.stdin?.write(`${JSON.stringify({ type: "prompt", message: args.prompt })}\n`);
    // Closing stdin is the rpc protocol's "no more commands": the child answers this one prompt and
    // exits, exactly as the first child did.
    child.stdin?.end();
  } catch {
    /* the child may already be gone; the settle below answers for it */
  }

  const settled = await new Promise<{
    reason?: string;
    timedOut: boolean;
  }>((resolve) => {
    let done = false;
    const finish = (r: { reason?: string; timedOut: boolean }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The group, not just the leader — see `spawn-kill.ts`: `child.kill()` signals the leader
      // alone, and a `bash` grandchild left alive keeps writing into the fix tree this step is about
      // to fold and delete. The escalation grace is `killProcessTree`'s own.
      killProcessTree(child);
      resolve(r);
    };
    const timer = setTimeout(() => {
      // SIGTERM to the whole group first, exactly as the fixer's bound ends its child.
      killProcessTree(child);
      finish({ timedOut: true });
    }, args.boundMs);
    child.on("exit", () => finish({ timedOut: false }));
    // A child that never started emits `error` and NEVER `exit`, so a promise listening only for
    // `exit` would hold the review step for the life of the parent.
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({ reason: err.code ?? String(err), timedOut: false }),
    );
  });
  if (settled.reason !== undefined) {
    trace(`${CONTINUATION_SOURCE_TAG}: child spawn failed (${settled.reason})`);
    return { ok: false, reason: "spawn-failed" };
  }
  if (settled.timedOut) return { ok: false, reason: "timeout" };
  const text = continuationReplyText(Buffer.concat(stdoutChunks).toString("utf8"));
  if (text === "") return { ok: false, reason: "no-answer" };
  // The resumed child's own last turn, read from the same reply the text came from: a continuation
  // that was ITSELF cut at the cap is recorded as one, so the step's row tells the truth even though
  // the one-shot flag means it is never asked again.
  const raw = Buffer.concat(stdoutChunks).toString("utf8");
  const final = lastAgentEndFinalTurn(raw);
  return {
    ok: true,
    text,
    ...(final.stopReason === undefined ? {} : { stopReason: final.stopReason }),
    ...(final.usage === undefined ? {} : { usage: final.usage }),
    ms: Date.now() - startedAt,
  };
}
