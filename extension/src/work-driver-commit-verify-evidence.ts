/**
 * work-driver-commit-verify-evidence — #1064: the terminal commit-pr caps always
 * carry their evidence.
 *
 * The measured defect. Cycle 1064 parked at `integration-verify-failed` with the
 * cap as its ONLY evidence: `causeEvidence` was the string
 * `integration-verify-failed`, the handoff named no failing test, and the operator
 * had nothing to read. `runCommitPrLocked` attached `evidence` only when the run had
 * been killed at its bound (`mech.timedOut`), so every ordinary red consolidated
 * verify parked blank. The develop step had the same hole until #841 fixed it in
 * `appendDevelopVerifyFailure`; this is the commit-pr twin of that fix, reading the
 * same bounded failure lines the classifier already saw.
 *
 * Two rules:
 *   - the evidence is the gate's OWN bounded extraction (`vr.failures` — the
 *     `FAILED: N test(s)` names and the `✗` assertion lines), never a re-read of the
 *     raw stream at the cap site. Re-deriving it here is how two renderers of one
 *     failure start disagreeing.
 *   - the log path rides STRUCTURALLY on the cap event (`logPaths`), the same
 *     #841 contract the develop caps use, so no renderer has to regex a path out of
 *     prose. Absent when no log was written — absence is honest, a fabricated path
 *     is not.
 *   - EVERY string this module writes is redacted BEFORE it is bounded (#1702 review
 *     round). These fields land in the state file, the handoff comment and the PR body.
 *     The raw stream is the project's own verify output and the forge's refusal text —
 *     both untrusted, and a GH013 refusal quotes the very content push protection
 *     flagged. `redactThenBound` redacts first so the bound cannot cut a token into a
 *     fragment no pattern recognises.
 */

import { redactThenBound } from "./text-flatten.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/** The cap a terminal commit-pr park records — the cap union, not a free string. */
export type CommitPrTerminalCap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * The lines of the gate's failure text that name an actual failure: the verify
 * loop's per-test `FAILED:` markers (including the `FAILED: <n> test(s) — a, b`
 * summary, which carries the names) and its `✗` assertion lines. Both come from the
 * same stream the classifier read, so the cap and the classification describe one
 * run.
 */
const NAMED_FAILURE_LINE = /^\s*(FAILED:|✗)/;

/**
 * Per-line bound for a recovered failure line. A verify assertion can print a whole
 * document; the evidence field is a summary, not a log, and the log pointer
 * (`logPaths`) is where the full stream lives.
 *
 * EXPORTED, and the values are the contract: they must stay LOOSER than the render-side
 * clips (`LINE_MAX` in work-driver-cause-class.ts, `EVIDENCE_MAX` in headless/failure.ts),
 * because a store bound that drops below a display bound silently truncates evidence the
 * operator is entitled to see. `test-commit-pr-verify-evidence-1064.ts` pins that ordering —
 * a tightened constant is precisely the change nobody notices in review.
 */
export const NAMED_FAILURE_LINE_MAX = 400;

/**
 * Bounds for the two composed surfaces. They mirror the develop caps' evidence bound
 * (`CAP_EVIDENCE_TOTAL_MAX` in work-develop-cap-evidence.ts) so the two parks the operator
 * reads side by side are bounded alike; `boundJoinFailures` still bounds the joined
 * failure block inside them. Same export contract as `NAMED_FAILURE_LINE_MAX`.
 */
export const REASON_MAX = 2000;
export const FAILURE_LINE_MAX = 1200;
export const EVIDENCE_TOTAL_MAX = 4200;

/**
 * The named-failure lines the verify loop printed, in stream order, de-duplicated.
 *
 * Why this exists at all: the 800-char attributed tail that feeds the classifier
 * anchors on the LAST `FAILED:` marker and elides its own head when the verbose
 * re-run after it is long (`extractAttributedTail`, work-driver-exec-error.ts). With
 * many failures the summary line — the one that carries the test NAMES — falls in
 * the elided head, and `extractSpecificAssertion` was left reporting
 * `(no specific assertion could be extracted)` over a stream that had named every
 * failing test. Searching the full text recovers what the window clipped.
 *
 * Returns `[]` when the stream names nothing (a bare tsc/biome tail, an echoed
 * command): the caller then keeps whatever the classifier extracted rather than
 * replacing an honest absence with an invented line.
 */
