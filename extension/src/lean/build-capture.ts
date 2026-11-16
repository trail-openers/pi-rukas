/**
 * lean/build-capture — the one look at a changed path that is not a read of its
 * bytes.
 *
 * The bytes themselves come from `readOneDescriptor` in `specify-capture.ts`, so
 * "read a file you do not trust" has one implementation in this step family.
 * What remains here is what that read cannot answer: what is at this name,
 * without following a link? Only a name with nothing at it at all is a deletion
 * the commit must carry. A link, device, directory, or a name reached through a
 * link or non-directory is refused, and the reset clears it.
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
 * followed. A missing ancestor means the path is genuinely absent; a link or
 * non-directory in the way is `other`, never a deletion to apply through it.
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
