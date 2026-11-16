/**
 * lean/verify-frozen — the independent claims a frozen test file must hold before its verdict counts
 * as evidence.
 *
 * A frozen file is a promise made earlier in the run: `specify` hashed each acceptance test at the
 * commit it committed them to, and every later verdict is a verdict about THOSE bytes. Three things
 * can break that promise, and each says something different to whoever reads the handback:
 *
 *   - **HEAD's tree no longer holds the frozen blob** — somebody committed a change to the test, or
 *     the run sits at a commit that never held it. `frozenMatches` (from `build-git.ts`) is the same
 *     probe `build` runs, so the two steps cannot disagree about what a frozen blob is;
 *   - **the file on disk is not the file that was frozen** — edited without committing, turned into
 *     a symlink, or hard-linked to an outside file;
 *   - **the file is untracked or otherwise not part of the commit** — caught by the whole-tree
 *     `porcelain` scan plus an existence probe.
 *
 * The shape half of the on-disk check reuses `fileProblem` from `specify-path.ts`, which already
 * refuses a symlink, a non-regular file, an `nlink > 1` hard link and a realpath escape. All
 * findings are reported together when several apply.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { frozenTamperedAtHead } from "./build-git.ts";
import { fileProblem } from "./specify-path.ts";
import { sha256 } from "./specify-proof.ts";
import { changedPaths } from "./specify-tree.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/**
 * Why this frozen path is not a file this worktree owns, or `undefined`.
 *
 * Read through `lstat` and an exclusive-link check BEFORE hashing: a symlink or a hard link shares
 * its bytes with something outside the tree, and hashing the target would vouch for bytes nobody
 * froze.
 */
function diskShapeProblem(wt: string, rel: string): string | undefined {
  const abs = path.join(wt, rel);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `frozen file ${rel} is a symlink on disk`;
    if (!st.isFile()) return `frozen file ${rel} is not a regular file on disk`;
    if (st.nlink !== 1) return `frozen file ${rel} has ${st.nlink} hard links on disk`;
  } catch {
    throw new VerifyInfraError(`the frozen file ${rel} could not be read from the worktree`);
  }
  return fileProblem(wt, rel);
}

/** Why this frozen path's bytes on disk are not the frozen bytes, or `undefined`. */
function diskBytesProblem(wt: string, rel: string, want: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(wt, rel));
  } catch {
    throw new VerifyInfraError(`the frozen file ${rel} could not be read from the worktree`);
  }
  // A zero-byte file is never a test, whatever its record claims.
  if (bytes.length === 0) return `frozen file ${rel} is empty on disk`;
  if (sha256(bytes) !== want) return `frozen file ${rel} does not match its record on disk`;
  return undefined;
}

/** The frozen paths git reports as changed, added or deleted in `wt`. */
async function dirtyFrozen(exec: VerifyExec, wt: string, frozen: string[]): Promise<string[]> {
  const changed = await changedPaths(exec, wt).catch(() => undefined);
  if (changed === undefined) throw new VerifyInfraError(`could not read the tree state in ${wt}`);
  const moved = new Set(changed.map((e) => e.path));
  const out: string[] = [];
  for (const rel of frozen) {
    if (moved.has(rel)) out.push(rel);
    else if (!existsSync(path.join(wt, rel))) out.push(rel);
  }
  return out;
}

/** Why these frozen files are not the files that were frozen, or `undefined` when all are. */
export async function frozenTamperReason(
  exec: VerifyExec,
  wt: string,
  head: string,
  frozen: Record<string, string>,
): Promise<string | undefined> {
  const names = Object.keys(frozen);
  // Nothing was ever frozen is not a tampered contract — it is no contract, and the caller decides
  // what a run with no acceptance tests may claim.
  if (names.length === 0) return undefined;
  const parts: string[] = [];

  // The committed half: git's answer about HEAD's tree. An unreadable blob is infrastructure, not
  // evidence that anyone edited a test.
  const atHead = await frozenTamperedAtHead(exec, wt, head, frozen);
  if (atHead.unreadable !== undefined)
    throw new VerifyInfraError(
      `could not read frozen blob ${atHead.unreadable} at ${head} in ${wt}`,
    );
  if (atHead.tampered.length > 0) parts.push(`frozen tests altered: ${atHead.tampered.join(", ")}`);

  // The tree half, per file: changed, gone, a link rather than a file, or bytes that are not the
  // frozen bytes. All four say the same thing to the reader, and the whole-tree scan only says WHICH
  // files — so each file that scan flagged is not hashed as well.
  const moved = await dirtyFrozen(exec, wt, names);
  const seen = new Set(moved);
  const bad = [...moved];
  for (const [rel, want] of Object.entries(frozen)) {
    if (seen.has(rel)) continue;
    const shape = diskShapeProblem(wt, rel);
    if (shape !== undefined) {
      bad.push(rel);
      continue;
    }
    if (diskBytesProblem(wt, rel, want) !== undefined) bad.push(rel);
  }
  if (bad.length > 0) parts.push(`frozen files not as frozen: ${bad.join(", ")}`);
  return parts.length === 0 ? undefined : parts.join(" — ");
}
