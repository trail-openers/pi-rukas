/**
 * work-driver-verify-full — verify-full command discovery and execution.
 *
 * Issue #279 — adds a second verify tier that distinguishes \"the fast
 * suite passed\" from \"the suite that exercises real dependencies passed.\"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { withVerifySlot } from "./host-resources.ts";
import { redactThenBound } from "./text-flatten.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { classifyFailureLine } from "./work-driver-verify-failures.ts";
import { combinedExecFailureStream } from "./work-driver-verify-flake.ts";

/** Read the first non-empty, non-comment line from a config file. */
function readFirstConfigLine(content: string): string | undefined {
  return content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Resolve the verify-full command for the project.
 *
 * Issue #279 part A: reads `.pi/verify-cmd-full` ONLY — first non-empty,
 * non-comment line, verbatim. NO derivation fallback (an inferred \"full
 * suite\" recreates exactly the ambiguity this removes). Explicit escape
 * hatch: when the file is absent, the verify-full tier is skipped with a
 * visible `verify-full-status: skipped` event.
 *
 * Returns the command verbatim (caller must execute it in the correct cwd:
 * the group's primary worktree, never repoRoot, per #279 addendum).
 */
export async function verifyCmdFullFor(repoRoot: string): Promise<string | undefined> {
  const fullPath = path.join(repoRoot, ".pi", "verify-cmd-full");
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    const line = readFirstConfigLine(raw);
    return line;
  } catch {
    // No explicit file — verify-full tier skipped.
    return undefined;
  }
}

/**
 * #782 — a single bounded re-run for the verify-full flake. Opt-in via the
 * `retry` argument of `runVerifyFull`; the existing callers that run the
 * tier once (the offline test fixtures, pre-#782 callers) keep the pre-#782
 * shape by passing nothing.
 */
interface VerifyRun {
  ms: number;
  ok: boolean;
  output: string;
  /** True when `output` opens at a recognised failure line — see {@link StoredTierOutput}. */
  anchored: boolean;
}

/**
 * #1642 — the output bound every project gate run carries: the same 8 MiB the
 * develop / consolidated / per-worktree tiers use.
 *
 * The ci tier used to pass `1024 * 1024` — one MiB per stream, described in
 * the code as "a cap for the evidence tail". That number never bounded the
 * tail (the caller slices the last 500 chars itself); it bounded the RUN, so a
 * full offline suite whose combined output crossed 1 MiB was SIGKILLed at the
 * overflow and reported to the operator as
 * `stdout maxBuffer length exceeded` — a red gate that said nothing about the
 * code, and one that could not be fixed from the project side. A chatty gate
 * now runs to completion and the tail is still bounded where it is actually
 * read (`evidenceTail`, and `extractAttributedTail` in the classifier).
 */
export const VERIFY_FULL_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * #1770 — how much of a tier's output the driver STORES.
 *
 * The ci tier's `VerifyRun.output` is not a transient: it becomes the
 * `verify-full-status` event's `evidenceTail`, which is appended to the event
 * log, written to the state file, and rendered into the handoff comment the
 * driver posts to the forge. The tier reads 8 MiB per stream because the RUN
 * must survive a chatty suite; nothing downstream reads more than a tail. The
 * bound is where the producer stops, so the unbounded stream never reaches a
 * stored field at all.
 */
export const VERIFY_FULL_OUTPUT_MAX = 4000;

/**
 * How far BACK from the end of a redacted stream {@link storeTierOutput} looks
 * for the anchor line: eight stored excerpts. A gate's failure line lives in the
 * last screenfuls of its output — anything beyond eight windows of tail is
 * earlier passing noise, and the excerpt would have started there anyway.
 *
 * The number is a cost bound, not a semantic one. `failureLines` over the whole
 * stream is O(size x lines) and a full offline suite prints megabytes, so finding
 * "the last recognised line" by scanning forward over all of it re-reads the
 * entire run to decide a 4 KB window. A backward scan over the tail is bounded by
 * the window, and a failure line deeper than that is deeper than the window can
 * show anyway.
 */
const VERIFY_FULL_ANCHOR_SCAN_MAX = 8 * VERIFY_FULL_OUTPUT_MAX;

/**
 * A recognised failure line and where it sits, as {@link lastFailureLineIn} found
 * it. The offset is a UTF-16 offset into the REDACTED text the scan was given,
 * which is the same text the window is cut from — one coordinate space, so a
 * caller never re-derives an offset from a string it was handed.
 */
interface FailureAnchor {
  /** The recognised line, trimmed. */
  line: string;
  /** Its first character in `text`. */
  at: number;
}

/**
 * The LAST line of `text` the failure-line table recognises, or `undefined`.
 *
 * A BACKWARD line scan, and the direction is the whole point. The line is wanted
 * for its position, the tail is kept regardless, and a failure line printed after
 * the window's end is of no use to a window that cannot show it — so the search is
 * confined to the last {@link VERIFY_FULL_ANCHOR_SCAN_MAX} characters and stops at
 * the first hit, which is the last one in stream order. `failureLines` over the
 * whole stream answers the same question by reading every byte of a multi-megabyte
 * run first, which is the cost this replaces.
 */
function lastFailureLineIn(text: string): FailureAnchor | undefined {
  const from = Math.max(0, text.length - VERIFY_FULL_ANCHOR_SCAN_MAX);
  // Walk line ends backwards. A line break is one of three physical forms, so the
  // scan steps by characters and treats a `\n` preceded by `\r` as one break.
  let lineEnd = text.length;
  for (let i = text.length - 1; i >= from; i--) {
    const c = text[i];
    if (c !== "\n" && c !== "\r") continue;
    // Skip the `\n` half of a `\r\n` pair so the pair is one boundary, not two.
    if (c === "\n" && i > 0 && text[i - 1] === "\r") continue;
    const start = i + 1;
    if (start < lineEnd) {
      const line = text.slice(start, lineEnd).trim();
      if (line.length > 0 && classifyFailureLine(line) !== undefined) {
        return { line, at: start + (text.slice(start, lineEnd).length - line.length) };
      }
    }
    lineEnd = i;
  }
  // The head of the scanned region is a line with no break before it.
  if (lineEnd > from) {
    const head = text.slice(from, lineEnd).trim();
    if (head.length > 0 && classifyFailureLine(head) !== undefined) {
      return { line: head, at: from + (text.slice(from, lineEnd).length - head.length) };
    }
  }
  return undefined;
}

/**
 * Clip `text` to `max` CODE POINTS from `keep` — the code-point half of
 * {@link redactThenBound}, exposed separately for the caller that has ALREADY
 * redacted. A caller that redacts the whole stream once and then clips must not
 * redact again: re-running the arms over a window that opens mid-token is how a
 * fragment that no pattern recognises survives, and it costs a second pass over
 * text the first pass already saw.
 */
export function boundByCodePoints(
  text: string,
  max: number,
  keep: "head" | "tail" = "head",
): { text: string; clipped: boolean } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text: chars.join(""), clipped: false };
  return keep === "tail"
    ? { text: chars.slice(-max).join(""), clipped: true }
    : { text: chars.slice(0, max).join(""), clipped: true };
}

