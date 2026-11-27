/**
 * oracle-repair-capture — the ONLY read of the repair seat's submitted bytes.
 *
 * The specify step keeps exactly one thing from its child, and this round is the same shape: hold the
 * submitted files in memory, and judge those bytes, so a name the child swapped after the boundary read
 * cannot be judged as other than what it was. `readOneDescriptor` is the specify capture's own reader — one
 * descriptor, `O_NOFOLLOW`, `nlink === 1`, stable across the read — so the link and swap rules are not a
 * second rulebook but the rules the run already applies to any test file it might freeze.
 *
 * A file that fails any of it is not a verdict, it is a refusal of the whole round: a repair that could not
 * be read is a repair nobody judged.
 */
import { MAX_TEST_BYTES } from "./lean/test-size.ts";
import { readOneDescriptor } from "./lean/specify-capture.ts";

/** What the round captured, or the one reason it captured nothing. */
export interface CapturedSubmission {
  bytes: Array<{ path: string; bytes: Buffer }>;
  refused?: string;
}

/** Read every submitted path's bytes, or refuse the round with the first reader's reason. */
export function readRepairSubmission(wt: string, paths: readonly string[]): CapturedSubmission {
  if (paths.length === 0) return { bytes: [], refused: "the repair submitted no test file" };
  const bytes: Array<{ path: string; bytes: Buffer }> = [];
  for (const rel of paths) {
    const one = readOneDescriptor(joinUnder(wt, rel));
    if ("why" in one) return { bytes: [], refused: `${rel}: ${one.why}` };
    if (one.bytes.length === 0) return { bytes: [], refused: `${rel}: the submitted file is empty` };
    if (one.bytes.length > MAX_TEST_BYTES)
      return { bytes: [], refused: `${rel}: the submitted file is over the test size cap` };
    bytes.push({ path: rel, bytes: one.bytes });
  }
  return { bytes };
}

/** Join a repo-relative path under a tree, refusing one that escapes it. */
function joinUnder(wt: string, rel: string): string {
  const abs = `${wt}/${rel}`;
  // The boundary rule is `specify`'s own (`frozenKeyProblem` on the record, `pathProblem` at capture); this
  // is the last gate before a read of the filesystem, so the escape check is spelled here rather than
  // assumed from a name a caller normalised.
  if (rel.startsWith("/") || rel.startsWith("\\") || rel.includes(".."))
    return `\0refuse-${rel}`;
  return abs;
}
