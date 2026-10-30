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
 * here has to be a change there. The text is cut to this BEFORE the newline
 * escaping, so `oneline` never runs over a multi-MB stack, and cut once more
 * AFTER it: escaping turns each `\n` into two characters, so the second cut is
 * what keeps the line at `TRACE_MAX` and lands on escaped text, where a cut
 * cannot split a `\n` pair in half and rejoin two frames.
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

/**
 * How long an Error's own `name` may be in the trace label.
 *
 * `name` is the one field a hostile Error supplies VERBATIM into the trace
 * prefix — a 100 KB `name` is a 100 KB line no `TRACE_MAX` on the body would
 * bound, and a `name` carrying a newline would split the record the same way a
 * raw stack would. So it is put through the same single-line rule as the body
 * and bounded on its own: the label is a word, and a word that needs more than
 * this many characters to say "Error" is not a label, it is the payload.
 */
export const NAME_MAX = 120;

/**
 * What the document says when a crash's Error has nothing to say at all.
 *
 * Applied in `fail()` alone: it is the stand-in for a CRASH with no reason, not
 * a rule for any text this verb prints. The success path's summary goes through
 * `clip` with no stand-in, so a run that reported an empty summary is reported
 * that way rather than being handed a word this verb invented.
 */
const UNKNOWN_CRASH = "unknown error";

/**
 * The line terminators `oneline` escapes, as code points.
 *
 * Tab is deliberately NOT here: it does not end a line, and leaving it raw keeps
 * a stack's indentation readable. `\r` does — a terminal, and any NDJSON
 * splitter that honours CRLF, ends the record on it — and U+2028 / U+2029 /
 * U+0085 are line terminators to the JS grammar itself. Same set
 * `lean/text-fence.ts` strips, restated because that one is not exported and
 * folds tab to a space. Code points, not a literal of escape sequences, so a
 * terminator can never be written in a form that matches nothing.
 */
const LINE_BREAK_CP = [0x0a, 0x0d, 0x2028, 0x2029, 0x0085];
/** A single backslash — the escape introducer `oneline` writes. */
const BS = String.fromCharCode(0x5c);

/** A reason line a host can print: clipped, and never the whole step log. */
function clip(text: string): string {
  const reason = text.trim();
  return reason.length > 2000 ? `${reason.slice(0, 2000)}…` : reason;
}

/**
 * Whether a value has anything to say — one predicate, one rule (a blank trim),
 * behind every blank test in this module. A bare `||` on a string treats a
 * whitespace-only message as present, which is AC3's bug.
 */
function blank(text: string): boolean {
  return text.trim() === "";
}

/**
 * Text a hostile value cannot refuse to give: its own text, or "".
 *
 * "" is the answer that says "this value gave nothing", and the CALLER supplies
 * the stand-in (`UNKNOWN_CRASH` for a crash, nothing at all for a summary) — a
 * stand-in baked in here would leak a crash's wording into text that is not a
 * crash.
 *
 * `String()` is where a thrown value's own code runs — `Symbol.toPrimitive`,
 * `valueOf`, `toString` for a non-Error, and a computed `message`/`stack`
 * property for an Error — and `fail()` is the LAST net this verb has. A throw
 * from any of them escapes the verb, `runSubcommand` rejects, and the host
 * reads an empty stdout where the contract promises one document at 30. So a
 * value that refuses to describe itself still gets a label the host can print.
 * A hostile PROPERTY is handed to this function already read (`readField`),
 * because the read itself has to happen in a frame whose try can catch it.
 */
function safeText(text: unknown): string {
  if (typeof text === "string") return text;
  // A symbol has no string form — a bare coercion throws — and `description` is
  // the only text it has; "symbol" is what an undecorated one is called.
  if (typeof text === "symbol") return text.description ?? "symbol";
  // `text` arrives already obtained in a guarded frame, so a failed property
  // read reaches here as `undefined`/`null` and becomes "" rather than the word
  // "undefined" — which would otherwise outrank a readable stack in the
  // fallback chain. The throw this catch exists for is the conversion's own.
  if (text === undefined || text === null) return "";
  try {
    return String(text);
  } catch {
    return "";
  }
}

/**
 * Read ONE property in THIS frame, so the throw lands inside this function's try.
 *
 * `String(err.message)` and `{ message: err.message }` do not do: bun evaluates
 * the property read at the CALLER's frame, before any callee's try can see it —
 * so a hostile `message` getter throws past `safeText`'s catch and takes the
 * verb down, which is the exact failure this net exists to stop (measured: the
 * getter's throw escapes with `safeText(String)` as its only guard). Each field
 * is therefore read through a call whose own try can see the throw, and one
 * hostile field cannot take the others with it. A property read, not
 * `Object.getOwnPropertyDescriptor`: reading a getter's descriptor is safe but
 * useless — the value still has to be obtained, and that is the dangerous step.
 * A failed read is `undefined`, which `safeText` turns into "" — never a string,
 * because a sentinel would be `String`-ified into a fake reason that outranks a
 * readable stack in the fallback chain.
 */
