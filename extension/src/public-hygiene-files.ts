/**
 * public-hygiene-files — reading the publish text an agent named by PATH
 * (#1788 round 1), split out of `public-hygiene-scan.ts` along the seam
 * AGENTS.md §12 asks for (the scan decides what a command publishes; this
 * decides what a named file is allowed to say, and what it may not).
 *
 * ## The invariant: an unreadable file never reads as clean
 *
 * Every failure arm returns a `problem`, never `undefined` with no text. The
 * scan's rule is that a publish it could not read is a publish it refuses
 * (PM: "an unchecked publish has never counted as a clean one"), so a `return`
 * that meant "skip this flag" would have been the exact hole: `--body-file
 * /etc/shadow` reading as clean because the read threw.
 *
 * ## The admissible-root test comes BEFORE anything is opened
 *
 * Reading first and checking after would decide by CONTENT which files this
 * guard is allowed to read: a file outside the cwd tree and the temp dir that
 * happened to carry a denylist term was reported as a hit, and its refusal
 * named the term's line number. That is a confirmation that the private string
 * occurs at that path — in a directory the guard had just said it would not
 * read. So the roots question is answered on the PATH alone, whatever — and
 * whoever — is inside, and a path that does not resolve is still a path for
 * that question. See `public-hygiene-cwd.ts` for which roots are admissible.
 *
 * ## What a refusal may say about a path it will not open
 *
 * Only `OUTSIDE_ROOTS`. Not the path, not its basename, not its parent
 * directory: a path is frequently itself the private information (the operator's
 * home layout, a customer directory), and the location the refusal carries is
 * already the flag that named it, which is enough to act on.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { admissibleRoots, within } from "./public-hygiene-cwd.ts";
import type { ScanProblem } from "./public-hygiene-types.ts";

/** A body file this large is not a body. */
export const MAX_BODY_FILE_BYTES = 1024 * 1024;

/** What a refusal may say about a path it will not open — and the only thing it may say. */
export const OUTSIDE_ROOTS =
  "names a file outside this directory tree, the system temp dir and the repository";

/** An exec/fs error's `code`, for a refusal that names why without quoting content. */
export function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

/**
 * Read a file the agent named, if it may be read. `undefined` means "no
 * problem, nothing to scan" is NOT an option here — a refusal reason is
 * returned instead, so an unreadable file never reads as clean.
 */
export function readPublishFile(
  file: string,
  cwd: string,
  location: string,
): { text?: string; problem?: ScanProblem } {
  if (file === "") return { problem: { location, reason: "named an empty file" } };
  const abs = path.resolve(cwd, file);
  const roots = admissibleRoots(cwd);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    // A path that does not resolve is still a path, and the roots question is
    // answerable for it: an unreadable file under an admissible root is a
    // problem the agent can fix, so it is reported where it was named.
    if (!roots.some((root) => within(root, path.resolve(abs)))) {
      return { problem: { location, reason: OUTSIDE_ROOTS } };
    }
    return { problem: { location, reason: `could not read the named file (${codeOf(err)})` } };
  }
  if (!roots.some((root) => within(root, real))) {
    return { problem: { location, reason: OUTSIDE_ROOTS } };
  }
  let size: number;
  try {
    size = statSync(real).size;
  } catch (err) {
    return { problem: { location, reason: `could not read the named file (${codeOf(err)})` } };
  }
  if (size > MAX_BODY_FILE_BYTES) {
    return {
      problem: {
        location,
        reason: `names a file larger than ${MAX_BODY_FILE_BYTES} bytes`,
      },
    };
  }
  try {
    return { text: readFileSync(real, "utf8") };
  } catch (err) {
    return { problem: { location, reason: `could not read the named file (${codeOf(err)})` } };
  }
}

/** `@file` and `file=@path` are gh api's ways of taking a field from a file. */
export function apiFileOperand(v: string): string | undefined {
  if (!v.startsWith("@")) return undefined;
  return v.slice(1);
}
