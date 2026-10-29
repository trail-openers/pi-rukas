/**
 * lean/build-capture — the one look the build step takes at the child's bytes.
 *
 * Everything `normaliseBuild` keeps of the developer's work is the bytes it
 * reads here, plus the set of paths the child deleted. The reset that follows
 * makes the tree trustworthy again, so nothing else about it needs to survive:
 * no per-path restore, no per-path unlink. That claim is only true if the bytes
 * here are the bytes of the file the step decided to keep, which is what the
 * single-descriptor read below is for — and it is the same read `specify`
 * makes of its submitted tests, so there is one implementation of "read a file
 * you do not trust" in this step family rather than two.
 */

import { constants as fsConstants } from "node:fs";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

/** One file's bytes and its executable bit, or the reason it is not committable. */
export type Capture = { bytes: Buffer; exec: boolean } | { why: string };

/**
 * Read one file through a single descriptor, or say why it cannot be committed.
 *
 * Nothing re-resolves the path: `O_RDONLY|O_NOFOLLOW` pins the inode, so a
 * symlink swapped in afterwards is a refusal rather than a read of wherever it
 * points; `fstat` must see a regular file with `nlink === 1`, which is the only
 * thing that sees a hard link (`lstat` calls it an ordinary file and `realpath`
 * stays inside the tree, so the link count is the whole story); the bytes come
 * from that descriptor alone; and a second `fstat` must agree on `ino` and
 * `size`, or what was read was not one file the whole time.
 *
 * A refusal is not an error. The caller DROPS the path — the child's claim
 * about that file goes uncommitted — and reports it, which is a verdict about
 * the child's work rather than an infrastructure fault.
 */
export function captureOne(abs: string): Capture {
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    return { why: `could not be opened: ${(err as Error).message}` };
  }
  try {
    const first = fstatSync(fd);
    if (!first.isFile()) return { why: "is not a regular file" };
    if (first.nlink !== 1)
      return { why: `has ${first.nlink} hard links — not a file of this worktree` };
    const bytes = Buffer.allocUnsafe(first.size);
    let off = 0;
    while (off < bytes.length) {
      const n = readSync(fd, bytes, off, bytes.length - off, off);
      if (n <= 0) return { why: `ended at ${off} of ${bytes.length} bytes` };
      off += n;
    }
    const after = fstatSync(fd);
    if (after.ino !== first.ino || after.size !== first.size)
      return { why: "changed while it was read" };
    return { bytes, exec: (first.mode & 0o111) !== 0 };
  } catch (err) {
    return { why: `could not be read: ${(err as Error).message}` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed; nothing left to clean up */
    }
  }
}

/** Is `rel` present in `wt` as a regular file? A symlink or device reads as absent. */
export function isRealFile(wt: string, rel: string): boolean {
  try {
    return lstatSync(path.join(wt, rel)).isFile();
  } catch {
    return false;
  }
}
