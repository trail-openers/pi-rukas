/**
 * lean/verify-roster-edited — an EDITED pre-existing test file, run as its BASE bytes.
 *
 * Bench cell 2: a build rewrites one of the project's own existing tests, `verify` runs the EDITED
 * copy and passes, and restoring the original fails. The only observation that sees it is the file's
 * BASE bytes run against the head code, per file, through the project's `verify.test` template. Bytes
 * come from `git show <baseSha>:<path>` (the object store, never the tree the run may have rewritten);
 * the scratch that materialises them is the gate's own and is removed before this returns, so the
 * step's clean-tree re-check never reports them as a tier's. Rules stated where judged: roster.ts.
 */

import { rmSync } from "node:fs";
import path from "node:path";
import { verifyChildEnv, verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { renderTestCommand, runTestFile, sha256 } from "./specify-proof.ts";
import { NO_HOOKS, writeCaptured } from "./specify-reset.ts";
import type { VerifyExec } from "./verify-types.ts";

/** Scratch directory (inside the worktree) a base-version test file is materialised into. */
const ROSTER_SCRATCH_DIR = ".lean-roster-base";

/**
 * The pre-existing test files this run changed, deletion included.
 *
 * `git diff --name-only <base> HEAD -- <files>` names the pair that differ between the two
 * commits the record is about, intersected with the pre-existing set so a file the run ADDED is
 * not "edited" (it is the run's own contract and the roster's per-test verdicts cover it). A
 * rejection is `undefined` — "git would not answer" — never "nothing moved".
 *
 * The diff is asked WITHOUT pathspecs: a `--` list of the pre-existing files would hide a file
 * the run DELETED only if the listing still named it, and the point of asking the diff is to
 * catch the files whose bytes the run changed. Names outside the pre-existing set are dropped by
 * the intersection below, so the wider read costs nothing in the answer.
 */
export async function editedTestFiles(
  exec: VerifyExec,
  wt: string,
  baseSha: string,
  preexisting: readonly string[],
): Promise<string[] | undefined> {
  const ran = await exec("git", {
    argv: [...NO_HOOKS, "diff", "--name-only", "-z", "--end-of-options", baseSha, "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: verifyHostEnv(),
  }).catch(() => undefined);
  if (ran === undefined) return undefined;
  const changed = new Set(
    (ran.stdout ?? "")
      .split("\0")
      .map((p) => p.trim())
      .filter((p) => p !== ""),
  );
  return preexisting.filter((f) => changed.has(f));
}

/**
 * The base commit's bytes at `rel`, or `undefined` when git would not give them.
 *
 * "Would not give them" covers three answers, and none of them may come back as an empty file: a
 * rejection (the executor could not run git, or git was killed), a child that printed nothing because
 * it failed, and a blob that is empty when the commit says it is not. An empty string returned for
 * any of those is a VALID empty test file to the caller, which runs it, watches it pass, and records a
 * base version that never existed as a contract this run did not break — the exact green the edited-file
 * arm exists to refuse.
 *
 * A genuinely zero-byte blob IS acceptable, and is confirmed rather than assumed: `git cat-file -s`
 * asks the object how big it is, so an empty read is believed only when the object really is empty.
 * Any doubt about the size is answered as "no bytes", which is the fail-closed direction — the run
 * hands back rather than grading a green on a base file it could not read.
 */
async function gitShowBlob(
  exec: VerifyExec,
  repoRoot: string,
  baseSha: string,
  rel: string,
): Promise<string | undefined> {
  const ran = await exec("git", {
    argv: [...NO_HOOKS, "show", `${baseSha}:${rel}`],
    cwd: repoRoot,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: verifyHostEnv(),
  }).catch((err: unknown) =>
    typeof err === "object" && err !== null
      ? (err as Record<string, unknown>)
      : { message: String(err) },
  );
  // A rejection is the executor speaking, not git's "no such path", and only bytes the child really
  // printed are the base's bytes.
  if (!Object.hasOwn(ran, "stdout") || typeof ran.stdout !== "string") return undefined;
  const bytes = ran.stdout;
  if (bytes !== "") return bytes;
  // The read came back empty. Ask the object its own size before believing it: a `git show` that
  // failed for a reason the executor still reported as a success prints nothing, and nothing is not
  // the same fact as a zero-byte blob.
  const sized = await exec("git", {
    argv: [...NO_HOOKS, "cat-file", "-s", `${baseSha}:${rel}`],
    cwd: repoRoot,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    env: verifyHostEnv(),
  }).catch(() => undefined);
  const reported = (sized as { stdout?: unknown } | undefined)?.stdout;
  if (typeof reported !== "string") return undefined;
  const trimmed = reported.trim();
  // A non-numeric answer is git failing to name a size, not a size of zero.
  if (!/^\d+$/.test(trimmed)) return undefined;
  return trimmed === "0" ? "" : undefined;
}

/**
 * The base version of every edited pre-existing test file, run against the HEAD code.
 *
 * Bench cell 2: the fold edits an existing test's expectation, verify runs the EDITED copy and
 * passes, and the hidden run restores the original and fails. Each original is materialised
 * under a scratch directory inside the worktree — named so its own failure output still names
 * it — and run through `runTestFile`, the project's own `verify.test` template in argv form.
 *
 * `redFiles` is what makes land refuse: a base-version file green at base and red against the
 * head code is a contract this run broke, and Part A has NO acceptance path for it.
 */
export async function runEditedBaseVersions(opts: {
  exec: VerifyExec;
  repoRoot: string;
  wt: string;
  baseSha: string;
  template: string;
  timeoutMs: number;
  edited: readonly string[];
}): Promise<
  { ok: true; editedFiles: string[]; redFiles: string[] } | { ok: false; reason: string }
> {
  const { exec, repoRoot, baseSha, wt, template, timeoutMs, edited } = opts;
  if (edited.length === 0) return { ok: true, editedFiles: [], redFiles: [] };
  const redFiles: string[] = [];
  for (const rel of edited) {
    const bytes = await gitShowBlob(exec, repoRoot, baseSha, rel);
    if (bytes === undefined)
      return {
        ok: false,
        reason: `could not read the base version of ${rel} at ${baseSha.slice(0, 12)}`,
      };
    // The scratch name keeps the file's own basename, so a runner that names the failing file
    // names it, and `runTestFile`'s red/unclear test still works.
    const probe = `${ROSTER_SCRATCH_DIR}/${sha256(rel).slice(0, 12)}/${baseName(rel)}`;
    try {
      writeCaptured(wt, new Map([[probe, Buffer.from(bytes, "utf8")]]));
      const proof = await runTestFile(exec, {
        wt,
        template,
        file: probe,
        // The SAME scrubbed env `runProjectSuite` gives the project's suite. A base version run that
        // inherited the driver's environment could see knobs the real tier never passes, and a
        // verdict it reached under them is not the verdict the project's runner would have reached.
        limits: { timeoutMs, env: verifyChildEnv() },
      });
      if (proof.kind === "infra")
        return {
          ok: false,
          reason: `the base version of ${rel} could not be judged: ${proof.detail}`,
        };
      if (proof.kind !== "green") redFiles.push(rel);
    } catch {
      return { ok: false, reason: `could not write the base version of ${rel} for its run` };
    } finally {
      // The gate's own bytes, in the tree it is judging: left behind, the step's clean-tree
      // re-check reports them as a tier that dirtied the worktree. Removed per file, on every
      // exit path, so an early return cannot strand one.
      try {
        rmSync(path.join(wt, ROSTER_SCRATCH_DIR), { recursive: true, force: true });
      } catch {
        // Nothing to do about it: the re-check is the backstop, not this line.
      }
    }
  }
  return { ok: true, editedFiles: [...edited], redFiles };
}

/** The final path segment of a repo-relative path. */
function baseName(rel: string): string {
  const parts = rel.split("/");
  return parts[parts.length - 1] ?? rel;
}

/**
 * The roster: the project's pre-existing tests at head and at base, plus the base version of
 * every one of them the run edited, run against the head code.
 *
 * Ordered so the cheap refusals come first — the config pair, the base listing, the report
 * command — because each makes the expensive runs pointless. A `red` here is builder-fixable
 * and names the tests; a `none` is the hand-back.
 */
