/**
 * adversarial-fix-guard — the tool-path guards around a fix round (#1104).
 *
 * A fix-developer edits files. Two rules keep those edits inside the worktree
 * the caller named:
 *   1. a fix round needs `workCwd` (the worktree the developer edits), enforced
 *      in runAdversarialLoop on every path;
 *   2. around each fix round, the calling process's repository is snapshotted
 *      (`git status --porcelain`) when it is NOT the workCwd repository; any
 *      change there is reported as a violation. A snapshot that cannot be read
 *      is reported as a note — "not checked" is never silently "clean".
 * Rule 2 is armed only by the tool path (`guardFixRounds`); the /work driver
 * always passes workCwd and is unchanged.
 */

import { synthesizeResult, toRoundRecords } from "./adversarial-verdict.ts";
import { execp } from "./lens-exec.ts";
import type { AdversarialVerdict, DispatchResult } from "./types.ts";
import { type ExecFn, resolvePath } from "./worktree.ts";

type Snapshot =
  | {
      kind: "repo";
      top: string;
      /** One entry per dirty path: its porcelain status line plus a content id. */
      entries: string[];
    }
  | { kind: "not-repo" }
  | { kind: "unreadable"; reason: string };

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).trim().split("\n").at(-1) ?? "unknown error";

/** The status column pair marks a deleted path: it has no content to hash. */
const isDeleted = (line: string): boolean => line.slice(0, 2).includes("D");

/**
 * Snapshot one repository's dirty state. Argv form throughout (no shell), so a
 * path name is never re-parsed. Porcelain status records path and state, not
 * content, so a write to an already-dirty file leaves the status line unchanged;
 * the content hashes catch that. All live paths are hashed in ONE process, and a
 * failed hash is `unreadable` (reported as not checked), never a silent marker.
 */
async function snapshotRepo(cwd: string, exec: ExecFn): Promise<Snapshot> {
  let top: string;
  try {
    top = resolvePath(
      (await exec("git", { argv: ["rev-parse", "--show-toplevel"], cwd })).stdout.trim(),
    );
  } catch (err) {
    return /not a git repository/i.test(errorText(err))
      ? { kind: "not-repo" }
      : { kind: "unreadable", reason: errorText(err) };
  }
  try {
    // -z: NUL-separated, unquoted paths; -uall: every untracked file, not its dir.
    const parts = (
      await exec("git", { argv: ["status", "--porcelain", "-z", "-uall"], cwd })
    ).stdout
      .split("\0")
      .filter(Boolean);
    const records: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (line === undefined) break;
      // A rename/copy record is followed by its origin path, which is not a record.
      if (/[RC]/.test(line.slice(0, 2))) i++;
      records.push(line);
    }
    const live = records.filter((line) => !isDeleted(line)).map((line) => line.slice(3));
    const hashes =
      live.length === 0
        ? []
        : (await exec("git", { argv: ["hash-object", "--", ...live], cwd: top })).stdout
            .split("\n")
            .filter(Boolean);
    if (hashes.length !== live.length) {
      throw new Error(`hash-object returned ${hashes.length} ids for ${live.length} paths`);
    }
    let h = 0;
    const entries = records.map((line) =>
      isDeleted(line) ? `${line}\tdeleted` : `${line}\t${hashes[h++]}`,
    );
    return { kind: "repo", top, entries };
  } catch (err) {
    return { kind: "unreadable", reason: errorText(err) };
  }
}

const noCheck = async (): Promise<void> => {};

/**
 * Arm the caller-repo check for one fix round. Resolves to a check run after
 * the round: it pushes a violation onto `violations` when the calling process's
 * `git status` changed, or a note when the check could not run. A no-op unless
 * `guardFixRounds` is set, or when the caller is not a git repository, or when
 * the caller's repository IS the workCwd repository.
 */
export async function beginFixGuard(
  opts: { guardFixRounds?: boolean; workCwd?: string },
  violations: string[],
  exec: ExecFn = execp,
): Promise<(round: number) => Promise<void>> {
  const workCwd = opts.guardFixRounds ? opts.workCwd : undefined;
  if (!workCwd) return noCheck;
  const caller = await snapshotRepo(process.cwd(), exec);
  if (caller.kind === "not-repo") return noCheck;
  const work = await snapshotRepo(workCwd, exec);
  if (work.kind === "repo" && caller.kind === "repo" && caller.top === work.top) return noCheck;
  if (caller.kind === "unreadable" || work.kind === "unreadable") {
    const failure = caller.kind === "unreadable" ? caller : work;
    const reason = failure.kind === "unreadable" ? failure.reason : "unknown";
    return async (round) => {
      violations.push(`note: fix round ${round} caller-repo check did not run (${reason})`);
    };
  }
  const workTop = work.kind === "repo" ? work.top : workCwd;
  const baseline = caller.entries;
  return async (round) => {
    const after = await snapshotRepo(process.cwd(), exec);
    if (after.kind !== "repo") {
      const why = after.kind === "unreadable" ? after.reason : "caller is no longer a repository";
      violations.push(`note: fix round ${round} caller-repo check did not run (${why})`);
      return;
    }
    const b = new Set(baseline);
    const a = new Set(after.entries);
    const delta = [...after.entries.filter((l) => !b.has(l)), ...baseline.filter((l) => !a.has(l))];
    if (delta.length === 0) return;
    violations.push(
      `VIOLATION: caller repository (${caller.top}) changed during fix round ${round} (attribution not verified), outside workCwd (${workTop}): ${delta.join("; ")}`,
    );
  };
}

/**
 * Prefix a result's text with any recorded violations (the ledger sees the same
 * text). A VIOLATION (a write outside workCwd) also fails the result: callers
 * keying on `ok` must not read a run that breached the fence as clean. Notes
 * (a check that did not run) leave `ok` alone.
 */
export function withFixViolations(result: DispatchResult, violations: string[]): DispatchResult {
  if (violations.length === 0) return result;
  const breached = violations.some((v) => v.startsWith("VIOLATION:"));
  return {
    ...result,
    ok: breached ? false : result.ok,
    text: [...violations, "", result.text].join("\n"),
  };
}

/**
 * The result when a fix is needed but the tool was called without workCwd:
 * the verdict is kept, no developer is dispatched, and the error names workCwd.
 */
export function workCwdRequiredResult(
  round: number,
  verdict: { status: AdversarialVerdict["status"]; findings: string },
  state: {
    start: number;
    usage: DispatchResult["usage"];
    lastTranscript: string | undefined;
    lastModel: string | undefined;
    rounds: Parameters<typeof toRoundRecords>[0];
  },
): DispatchResult {
  return synthesizeResult({
    ok: false,
    loopOutcome: "rejected",
    text: `Adversarial round ${round} verdict: ${verdict.status}. A fix is needed, but no \`workCwd\` was given, so no developer was dispatched — fixes edit files only in workCwd. Pass \`workCwd\` (the worktree the fix should edit), or set \`reportOnly: true\` to review without fixing.\n\n${verdict.findings}`,
    ms: Date.now() - state.start,
    usage: state.usage,
    transcriptPath: state.lastTranscript,
    model: state.lastModel,
    adversarialRounds: toRoundRecords(state.rounds),
  });
}