/**
 * A tier's stored excerpt: the bounded text, and whether it opens AT a
 * recognised failure line. The flag is returned rather than left for a caller to
 * re-derive, because the caller's own cut is what the flag is for: a reader that
 * takes `slice(-500)` of an excerpt that starts at the failure throws the failure
 * away and keeps the passing tail.
 */
export interface StoredTierOutput {
  output: string;
  /** True when `output` starts at the anchor line (so its HEAD is the evidence). */
  anchored: boolean;
}

/**
 * The one normaliser for tier output before the driver keeps it (#1770, #1762
 * rounds 1 and 2). Three rules, in this order:
 *
 *   - **Redact the WHOLE stream ONCE.** A clip that cuts a credential in half
 *     leaves a fragment no pattern recognises, and this is the project's own gate
 *     output, which prints whatever the suite prints (a connection string, a token
 *     echoed by an assertion). So redaction runs over the whole stream exactly one
 *     time, and every window below is cut from THAT text by
 *     {@link boundByCodePoints} — never re-redacted, because a second pass over a
 *     window that opens mid-token sees a fragment no arm anchors on and reports a
 *     clean result over material the first pass already judged.
 *   - **Anchor on the table's LAST recognised failure line, found by a BOUNDED
 *     BACKWARD scan** ({@link lastFailureLineIn}) rather than by reading the whole
 *     stream. The ci tier's `evidenceTail` is what a handoff quotes and what a
 *     developer is dispatched with, and #1762's defect was that the stored window's
 *     top line was a stage that had PASSED. When the tail of the redacted stream
 *     contains a line the shared table recognises, the stored excerpt STARTS at
 *     that line, so the failure is never cut off its top; the window then runs to
 *     the end of the stream, where the verbose re-run, the diff and the stack trace
 *     a failure announces all live.
 *   - **Bound it.** {@link VERIFY_FULL_OUTPUT_MAX} code points, whichever end
 *     survives. Code points, never chars, so a surrogate pair is never split.
 *
 * With no anchor in the scanned tail the excerpt is the positional tail — an
 * unrecognised gate still gets its last words stored, and `anchored` says so.
 */
