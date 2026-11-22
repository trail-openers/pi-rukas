/**
 * lean/verify-roster-edited — an EDITED pre-existing test file, run as its BASE bytes.
 *
 * Bench cell 2: a build rewrites one of the project's own existing tests, `verify` runs the EDITED
 * copy and passes, and restoring the original fails. The only observation that sees it is the file's
 * BASE bytes run against the head code, per file, through the project's `verify.test` template. Bytes
 * come from `git show <baseSha>:<path>` (the object store, never the tree the run may have rewritten)
 * and stand in the file's own path only for that run; the head copy is put back before this returns,
 * so the step's clean-tree re-check never reports them as a tier's. Rules stated where judged: roster.ts.
 */

import { chmodSync, lstatSync, readFileSync, rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { verifyChildEnv, verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { runTestFile } from "./specify-proof.ts";
import { NO_HOOKS, writeCaptured } from "./specify-reset.ts";
import type { VerifyExec } from "./verify-types.ts";

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
 * passes, and the hidden run restores the original and fails. Each original is put AT ITS OWN
 * PATH for the run and the head copy put back after, because only that path is one `verify.test`
 * is known to run: a cargo wrapper resolves a target from it and pytest applies the directory's
 * conftest to it, so a relocated copy reads as a red the base version never had.
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
    const head = headCopy(path.join(wt, rel));
    if (head === null)
      return { ok: false, reason: `the head copy of ${rel} is not a plain file to put back` };
    try {
      writeCaptured(wt, new Map([[rel, Buffer.from(bytes, "utf8")]]));
      const proof = await runTestFile(exec, {
        wt,
        template,
        file: rel,
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
      // Put back on every exit path. The mode and mtime travel with the bytes: a changed mode is a
      // dirty tree, and a bytecode cache keyed on mtime and size would otherwise serve the base
      // version to every later tier. A failed put-back is left for the step's clean-tree re-check,
      // which reads base bytes in a tracked file as a dirty tree and hands back.
      try {
        if (head === undefined) rmSync(path.join(wt, rel), { force: true });
        else {
          writeCaptured(wt, new Map([[rel, head.bytes]]));
          chmodSync(path.join(wt, rel), head.mode);
          utimesSync(path.join(wt, rel), head.atime, head.mtime);
        }
      } catch {
        // Nothing to do about it here: the re-check is the backstop.
      }
    }
  }
  return { ok: true, editedFiles: [...edited], redFiles };
}

/**
 * The head copy of a file, `undefined` when the run deleted it, `null` when it is something other
 * than a plain file — a symlink or a directory is not a copy this step may write through.
 */
function headCopy(
  abs: string,
): { bytes: Buffer; mode: number; atime: Date; mtime: Date } | undefined | null {
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return null;
    return { bytes: readFileSync(abs), mode: st.mode, atime: st.atime, mtime: st.mtime };
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT" ? undefined : null;
  }
}
