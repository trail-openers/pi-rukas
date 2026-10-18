/**
 * work-driver-verify-output-tail — the bounded, REDACTED tail of a failed
 * verify run, recorded on `verifyEvidence.outputTail` and rendered into both
 * handoff surfaces (#1392).
 *
 * A park that names only `Raw output: <path>` sends the operator to a file in
 * the cycle's scratch dir, which is not where they read the handoff. The tail
 * puts the end of the gate's own output in the comment. That output is
 * attacker-influenced (a test prints what it likes) and the handoff body is
 * posted to the forge verbatim, so:
 *
 * - the writer REDACTS BEFORE IT BOUNDS (`redactClip` widens its scan past the
 *   cut, so a credential straddling the clip is redacted whole rather than
 *   leaving a fragment in the kept half), and starts the kept text at a line
 *   boundary;
 * - the renderer redacts again (a state file is a file anyone can edit) and
 *   fences the text with a fence longer than any backtick run inside it, so
 *   the output cannot close the block and inject markdown.
 */

import { readFileSync } from "node:fs";
import { redactClip } from "./decision-log.ts";
import { redactSecrets } from "./secret-patterns.ts";
import type { WorkState } from "./workflow-state.ts";

/** The most of a failed run's output a handoff carries. */
export const VERIFY_OUTPUT_TAIL_CHARS = 3000;

/** Redact, then bound to the last `VERIFY_OUTPUT_TAIL_CHARS`, from a line start. */
export function verifyOutputTail(raw: string): string | undefined {
  const clipped = redactClip(raw, VERIFY_OUTPUT_TAIL_CHARS, "end");
  // A clip that landed mid-line keeps a partial first line; drop it unless the
  // tail is a single line.
  const nl = clipped.length < raw.length ? clipped.indexOf("\n") : -1;
  const text = (nl >= 0 ? clipped.slice(nl + 1) : clipped).trim();
  return text.length > 0 ? text : undefined;
}

/** The tail of a persisted verify log; `undefined` when it cannot be read. */
export function verifyLogOutputTail(logPath: string | undefined): string | undefined {
  if (logPath === undefined) return undefined;
  try {
    return verifyOutputTail(readFileSync(logPath, "utf8"));
  } catch {
    return undefined;
  }
}

/** The step a verify-family cap parked, or `undefined` for any other cap. */
function verifyCapStep(cap: string): string | undefined {
  if (cap === "integration-verify-failed") return "commit-pr";
  if (cap.startsWith("consolidated-verify-")) return "develop";
  return /^verify-[a-z-]+:(.+)$/.exec(cap)?.[1];
}

/**
 * The handoff lines for the terminal cap's verify evidence: the baseline
 * verdict and the fenced output tail. Empty unless the last cap is a verify
 * park for the same step the evidence was recorded at — `verifyEvidence` is
 * never cleared, so a stale record from an earlier round must not be shown
 * under an unrelated cap.
 */
export function verifyEvidenceLines(state: WorkState, style: "markdown" | "chat"): string[] {
  const ev = state.pipelineState.verifyEvidence;
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  if (!ev || cap?.kind !== "cap-hit" || verifyCapStep(cap.cap) !== ev.step) return [];
  if (ev.baseline === undefined && ev.outputTail === undefined) return [];
  const md = style === "markdown";
  const lines: string[] = [md ? "### Verify output" : "Verify output:", ""];
  if (ev.baseline !== undefined) lines.push(`${md ? "" : "  "}Baseline: ${ev.baseline}`, "");
  if (ev.outputTail !== undefined) {
    const tail = redactSecrets(ev.outputTail).text;
    const longest = Math.max(2, ...(tail.match(/`+/g) ?? []).map((r) => r.length));
    const fence = "`".repeat(longest + 1);
    lines.push(
      `${md ? "" : "  "}Last lines of the failing run (secrets redacted):`,
      "",
      `${fence}text`,
      tail,
      fence,
      "",
    );
  }
  return lines;
}
