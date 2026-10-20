/**
 * work-driver-cap-checkpoint-typecheck — the checkpoint's typecheck, split
 * out of work-driver-cap-checkpoint.ts (AGENTS.md §12 file-size limit).
 *
 * #1414 round 3 — the DEPENDENCY DIRECTION. This module used to value-import
 * `CHECKPOINT_TYPECHECK_CMD` from `work-driver-cap-checkpoint.ts` while that
 * file imported `typecheckWorktree` from here — a real runtime cycle, kept
 * alive only by ESM's live bindings (the constant is a hoisted `const` read at
 * call time, so the TDZ is never observed today). It is still a cycle, and one
 * refactor of either side into a top-level read turns it into a
 * ReferenceError. The constant is defined HERE, in the leaf, and the
 * checkpoint module imports it back: the edges point one way.
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
import type { DriverExecFn } from "./work-driver-context.ts";
import { isHostForkExhaustion } from "./work-driver-exec-error.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import {
  boundText,
  isTimedOutKill,
  verifyTimeoutMs,
} from "./work-driver-verify-develop-helpers.ts";

/** Cap on the compiler's captured output for the record's evidence tail. */
const TYPECHECK_MAX_BUFFER = 256 * 1024;

/**
 * #1414/#1118 — the ONE spelling of a typecheck command, and it names the
 * compiler rather than an alias that resolves it.
 *
 * `bun x tsc` does NOT mean "the project's tsc". Bun's x (like `npx`) walks a
 * resolution chain that can answer with something other than the pinned
 * dependency, and on the host this ticket was filed from it answered with a
 * GLOBAL TypeScript 7: the invocation printed its usage and exited 0, so the
 * driver's typecheck gate was a NO-OP that reported every tree as typechecking.
 * The same alias is why the checkpoint used to accuse good code of being broken
 * (#1414 round 1: no hyphenless launcher alias on PATH at all, plus the
 * `--no-emit` flag that is
 * not a tsc flag).
 *
 * So the command spells the compiler as a PATH under the package's own
 * dependency directory. Nothing in it is looked up: no launcher, no hyphenless
 * alias, no `tsc` on PATH, no npx-style cache. `node` is the one name that must
 * resolve, and the sandbox image installs node as a prerequisite. The file it
 * runs is
 * the real CLI shipped by the `typescript` devDependency, so the version that
 * answers is the version `extension/package.json` pins — which is the whole
 * point: a gate cannot pass a tree by running a compiler the project does not
 * have.
 *
 * Written as a bare relative path because every call site runs it with cwd =
 * the `extension/` directory (the checkpoint's `typecheckWorktree`, the develop
 * gate's fast tier, and `.pi/verify-cmd*` all `cd extension` first), and that
 * keeps one spelling for all three.
 */
const LOCAL_TSC = "node node_modules/typescript/bin/tsc";

/** The project's main typecheck project, named explicitly rather than defaulted. */
const TSC_PROJECT = "tsconfig.json";

/**
 * #1414 — the ONE spelling of the checkpoint's typecheck command. The
 * executed call below, the checkpoint's status-file lines and the handoff
 * bullet (work-driver-caped-state.ts) all carry this exact text, so what the
 * driver RUNS and what it TELLS the operator it ran cannot drift. The
 * no-bare-alias gate under `smoke-tests/` pins the exported value, the
 * executed literal and each prose site to one another.
 *
 * #1414 round 4 (#1414/#1118) — the command no longer dispatches through an
 * alias at all: it names the pinned compiler by path. See {@link LOCAL_TSC}
 * for why `bun x tsc` was the bug rather than the fix (on the reporting host
 * it resolved a global TypeScript 7, printed usage, and exited 0 — a typecheck
 * gate that judged nothing). `--noEmit` is the real tsc flag; the hyphenated
 * form the old literal carried is not one.
 *
 * #1414 round 3 — the constant lives in the LEAF and
 * `work-driver-cap-checkpoint.ts` re-exports it (so the gate's "read the
 * checkpoint file for the literal" check keeps a stable site), never the other
 * way round: a leaf cannot value-import from the module that imports it, which
 * is the cycle this file used to be in. See the module header.
 */
export const CHECKPOINT_TYPECHECK_CMD = `${LOCAL_TSC} --noEmit -p ${TSC_PROJECT}`;

/**
 * #1414/#1118 — the same compiler, spelled for the project's `.pi/verify-cmd*`
 * files and any prose site that prescribes a typecheck. One exported string so
 * the tier files, this constant and the docs cannot each keep their own idea
 * of what "run the typecheck" means; the launcher gate in smoke-tests asserts
 * the tier files use exactly this prefix.
 */