function readField(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * An Error's own fields, each read on its own (`readField` + `safeText`): one
 * getter that throws costs ONLY that field. A try around the whole read would
 * discard a readable `name` and `stack` because `message` refused — exactly what
 * a hostile wrapped Error does.
 *
 * `name` is the one field with a default, because it labels the trace line and
 * an unlabelled warning says nothing about what warned.
 */
function errorFields(err: Error): { name: string; message: string; stack: string } {
  const name = safeText(readField(err, "name")).trim();
  return {
    name: name === "" ? "Error" : name,
    message: safeText(readField(err, "message")),
    stack: safeText(readField(err, "stack")),
  };
}

/**
 * A multi-line value as ONE line: each line terminator escaped, so nothing
 * splits a record.
 *
 * NOT `oneLine` from `lean/text-fence.ts` — that one is for a MARKDOWN table
 * cell (it escapes `|`, collapses runs of spaces, folds tabs), and a stack
 * wants its indentation. The hazard here is narrower: the headless stderr writer
 * turns each physical line into its own NDJSON record, so every terminator in
 * `LINE_BREAK_CP` becomes its escape (`\n`, `\r`, or `\uXXXX`) and the result
 * holds no terminator at all. An escape is longer than the character it
 * replaces, so callers bound the result AFTER this runs.
 */
function oneline(text: string): string {
  let out = text;
  for (const cp of LINE_BREAK_CP) {
    const code = cp === 0x0a ? "n" : cp === 0x0d ? "r" : `u${cp.toString(16).padStart(4, "0")}`;
    out = out.replaceAll(String.fromCharCode(cp), BS + code);
  }
  return out;
}

/**
 * The trace label: an Error's `name`, scrubbed and bounded.
 *
 * `name` is the only field that reaches the trace VERBATIM — `TRACE_MAX` bounds
 * the body alone — so a 200 KB `name` or a `name` carrying a newline would get
 * past the body's bound and split or flood the record. It goes through
 * `oneline` — cut before the escape so it never walks a huge name, and again
 * after it so the bound holds on the ESCAPED text, because escaping lengthens it
 * (`\r` becomes two characters, U+2028 six) and a bound on the raw label is not
 * a bound on what a reader sees. The cut keeps its ellipsis inside the bound.
 */
function traceLabel(name: string): string {
  // Cut BEFORE the escape so `oneline` never walks a 200 KB label, then again
  // AFTER it so the bound holds on the text a reader actually sees: an escape
  // only ever lengthens a string (`\r` is two characters, U+2028 six), so a
  // bound on the raw label is not a bound on the escaped one. The ellipsis is
  // counted INSIDE the bound, so the label is never longer than NAME_MAX.
  const scrubbed = oneline(name.slice(0, NAME_MAX));
  return scrubbed.length > NAME_MAX ? `${scrubbed.slice(0, NAME_MAX - 1)}…` : scrubbed;
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
      traceWarn(`work-lean: #${issue} could not tell the host — ${oneline(safeText(err))}`);
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
    const fields = err instanceof Error ? errorFields(err) : undefined;
    // The trace and the document's reason come from ONE read of the Error, so
    // the `err instanceof Error` test is not written twice: `traceFields` is
    // this crash's fields or nothing, which is both the "is it an Error" and the
    // "is it a crash" test the trace needs.
    const traceFields = refused ? undefined : fields;
    // ONE derivation for both outputs: the message, or the stack when the
    // message says nothing, or nothing at all. The document prints that and the
    // trace carries it, so the reason the host parses and the reason a developer
    // reads on stderr cannot disagree about what the crash said.
    const reason = fields ? (blank(fields.message) ? fields.stack : fields.message) : safeText(err);
    // The stand-in is the crash path's alone (`UNKNOWN_CRASH`), applied here and
    // nowhere else in this module. `oneLine` escapes (control chars, `|`) BEFORE
    // it cuts, so the cut lands on the text a host reads — every `|` in a reason
    // becomes TWO characters there, and its cut appends one "…", hence
    // `MESSAGE_MAX - 1`: `oneLine(x, n)` returns at most n+1 characters, so this
    // is the argument that keeps `doc.error.message` within MESSAGE_MAX.
    const message = oneLine(clip(reason) || UNKNOWN_CRASH, MESSAGE_MAX - 1);
    const exitCode = refused ? EXIT.refused : EXIT.crash;
    // The full error goes to the trace, not just the clipped line the document
    // carries: a crash whose stack is 20 KB is still diagnosable by whoever
    // reads the runner's stderr, and a clipped document is what the host parses.
    // Written as ONE line (newlines escaped): the headless stderr writer turns
    // every physical line into its own NDJSON record, so a raw stack would
    // arrive as a frame dump with the error name detached from it.
    if (err instanceof Error && traceFields !== undefined) {
      // Same fields as the document's reason, never a second derivation: a
      // trace whose reason disagrees with the host's is worse than no trace.
      const body = blank(traceFields.stack) ? reason : traceFields.stack;
      // Cut before the escape so it never walks a multi-MB stack, then again
      // after it (an escape is longer than its character) to keep the bound exact.
      const trace = oneline(body.slice(0, TRACE_MAX + 16)).slice(0, TRACE_MAX);
      traceWarn(`work-lean: #${issue} crashed — ${traceLabel(traceFields.name)}: ${trace}`);
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
