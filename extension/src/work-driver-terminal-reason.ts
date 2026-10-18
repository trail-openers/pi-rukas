/**
 * work-driver-terminal-reason — the cycle's terminal reason when a clock, not
 * the step's own judgement, ended the step (#1593).
 *
 * The headless result and the handoff marker read the LAST cap-hit as the
 * cycle's cap. A step that ends on a verdict (`verify-failed:develop`, a fence
 * park) writes that verdict last, even when what actually ended the step was a
 * clock. example-owner/orchard cycle 175 is the reference: its developer was killed at
 * the 2 h spawn backstop, the fence gate then judged the tree the killed child
 * left, and both events carry one timestamp — the record read as a code-fence
 * park for a develop round that was killed at its ceiling.
 *
 * At the handoff boundary (the one place every routed park passes), this
 * appends a cap-hit that says what ended the step, keeping the step's own
 * verdict in the log and naming it in the evidence:
 *
 * - `deadline` — the caller's whole-cycle deadline had passed by the time the
 *   step ended. The boundary check only consults the deadline before a step
 *   starts, so a step that crossed it ran without it; its verdict is not the
 *   reason the cycle stopped.
 * - otherwise, a child of that step killed at its backstop (`killCause:
 *   timeout`) and never re-run to completion → the cap the router gives a
 *   backstop kill of its own: `spawn-backstop` for develop,
 *   `step-failed:<step>` elsewhere. A child ended at its per-child run bound
 *   (`killCause: child-bound`, #1560) records `child-timeout:<step>`.
 *
 * Caps that already name a clock, a kill or a guard are left alone, and so is
 * `awaiting-human-merge` (finished work waiting on a person). Pure.
 */

import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

type FailedDispatch = Extract<WorkEvent, { kind: "dispatch-failed" }>;

/** Caps whose own name already says a clock, a kill or a guard ended the step. */
const STANDS_AS_IS = new Set<string>([
  "deadline",
  "awaiting-human-merge",
  "spawn-backstop",
  "plan-timeout",
  "lens-review-timeout",
  "loop-detected",
  "token-budget",
  "provider-unavailable",
  "develop-child-crash",
]);
const STANDS_AS_IS_PREFIXES = [
  "step-failed:",
  "verify-timeout:",
  "driver-crash:",
  "child-timeout:",
];

const EVIDENCE_QUOTE_MAX = 300;

function standsAsIs(cap: string): boolean {
  return STANDS_AS_IS.has(cap) || STANDS_AS_IS_PREFIXES.some((p) => cap.startsWith(p));
}

function quote(text: string | undefined): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_QUOTE_MAX ? `${flat.slice(0, EVIDENCE_QUOTE_MAX)}…` : flat;
}

/** Children of the window killed at a time bound and not re-run to completion. */
function backstopKills(window: readonly WorkEvent[]): FailedDispatch[] {
  return window.filter(
    (e, i): e is FailedDispatch =>
      e.kind === "dispatch-failed" &&
      (e.killCause === "timeout" || e.killCause === "child-bound") &&
      !window
        .slice(i + 1)
        .some((later) => later.kind === "dispatch-completed" && later.label === e.label),
  );
}

/**
 * The state the handoff starts from: `state` itself, or `state` with one
 * cap-hit appended naming the clock that ended the step (see the header).
 * `deadline` is the cycle's resolved deadline (undefined: none set).
 */
export function terminalReasonAtHandoff(
  state: WorkState,
  deadline: number | undefined,
  now: number,
): WorkState {
  const log = state.eventLog;
  let capIdx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.kind === "cap-hit") {
      capIdx = i;
      break;
    }
  }
  const cap = log[capIdx];
  if (cap?.kind !== "cap-hit" || standsAsIs(cap.cap)) return state;
  let startIdx = capIdx;
  while (startIdx >= 0 && log[startIdx]?.kind !== "step-started") startIdx--;
  const started = log[startIdx];
  if (started?.kind !== "step-started" || started.step === "handoff") return state;
  const step = started.step;
  const kills = backstopKills(log.slice(startIdx, capIdx + 1));
  const verdict = `its own verdict \`${cap.cap}\`${cap.evidence ? ` (${quote(cap.evidence)})` : ""}`;

  if (deadline !== undefined && now >= deadline) {
    const killed = kills.length
      ? `; ${kills.length} child dispatches of the step were killed (${kills.map((k) => `${k.label}: ${quote(k.errorTail)}`).join("; ")})`
      : "";
    return appendEvent(state, {
      kind: "cap-hit",
      at: now,
      cap: "deadline",
      reviewRound: state.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence:
        `caller deadline ${deadline} (absolute epoch ms) passed while step "${step}" ran — ` +
        `it ended ${now - deadline}ms past it${killed}. The deadline is checked only before a step ` +
        `starts, so ${verdict} is not why the cycle stopped`,
    });
  }

  const kill = kills[kills.length - 1];
  if (!kill) return state;
  const backstopCap: WorkCapLiteral =
    kill.killCause === "child-bound"
      ? `child-timeout:${step}`
      : step === "develop"
        ? "spawn-backstop"
        : `step-failed:${step}`;
  return appendEvent(state, {
    kind: "cap-hit",
    at: now,
    cap: backstopCap,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: [
      `${kill.label} was killed at its time bound (${quote(kill.errorTail) || "killCause timeout"})`,
      `in the same step "${step}" that then recorded ${verdict} — that verdict judged what the`,
      "killed child left behind, so it is not why the cycle stopped",
    ].join(" "),
  });
}
