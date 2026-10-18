/**
 * work-driver-cap-checkpoint-typecheck — the checkpoint's typecheck, split
 * out of work-driver-cap-checkpoint.ts (AGENTS.md §12 file-size limit).
 *
 * The checkpoint (#543 F5) stage+commits a cap-killed worktree's partial
 * state, and it typechecks first so the recovery commit cannot silently claim
 * a tree that does not compile. This module owns that one step: running the
 * command, and deciding what its outcome MEANS. It is the seam the #1414 fix
 * lives on, and the reason it is a separate file rather than a block inside
 * the checkpoint is that the classifier is pure — it is testable in both
 * directions without a repository, a compiler, or a dispatch.
 *
 * Two properties the rest of the checkpoint depends on:
 *
 *   1. The run is BOUNDED and SLOTTED. It is a verify run, not a git call: it
 *      compiles the whole tree and can hold the machine for minutes. It gets
 *      the same wall clock (`verifyTimeoutMs()`) and the same concurrency slot
 *      (`withVerifySlot`) every other gate seam gives its leaf exec — which it
 *      had neither of before #1414 round 2. Unbounded, a `tsc` that hung (an
 *      unreadable lockfile, a `bun x` resolving over a dead network) held the
 *      whole handoff open indefinitely; unslotted, N cap-killed workstreams
 *      each pinned a full compiler while the host's verify ceiling said
 *      otherwise. `withVerifySlot` documents exactly this shape: wrap only the
 *      leaf exec, and nothing else is held across the await.
 *
 *   2. "Could not run" is NOT "broken". See {@link TypecheckOutcome}: the
 *      pre-fix shape reported both as `false`, and the handoff told operators
 *      their committed code was broken on the strength of a command that never
 *      judged it.
 *
 * The checkpoint's git calls deliberately do NOT come through here — they stay
 * on the module-level executor in work-driver-cap-checkpoint.ts, so an
 * injected fake cannot make `tree: "committed"` vacuous.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { withVerifySlot } from "./host-resources.ts";
import { trace } from "./trace.ts";
import { CHECKPOINT_TYPECHECK_CMD } from "./work-driver-cap-checkpoint.ts";
import type { DriverExecFn } from "./work-driver-context.ts";
import { boundText, verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";

/** Cap on the compiler's captured output for the record's evidence tail. */
const TYPECHECK_MAX_BUFFER = 256 * 1024;

/**
 * #1414 round 2 — what the checkpoint's typecheck observed, in the three
 * states the handoff must tell apart.
 *
 * Pre-fix the branch had two outcomes, `true` and `false`, and `false` was the
 * catch-all: no `extension/` to check, a binary that could not be spawned, and
 * a run killed at its bound all landed on `false` — the same value a real
 * diagnostic produces. The handoff then said "the code is broken as-is", in
 * the same words, about a command that never judged the code. That is the
 * #1414 bug class one layer down: round 1 fixed the command, the lie survived
 * because "could not run" and "the code is broken" shared one boolean.
 */
export type TypecheckOutcome =
  /** tsc exited 0 — the tree typechecks. */
  | { verdict: true }
  /** tsc RAN and reported diagnostics — the only state that indicts the code. */
  | { verdict: false; detail: string }
  /** The check never judged anything. `why` is the operator-facing reason. */
  | { verdict: undefined; why: string };

/**
 * A tsc diagnostic — `error TS2345:`, the shape tsc emits for every real type
 * error. A non-zero exit carrying none of these never reached the type system
 * (a bad invocation, a missing binary, a shell that could not fork), which is a
 * no-verdict, not a broken tree.
 */
const TSC_DIAGNOSTIC_RE = /\berror TS\d{4}\b/i;

/** A refusal to START the command, in any of the forms it arrives in:
 * `ENOENT` is Node's own spawn error; `command not found` / `not found` are
 * what the SHELL reports (a `bun x` that cannot resolve tsc comes back through
 * a shell, not through Node's spawn path); `Cannot find module` is what `bun
 * x`/npm print when the package is absent; `Cannot fork` / `EACCES` are the
 * host refusing to run anything (the #1277 class). */
const COULD_NOT_RUN_RE =
  /\bENOENT\b|no such file or directory|command not found|not found$|cannot find module|MODULE_NOT_FOUND|\bCannot fork\b|\bEACCES\b/i;

/** The last few non-empty lines of a failure, bounded — the record is an
 * operator-facing note, not a log. */
