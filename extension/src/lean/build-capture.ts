/**
 * lean/build-capture — the one look at a changed path that is not a read of its
 * bytes.
 *
 * The bytes `normaliseBuild` keeps are read by `readOneDescriptor` in
 * `specify-capture.ts`: the single-descriptor read `specify` makes of its
 * submitted tests, so there is one implementation of "read a file you do not
 * trust" in this step family rather than two. What remains here is the question
 * that read cannot answer for a path: is there a regular file at this name at
 * all? A symlink or a device reads as absent, and the child's change to it is a
 * deletion the commit must carry rather than a capture the step refused.
 */

import { lstatSync } from "node:fs";
import path from "node:path";

/** Is `rel` present in `wt` as a regular file? A symlink or device reads as absent. */
export function isRealFile(wt: string, rel: string): boolean {
  try {
    return lstatSync(path.join(wt, rel)).isFile();
  } catch {
    return false;
  }
}
