/**
 * work-driver-explore-reask — the ONE follow-up an explore reply gets when it
 * ended its turn without the two things the reply contract requires.
 *
 * The shape this exists for (#2611, measured on #2610's cycle): an explore child
 * ran 152 turns, verified the body, closed with "Verified. Writing the spec."
 * and emitted zero `INTENT-VERDICT:` lines. Its sibling ran 313 turns and ended
 * the same way. Neither was a transport or parser loss — each said it was about
 * to write the verdict and stopped. The driver's only recovery was a FRESH
 * re-dispatch, which repeats the whole investigation (465 turns and 48.8M
 * cache-read tokens across the two) and ends the same way, because the thing
 * that went wrong is not something a second child fixes.
 *
 * The child that stopped on the status line already holds the evidence in its own
 * context. So the driver asks THAT session, once, for the two artefacts the
 * prompt already promised: the `INTENT-VERDICT:` line and the `## Spec` block.
 * This is the explore twin of the lean specify re-ask (`lean/specify-reask.ts`)
 * and the adversarial verdict re-ask (`adversarial-verdict-reask.ts`), and it
 * reuses their spawn seam rather than inventing a third one: same argv
 * (`reResumeChildArgs`), same prompt-file writer (`writeReaskPromptFile`), same
 * env helper, same one-prompt-then-close-stdin protocol, same reply reader
 * (`reaskReplyText` — the LAST `agent_end`, because a resumed session replays
 * its own earlier turns and any other read would hand the first reply back as
 * the answer).
 *
 * What keeps it a follow-up rather than a second explore:
 *
 *   - the same role, so the same system prompt, the same model resolution and
 *     the same tool roster;
 *   - ONE prompt and no deck row, no steer seam, no skill, no forwarded
 *     extension — anything more would re-run the investigation, and a re-run is
 *     a second opinion rather than an answer to the question;
 *   - the answer is read by `resolveExploreSpec`, the SAME reader the original
 *     reply goes through, so an answer that is prose, a fence, or a description
 *     of a spec stays unreadable exactly as it was in the first reply;
 *   - a session that cannot be named, a spawn failure, a bound expiry or an empty
 *     answer changes nothing: the step proceeds to today's fresh re-dispatch.
 *
 * The ask is the seam (`exploreReask` on the DriverContext, the same shape the
 * verdict re-ask's `verdictReask` has), so the offline suite pins the behaviour
 * without spawning; production is {@link spawnExploreReaskChild}.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  reResumeChildArgs,
  reaskReplyText,
  writeReaskPromptFile,
} from "./adversarial-verdict-reask-child.ts";
import { childGuardsArgs, preflightChildGuards } from "./child-guards.ts";
import { resolveModel } from "./models.ts";
import { getPiInvocation } from "./pi-binary-resolve.ts";
import { excludeToolsFor } from "./role-tools.ts";
import { ROLES, type RoleName } from "./roles.ts";
import { buildResumedChildEnv } from "./spawn-child-env.ts";
import { withOperatorConfigGuard } from "./spawn-operator-config.ts";
import { assertLiveSpawnAllowed } from "./spawn-support.ts";
import { attachStdinErrorGuard } from "./stdin-guard.ts";
import { trace } from "./trace.ts";

/** The trace tag every line this module writes carries, so an operator can grep one word. */
export const EXPLORE_REASK_SOURCE_TAG = "work-driver-explore-reask";

/** An answer costs one short reply; a wedged provider must not hold explore open. */
const EXPLORE_REASK_BOUND_MS = 180_000;

/**
 * The ONE prompt the re-ask child is given. It names the two artefacts and no
 * verdict VALUE — a prompt that listed `proceed` / `park` would hand a model
 * asked for a spec block a menu to recite, and the reader downstream cannot tell
 * a recited value from a decided one.
 */
export function exploreReaskPrompt(): string {
  return [
    "Your previous reply ended on a status line: it said it was about to write the spec and did not.",
    "Do not investigate further and do not make any more tool calls.",
    "Reply now, in this message, with the two things your reply contract requires:",
    "1. the `INTENT-VERDICT:` line, with the verdict you reached;",
    "2. a `## Spec` block with its subsections (Intent, Deliverables, Acceptance criteria).",
    "Write them from what you already verified. Nothing else.",
  ].join("\n");
}

