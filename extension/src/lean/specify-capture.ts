/**
 * lean/specify-capture — CAPTURE, the one read of the child's bytes.
 *
 * The specify step keeps exactly one thing from the adversary's worktree: the
 * bytes of each submitted test file, held in memory. Everything else the child
 * did — its own commits, a rewritten test, a `.gitignore` hiding a stray file —
 * is irrelevant afterwards, because the step resets the tree and writes these
 * bytes back. That claim is only true if the bytes here are the bytes of the
 * file the step validated, which is what this module is for.
 *
 * The validation in `specify-tree.ts`'s `fileProblem` is a fact about a NAME,
 * and a name can be swapped between that check and this read: the child writes
 * the file and submits its path from its own side of the step, so it has a
 * window. So nothing here re-resolves a path:
 *
 *   - one `openSync` with `O_RDONLY | O_NOFOLLOW` pins the inode, so a symlink
 *     swapped in afterwards is a refusal, not a read of wherever it points;
 *   - `fstat` on that fd must see a REGULAR file with `nlink === 1` — the
 *     hard-link check has to live here as well as in `fileProblem`, because
 *     `lstat` ran before the swap and this is the only look a post-swap link
 *     gets (a hard link is not a link: `lstat` sees an ordinary file and
 *     `realpath` stays inside the tree, so only the link count tells on it);
 *   - the whole file is read from that descriptor, never by name;
 *   - `fstat` again on the same fd must agree with the first — same `ino`,
 *     `size` and `mtimeMs` — or what was read was not one file the whole time.
 *
 * A file that fails any of it is DROPPED with its reason, like every other
 * failed check on a submitted row: the row leaves, its criterion goes
 * uncovered, and the step reports a verdict about the child's work rather than
 * an infrastructure fault. A swapped-in hard link, symlink, fifo, empty or
 * truncated file never becomes a captured test.
 */

import { constants as fsConstants } from "node:fs";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { DroppedRow } from "./specify-tree.ts";

/** The identity of an open file, enough to notice it changed under us. */
interface Stamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

function stampOf(st: { ino: number | bigint; size: number | bigint; mtimeMs: number }): Stamp {
  return { ino: Number(st.ino), size: Number(st.size), mtimeMs: st.mtimeMs };
}

function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** One file's bytes, or the reason this file is not a capturable test. */
type OneRead = { bytes: Buffer } | { why: string };

/** Read one file through a single descriptor, or say why it cannot. */
function readOneDescriptor(abs: string): OneRead {
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    return { why: `could not be opened: ${(err as Error).message}` };
  }
  try {
    let first: ReturnType<typeof fstatSync>;
    try {
      first = fstatSync(fd);
    } catch (err) {
      return { why: `could not be stat'd: ${(err as Error).message}` };
    }
    if (!first.isFile()) return { why: "is not a regular file" };
    if (first.nlink !== 1)
      return { why: `has ${first.nlink} hard links — not a file of this worktree` };
    if (first.size <= 0) return { why: "is empty, which cannot be a test" };

    const before = stampOf(first);
    const bytes = Buffer.allocUnsafe(first.size);
    let off = 0;
    while (off < bytes.length) {
      const n = readSync(fd, bytes, off, bytes.length - off, off);
      if (n <= 0) return { why: `ended at ${off} of ${bytes.length} bytes` };
      off += n;
    }

    let after: ReturnType<typeof fstatSync>;
    try {
      after = fstatSync(fd);
    } catch (err) {
      return { why: `could not be re-stat'd: ${(err as Error).message}` };
    }
    const later = stampOf(after);
    if (!sameStamp(before, later))
      return {
        why: `changed while it was read (${JSON.stringify(before)} → ${JSON.stringify(later)})`,
      };
    return { bytes };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed; there is nothing left to clean up */
    }
  }
}

/** What a capture returns: the bytes it holds, and the rows it refused. */
export interface CaptureResult {
  captured: Map<string, Buffer>;
  dropped: DroppedRow[];
}

/**
 * Read the bytes of every kept test file into memory, one descriptor each.
 *
 * `owners` maps a path to the criterion that claimed it, so a dropped row
 * names the criterion the step must then call uncovered; a caller with no
 * criterion map gets `unknown` rows rather than a throw.
 */
export function captureTestBytes(
  wt: string,
  paths: string[],
  owners: Map<string, string> = new Map(),
): CaptureResult {
  const captured = new Map<string, Buffer>();
  const dropped: DroppedRow[] = [];
  for (const rel of paths) {
    const criterionId = owners.get(rel) ?? "unknown";
    const read = readOneDescriptor(path.join(wt, rel));
    if ("why" in read) {
      dropped.push({ criterionId, path: rel, reason: `test ${rel} ${read.why}` });
      continue;
    }
    captured.set(rel, read.bytes);
  }
  return { captured, dropped };
}
