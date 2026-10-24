/**
 * public-hygiene-verdict — the traceable ACCOUNT of a publish check (#1788
 * round 1), split out of `public-hygiene-guard.ts` along the seam AGENTS.md §12
 * asks for: the guard decides, this module says what it decided in the one form
 * a log may carry.
 *
 * ## Why a verdict is a TYPE and not a string
 *
 * Every refusal the guard makes must be actionable, and the thing that makes it
 * actionable is structure: WHICH surface, WHICH denylist line or WHICH category,
 * and how long the text was. The prose is rendered from those fields by
 * `public-hygiene-refusals.ts`; the trace lines are rendered from the same ones
 * here. A free-text verdict would let a future author interpolate the matched
 * term into a sentence without anyone noticing, and a trace line is NOT a safe
 * place for the term — `traceWarn` is ungated stderr that the headless console
 * writer and the run transcript capture with no redaction in front of it
 * (#1417). The four variants below are the whole vocabulary a refusal may use,
 * and adding a fifth is a visible act.
 *
 * ## What a verdict never carries
 *
 * The term. Not in a field, not in a prefix, not truncated. The `length` field
 * exists precisely so a trace can say "a 46-character body matched line 2"
 * without saying what those 46 characters were — the operator opens the denylist
 * at the line, and that is the only route from a refusal to the term.
 */

import { trace, traceWarn } from "./trace.ts";

/** A verdict the guard reached, for the trace. Never carries text. */
export type Verdict =
  /** Clean, with the number of text surfaces that were actually checked. */
  | { kind: "clean"; texts: number }
  | { kind: "denylist"; location: string; line: number; length: number }
  | { kind: "generic"; location: string; category: string; length: number }
  | { kind: "unreadable"; location: string; length: number };

/**
 * Trace a verdict: categories, line numbers and lengths only, never the term.
 *
 * The BLOCKED lines are `traceWarn` — ungated stderr — because a refusal an
 * operator cannot see is a refusal they cannot debug, and the diagnostic value
 * of "which surface, which line, how long" is what makes a wrong denylist entry
 * findable. That is also exactly why the fields are the only thing printed: the
 * value that would make the line most useful, the matched text, is the one value
 * this guard may never print.
 */
export function traceVerdict(v: Verdict): void {
  if (v.kind === "denylist") {
    traceWarn(
      `public-hygiene: BLOCKED publish denylist line=${v.line} location=${v.location} textLength=${v.length}`,
    );
  } else if (v.kind === "generic") {
    traceWarn(
      `public-hygiene: BLOCKED publish category=${v.category} location=${v.location} textLength=${v.length}`,
    );
  } else if (v.kind === "unreadable") {
    traceWarn(
      `public-hygiene: BLOCKED publish unreadable location=${v.location} textLength=${v.length}`,
    );
  } else {
    trace(`public-hygiene: publish clean (${v.texts} text surface(s) checked)`);
  }
}