/** How a re-ask failed, for the trace line. Every one of these means the same thing to the step:
 * today's behaviour follows unchanged. The reason is what tells a wedged provider from no session. */
export type ExploreReaskFailure = "no-session" | "spawn-failed" | "timeout" | "no-answer";

/** The re-ask's reply, or why there is none. Only this shape can carry an answer: a stream cut
 * short by the bound has nowhere to come from, so a partial reply is not a spec. */
export type ExploreReaskOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: ExploreReaskFailure };

/** The seam: asks the re-ask child. Tests inject this; production is {@link spawnExploreReaskChild}. */
export type ExploreReaskFn = (args: {
  transcriptPath: string;
  role: string;
  cwd: string;
  boundMs: number;
  prompt: string;
}) => Promise<ExploreReaskOutcome | (ExploreReaskOutcome & { asked: false })>;

/**
 * The child's argv: the resume flags shared with every re-ask, plus the explore
 * role's OWN tool roster. Explore excludes `write`/`edit`/`multiedit`, so the
 * resumed child can answer with text and cannot touch the tree — which is the
 * whole point of an ask that must not go and re-do the investigation.
 */
export function exploreReaskChildArgs(args: {
  transcriptPath: string;
  role: string;
  promptFile: string;
  model?: string;
  provider?: string;
}): string[] {
  const argv = [
    ...reResumeChildArgs(args.transcriptPath),
    "--append-system-prompt",
    args.promptFile,
  ];
  const excluded = excludeToolsFor(args.role);
  if (excluded) argv.push("--exclude-tools", excluded);
  if (args.provider) argv.push("--provider", args.provider);
  if (args.model) argv.push("--model", args.model);
  return argv;
}

/** Explore's system prompt, written the way `spawnSpecialist` does, so the resumed child is
 *  configured like the child it continues. The temp DIRECTORY travels with the file: the caller
 *  owns its removal, and a role's system prompt left in a shared /tmp is nobody's to clean. */
async function writeExplorePromptFile(): Promise<{ dir: string; promptFile: string }> {
  const roleDef = ROLES.explore as (typeof ROLES)[RoleName];
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const systemPrompt = await fs.readFile(roleDef.promptFile, "utf8");
  return writeReaskPromptFile("explore", systemPrompt, os.tmpdir(), path.join);
}

/**
 * The production re-ask: one `pi` child on the explore child's session, one
 * prompt, its own wall clock, and nothing else.
 *
 * The env comes from the ONE builder the dispatch path uses
 * (`buildResumedChildEnv`, spawn-child-env.ts) — a re-ask is the same helper role
 * with the same credentials, and a strip placed only at the other site would
 * leave this one fully authenticated. It is deliberately NOT the forge strip on
 * its own: that helper stamps no `PI_ENSEMBLE_ROLE`, names no per-child temp
 * root, and gives a read-only role no scratch `HOME`/XDG, so every role-scoped
 * child-side guard (the read-only dependency rule, the #2200 deletion roots, the
 * reviewer bash bound, the reviewer write guard) sat inert for this child while
 * the same role's normal dispatch was judged by all of them. `withOperatorConfigGuard`
 * wraps the window because this child runs outside `spawnSpecialist`, so it
 * guards its own operator-config window.
 *
 * Every failure is an OUTCOME, never a throw: the caller is the explore step
 * deciding whether to re-dispatch, and an exception from a wedged temp root
 * would end the step where a failed ask only costs the ask.
 */