export function namedFailureLines(text: string | undefined): string[] {
  if (text === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || !NAMED_FAILURE_LINE.test(line)) continue;
    // #1702 — a `FAILED:` / `✗` line is a line of the project's own output, and a
    // failing assertion commonly ECHOES the value it compared: a test that asserts on
    // a token, a connection string or a config dump prints it here. This is the
    // highest-value line in the whole evidence set and it used to be the one that was
    // never redacted. Redacting before the de-dup keeps two spellings of one line
    // (same line, one carrying a secret) collapsing to one entry rather than two.
    const redacted = redactThenBound(line, NAMED_FAILURE_LINE_MAX).text;
    if (redacted.length === 0 || seen.has(redacted)) continue;
    seen.add(redacted);
    out.push(redacted);
  }
  return out;
}

/** What one terminal commit-pr park knows about itself. */
export interface ConsolidatedVerifyEvidence {
  /** The cap the caller records (`integration-verify-failed`, `verify-timeout:commit-pr`, `push-refused:commit-pr`). */
  cap: CommitPrTerminalCap;
  /** The mechanized failure's reason — the gate's own handoff-ready text. */
  reason: string;
  /** The run was killed at its bound, so it reached no verdict. */
  timedOut?: boolean;
  /** The FORGE refused the push; the verdict is the remote's, not the code's. */
  pushRefused?: boolean;
  /** The raw failure lines the gate extracted from (the `FAILED:` / `✗` source). */
  failures?: string[];
  /** Persisted raw-output logs, on the same structural channel #841 uses. */
  logPaths?: string[];
}

/**
 * `pipelineState.verifyEvidence` for a terminal commit-pr park, or `undefined` when
 * there is nothing to record. Written for every terminal cap, not only the timed-out
 * one (#1064): with no `failures` the cause classifier has no check lines to name and
 * the `✗`/`FAILED:` recovery cannot run at all.
 */
export function consolidatedVerifyEvidenceFields(e: ConsolidatedVerifyEvidence):
  | {
      verifyEvidence: {
        step: "commit-pr";
        failures: string[];
        at: number;
        origin: "outcome-gate" | "push-refused";
      };
    }
  | undefined {
  if (e.pushRefused === true) {
    return {
      verifyEvidence: {
        step: "commit-pr",
        // #1702 — this line is the forge's own refusal text, which quotes the content
        // push protection flagged. It is stored on `pipelineState` and rendered by the
        // handoff and the cause classifier, so it is redacted on the way in.
        failures: [redactThenBound(e.reason, REASON_MAX).text],
        at: Date.now(),
        origin: "push-refused",
      },
    };
  }
  const failures = (e.failures ?? [])
    .map((f) => redactThenBound(f, FAILURE_LINE_MAX).text)
    .filter((f) => f.trim().length > 0);
  if (failures.length === 0) return undefined;
  return {
    verifyEvidence: {
      step: "commit-pr",
      failures,
      at: Date.now(),
      origin: "outcome-gate",
    },
  };
}

/**
 * The cap-hit's own `evidence` (+ `logPaths`) for a terminal commit-pr park. Every
 * terminal cap gets one — the pre-#1064 spread emitted evidence for a timeout only,
 * which is what left 1064's handoff with the cap name and nothing else.
 *
 * The reason leads (it is the classified message: the assertion, the workstream ids,
 * the restore claim), and the named-failure lines are appended so the test names
 * survive even when the classifier's window clipped them. Bounded through the same
 * `boundJoinFailures` the develop caps use.
 */
export function consolidatedVerifyCapFields(e: ConsolidatedVerifyEvidence): {
  evidence?: string;
  logPaths?: string[];
} {
  const named = (e.failures ?? []).flatMap((f) => namedFailureLines(f));
  // The reason leads (it is the classified message), redacted, and the named-failure lines
  // are appended so the test names survive even when the classifier's window clipped them.
  // Bounded through the same `boundJoinFailures` the develop caps use, then redacted again
  // with the join's own bound so a credential SPLIT across the join boundary is still swept
  // (`redactThenBound` redacts before it clips — the order is the whole point).
  const joined =
    named.length > 0
      ? `${redactThenBound(e.reason, REASON_MAX).text}\n${boundJoinFailures([named.join("\n")])}`
      : e.reason;
  const body = redactThenBound(joined, EVIDENCE_TOTAL_MAX).text;
  const logs = (e.logPaths ?? []).filter((p) => p.trim().length > 0);
  return {
    evidence: body,
    ...(logs.length > 0 ? { logPaths: logs } : {}),
  };
}
