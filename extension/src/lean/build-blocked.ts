/**
 * lean/build-blocked — the anti-forgery gate for the build child's "these
 * frozen tests cannot all pass together" report.
 *
 * The child's report is narration, not executed evidence (AGENTS.md §7 rule 1). A
 * builder that could end a run by naming a conflict would end runs whose contract it
 * never read, or one that is satisfiable — the shape of a child that gave up. So the
 * driver honours the report only when BOTH hold, and the second is its own command:
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
 * A green named test is not a conflict either. When ignored, the caller traces the
 * reason and continues its ordinary path: there is no third verdict.
 *
 * The entry and reason bounds here are the DURABLE record's, so an entry that could
 * not be persisted is refused before anything is spent running it.
 */

import { trace, traceWarn } from "../trace.ts";
import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { extractBlockedReport } from "./build-blocked-extract.ts";
import { blobAt } from "./build-git.ts";
import { normaliseBuild } from "./build-normalise.ts";
import type { NormaliseReport } from "./build-types.ts";
import type { BuildExec } from "./build-types.ts";
import { CaptureBudget } from "./specify-capture.ts";
import {
  type Proof,
  TEST_TIMEOUT_MS,
  renderTestCommand,
  runTestFile,
  sha256,
} from "./specify-proof.ts";
import { RECORD_MAX_ENTRIES, RECORD_REASON_MAX_CHARS } from "./state-outcome-maps.ts";
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP, frozenKeyProblem } from "./state-outcome.ts";
import { oneLine } from "./text-fence.ts";

/** How many conflicts one report may name — the record's own bound, imported from
 * the module that enforces it so the gate never runs an entry it would refuse. */
export const BLOCKED_MAX_ENTRIES = RECORD_MAX_ENTRIES;

/** How long one stated conflict may be. Same single source as the entry cap. */
export const BLOCKED_MAX_REASON_CHARS = RECORD_REASON_MAX_CHARS;

/** The cause LINE's ceiling: the renderer caps plus the sentence around them. */
const BLOCKED_CAUSE_CAP = BLOCKED_PATH_CAP + BLOCKED_REASON_CAP + 44;

/**
 * The child's reported conflicts, filtered to entries the record could hold, in the
 * child's own order: `blockedProved` runs them in it and stops at the first red, so a
 * re-sorted list would prove a file the builder never feared. Illegal frozen keys are
 * dropped here, before any `git`/runner call.
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
  /** `ran` is every file the driver executed, up to and including the `red`. */
  | { honoured: true; red: string; ran: string[] }
  /** `why` is the reason the report was ignored, for the trace line. */
  | { honoured: false; why: string };

/**
 * Did the driver itself prove the named tests disagree?
 *
 * `wt` is the child's tree, before any reset, so the red is a fact about the child's
 * work. Hence each named file is hashed before its runner starts: a builder that
 * rewrote a frozen file into one that fails would otherwise be handed a red the
 * driver watched. Only what `ran` lists may be recorded.
 *
 * One wall clock bounds the WHOLE loop, not each runner: a report naming the 32
 * files the tool may ask for would otherwise cost 32 ceilings, and the step's own
 * budget is no substitute because the re-run happens after the child is paid. The
 * bound is enforced TWICE — nothing STARTS once spent, and a runner in flight is
 * abandoned at the same instant. A file whose runner could not start or was killed
 * is skipped, not fatal; if nothing came back red the report is not honoured.
 */
