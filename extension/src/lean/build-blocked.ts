/**
 * lean/build-blocked — the anti-forgery gate for the build child's "these frozen tests cannot all pass
 * together" report.
 *
 * The child's report is narration, not executed evidence. A builder that could end a run by naming a conflict
 * would end runs whose contract it never read, or one that is satisfiable. The driver honours it only when
 * BOTH hold:
 *
 *   1. **every named path is in the run's frozen map** — read off the same `frozenFromLog` every other reader
 *      of the contract uses;
 *   2. **at least one named frozen test comes back red on the child's tree**, run with the project's own
 *      `verify.test` template through the runner `verify` and `specify` use.
 *
 * A runner that could not start or was killed is NOT a red — it observed nothing — and a green named test is
 * not a conflict either.
 *
 * The entry and reason bounds are the DURABLE record's, so an entry that could not be persisted is refused
 * before anything is spent running it.
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
 * The child's conflicts, filtered to entries the record could hold, in the child's order — load-bearing,
 * because `blockedProved` runs them in it and stops at the first red. Illegal frozen keys drop before any
 * `git`/runner call.
 */
function usableConflicts(rows: Array<{ path: string; reason: string }>): string[] {
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
 * `wt` is the child's tree before any reset, so the red is a fact about its work. Each named file is hashed
 * before its runner starts: a builder that rewrote a frozen file into one that fails would otherwise be handed
 * a red the driver watched.
 *
 * One wall clock bounds the WHOLE loop, not each runner — 32 named files would otherwise cost 32 ceilings. An
 * un-startable or killed runner is skipped, not fatal.
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
    // No runner means no proof, so the report is ignored — and the silence is named, because `verify` calls
    // the same missing template an error.
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
  // ONE deadline for the loop, enforced at both ends of a runner (`runFrozen`).
  const perFile = opts.timeoutMs ?? TEST_TIMEOUT_MS;
  const deadline = Date.now() + perFile;
  const ran: string[] = [];
  const skipped: string[] = [];
  for (const file of paths) {
    // Only an ANSWERED file is evidence and only a `red` honours the report; `unclear` and abandoned SKIP.
    const proof = await runFrozen(exec, { wt, template, file }, deadline - Date.now());
    if (proof.kind === "infra" || proof.kind === "unclear") {
      trace(`lean build: blocked report skipped one file — ${file}: ${proof.detail}`);
      skipped.push(file);
      continue;
    }
    // Every file the driver JUDGED reaches `ran`, greens included — the cause's map holds every file vetted
    // up to and including the red, and stops there.
    ran.push(file);
    if (proof.kind === "green") continue;
    // A red counts only while the bytes behind its name are those the freeze hashed. Refused by name.
    const bytes = await blobAt(exec, wt, "HEAD", file);
    if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== frozen[file])
      return {
        honoured: false,
        why: `${file} is no longer the bytes the run froze — the frozen test was edited`,
      };
    return { honoured: true, red: file, ran };
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
 * One frozen file's verdict under the loop's ONE remaining budget. A runner that swallows the SIGKILL, or one
 * a grandchild holds open, is ABANDONED at the deadline and counts `infra` — the step refuses at its bound.
 */
async function runFrozen(
  exec: BuildExec,
  run: { wt: string; template: string; file: string },
  left: number,
): Promise<Proof> {
  if (left <= 0) return abandoned(run, left);
  let abandonTimer: ReturnType<typeof setTimeout> | undefined;
  const proof = await Promise.race([
    runTestFile(exec, {
      ...run,
      limits: { timeoutMs: Math.min(TEST_TIMEOUT_MS, left), env: verifyChildEnv() },
    }),
    new Promise<Proof>((resolve) => {
      abandonTimer = setTimeout(() => resolve(abandoned(run, left)), left);
    }),
  ]);
  if (abandonTimer !== undefined) clearTimeout(abandonTimer);
  return proof;
}

/** The verdict of a run the deadline took: nothing may be read into it, so it is `infra`. */
function abandoned(run: { template: string; file: string }, left: number): Proof {
  return {
    kind: "infra",
    // `killed`, not `never-started`: the deadline took a started process, so no one blames the project's
    // toolchain for a budget the driver ran out of.
    infraShape: "killed",
    cmd: renderTestCommand(run.template, run.file),
    detail: `gave up at the ${String(left)}ms re-run budget`,
  };
}

/**
 * Fold a budget-stopped builder's work into its attempt's commit, then say what is still red on the tree that
 * commit made — one function because the probe must read the RESET tree the fold produced. The sweep shares
 * {@link runFrozen}.
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
  /** Bounds the whole sweep of frozen tests; a test shortens it to watch a hang. */
  timeoutMs?: number;
}): Promise<{ kept: NormaliseReport; failing: string[] }> {
  const { exec, wt, frozen, template } = opts;
  const kept = await normaliseBuild({ ...opts, budget: new CaptureBudget(opts.ceiling) });
  // Only a runner that ANSWERED counts, and only bytes the freeze hashed — the tree is whatever the killed
  // child left, so each file comes out of HEAD.
  const failing: string[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? TEST_TIMEOUT_MS);
  if (template?.trim())
    for (const file of Object.keys(frozen)) {
      // ONE deadline for the sweep: once spent, no later file starts at all.
      const left = deadline - Date.now();
      if (left <= 0) break;
      const bytes = await blobAt(exec, wt, "HEAD", file);
      if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== frozen[file]) continue;
      if ((await runFrozen(exec, { wt, template, file }, left)).kind === "red") failing.push(file);
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
  // Only files the driver ACTUALLY RAN enter the record (`proved.ran` stops at the red), sanitised here
  // rather than at each reader since this durable record prints the child's prose. The first reason a path was
  // given wins.
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