function storeTierOutput(text: string): StoredTierOutput {
  // Redact the whole stream BEFORE any cut — see the first rule above. The bound
  // below is applied to that text alone, so no window is ever redacted from a
  // stream that was clipped first. The cap is a safety bound on a gate that printed
  // megabytes, not the window this function keeps, so it is well above the excerpt
  // size and what actually lands in the stored field is the anchored excerpt.
  const { text: redacted } = redactThenBound(text, VERIFY_FULL_MAX_BUFFER);
  const anchor = lastFailureLineIn(redacted);
  if (anchor !== undefined) {
    // Never start the window past the anchor's own first character: whatever the
    // budget, the failure line survives, and the lines around it fill the rest.
    const from = Math.min(anchor.at, Math.max(0, redacted.length - VERIFY_FULL_OUTPUT_MAX));
    // `boundByCodePoints`, not `redactThenBound`: this text has been redacted once
    // already and the cut is a pure bound. The excerpt is measured from the anchor
    // forward, so its HEAD is the failure and `anchored` is the flag a downstream
    // cut needs to keep it.
    return {
      output: boundByCodePoints(redacted.slice(from), VERIFY_FULL_OUTPUT_MAX).text,
      anchored: true,
    };
  }
  // Nothing in the scanned tail names a failure: fall back to the positional tail,
  // so an unrecognised gate still gets its last words stored rather than nothing.
  return {
    output: boundByCodePoints(redacted, VERIFY_FULL_OUTPUT_MAX, "tail").text,
    anchored: false,
  };
}

/**
 * #1770 — narrow a caught value before it is read as an exec error. `catch`
 * hands back `unknown`; the gate's rejection is a Node exec error carrying
 * `stdout`/`stderr`, but anything else the executor throws (a string, a
 * validation object) has no such fields, and reading them off it would report
 * an empty evidence tail for a run whose only information was the thrown value.
 */
function asExecError(err: unknown): Error & { stdout?: string; stderr?: string } {
  return err instanceof Error ? err : new Error(String(err));
}

async function execVerifyOnce(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr?: string }>,
): Promise<VerifyRun> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await withVerifySlot(() =>
      execFn(cmd, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: VERIFY_FULL_MAX_BUFFER,
        // #1642 — the tier hands the scrubbed env itself, so an executor that
        // ignores `env` and inherits the parent (the ci step's shape before
        // this) cannot leak the driver's knobs into the project's suite.
        env: verifyChildEnv(),
      }),
    );
    const ms = Date.now() - startedAt;
    const output = (stdout || stderr || "").trim();
    const stored = storeTierOutput(output);
    return { ms, ok: true, output: stored.output, anchored: stored.anchored };
  } catch (err) {
    const ms = Date.now() - startedAt;
    // #1770 — the same concatenation every other verify tier uses. Reading
    // `err.message` first meant a gate that fails with its report on stdout
    // recorded an evidenceTail of nothing but `Command failed: <cmd>`, which
    // is what two measured cycles showed: a 21-minute full gate whose
    // failure said nothing, and a developer dispatched to fix it blind.
    const output = combinedExecFailureStream(asExecError(err));
    const stored = storeTierOutput(output);
    return { ms, ok: false, output: stored.output, anchored: stored.anchored };
  }
}

