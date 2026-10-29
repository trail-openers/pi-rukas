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
 * The verb passes `{ headless: true }` to the engine: a headless run's children
 * need the /work-cycle trust stamp, and the mode belongs to THIS run rather
 * than to the process, so a second lean run in the same host is not stamped by
 * the first one's having come through here.
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

import { runWorkLean } from "../lean/command.ts";
import type { RunLeanResult } from "../lean/engine.ts";
import { LeanLockError } from "../lean/lock.ts";
import { EXIT_CODES, exitCodeFor } from "../lean/machine.ts";
import { validPrUrl } from "../lean/state-outcome.ts";
import { type Step, newestDecided } from "../lean/state.ts";
import { oneLine } from "../lean/text-fence.ts";
import { traceWarn } from "../trace.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const WORK_LEAN_FLAGS = ["--json"] as const;

/** What a run is described by once its document is built. */
export interface LeanRunOutcome {
  summary: string;
  result: RunLeanResult;
}

/** The run seam: the same signature `runWorkLean` has. */
export type RunLean = (
  repoRoot: string,
  issue: number,
  opts?: { headless?: boolean },
) => Promise<LeanRunOutcome>;

/**
 * Whether this throw is the engine refusing to start behind a live run.
 *
 * A TYPE test, not a message match: `lean/lock.ts` raises `LeanLockError` for
 * every refusal it makes, so "a run holds this issue" is a fact the class
 * carries rather than wording this verb has to keep in sync with another
 * module's prose. Anything else — a schema violation from `lean/state.ts`, a
 * git blow-up, a throw wrapped in somebody else's Error — is a crash, which is
 * the honest answer: this verb cannot tell a reworded refusal from a real
 * failure, and reporting a crash is the safe direction (a host that re-runs a
 * refused cycle collides again and sees 40 then).
 */
function lockHeld(err: unknown): boolean {
  return err instanceof LeanLockError;
}

/**
 * How much of a crash's stack reaches the trace.
 *
 * Exported because the test asserts against THIS number rather than a copy of
 * it: a bound that lives only in the test is a bound nobody chose, and a change
 * here has to be a change there. Applied AFTER the newline escaping, so the
 * clip cannot cut a `\n` in half and rejoin two frames.
 */
export const TRACE_MAX = 4000;

/**
 * How long one reason line the host reads may be.
 *
 * Separate from `TRACE_MAX` deliberately: the trace carries a stack a developer
 * needs, the document carries a reason a host prints, and the two bounds answer
 * different questions. `oneLine` clips at this and `clip` at its own bound
 * first, so a value that survives both still fits one record.
 */
export const MESSAGE_MAX = 1000;

/** A reason line a host can print: clipped, and never the whole step log. */
function clip(text: unknown): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

/**
 * Read one property of a thrown value without letting the read throw.
 *
 * An `Error` whose `message`, `name` or `stack` is an ACCESSOR that throws is
 * rare but real (a wrapped host error, a proxy, a deserialized object), and
 * every read `fail` makes happens outside the verb's own try — the try is what
 * called `fail`. A throwing getter would therefore reject `runSubcommand`, and
 * the host would read no document at all: the exact contract `fail` exists to
 * keep. A field that cannot be read is simply absent, so the caller's own
 * fallback answers for it.
 */