export async function spawnExploreReaskChild(args: {
  transcriptPath: string;
  role: string;
  cwd: string;
  boundMs: number;
  prompt: string;
}): Promise<ExploreReaskOutcome> {
  if (!existsSync(args.transcriptPath)) return { ok: false, reason: "no-session" };
  assertLiveSpawnAllowed("explore");
  try {
    preflightChildGuards();
  } catch (err) {
    traceWarnReask(`the companion is missing: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "spawn-failed" };
  }
  // The SAME resolution the explore dispatch itself went through: a re-ask on a
  // different model would be a second opinion rather than a follow-up.
  const choice = resolveModel(args.role);
  return withOperatorConfigGuard(args.role, async () => {
    let promptDir: string | undefined;
    let childTmp: string | undefined;
    try {
      const written = await writeExplorePromptFile();
      promptDir = written.dir;
      const invocation = getPiInvocation(
        exploreReaskChildArgs({
          transcriptPath: args.transcriptPath,
          role: args.role,
          promptFile: written.promptFile,
          ...(choice.model === undefined ? {} : { model: choice.model }),
          ...(choice.provider === undefined ? {} : { provider: choice.provider }),
        }),
      );
      // The child's own temp root is allocated by the CALLER and handed down, so
      // this `finally` owns its removal on every arm — success, failure and the
      // bound alike — exactly as `spawnSpecialist` owns its `tmpDir`. It is the
      // root the deletion rule (#2200) judges the child against, so it must
      // exist before `spawn()`.
      childTmp = await mkdtempChildRoot();
      return await runExploreReaskChild(invocation.command, invocation.args, args, childTmp);
    } catch (err) {
      traceWarnReask(
        `the child could not be prepared: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      return { ok: false, reason: "spawn-failed" };
    } finally {
      const fs = await import("node:fs/promises");
      for (const dir of [promptDir, childTmp]) {
        if (dir !== undefined) {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  });
}

function traceWarnReask(detail: string): void {
  trace(`${EXPLORE_REASK_SOURCE_TAG}: ${detail}`);
}

async function runExploreReaskChild(
  command: string,
  argv: string[],
  args: { cwd: string; boundMs: number; prompt: string },
  childTmp: string,
): Promise<ExploreReaskOutcome> {
  // The SAME env the dispatch path builds (`buildChildEnv`, spawn-child-env.ts):
  // the forge strip, the role stamp, the git scrub and its non-interactive pins,
  // the permission marker, and this child's own temp root with the scratch
  // `HOME`/XDG derived from it — written LAST, so no inherited `TMPDIR` wins.
  // Nothing below writes the env: it goes straight to `spawn()`.
  const childEnv = buildResumedChildEnv("explore", childTmp);
  const child = spawn(command, argv, {
    // The explore child's own tree: the session is resumed by absolute path, so
    // cwd only decides what a `bash` call it makes resolves against.
    cwd: args.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  attachStdinErrorGuard(child.stdin, EXPLORE_REASK_SOURCE_TAG);
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
    // this one prompt and exits, exactly as the explore dispatch itself does.
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
    const finish = (r: { exitCode: number | null; reason?: string; timedOut: boolean }): void => {
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
    // A child killed by the bound may still have printed its reply, and that
    // reply is the answer: SIGTERM ends it and the verdict below reads whatever
    // arrived. Only a child that printed nothing at all fails as a timeout
    // (`text` is the reader's answer, examined below).
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
    // listening only for `exit` would hold the step for the life of the driver.
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({ exitCode: null, reason: err.code ?? String(err), timedOut: false }),
    );
  });
  const text = reaskReplyText(Buffer.concat(stdoutChunks).toString("utf8"));
  if (settled.reason !== undefined) {
    traceWarnReask(`the child could not be spawned (${settled.reason})`);
    return { ok: false, reason: "spawn-failed" };
  }
  // A child the bound killed may well have printed its reply first — the RPC
  // stream reaches the parent before the process does, so the kill lands on a
  // child that had already answered. What arrived IS the answer when it is
  // non-empty: the reader downstream (`resolveExploreSpec`) is the same strict
  // reader the first reply went through, so a partial, fenced or prose reply
  // stays unreadable here exactly as it would have on a clean exit. Only a child
  // that printed nothing at all fails as a timeout.
  if (settled.timedOut && text === "") {
    traceWarnReask(`the child hit its ${String(args.boundMs)}ms bound without printing a reply`);
    return { ok: false, reason: "timeout" };
  }
  if (text === "") return { ok: false, reason: "no-answer" };
  return { ok: true, text };
}

/** The re-ask child's own temp root: a private dir under the run's temp root. The
 *  caller that spawned the child naming it removes it. `chmod` after `mkdtemp`
 *  because the mode is what makes a 0700 root, and the sibling re-ask writes its
 *  prompt tree the same way. */
async function mkdtempChildRoot(): Promise<string> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await fs.mkdtemp(`${os.tmpdir()}/pi-rukas-explore-reask-`);
  await fs.chmod(dir, 0o700);
  return dir;
}

/** The bound the step arms the ask with, read at call time so a test can pin it. */
export function exploreReaskBoundMs(): number {
  const v = Number(process.env.PI_ENSEMBLE_EXPLORE_REASK_BOUND_MS);
  return Number.isFinite(v) && v > 0 ? v : EXPLORE_REASK_BOUND_MS;
}