export async function blockedProved(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  paths: string[];
  /** Bounds the whole re-run loop; a test shortens it to observe a hang. */
  timeoutMs?: number;
}): Promise<BlockedVerdict> {
  const { exec, wt, template, frozen, paths } = opts;
  // The list's ceiling is applied where it is built (`usableConflicts`).
  if (paths.length === 0) return { honoured: false, why: "the report named no usable path" };
  if (template === undefined || template.trim() === "") {
    // No runner means no proof, so the report is ignored like every other refusal
    // here. The silence is named because `verify` calls the same missing template an
    // error, and a project with none would see a builder probe the ceiling silently.
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
  // may START once it is spent, and one in flight is abandoned at the same instant
  // (see the race below). Each runner keeps its own ceiling too, so an ordinary
  // hung test is killed and classified as infra rather than abandoned.
  const perFile = opts.timeoutMs ?? TEST_TIMEOUT_MS;
  const deadline = Date.now() + perFile;
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const file of paths) {
    const left = deadline - Date.now();
    if (left <= 0) {
      return {
        honoured: false,
        why: `the re-run budget of ${String(perFile)}ms ran out after ${String(ran.length)} file(s)`,
      };
    }
    // "The driver ran it and saw red" is evidence only while the bytes behind the
    // name are the bytes the freeze hashed: a frozen file the child edited into one
    // that fails is its own edit, and to the runner the two look identical. Refused
    // by name, not skipped — such a red says nothing about the files after it.
    const bytes = await blobAt(exec, wt, "HEAD", file);
    if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== frozen[file]) {
      return {
        honoured: false,
        why: `${file} is no longer the bytes the run froze — the frozen test was edited`,
      };
    }
    // The in-flight runner is bounded too, not just the decision to start one:
    // `runTestFile` carries its own ceiling and group kill, but nothing here can
    // assume it honours either — a process that swallows the SIGKILL, or a
    // grandchild holding the pipe, keeps the `await` alive past this deadline.
    // Racing it means the step refuses AT the budget rather than whenever the
    // runaway exits, and an abandoned run counts `infra`: it observed nothing. The
    // timer is cleared once the race settles (an abandoned runner would otherwise
    // leave it for the life of the process), and the guard is not defensive — when
    // the timer wins, its `resolve` runs before the assignment below is observed.
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    const proof = await Promise.race([
      runTestFile(exec, {
        wt,
        template,
        file,
        limits: { timeoutMs: Math.min(perFile, left), env: verifyChildEnv() },
      }),
      new Promise<Proof>((resolve) => {
        abandonTimer = setTimeout(
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
    if (abandonTimer !== undefined) {
      clearTimeout(abandonTimer);
      abandonTimer.unref();
    }
    // Only the kinds that ANSWERED reach `ran`, the set the record is built from.
    // Infra/unclear prove nothing but are not fatal: one broken file must not
    // hide a genuine conflict among the rest.
    if (proof.kind === "infra" || proof.kind === "unclear") {
      trace(`lean build: blocked report skipped one file — ${file}: ${proof.detail}`);
      skipped.push(file);
      continue;
    }
    ran.push(file);
    // ONLY `red`. An `unclear` exit named no file, and a cause that says "these
    // frozen tests cannot all pass together" would attribute that failure to the
    // contract; this gate does not honour a claim it cannot tie to a file.
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

/**
 * Fold a budget-stopped builder's work into its attempt's commit, then say what is
 * still red on the tree that commit made (#2067) — one function because the probe
 * must read the RESET tree the fold produced.
 */
export async function foldStoppedBuild(opts: {
  exec: BuildExec;
  wt: string;
  repoRoot: string;
  branch: string;
  headBefore: string;
  frozen: Record<string, string>;
  attempt: number;
  issue: number;
  template: string | undefined;
  ceiling?: number;
}): Promise<{ kept: NormaliseReport; failing: string[] }> {
  const { exec, wt, frozen, template } = opts;
  const kept = await normaliseBuild({ ...opts, budget: new CaptureBudget(opts.ceiling) });
  // Only a runner that ANSWERED counts, and only bytes the freeze hashed: the
  // working tree is whatever the killed child left, so each file comes out of HEAD.
  const failing: string[] = [];
  if (template?.trim())
    for (const file of Object.keys(frozen)) {
      const bytes = await blobAt(exec, wt, "HEAD", file);
      if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== frozen[file]) continue;
      if ((await runTestFile(exec, { wt, template, file })).kind === "red") failing.push(file);
    }
  return { kept, failing };
}

/** The child's report judged end to end. `undefined` says "not honoured". */
export async function judgeBlockedReport(opts: {
  exec: BuildExec;
  wt: string;
  template: string | undefined;
  frozen: Record<string, string>;
  toolUses: unknown[];
  issue: number;
  timeoutMs?: number;
}): Promise<{ reason: string; blockedBy: Record<string, string> } | undefined> {
  const extracted = extractBlockedReport(opts.toolUses);
  if (extracted.rows.length === 0) {
    if (extracted.skipped > 0)
      trace(
        `lean build #${String(opts.issue)}: ignored ${String(extracted.skipped)} unreadable report_blocked call(s)`,
      );
    return undefined;
  }
  const paths = usableConflicts(extracted.rows);
  const proved = await blockedProved({
    exec: opts.exec,
    wt: opts.wt,
    template: opts.template,
    frozen: opts.frozen,
    paths,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (!proved.honoured) {
    traceWarn(`lean build #${String(opts.issue)}: blocked report ignored — ${proved.why}`);
    return undefined;
  }
  // Only files the driver ACTUALLY RAN enter the record (`proved.ran` stops at the
  // red, so an unexecuted entry cannot be recorded as proved), sanitised here rather
  // than at each reader since this durable record prints the child's prose. The
  // first reason a path was given wins, so a later row cannot overwrite it.
  const ran = new Set(proved.ran);
  const blockedBy: Record<string, string> = {};
  for (const row of extracted.rows) {
    if (!ran.has(row.path) || row.path in blockedBy) continue;
    blockedBy[oneLine(row.path, BLOCKED_PATH_CAP)] = oneLine(row.reason, BLOCKED_REASON_CAP);
  }
  const red = proved.red;
  if (!(red in blockedBy)) return undefined;
  // The cause line leads with the file the driver watched fail; the map carries all.
  return {
    reason: oneLine(
      `frozen tests cannot all pass together: ${red} — ${blockedBy[red] ?? ""}`,
      BLOCKED_CAUSE_CAP,
    ),
    blockedBy,
  };
}
