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
// The single-line rules for everything this verb prints, in one module: see its
// header for why the bounds live there and are re-exported from here.
import {
  MESSAGE_MAX,
  TRACE_MAX,
  blank,
  clip,
  errorFields,
  oneline,
  safeText,
  traceLabel,
} from "./work-lean-trace.ts";
export { MESSAGE_MAX, NAME_MAX, TRACE_MAX } from "./work-lean-trace.ts";
import { MINUTE_MS } from "../lean/deadline.ts";
import type { RunLeanResult } from "../lean/engine.ts";
import { LeanLockError } from "../lean/lock.ts";
import { EXIT_CODES, exitCodeFor } from "../lean/machine.ts";
import { validPrUrl } from "../lean/state-outcome.ts";
import { type Step, newestDecided } from "../lean/state.ts";
import { oneLine } from "../lean/text-fence.ts";
import { traceWarn } from "../trace.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";
import { leanResultDocument } from "./work-lean-result.ts";
/**
 * What `work-lean` accepts besides its issue number, in one list as every other
 * verb publishes its own (`work` lists `--timeout` the same way). `--json` is
 * accepted and changes nothing; `--timeout` takes minutes and means what it means
 * to `work` (#1920 item 2): the run starts no new step once its deadline is
 * inside the handoff allowance, and it ends with a result document rather than
 * being killed mid-step. `WORK_LEAN_VALUE_FLAGS` names which of these take a
 * value, because the parser must not read the next token as positional for a
 * flag that has none.
 */
export const WORK_LEAN_FLAGS = ["--json", "--timeout"] as const;
/** The flags that take one value. Published beside the bools for `--capabilities`. */
export const WORK_LEAN_VALUE_FLAGS = ["--timeout"] as const;

/** What a run is described by once its document is built. */
export interface LeanRunOutcome {
  summary: string;
  result: RunLeanResult;
}

/** The run seam: the same signature `runWorkLean` has. */
export type RunLean = (
  repoRoot: string,
  issue: number,
  opts?: { headless?: boolean; timeoutMs?: number },
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
 * What the document says when a crash's Error has nothing to say at all.
 *
 * Applied in `fail()` alone: it is the stand-in for a CRASH with no reason, not
 * a rule for any text this verb prints. The success path's summary goes through
 * `clip` with no stand-in, so a run that reported an empty summary is reported
 * that way rather than being handed a word this verb invented.
 */
const UNKNOWN_CRASH = "unknown error";

/**
 * The document one crash or one refusal is described by.
 *
 * Extracted UNCHANGED from `fail` (#1920 slice B) so the verb's thin facade can
 * rebuild the byte-identical answer rather than copy it: #1924 hardened these
 * two documents — a refusal at 40, a crash at 30 — and their tests must stay
 * green, so there is exactly one place that writes them.
 */
export function leanFailureDocument(
  issue: number,
  refused: boolean,
  message: string,
): Record<string, unknown> {
  return {
    subcommand: "work-lean",
    issue,
    exitCode: refused ? EXIT.refused : EXIT.crash,
    error: { code: refused ? "refused" : "crash", message },
  };
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
  const p = parseFlags(argv, {
    bool: [...WORK_LEAN_FLAGS],
    value: [...WORK_LEAN_VALUE_FLAGS],
  });
  if ("error" in p) return badArguments(p.error);
  if (p.positional.length !== 1 || !/^\d+$/.test(p.positional[0] as string)) {
    return badArguments("usage: work-lean <issue> [--json] [--timeout <minutes>]");
  }
  const issue = Number.parseInt(p.positional[0] as string, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    return badArguments("usage: work-lean <issue> [--json] [--timeout <minutes>]");
  }
  // `--timeout <minutes>` means the same number to both engines, so it is
  // refused with the same words `work`'s parser uses and reaches the engine as
  // minutes × 60 000 — the same `timeoutMs` `runHeadless` gets.
  let timeoutMs: number | undefined;
  const rawTimeout = p.value.get("--timeout");
  if (rawTimeout !== undefined) {
    const minutes = Number(rawTimeout);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return badArguments("--timeout needs minutes > 0");
    }
    timeoutMs = minutes * MINUTE_MS;
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
      // Its OWN guarded frame. The trace is a diagnostic; the document this
      // function returns is the contract, and `fail()` is the LAST net the verb
      // has — so a stderr writer that throws (a closed fd, a host that replaced
      // the stream, a trace seam that itself fails) must not cost the host its
      // one document and its exit code 30. Swallowed on purpose: there is no
      // second channel to report a broken first channel to from inside the
      // handler for it.
      try {
        traceWarn(`work-lean: #${issue} crashed — ${traceLabel(traceFields.name)}: ${trace}`);
      } catch {
        /* the document is the contract */
      }
    }
    say(`work-lean: #${issue} ${refused ? "refused" : "crashed"} (exit ${exitCode}) — ${message}`);
    // ONE writer for this document: the export below is what builds it, so the
    // facade cannot drift from the shape #1924 hardened (key order included —
    // `JSON.stringify` follows insertion order, and a host that string-compares
    // the refusal would see a reordering as a changed contract).
    return { exitCode, doc: leanFailureDocument(issue, refused, message) };
  };
  try {
    // #1883 — this run's children carry the /work-cycle trust stamp, or the
    // headless permission path hard-denies their tool calls. Passed per run
    // rather than marked on the process: an interactive `/work-lean` in the
    // same host stays unstamped, and so does a second headless run that does
    // not ask for it.
    const raw = await run(ctx.repoRoot, issue, { headless: true, timeoutMs });
    if (!wellFormed(raw)) throw new Error("the run returned a malformed outcome");
    const summary = oneLine(clip(raw.summary), MESSAGE_MAX);
    say(`work-lean: ${summary}`);
    // #1920 slice B — the success path is a schema-5 `ResultDocument`: one
    // issue, with `status`, `cap`, `failure`, `branch`, `prUrl`, `prState` and
    // `usage`, so the host that drives `work` reads one reader for both engines.
    // `schemaVersion` is written here, not in `result.ts`'s `resultDocument`,
    // because `runSubcommand` (cli.ts) spreads `buildCommit`/`buildVersion` into
    // whatever a verb returns and the two surfaces must not both own the build.
    // The crash and refusal documents are untouched — #1924 hardened them.
    return {
      exitCode: raw.result.code,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode: raw.result.code,
        state: raw.result.state,
        summary,
        // Kept beside the schema-5 fields: the step COUNT is what the
        // pre-#1920 document carried and a host that read it still finds it.
        // The per-step timings are in `issues[0].steps`.
        steps: raw.result.run.steps.length,
        ...leanResultDocument(raw.result.run, raw.result.code).doc,
      },
    };
  } catch (err) {
    return fail(err, lockHeld(err));
  }
}
