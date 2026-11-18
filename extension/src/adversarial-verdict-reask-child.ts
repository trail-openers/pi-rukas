/**
 * adversarial-verdict-reask-child — the second child that asks a reviewer for
 * its verdict line, and the plumbing that keeps that child a FOLLOW-UP rather
 * than a second reviewer.
 *
 * Split out of `adversarial-verdict-reask.ts` along the seam that already
 * existed there (AGENTS.md §12 size cap): this file is everything that touches
 * the child process — argv, env, stdin, the bound, the RPC stream — and nothing
 * that touches the loop. The rule that belongs to the child, and is what makes
 * the split safe: a re-ask is ONE prompt and ONE line, so the child is
 * configured like the reviewer it resumes (same role, model, provider, system
 * prompt, tool fence, child guards) and is given none of the machinery a review
 * needs — no deck row, no caps, no steer seam, no skill. A skill or a forwarded
 * extension would re-run the review, and a re-run is a second opinion rather
 * than an answer to the question.
 *
 * Sibling of `work-driver-resume-reattach.ts`, which resumes a crashed child the
 * same way: `pi --mode rpc --session <transcript>` plus a single prompt, with
 * the child env and the operator-config guard that `spawnSpecialist` would
 * otherwise own.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { VERDICT_REASK_SOURCE_TAG } from "./adversarial-verdict-reask-constants.ts";
import { forgeReadChildEnv } from "./child-forge-env.ts";
import { childGuardsArgs } from "./child-guards.ts";
import { scrubGitLocation } from "./git-env.ts";
import { resolveModel } from "./models.ts";
import { getPiInvocation } from "./pi-binary-resolve.ts";
import { isReviewerRole } from "./review-bounds.ts";
import { excludeToolsFor } from "./role-tools.ts";
import { ROLES } from "./roles.ts";
import { withOperatorConfigGuard } from "./spawn-operator-config.ts";
import { attachStdinErrorGuard } from "./stdin-guard.ts";
import { trace } from "./trace.ts";
import type { AdversarialVerdict, DispatchResult } from "./types.ts";

/** How a re-ask failed, for the trace line. The loop treats every one of these
 * the same way — today's infrastructure failure — but the reason is what an
 * operator needs in order to tell a wedged provider from a missing session. */
export type ReaskFailure = "no-session" | "spawn-failed" | "timeout" | "no-answer";

/** What the re-ask returned: the re-ask child's own reply, or why it did not.
 *
 * There is exactly one shape that can carry an answer, and the reader of this
 * type (`reaskAdversarialVerdict`) accepts an answer from no other: a stream cut
 * short by the bound or a signal has nowhere to come from, so a partial reply is
 * not a verdict and no arm of this union can express one. */
export type ReaskOutcome =
  | { ok: true; text: string; usage?: DispatchResult["usage"] }
  | { ok: false; reason: ReaskFailure };

/** The answer a re-ask yielded that the strict reader still refused — the fenced
 * answer, the menu echo, the prose — and what the loop keeps from one it did
 * read. Declared ONCE, in the loop-side module that consumes them
 * (`adversarial-verdict-reask.ts`), and re-exported here so a caller of either
 * half of the seam names the type without importing the other half across it.
 * The vocabulary both sides must agree on lives in
 * `adversarial-verdict-reask-constants.ts` for the same reason. */
export type { ReaskUnreadable, ReaskedVerdict } from "./adversarial-verdict-reask.ts";

/** The seam: asks the re-ask child. Tests inject this; production is
 * {@link spawnVerdictReaskChild}. */
export type VerdictReaskFn = (args: {
  transcriptPath: string;
  role: string;
  model?: string;
  cwd?: string;
  boundMs: number;
  prompt: string;
}) => Promise<ReaskOutcome>;

/** The assistant text of the LAST `agent_end` the stream carried.
 *
 * Only that reply counts: a resumed session replays earlier turns, so a reader
 * that took any assistant text would read the reviewer's own fenced report back
 * as the re-ask's answer.
 */
