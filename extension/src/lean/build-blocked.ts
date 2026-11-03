/**
 * lean/build-blocked — the anti-forgery gate for the build child's "these
 * frozen tests cannot all pass together" report.
 *
 * The child's report is narration, not executed evidence (AGENTS.md §7 rule 1).
 * A builder that could end a run by naming a conflict would end runs whose
 * contract it never read — or whose contract is perfectly satisfiable, which is
 * the exact shape of a child that gave up on the hard case. So the driver
 * honours the report only when BOTH of these hold, and the second one is a
 * command the driver itself ran:
 *
 *   1. **every named path is in the run's frozen map** — read off the same
 *      `frozenFromLog` every other reader of the contract uses, so a file the
 *      child merely imagined is not evidence;
 *   2. **at least one named frozen test comes back red on the child's tree**,
 *      run with the project's own `verify.test` template through the same
 *      runner `verify` and `specify` use (`runTestFile`, argv form, no shell).
 *
 * A runner that could not be started or was killed is NOT a red — it observed
 * nothing — and the report is ignored rather than honoured on a toolchain fault.
 * A green named test is not a conflict either. When the report is ignored the
 * caller traces the reason and continues its ordinary `ok`/`exhausted` path:
 * there is no third verdict, and nothing is recorded.
 *
 * The entry and reason bounds here are the DURABLE record's bounds, so an entry
 * that could not be persisted is refused before anything is spent running it.
 */

import { trace, traceWarn } from "../trace.ts";
import type { BuildExec } from "./build-types.ts";
import { type Proof, TEST_TIMEOUT_MS, renderTestCommand, runTestFile } from "./specify-proof.ts";
import { RECORD_MAX_ENTRIES, RECORD_REASON_MAX_CHARS } from "./state-outcome-maps.ts";
import { frozenKeyProblem } from "./state-outcome.ts";

/**
 * How many conflicts one report may name, and how long one stated conflict may
 * be. BOTH are the durable record's own bounds, imported from the module that
 * enforces them at load (`state-outcome-maps.ts`) rather than restated here: a
 * copy would let the gate spend a runner on an entry the loader then refuses,
 * and a widening on one side only is exactly what a shared constant refuses to
 * allow.
 */
export const BLOCKED_MAX_ENTRIES = RECORD_MAX_ENTRIES;

/**
 * How long one stated conflict may be. See {@link BLOCKED_MAX_ENTRIES} — the
 * same argument, and the same single source.
 */
export const BLOCKED_MAX_REASON_CHARS = RECORD_REASON_MAX_CHARS;

/**
 * The child's reported conflicts, filtered to entries the record could hold.
 *
 * Order is the child's: `blockedProved` runs them in this order and stops at the
 * first red, so a re-sorted list would have the driver prove a different file
 * than the builder was worried about. A path that is not a legal frozen key is
 * dropped here rather than later, so a junk entry never reaches a `git`/runner
 * call.
 */
export function usableConflicts(rows: Array<{ path: string; reason: string }>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.size >= BLOCKED_MAX_ENTRIES) break;
    if (typeof row.reason !== "string" || row.reason.length > BLOCKED_MAX_REASON_CHARS) continue;
    if (frozenKeyProblem(row.path) !== undefined) continue;
    seen.add(row.path);
  }
  return [...seen];
}

/** What the gate decided, and the sentence the caller traces when it refused. */
export type BlockedVerdict =
  /**
   * `red` is the file the driver itself ran and saw fail; `ran` is every file it
   * executed, in order, up to and including that one. Nothing outside `ran` may
   * be recorded as the run's cause.
   */
  | { honoured: true; red: string; ran: string[] }
  /** `why` is the reason the report was ignored, for the trace line. */
  | { honoured: false; why: string };

/**
 * Did the driver itself prove the named tests disagree?
 *
 * `wt` is the child's tree — the one it was left in, before any reset — so the
 * red is a fact about the work the child did, not about the base commit.
 *
 * The verdict carries `red` (the file the driver itself watched fail) and `ran`
 * (every file it actually executed, in order, up to and including the red). A
 * record whose cause sentence names some other file prints a claim the driver
 * does not hold, and a map carrying a file the driver never ran carries the
 * child's word as though it were evidence — so only what `ran` lists may be
 * recorded.
 *
 * One wall clock bounds the WHOLE loop, not each runner: a report naming the
 * 32 files the tool may ask for would otherwise cost 32 separate ceilings, and
 * the step's own budget is not a substitute because the re-run happens after the
 * child is paid. The bound is enforced TWICE — no file may START once the budget
 * is spent, and a runner already in flight is abandoned at the same instant —
 * because a runner that ignores its own kill (a group kill it swallows, a child
 * holding the pipe as a zombie) would otherwise hold the step past the ceiling
 * it was given. A file whose runner could not be started or was killed is
 * skipped rather than fatal — one broken test must not hide a real conflict
 * among the rest — and if nothing came back red the report is not honoured.
 */
