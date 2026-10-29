/**
 * headless/work-lean — `pi-rukas-headless work-lean <issue>` (epic #1883): one
 * run of the lean /work engine (`runWorkLean`) on the headless DriverHost, so a
 * host that drives `work` can drive the lean pipeline the same way.
 *
 *   work-lean <issue> [--json]
 *
 * The verb adds no policy of its own: it parses one positional issue number,
 * calls the same entry point the `/work-lean` command calls, and reports the
 * run's own code. The engine is the authority on what "done" means — a run's
 * `code`/`state` come from its step log, and this module restates them rather
 * than deciding anything.
 *
 * `--json` is accepted and changes nothing, as with every other S6 subcommand.
 *
 * Exit codes, taken from the run:
 *   0   `landed`
 *  10   `handed-back`
 *  11   `not-ready`
 *  30   the run threw for any reason other than a held lock, with `error.code:
 *       "crash"`
 *  40   bad arguments, or a live run already holds this issue's lock
 *       (`error.code: "refused"`) — the same answer `work` gives a cycle it
 *       could not enter, and for the same reason: re-running it now only
 *       collides again.
 */

import { markLeanHeadless } from "../lean/child-opts.ts";
import { runWorkLean } from "../lean/command.ts";
import type { RunLeanResult } from "../lean/engine.ts";
import { LeanStateError } from "../lean/state.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const WORK_LEAN_FLAGS = ["--json"] as const;

/** The lock-held refusals `lean/lock.ts` raises, by the message it writes. */
const LOCK_HELD = /run already in progress|lock unreadable|cannot lock /;

/** What a run is described by once its document is built. */
export interface LeanRunOutcome {
  summary: string;
  result: RunLeanResult;
  /**
   * The permission stamp the run's children carry. Defaults to this process's
   * lean mode; a test injects one to observe what a dispatch was stamped with.
   */
  childOpts?: { workCycleTrust: boolean };
}

/** The run seam: the same signature `runWorkLean` has. */
export type RunLean = (repoRoot: string, issue: number) => Promise<LeanRunOutcome>;

/** Whether this throw is the engine refusing to start behind a live run. */
function lockHeld(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof LeanStateError || LOCK_HELD.test(message);
}

/** The newest `publish` step's URL, if the run got that far. */
function prUrlOf(result: RunLeanResult): string | undefined {
  for (let i = result.run.steps.length - 1; i >= 0; i--) {
    const step = result.run.steps[i];
    if (step?.state !== "publish" || step.outcome === undefined) continue;
    const url = step.outcome.prUrl;
    if (typeof url === "string" && url !== "") return url;
  }
  return undefined;
}

/** A reason line a host can print: clipped, and never the whole step log. */
function clip(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export async function runWorkLeanVerb(
  argv: readonly string[],
  ctx: VerbContext,
  run: RunLean = runWorkLean,
): Promise<VerbOutcome> {
  const p = parseFlags(argv, { bool: [...WORK_LEAN_FLAGS], value: [] });
  if ("error" in p) return badArguments(p.error);
  if (p.positional.length !== 1 || !/^\d+$/.test(p.positional[0] as string)) {
    return badArguments("usage: work-lean <issue> [--json]");
  }
  const issue = Number.parseInt(p.positional[0] as string, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    return badArguments("usage: work-lean <issue> [--json]");
  }
  ctx.host.sendUserMessage(`work-lean: #${issue} starting`, { deliverAs: "steer" });
  // #1883 — a headless lean run's children need the /work-cycle trust stamp,
  // or the headless permission path hard-denies their tool calls. Marked once
  // for the whole process here, because this module is the only entry point
  // that runs the engine without a UI; the interactive `/work-lean` command
  // never calls it, so those children stay unstamped as they were. Read by the
  // three dispatch sites (lean/child-opts.ts).
  markLeanHeadless();
  let outcome: LeanRunOutcome;
  try {
    outcome = await run(ctx.repoRoot, issue);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refused = lockHeld(err);
    const exitCode = refused ? EXIT.refused : EXIT.crash;
    ctx.host.sendUserMessage(
      `work-lean: #${issue} ${refused ? "refused" : "crashed"} (exit ${exitCode}) — ${clip(message)}`,
      { deliverAs: "steer" },
    );
    return {
      exitCode,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode,
        error: { code: refused ? "refused" : "crash", message: clip(message) },
      },
    };
  }
  const { result } = outcome;
  const summary = clip(outcome.summary);
  ctx.host.sendUserMessage(`work-lean: ${summary}`, { deliverAs: "steer" });
  const prUrl = prUrlOf(result);
  return {
    exitCode: result.code,
    doc: {
      subcommand: "work-lean",
      issue,
      exitCode: result.code,
      state: result.state,
      summary,
      steps: result.run.steps.length,
      ...(prUrl === undefined ? {} : { prUrl }),
    },
  };
}