export function reaskReplyText(rawStdout: string): string {
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

/** The re-ask child's argv: the reviewer's own role, system prompt, tool fence
 * and model, on the session file the reviewer wrote. */
export function reaskChildArgs(args: {
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
  const excluded = excludeToolsFor(args.role);
  if (excluded) argv.push("--exclude-tools", excluded);
  if (args.provider) argv.push("--provider", args.provider);
  if (args.model) argv.push("--model", args.model);
  return argv;
}

/**
 * The production re-ask: one `pi` child on the reviewer's session, one prompt,
 * its own wall clock, and nothing else — no deck row, no caps, no steer seam.
 *
 * The child env comes from the same helper `spawn.ts` uses, because a re-ask is
 * the same helper role with the same credentials; a strip placed only at the
 * other site would leave this one fully authenticated. The strip is asked for
 * with `args.role` — the role actually being re-asked — and never a literal, so
 * the env matches the child rather than the first caller this feature had.
 * `withOperatorConfigGuard` wraps it for the same reason the reattach path wraps
 * its own spawn: this child runs outside `spawnSpecialist`, so it guards its own
 * operator-config window.
 *
 * `cwd` is the review's own tree, threaded from the loop's `workCwd` (which is
 * required on every non-reportOnly round). The child resumes the reviewer's
 * session file by absolute path, so the tree it starts in changes only what a
 * `bash` call it makes would resolve against — and the tool fence strips
 * `write`/`edit`/`multiedit` and the child guards register, so a re-ask child
 * cannot write anything anywhere. It is still the reviewer's tree, because a
 * second reviewer child that looked at a different checkout is a second opinion
 * rather than a follow-up.
 */
export async function spawnVerdictReaskChild(args: {
  transcriptPath: string;
  role: string;
  model?: string;
  provider?: string;
  cwd?: string;
  boundMs: number;
  prompt: string;
}): Promise<ReaskOutcome> {
  if (!existsSync(args.transcriptPath)) return { ok: false, reason: "no-session" };
  // The SAME resolution the reviewer's own dispatch went through — the caller's
  // answer when it gave one, the role's configured model otherwise. A re-ask on
  // a different model would be a second opinion rather than a follow-up.
  const choice = resolveModel(args.role, args.model);
  const model = args.model ?? choice.model;
  const provider = args.provider ?? choice.provider;
  return withOperatorConfigGuard(args.role, async () => {
    // The prompt file is written inside the guard's own window, so every fs call
    // it makes — reading the role's prompt, `mkdtemp`, the write — can fail here.
    // The contract on this function is that every failure is an OUTCOME: an
    // exception would propagate through `reaskRoundOnce` into the round body and
    // end the loop where a wedged temp root only costs the re-ask. The prompt dir
    // is removed once the child settles, on every arm (a spawn that never started
    // still runs its own kill and settle), so the `finally` covers success,
    // failure and the bound alike.
    let promptDir: string | undefined;
    try {
      const written = await writeReviewerPromptFile(args.role);
      if (written === undefined) return { ok: false, reason: "spawn-failed" };
      promptDir = written.dir;
      const invocation = getPiInvocation(
        reaskChildArgs({
          transcriptPath: args.transcriptPath,
          role: args.role,
          promptFile: written.promptFile,
          ...(model === undefined ? {} : { model }),
          ...(provider === undefined ? {} : { provider }),
        }),
      );
      return await runReaskChild(invocation.command, invocation.args, args);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      trace(`${VERDICT_REASK_SOURCE_TAG}: prompt file could not be prepared (${reason})`);
      return { ok: false, reason: "spawn-failed" };
    } finally {
      if (promptDir !== undefined) {
        const fs = await import("node:fs/promises");
        await fs.rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}

async function runReaskChild(
  command: string,
  argv: string[],
  args: { role: string; cwd?: string; boundMs: number; prompt: string },
): Promise<ReaskOutcome> {
  const childEnv = forgeReadChildEnv(process.env, args.role);
  scrubGitLocation(childEnv);
  const child = spawn(command, argv, {
    // Absent means the parent's cwd, which is the loop's process directory, not
    // the reviewed tree — so the loop always names one (adversarial.ts).
    cwd: args.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  attachStdinErrorGuard(child.stdin, VERDICT_REASK_SOURCE_TAG);
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
    /* discarded — a re-ask child's diagnostics change nothing here */
  });
  try {
    child.stdin?.write(`${JSON.stringify({ type: "prompt", message: args.prompt })}\n`);
    // Closing stdin is the rpc protocol's "no more commands": the child answers
    // this one prompt and exits, exactly as the reviewer's own dispatch does.
    child.stdin?.end();
  } catch {
    /* the child may already be gone; the settle below answers for it */
  }

  const settled = await new Promise<{
    exitCode: number | null;
    reason?: string;
    timedOut: boolean;
  }>((resolve) => {
    let done = false;
    const finish = (r: {
      exitCode: number | null;
      reason?: string;
      timedOut: boolean;
    }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
      resolve(r);
    };
    // A child killed by the bound still printed its reply, and that reply is the
    // answer: SIGTERM ends it and the verdict below reads whatever arrived. Only
    // a child that printed nothing at all fails as a timeout.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
      finish({ exitCode: null, timedOut: true });
    }, args.boundMs);
    child.on("exit", (code) => finish({ exitCode: code ?? 0, timedOut: false }));
    // A child that never started emits `error` and NEVER `exit`, so a promise
    // listening only for `exit` would hold the round for the life of the parent.
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({ exitCode: null, reason: err.code ?? String(err), timedOut: false }),
    );
  });
  const text = reaskReplyText(Buffer.concat(stdoutChunks).toString("utf8"));
  if (settled.reason !== undefined) {
    // A child that never started said nothing about the verdict; the reason goes
    // to the trace, where the operator reads why the round fell back.
    trace(`${VERDICT_REASK_SOURCE_TAG}: child spawn failed (${settled.reason})`);
    return { ok: false, reason: "spawn-failed" };
  }
  if (settled.timedOut) return { ok: false, reason: "timeout" };
  if (text === "") return { ok: false, reason: "no-answer" };
  return { ok: true, text };
}

/** The role's system prompt, written to a temp file the way `spawnSpecialist`
 * does, so the re-ask child is configured the same as the reviewer it resumes.
 * A role that is not a reviewer has no business being re-asked, and gets none.
 * The temp DIRECTORY travels with the file because the caller owns its removal:
 * the ask outlives this call, and a prompt file left in a shared /tmp per round
 * is a role's system prompt nobody cleans up. */
async function writeReviewerPromptFile(
  role: string,
): Promise<{ dir: string; promptFile: string } | undefined> {
  if (!isReviewerRole(role)) return undefined;
  const roleDef = ROLES[role as keyof typeof ROLES];
  if (roleDef === undefined) return undefined;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const systemPrompt = await fs.readFile(roleDef.promptFile, "utf8");
  return writeReaskPromptFile(role, systemPrompt, os.tmpdir(), path.join);
}

/** The temp-file write, split out so the file the child is configured with comes
 * from one function a test can drive without touching a role's prompt. Returns
 * the temp dir alongside the file so the caller can remove the whole tree. */
export async function writeReaskPromptFile(
  role: string,
  systemPrompt: string,
  tmpRoot: string,
  join: (...parts: string[]) => string,
): Promise<{ dir: string; promptFile: string }> {
  const fs = await import("node:fs/promises");
  const tmpDir = await fs.mkdtemp(join(tmpRoot, "pi-rukas-reask-"));
  await fs.chmod(tmpDir, 0o700);
  const promptFile = join(tmpDir, `${role}.md`);
  // 0600 explicitly, not the umask's default: the harness reads this tree by
  // owner AND mode, and a group/world-readable copy of the role's system prompt
  // in a shared /tmp is the thing that walk is meant to refuse.
  await fs.writeFile(promptFile, systemPrompt, { mode: 0o600 });
  return { dir: tmpDir, promptFile };
}
