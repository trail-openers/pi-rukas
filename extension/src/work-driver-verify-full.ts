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
import { failureLines } from "./work-driver-verify-failures.ts";
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
 * The one normaliser for tier output before the driver keeps it (#1770, #1762
 * round 1). Three rules, in this order:
 *
 *   - **Redact the WHOLE stream first.** A clip that cuts a credential in half
 *     leaves a fragment no pattern recognises, and this is the project's own gate
 *     output, which prints whatever the suite prints (a connection string, a token
 *     echoed by an assertion). Every other store-side reader of verify output
 *     redacts before it bounds for exactly this reason, and this field is stored
 *     and rendered, so it goes through {@link redactThenBound} — the one
 *     redact-then-clip the whole driver shares — rather than a hand-rolled slice.
 *   - **Anchor on the table's LAST recognised failure line.** The ci tier's
 *     `evidenceTail` is what a handoff quotes and what a developer is dispatched
 *     with, and #1762's defect was precisely that the stored window's top line was
 *     a stage that had PASSED. So when the redacted stream contains any line the
 *     shared failure-line table recognises, the stored excerpt starts no later than
 *     the last such line — the failure is never cut off its top — and otherwise runs
 *     to the end of the stream, where the verbose re-run, the diff and the stack
 *     trace a failure announces all live. The positional tail is only the fallback
 *     when nothing in the stream names a failure.
 *   - **Bound it.** {@link VERIFY_FULL_OUTPUT_MAX} code points, whichever end
 *     survives. Code points, never chars, so a surrogate pair is never split.
 */
function storeTierOutput(text: string): string {
  // Redact the whole stream BEFORE any cut — see the first rule above. The bound
  // below is applied to that text alone, so no window is ever redacted from a
  // stream that was clipped first. The cap is a safety bound on a gate that printed
  // megabytes, not the window this function keeps, so it is well above the excerpt
  // size and what actually lands in the stored field is the anchored excerpt.
  const { text: redacted } = redactThenBound(text, VERIFY_FULL_MAX_BUFFER);
  const named = failureLines(redacted);
  // The LAST recognised failure line is the anchor, but the stream's own tail is
  // stored too: the loop's verbose re-run, the diff and the stack trace a failure
  // line announces all print AFTER it, and dropping them is the same "the evidence
  // says nothing" symptom this field exists to close. So the window ends at the end
  // of the stream and the anchor line is what guarantees it is IN the window — the
  // excerpt is never cut so short that the failure itself falls off its top.
  const last = named[named.length - 1];
  const at = last === undefined ? -1 : redacted.lastIndexOf(last);
  if (last !== undefined && at !== -1) {
    // Never start the window past the anchor's own first character: whatever the
    // budget, the failure line survives, and the lines around it fill the rest.
    const from = Math.min(at, Math.max(0, redacted.length - VERIFY_FULL_OUTPUT_MAX));
    return redactThenBound(redacted.slice(from), VERIFY_FULL_OUTPUT_MAX).text;
  }
  // Nothing in the stream names a failure: fall back to the positional tail, so an
  // unrecognised gate still gets its last words stored rather than nothing.
  return redactThenBound(redacted, VERIFY_FULL_OUTPUT_MAX, "tail").text;
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
    return { ms, ok: true, output: storeTierOutput(output) };
  } catch (err) {
    const ms = Date.now() - startedAt;
    // #1770 — the same concatenation every other verify tier uses. Reading
    // `err.message` first meant a gate that fails with its report on stdout
    // recorded an evidenceTail of nothing but `Command failed: <cmd>`, which
    // is what two measured cycles showed: a 21-minute full gate whose
    // failure said nothing, and a developer dispatched to fix it blind.
    const output = combinedExecFailureStream(asExecError(err));
    return { ms, ok: false, output: storeTierOutput(output) };
  }
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
}> {
  const first = await execVerifyOnce(cmd, cwd, timeoutMs, execFn);
  if (first.ok) return { outcome: "success", ms: first.ms, output: first.output };

  if (!opts?.retry) {
    return { outcome: "failure", ms: first.ms, output: first.output };
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
    };
  }
  // Second run also failed — report the second run's output as the primary
  // evidence (it's what the caller's handoff tail should show), and preserve
  // the first run's output so the caller can surface both on the event.
  return {
    outcome: "failure",
    ms: first.ms + second.ms,
    output: second.output,
    firstRunOutput: first.output,
  };
}