export const LOCAL_TSC_CMD = LOCAL_TSC;

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

/**
 * #1414 round 3 — the longest `typecheckReason` the record will carry. The
 * reason is composed from the failing command's own message, so it is
 * child-supplied text that lands verbatim in the handoff markdown and in the
 * status file; it is bounded like any other operator-facing string.
 */
const TYPECHECK_REASON_MAX_CHARS = 200;

/**
 * The control characters {@link sanitiseReason} collapses: C0 minus the
 * whitespace `\s` handles, DEL, and C1. Built from code points — the lint rule
 * that disallows control characters inside a regex literal also rejects the
 * readable form, so a string-constructed pattern is how the class gets named
 * without invisible bytes in the file.
 */
const CONTROL_RANGES: readonly [number, number][] = [
  [0, 8],
  [11, 12],
  [14, 31],
  [127, 159],
];

const CONTROL_CLASS = CONTROL_RANGES.map(
  ([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`,
).join("");

/**
 * The control characters {@link sanitiseReason} collapses: C0 minus the
 * whitespace `\s` handles, DEL, and C1. Assembled from numeric code-point
 * ranges via `String.fromCharCode` rather than written as a class literal —
 * the lint rule that disallows control characters in a regex also rejects the
 * readable `\u` form in either notation, and numeric ranges name the same set
 * while keeping invisible bytes out of the file.
 */
const TYPECHECK_REASON_CONTROL_RE = new RegExp(`[${CONTROL_CLASS}]`, "g");

/**
 * #1414 round 3 — make a captured reason safe to embed in the handoff
 * markdown: every control character (newlines, tabs, carriage returns, ANSI
 * escapes) collapses to a space, whitespace runs collapse, and the length is
 * bounded. A `tsc` message is a single line today, but the reason is composed
 * from child output, and an embedded newline plus indentation breaks the list
 * item the bullet lives in — which is the same "the record says one thing, the
 * rendered text says another" class #1414 is about.
 */
export function sanitiseReason(raw: string): string {
  // The C0 controls (except the whitespace `\s` already collapses), DEL, and
  // the C1 range — an ANSI escape reaches us as C1 + `[`. Built from code
  // points rather than a literal control-character class: the lint rule that
  // disallows control characters in a pattern also rejects the readable form,
  // and a class assembled from named bounds says "the controls" without
  // embedding invisible bytes in the source. `RegExp` is hoisted to a module
  // constant so the string form is parsed once, not per call.
  return raw
    .replace(TYPECHECK_REASON_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TYPECHECK_REASON_MAX_CHARS);
}

/** The last few non-empty lines of a failure, bounded — the record is an
 * operator-facing note, not a log.
 *
 * #1414 round 3 — routed through {@link sanitiseReason} like `why` is. Both
 * strings land in the same two operator-facing surfaces (the handoff bullet and
 * the status file), and before this only one of them was cleaned: a `detail`
 * kept its embedded newlines and ANSI escapes, so the same child output broke
 * the markdown list item in one field and not the other. `sanitiseReason`
 * bounds to 200 chars (tighter than the 240 the join could produce); the line
 * selection is the part `detail` keeps and the reason does not have.
 */
function evidenceTail(text: string): string {
  return sanitiseReason(
    text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-6)
      .join(" | "),
  );
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
 *
 * `timeoutMs` (#1414 round 3) is the bound the RUN was given, captured by the
 * caller and passed in rather than re-read here: `verifyTimeoutMs()` reads the
 * environment, so a classifier that called it itself could name a bound other
 * than the one the command was actually bounded by — the same two-sources-of-
 * truth shape #1414 is about, one layer down. It is a REQUIRED parameter, not
 * one defaulted from the same environment helper it exists to bypass: a default
 * is a second source that fires silently whenever a caller forgets it, which is
 * the defect the parameter closes. The one pure-classifier caller that has no
 * run behind it passes `verifyTimeoutMs()` explicitly.
 */
export function classifyTypecheckRejection(err: unknown, timeoutMs: number): TypecheckOutcome {
  // The checkpoint is contractually non-throwing and a rejection may be a
  // non-Error, so every field is read through a guard, never blind.
  const e = (err ?? {}) as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    killed?: unknown;
    timedOutKill?: unknown;
    overflow?: unknown;
  };
  const message = typeof e.message === "string" ? e.message : String(err);
  const output = [e.stdout, e.stderr, message]
    .map((x) => (typeof x === "string" ? x : ""))
    .join("\n");
  // A run killed at its BOUND reached no verdict: the bound is the finding, not
  // the code. #1414 round 3 — read through the shared `isTimedOutKill`, NOT
  // `killed`: every executor in this repo stamps `killed` on BOTH kill paths
  // (`exec-tree.ts` documents it as "True on EITHER kill path"), so a run whose
  // output exceeded `maxBuffer` was killed for being chatty and used to be
  // reported to the operator as "killed at its bound" — an accusation of a stall
  // that never happened (#1427's lesson, applied here). An overflow kill is a
  // real non-zero exit whose output the driver chose not to keep, so it falls
  // through to the verdict arms below. Checked BEFORE the diagnostic test on
  // purpose — a compiler killed mid-run can have printed TS errors for the
  // files it got through, and those describe a partial run, not a verdict.
  //
  // The flags are the ENTIRE contract — the message fallback this arm used to
  // carry (`/timed out after/i.test(message)") is gone. A message is the
  // compiler's own prose, and a `tsc` run that printed that phrase was reported
  // to the operator as a stalled run whose bound fired when nothing of the kind
  // happened. The executors that kill at a bound stamp the flags (`exec.ts`
  // `groupKillError`, `exec-tree.ts`), so the fallback never carried a real
  // timeout the flags do not already cover; it only ever widened the arm.
  if (
    isTimedOutKill({
      killed: e.killed === true,
      ...(typeof e.timedOutKill === "boolean" ? { timedOutKill: e.timedOutKill } : {}),
      ...(typeof e.overflow === "string" ? { overflow: e.overflow } : {}),
    })
  ) {
    return {
      verdict: undefined,
      why: sanitiseReason(
        `killed at its ${boundText(timeoutMs)} bound before finishing, so it judged nothing`,
      ),
    };
  }
  // The host refused to start a process (fork failed / EAGAIN / Cannot
  // allocate memory) — the machine had no slot, which says NOTHING about the
  // tree. Pre-fix this fell to the bottom arm and read as "the code is
  // broken", the #1277 class in a new seam. Read BEFORE the diagnostic test:
  // a compiler that forked some workers before the host said no has TSxxxx in
  // its buffer, and those describe the workers that started. Shares the one
  // regex the verify gates use (`isHostForkExhaustion`), so the two cannot
  // disagree about what a fork failure looks like.
  if (isHostForkExhaustion(output)) {
    return {
      verdict: undefined,
      why: sanitiseReason(
        "the host could not start the typecheck (fork failed / out of process slots), so it judged nothing",
      ),
    };
  }
  if (TSC_DIAGNOSTIC_RE.test(output)) {
    return { verdict: false, detail: evidenceTail(output) };
  }
  if (COULD_NOT_RUN_RE.test(output)) {
    const first = message.split("\n").find((l) => l.trim().length > 0) ?? "no output";
    return { verdict: undefined, why: sanitiseReason(`could not run (${first})`) };
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
 *
 * #1414 round 3 — `killGroup: true`, so a timeout takes the WHOLE group down.
 * A typecheck is not one process: the launcher spawns a compiler grandchild
 * that inherits the pipes, and Node's plain exec timeout signals only the
 * direct child — the grandchild keeps compiling and keeps the pipe open, so
 * the handoff waits on a process whose bound already fired. The driver's
 * network git calls pass the same flag for exactly this reason (#1095).
 */
export async function typecheckWorktree(cwd: string, run: DriverExecFn): Promise<TypecheckOutcome> {
  const ext = path.join(cwd, "extension");
  try {
    await fs.access(ext);
  } catch {
    return {
      verdict: undefined,
      why: sanitiseReason(
        "the worktree has no extension/ directory, so there was nothing to typecheck",
      ),
    };
  }
  // The bound is captured ONCE and threaded into the classifier, so the reason
  // can only ever name the bound this run was given. The classifier takes it as
  // a REQUIRED parameter (round 3) — an unrun check has no bound of its own, so
  // this call names the run's configured bound explicitly rather than letting a
  // default read the environment behind the caller's back.
  const timeoutMs = verifyTimeoutMs();
  try {
    await withVerifySlot(() =>
      run(CHECKPOINT_TYPECHECK_CMD, {
        cwd: ext,
        timeout: timeoutMs,
        maxBuffer: TYPECHECK_MAX_BUFFER,
        killGroup: true,
        // The project's typecheck never runs with the driver's knobs (#1642).
        env: verifyChildEnv(),
      }),
    );
    return { verdict: true };
  } catch (err) {
    const outcome = classifyTypecheckRejection(err, timeoutMs);
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