function readable(target: object, key: string): string | undefined {
  try {
    const value = (target as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Characters that read as nothing on screen while `trim()` and `\s` keep them:
 * U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER, U+180E MONGOLIAN VOWEL SEPARATOR,
 * U+204F REVERSED SEMICOLON (a visible-looking separator that renders blank in
 * many fonts). None is `\s` or `\p{Cc}`, so a `trim()` — or the control-character
 * sweep in `lean/text-fence.ts` — leaves one standing.
 */
const INVISIBLE = /[\u200b\u2060\u180e\u204f]/;

/**
 * Is there anything here a host could print? `trim()` alone is not enough: a
 * message made of one of `INVISIBLE` trims to itself, so it would count as
 * content while rendering as a blank line.
 */
function printable(text: string | undefined): string {
  const trimmed = text?.trim() ?? "";
  return INVISIBLE.test(trimmed) ? "" : trimmed;
}

/**
 * What the document names a crash by: the message, else the stack, else a
 * literal.
 *
 * A crash whose message is empty or whitespace still has to be nameable — the
 * stack is the next thing the Error carries, and when neither has content the
 * host at least reads something it can print.
 */
function crashMessage(err: unknown): string {
  if (err instanceof Error) {
    return (
      printable(readable(err, "message")) || printable(readable(err, "stack")) || "unknown error"
    );
  }
  try {
    // A non-Error goes through `toString`, which is itself a seam that can throw.
    return printable(String(err)) || "unknown error";
  } catch {
    return "unknown error";
  }
}

/**
 * A multi-line value as ONE line: newlines escaped, so nothing splits a record.
 *
 * NOT `oneLine` from `lean/text-fence.ts` — that helper escapes `|` and
 * collapses runs of spaces for a MARKDOWN table cell, and folds tabs and the
 * Unicode separators into plain spaces. What this verb needs is narrower: the
 * headless stderr writer turns every physical newline into its own NDJSON
 * record, so the only hazard is a newline, and a stack whose indentation
 * survives is far more readable than one whose leading tabs became spaces.
 */
function oneline(text: string): string {
  return text.replaceAll("\n", "\\n");
}

/**
 * The newest DECIDED `publish` step's URL, if the run got that far.
 *
 * `newestDecided` is the log's own rule (an outcome-less step is a crash
 * mid-step and has said nothing), so a newer `publish` that decided without a
 * URL reports no URL — reading one from an earlier publish would hand the host
 * the address of a PR this run replaced.
 *
 * The value is then re-checked with the load-time rule `handback` applies, not
 * trusted: the log a verb sees is a `Step[]`, and the loader is not the only
 * thing that hands one over. A URL that breaks the shape is not a link the host
 * should open, so the answer is the same as "no publish step recorded one".
 */
function prUrlOf(steps: Step[]): string | undefined {
  return validPrUrl(newestDecided(steps, "publish")?.outcome?.prUrl);
}

/**
 * Does this object have the shape `RunLeanResult` says it has? The engine's
 * return value is the host's document, so a field that is missing or of the
 * wrong type is reported as a crash rather than thrown at the caller.
 *
 * `summary` and `code` are checked here rather than where they are printed:
 * both are typed non-optional and both are values this verb puts in front of a
 * host, so a `null` from a JSON round-trip is a malformed outcome, judged once
 * and before anything reads it.
 *
 * The code is judged against `EXIT_CODES` and `exitCodeFor` rather than being
 * range-checked: those two ARE the state→code contract, and this verb restates
 * the run's answer instead of keeping its own copy of it. `{code: 99, state:
 * "landed"}` is a malformed outcome, not a document that tells the host to
 * exit 99 for work that landed.
 */
function wellFormed(outcome: unknown): outcome is LeanRunOutcome {
  const o = outcome as LeanRunOutcome | undefined;
  const result = o?.result;
  if (
    typeof o?.summary !== "string" ||
    typeof result !== "object" ||
    result === null ||
    result.run === undefined ||
    !Array.isArray(result.run?.steps) ||
    typeof result.code !== "number" ||
    typeof result.state !== "string" ||
    !Object.hasOwn(EXIT_CODES, result.state)
  )
    return false;
  // `exitCodeFor` throws on a non-terminal state, which the `hasOwn` test above
  // already refused, so this only ever compares two numbers.
  return result.code === exitCodeFor(result.state);
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
  // Every host send goes through here. `sendUserMessage` is a host seam, and a
  // host whose chat channel throws (a closed stream, a Pi mid-turn rejection)
  // must not turn a run that FINISHED into an escaped exception out of the
  // verb — the message is a courtesy, the document is the contract. A failure
  // is traced, never swallowed silently: the run's answer still lands, and
  // whoever reads stderr can see the channel was broken.
  const say = (text: string): void => {
    try {
      ctx.host.sendUserMessage(text, { deliverAs: "steer" });
    } catch (err) {
      traceWarn(`work-lean: #${issue} could not tell the host — ${oneline(String(err))}`);
    }
  };
  say(`work-lean: #${issue} starting`);
  // ONE guarded region: everything from the call to the return of the document
  // sits here, so whatever the engine (or a malformed return from it) does, the
  // host gets exactly one document and one exit code rather than a rejection.
  // `fail` is the single shape both the refusal and the crash answer take —
  // they differ only in the code and the reason word, and were two copies of
  // the same body before.
  const fail = (err: unknown, refused: boolean): VerbOutcome => {
    // `oneLine` from `lean/text-fence.ts` before the message is printed
    // anywhere: it is untrusted text (a git tail, somebody's wrapped Error)
    // that goes into a JSON document AND a host message the NDJSON writer
    // turns into one record per physical newline — and every control character,
    // not just \n, has to go for the line to stay one line. The clip stays:
    // the fence clips at its own bound and a 20 KB message is what the clip
    // exists to stop.
    const message = oneLine(clip(crashMessage(err)), MESSAGE_MAX);
    const exitCode = refused ? EXIT.refused : EXIT.crash;
    // The full error goes to the trace, not just the clipped line the document
    // carries: a crash whose stack is 20 KB is still diagnosable by whoever
    // reads the runner's stderr, and a clipped document is what the host parses.
    // Written as ONE line (newlines escaped): the headless stderr writer turns
    // every physical line into its own NDJSON record, so a raw stack would
    // arrive as a frame dump with the error name detached from it.
    if (!refused && err instanceof Error) {
      const trace = oneline(readable(err, "stack") ?? message).slice(0, TRACE_MAX);
      traceWarn(`work-lean: #${issue} crashed — ${readable(err, "name") ?? "Error"}: ${trace}`);
    }
    say(`work-lean: #${issue} ${refused ? "refused" : "crashed"} (exit ${exitCode}) — ${message}`);
    return {
      exitCode,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode,
        error: { code: refused ? "refused" : "crash", message },
      },
    };
  };
  try {
    // #1883 — this run's children carry the /work-cycle trust stamp, or the
    // headless permission path hard-denies their tool calls. Passed per run
    // rather than marked on the process: an interactive `/work-lean` in the
    // same host stays unstamped, and so does a second headless run that does
    // not ask for it.
    const raw = await run(ctx.repoRoot, issue, { headless: true });
    if (!wellFormed(raw)) throw new Error("the run returned a malformed outcome");
    const summary = oneLine(clip(raw.summary), MESSAGE_MAX);
    say(`work-lean: ${summary}`);
    const prUrl = prUrlOf(raw.result.run.steps);
    return {
      exitCode: raw.result.code,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode: raw.result.code,
        state: raw.result.state,
        summary,
        steps: raw.result.run.steps.length,
        ...(prUrl === undefined ? {} : { prUrl }),
      },
    };
  } catch (err) {
    return fail(err, lockHeld(err));
  }
}