/**
 * The handoff's evidence budget for one tier — the width the `verify-full-status`
 * event's `evidenceTail` carries. Owned here, beside {@link storeTierOutput}, so
 * the two bounds of one field (the stored excerpt and the rendered evidence) are
 * read in one place rather than one living in the ci step as a bare `-500`.
 */
export const VERIFY_FULL_EVIDENCE_MAX = 500;

/**
 * Cut a stored tier excerpt down to the handoff's evidence budget, KEEPING THE END
 * THAT HOLDS THE FAILURE (#1762 round 2, C2).
 *
 * The producer already chose which end of the stream to store and says so with
 * `anchored`. An excerpt that opens AT the recognised failure line must keep its
 * HEAD: a blind `slice(-500)` of a 4 KB excerpt that starts at the failure keeps
 * the 500 characters of PASSING output that follow it and throws the failure away
 * — #1762's symptom re-created by the reader after the producer fixed it. An
 * excerpt with no anchor is a positional tail, and its last words are its tail.
 *
 * Code points, for the same reason every other bound in this file uses them: a
 * surrogate pair is never left as a lone half.
 */
export function keepEvidenceHead(output: string, anchored: boolean): string {
  return boundByCodePoints(output, VERIFY_FULL_EVIDENCE_MAX, anchored ? "head" : "tail").text;
}

/**
 * Execute the verify-full command driver-side in the ci step.
 *
 * Returns status and timing for the `verify-full-status` event. Caller
 * must ensure cwd is the group's worktree (per #279 addendum), NOT repoRoot.
 *
 * #782 — when `retry` is true, on a failure the SAME command is re-run ONCE
 * in the SAME worktree before giving up. The first failure's output is
 * preserved as `firstRunOutput` so the caller can surface it on the
 * `verify-full-status` event alongside the re-run's outcome. The re-run is
 * bounded (exactly one) — a command that fails twice is a genuine failure and
 * must park. Callers that do not pass `retry` keep the pre-#782 single-run
 * shape (the offline test fixtures, and any pre-#782 caller).
 */
export async function runVerifyFull(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  execFn: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr?: string }>,
  opts?: { retry?: boolean },
): Promise<{
  outcome: "success" | "failure";
  ms: number;
  output: string;
  recovered?: boolean;
  firstRunOutput?: string;
  /**
   * #1762 round 2 — true when `output` opens AT a recognised failure line. The
   * ci step's evidence cut needs this: an excerpt that starts at the failure must
   * keep its HEAD, and one that is a positional tail must keep its TAIL, so a
   * caller that cuts blindly throws the failure away half the time.
   */
  anchored?: boolean;
}> {
  const first = await execVerifyOnce(cmd, cwd, timeoutMs, execFn);
  if (first.ok)
    return { outcome: "success", ms: first.ms, output: first.output, anchored: first.anchored };

  if (!opts?.retry) {
    return {
      outcome: "failure",
      ms: first.ms,
      output: first.output,
      anchored: first.anchored,
    };
  }

  // #782 — single bounded re-run, same command, same worktree. No loop:
  // a command that fails twice is a genuine failure and must park.
  const second = await execVerifyOnce(cmd, cwd, timeoutMs, execFn);
  if (second.ok) {
    return {
      outcome: "success",
      ms: first.ms + second.ms,
      output: second.output,
      recovered: true,
      firstRunOutput: first.output,
      anchored: second.anchored,
    };
  }
  // Second run also failed — report the second run's output as the primary
  // evidence (it's what the caller's handoff tail should show), and preserve
  // the first run's output so the caller can surface both on the event. The
  // anchor flag follows whichever excerpt is reported as `output`.
  return {
    outcome: "failure",
    ms: first.ms + second.ms,
    output: second.output,
    firstRunOutput: first.output,
    anchored: second.anchored,
  };
}
