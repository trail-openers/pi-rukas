/**
 * lean/build-capture — the one look at a changed path that is not a read of its
 * bytes.
 *
 * The bytes `normaliseBuild` keeps are read by `readOneDescriptor` in
 * `specify-capture.ts`: the single-descriptor read `specify` makes of its
 * submitted tests, so there is one implementation of "read a file you do not
 * trust" in this step family rather than two. What remains here is the question
 * that read cannot answer for a path: what is at this name, without following a
 * link? Only a name with nothing at it at all is a deletion the commit must
 * carry. A link, a device, a directory, or a name reached through a link or a
 * non-directory is something the step will not follow, so it is refused, and
 * the reset clears it.
 */

import { lstatSync } from "node:fs";
import path from "node:path";

/** What `entryAt` found at a changed path. */
export type Entry = { kind: "absent" } | { kind: "file" } | { kind: "other"; why: string };

/** The code of a Node fs error, or undefined when the thrown value has none. */
function codeOf(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

/**
 * What is at `rel` in `wt`, read with `lstat` at every step so no link is ever
 * followed. Every ancestor is checked first: a missing one means the path is
 * genuinely absent; a link or a non-directory in the way means the path is
 * NOT known to be absent, so it is `other`, never a deletion to apply through
 * that link.
 */
export function entryAt(wt: string, rel: string): Entry {
  const segments = rel.split("/");
  let dir = wt;
  for (const seg of segments.slice(0, -1)) {
    dir = path.join(dir, seg);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if (codeOf(err) === "ENOENT") return { kind: "absent" };
      return { kind: "other", why: `could not be read: ${(err as Error).message}` };
    }
    if (st.isSymbolicLink()) return { kind: "other", why: "is reached through a symbolic link" };
    if (!st.isDirectory()) return { kind: "other", why: "has a non-directory ancestor" };
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path.join(wt, rel));
  } catch (err) {
    if (codeOf(err) === "ENOENT") return { kind: "absent" };
    return { kind: "other", why: `could not be read: ${(err as Error).message}` };
  }
  if (st.isFile()) return { kind: "file" };
  if (st.isSymbolicLink()) return { kind: "other", why: "is a symbolic link" };
  if (st.isDirectory()) return { kind: "other", why: "is a directory" };
  return { kind: "other", why: "is not a regular file" };
}