function evidenceTail(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-6)
    .join(" | ")
    .slice(0, 240);
}

/**
 * Classify a rejection from the typecheck executor into a {@link
 * TypecheckOutcome}. Pure, so both directions are testable without a real
 * compiler: a planted `error TS2345` must read as `false`, a planted ENOENT
 * must not.
 *
 * The output is read from every field the executor reports, not one: `execp`
 * rejects with `promisify(exec)`'s shape, which carries the captured
 * `stdout`/`stderr` beside `code`, and a tsc run writes diagnostics to either
 * stream depending on how it was invoked. Same reasoning as
 * `combinedExecFailureStream` in the verify gates.
 */
export function classifyTypecheckRejection(err: unknown): TypecheckOutcome {
  // The checkpoint is contractually non-throwing and a rejection may be a
  // non-Error, so every field is read through a guard, never blind.
  const e = (err ?? {}) as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const message = typeof e.message === "string" ? e.message : String(err);
  const output = [e.stdout, e.stderr, message]
    .map((x) => (typeof x === "string" ? x : ""))
    .join("\n");
  // A run killed at its bound reached no verdict: the bound is the finding, not
  // the code. Node stamps `killed` on a timeout kill; the group-kill path in
  // exec.ts stamps it too and says "timed out after" in the message. Checked
  // BEFORE the diagnostic test on purpose — a compiler killed mid-run can have
  // printed TS errors for the files it got through, and those describe a
  // partial run, not a verdict on the tree.
  if ((err as { killed?: unknown })?.killed === true || /timed out after/i.test(message)) {
    return {
      verdict: undefined,
      why: `killed at its ${boundText(verifyTimeoutMs())} bound before finishing, so it judged nothing`,
    };
  }
  if (TSC_DIAGNOSTIC_RE.test(output)) {
    return { verdict: false, detail: evidenceTail(output) };
  }
  if (COULD_NOT_RUN_RE.test(output)) {
    const first = message.split("\n").find((l) => l.trim().length > 0) ?? "no output";
    return { verdict: undefined, why: `could not run (${first.slice(0, 160)})` };
  }
  // Non-zero exit with output that is not a recognised refusal to start. The
  // compiler ran and refused to pass; calling that "never ran" would hide a
  // real defect, so it stays a `false` carrying whatever evidence there was.
  return { verdict: false, detail: evidenceTail(output) };
}

/**
 * #544 (8d) — typecheck the worktree's TypeScript BEFORE the checkpoint
 * commit (recovery, not the full gate — the full suite runs on the integrated
 * branch). Runs `CHECKPOINT_TYPECHECK_CMD` in the worktree's `extension/`
 * directory and reports the three-state {@link TypecheckOutcome}. Never
 * throws: the checkpoint's contract is that a typecheck problem degrades the
 * record, never the cycle.
 *
 * #1414 — the executor is a PARAMETER, not a module binding: the driver
 * passes `ctx.checkpointExecFn ?? execp` so a smoke test can prove the branch
 * runs and name the command it runs (including the bound and slot, which the
 * spy receives as opts).
 */
export async function typecheckWorktree(cwd: string, run: DriverExecFn): Promise<TypecheckOutcome> {
  const ext = path.join(cwd, "extension");
  try {
    await fs.access(ext);
  } catch {
    return {
      verdict: undefined,
      why: "the worktree has no extension/ directory, so there was nothing to typecheck",
    };
  }
  try {
    await withVerifySlot(() =>
      run(CHECKPOINT_TYPECHECK_CMD, {
        cwd: ext,
        timeout: verifyTimeoutMs(),
        maxBuffer: TYPECHECK_MAX_BUFFER,
      }),
    );
    return { verdict: true };
  } catch (err) {
    const outcome = classifyTypecheckRejection(err);
    // `classifyTypecheckRejection` never returns `verdict: true`, but the
    // union does not know that — so each arm tests its own discriminant rather
    // than leaning on an exhaustive `else`, which keeps a future fourth state
    // a compile error instead of a silent `.why`-on-`true` crash.
    trace(
      `work-driver: checkpoint typecheck ${
        outcome.verdict === false ? "failed" : "reached no verdict"
      } in ${cwd}: ${
        outcome.verdict === false
          ? outcome.detail
          : outcome.verdict === undefined
            ? outcome.why
            : ""
      }`.slice(0, 200),
    );
    return outcome;
  }
}