export async function blockedProved(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  paths: string[];
  /** Bounds the whole re-run loop; a test shortens it to observe a hang. */
  timeoutMs?: number;
  /**
   * A test seam that widens the re-run set: called with the vetted paths and the
   * loop's real per-file bound, returns the list to execute. Production passes
   * nothing, so the loop runs the vetted list. It exists so a case can put a path
   * in `ran` that the child never named — the exact shape a future caller that
   * unioned another source into the list would create — and check that the
   * RECORD still refuses it. The loop below reads this list, so what it executes
   * and what lands in `ran` stay one thing.
   */
  rerunPaths?: (vetted: string[], perFileMs: number) => string[];
}): Promise<BlockedVerdict> {
  const { exec, wt, template, frozen, paths } = opts;
  // One readable list is all the loop can spend time on, so the ceiling that
  // keeps the loop bounded is applied HERE — `usableConflicts` caps the list it
  // builds at the same number, so a caller cannot hand this gate a wider one and
  // a refusal for a wider list would be a branch no caller can reach.
  if (paths.length === 0) return { honoured: false, why: "the report named no usable path" };
  if (template === undefined || template.trim() === "") {
    // The step cannot prove ANY report without a runner, so the report is ignored
    // and the build runs on — the same way every other refusal here reads. But
    // the silence must be named: `verify` calls this same missing template an
    // error, so a project that configured no runner sees a builder probe to the
    // ceiling (#1984's shape) with no line saying why the valve never opened.
    traceWarn(
      "lean build: no verify.test runner is configured, so a blocked report cannot be re-run — set verify.test to enable it",
    );
    return { honoured: false, why: "no verify.test runner is configured to re-check it with" };
  }
  const unvetted = paths.filter((p) => frozen[p] === undefined);
  if (unvetted.length > 0)
    return {
      honoured: false,
      why: `named ${unvetted.length} file(s) the run never froze: ${unvetted.slice(0, 4).join(", ")}`,
    };
  // ONE deadline for the whole loop, enforced at both ends of a runner: no file
  // may START once the budget is spent, and one already in flight is abandoned at
  // the same instant (see the race below). Each runner still carries
  // `runTestFile`'s own ceiling so an ordinary hung test is killed and classified
  // as infra rather than abandoned; the loop's bound is what keeps 32 of them
  // inside one budget, and it is why the bound lives here rather than per call.
  const perFile = opts.timeoutMs ?? TEST_TIMEOUT_MS;
  const deadline = Date.now() + perFile;
  const queue = opts.rerunPaths === undefined ? paths : opts.rerunPaths(paths, perFile);
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const file of queue) {
    const left = deadline - Date.now();
    if (left <= 0) {
      return {
        honoured: false,
        why: `the re-run budget of ${String(perFile)}ms ran out after ${String(ran.length)} file(s)`,
      };
    }
    // The in-flight runner is bounded too, not just the decision to start one:
    // `runTestFile` carries its own ceiling and its own group kill, but nothing
    // here can assume the runner honours either — a process that swallows the
    // SIGKILL, or a grandchild holding the pipe, keeps the `await` alive past the
    // deadline this loop just computed. Racing it means the step reports its
    // refusal AT the budget instead of whenever the runaway finally exits (the
    // orphaned child is the runner's own kill's business, not this loop's). It is
    // classified `infra` — an abandoned run observed nothing, exactly like a kill.
    const proof = await Promise.race([
      runTestFile(exec, { wt, template, file, limits: { timeoutMs: Math.min(perFile, left) } }),
      new Promise<Proof>((resolve) => {
        setTimeout(
          () =>
            resolve({
              kind: "infra",
              cmd: renderTestCommand(template, file),
              detail: `gave up at the ${String(perFile)}ms re-run budget`,
            }),
          left,
        );
      }),
    ]);
    // Pushed to `ran` only for the kinds that ANSWERED the question. An infra or
    // unclear run observed nothing about this file's assertions, so recording it
    // as a conflicting test would be as unproven as recording one the driver
    // never started — and `ran` is exactly the set the record may be built from.
    if (proof.kind === "infra" || proof.kind === "unclear") {
      // Observed nothing, so it proves nothing — and it is not fatal either. A
      // toolchain fault or an unrelated failure on ONE file must not hide a
      // genuine conflict among the rest.
      trace(`lean build: blocked report skipped one file — ${file}: ${proof.detail}`);
      skipped.push(file);
      continue;
    }
    ran.push(file);
    // ONLY `red`. `unclear` is a non-zero exit whose output never named this
    // file — something else failed — and a cause that says "these frozen tests
    // cannot all pass together" would attribute that failure to the contract.
    // `verify` may degrade an unclear run its own way; this gate does not honour
    // a claim on evidence it cannot tie to the file it names.
    if (proof.kind === "red") return { honoured: true, red: file, ran };
  }
  return {
    honoured: false,
    why:
      skipped.length === 0
        ? "every named frozen test passed, so nothing was proved unsatisfiable"
        : `no named test came back red (${String(skipped.length)} could not be judged: ${skipped.slice(0, 4).join(", ")})`,
  };
}
