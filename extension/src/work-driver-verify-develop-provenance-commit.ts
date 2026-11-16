/**
 * work-driver-verify-develop-provenance-commit — the pinned-commit reads the data-provenance
 * gate answers a candidate against, split out of `work-driver-verify-develop-provenance.ts`
 * along the seam between *reading a commit* and *classifying a claim*.
 *
 * The gate module's job is the walk and the verdicts: which candidate under which key, host
 * context first, what to fail and what to disclose. This module's job is one git read of the
 * pinned commit — a blob, an exact-path entry, or the whole-tree listing a bare basename is
 * answered from — and it has exactly one rule to get right: an executed `absent` is a verdict and
 * any git fault is `unreadable`, never `absent`. A reader checking that a failed read cannot
 * invent a failure should not have to hold the walk beside it.
 *
 * The tree listing is read at most once per workstream and cached behind {@link TreePaths}, so a
 * record citing a dozen file names pays one full-tree walk, not a dozen — and a listing past its
 * ceiling fails closed to `unreadable` rather than a truncated listing that then reports absence.
 *
 * Leaf by policy: imports the commit-sha guard, the lean existence read, and the trace sink, so
 * widening the gate's dependency graph is not possible through this file.
 */

import { isFullCommitSha } from "./commit-sha.ts";
import { existsInCommit } from "./lean/specify-path.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  PROVENANCE_FILE_MAX_BYTES,
  PROVENANCE_GIT_TIMEOUT_MS,
} from "./work-driver-verify-develop-provenance-limits.ts";

/** The kinds of read a token probe can decline, kept distinct from "absent". */
export type ProbeVerdict = "present" | "absent" | "unreadable";

/** Byte ceiling on the whole-tree listing a bare-basename probe is answered from. Generous
 * against a real repository's path list (a path name costs a fraction of the file it names, so
 * this holds far more entries than the file ceiling holds bytes) and small enough that the read
 * is bounded work rather than an unbounded walk of an enormous tree. */
export const PROVENANCE_TREE_MAX_BYTES = 8 * 1024 * 1024;

/** The pinned tree's paths, read once per workstream and cached by the caller — the read a
 * bare-basename probe is answered from.
 *
 * A bare basename claims only that a file of that name was read; answering it with a pathspec
 * would be wrong, because git filters a `ls-tree <ref> -- <pathspec>` from the tree root and a
 * name that lives under `deep/nested/` matches nothing. So a basename claim is answered by a
 * tree-wide listing, and a listing is read ONCE (the caller caches it behind {@link TreePaths}):
 * the alternative is one recursive `ls-tree` per candidate, and a record citing a dozen file
 * names would buy a dozen full-tree walks.
 *
 * The cost ceiling fails closed toward disclosure. A tree whose entry bytes exceed it is not
 * partially listed and not silently truncated: the read says it could not tell and the caller
 * turns that into a could-not-tell note. A listing that stopped halfway and then reported absence
 * would fail a record for a file the gate never looked at.
 */
export async function readTreePaths(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
): Promise<{ ok: true; paths: Set<string> } | { ok: false; why: string }> {
  if (!isFullCommitSha(oid))
    return { ok: false, why: `\`${oid.slice(0, 20)}\` is not a full commit sha` };
  try {
    const ran = await execFn("git", {
      argv: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        "--name-only",
        "--end-of-options",
        oid,
      ],
      cwd,
      timeout: PROVENANCE_GIT_TIMEOUT_MS,
      maxBuffer: PROVENANCE_TREE_MAX_BYTES,
    });
    const stdout = ran.stdout ?? "";
    if (Buffer.byteLength(stdout, "utf8") >= PROVENANCE_TREE_MAX_BYTES) {
      return {
        ok: false,
        why: `the tree listing exceeds the ${PROVENANCE_TREE_MAX_BYTES}-byte ceiling this gate reads`,
      };
    }
    const paths = new Set<string>();
    for (const entry of stdout.split("\0")) {
      if (entry !== "") paths.add(entry);
    }
    return { ok: true, paths };
  } catch (err) {
    return {
      ok: false,
      why: `the tree listing could not be read (${(err as Error).message?.slice(0, 100)})`,
    };
  }
}

/** The caller's cached tree-listing read. A function, not a value, so the read is lazy — a pass
 * whose every candidate names a path never asks for the listing at all. */
export type TreePaths = () => Promise<
  { ok: true; paths: Set<string> } | { ok: false; why: string }
>;

/** Read one added file at the pinned commit. Absence of the blob is unreadable, not empty. */
export async function readAddedFile(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
  file: string,
): Promise<{ ok: true; content: string } | { ok: false; why: string }> {
  try {
    const ran = await execFn("git", {
      argv: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "show",
        "--end-of-options",
        `${oid}:${file}`,
      ],
      cwd,
      timeout: PROVENANCE_GIT_TIMEOUT_MS,
      maxBuffer: PROVENANCE_FILE_MAX_BYTES + 64 * 1024,
    });
    return { ok: true, content: ran.stdout ?? "" };
  } catch (err) {
    return {
      ok: false,
      why: `could not read the committed blob (${(err as Error).message?.slice(0, 100)})`,
    };
  }
}

async function probeToken(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
  probe: string,
): Promise<ProbeVerdict> {
  try {
    return (await existsInCommit(execFn, cwd, oid, probe)) ? "present" : "absent";
  } catch (err) {
    trace(`provenance: probe failed for ${probe.slice(0, 80)}: ${(err as Error).message}`);
    return "unreadable";
  }
}

/** Does any path in this listing carry `name` as its final component? Component-wise, so
 * `out.ndjson` is named by `deep/nested/out.ndjson` and NOT by `deep/nested/xout.ndjson`. Exported
 * as the predicate and used through {@link basenameMatch}: the whole-tree listing is read once and
 * then tested per candidate, and a reviewer checking "can a substring ever satisfy a claim" should
 * read this one line rather than hunt for a `Set.has` that would have been both faster and wrong
 * about paths at depth. */
export function basenameNames(paths: ReadonlySet<string>, name: string): boolean {
  return basenameMatch(paths, name) !== undefined;
}

/** The first path in this listing whose final component is exactly `name`, or undefined when no
 * path is. Compared component-wise, so `out.ndjson` is named by `deep/nested/out.ndjson` and not
 * by `deep/nested/xout.ndjson`. The matched path is RETURNED rather than reduced to a boolean:
 * the caller discloses it, because a bare claim satisfied at some unrelated depth is a weaker
 * answer than one satisfied at the path the record spelled out, and a reviewer has to be able to
 * see which of the two the green rests on. */
function basenameMatch(paths: ReadonlySet<string>, name: string): string | undefined {
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (base === name) return p;
  }
  return undefined;
}

/**
 * How one candidate is looked for in the pinned commit.
 *
 * A candidate that spells a directory out claims a PATH and is answered by the exact-path read.
 * A candidate with no directory component claims only that a file of that name was read — which
 * is how a measurement record cites its own results file (`out.ndjson`, `summary.json`) — and is
 * answered from the pass's cached tree listing. The two are not interchangeable: an exact-path
 * probe of a name that lives under `deep/nested/` reports absence, and failing a record for a
 * directory it never named would be the gate inventing a requirement. The basename arm is gated
 * on the caller's `basenameArm` flag (the prose switch) so the v0.14.85 off arm asks exactly the
 * reads it shipped with; a bare name's claim is the same with or without a split, but the off
 * arm's byte-identity requires the shipped exact-path read for it.
 *
 * `via` carries the tree path that satisfied a BARE-name claim, so the caller can disclose that
 * the commit answered the claim at a path other than the one the record named. It is `undefined`
 * for every exact-path answer — including a bare claim under `basenameArm: false`, which is
 * answered exactly, by a read that cannot say where in the tree it matched. It is the gate's
 * out-channel, so it is a parameter rather than something this module reports itself: this file
 * judges a candidate, it does not own the PR body.
 */
export async function probeCandidate(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  cwd: string,
  oid: string,
  probe: string,
  treePaths: TreePaths,
  basenameArm: boolean,
  onBasenameMatch?: (path: string) => void,
): Promise<ProbeVerdict> {
  if (probe.includes("/") || !basenameArm) return await probeToken(execFn, cwd, oid, probe);
  const tree = await treePaths();
  if (!tree.ok) return "unreadable";
  const matched = basenameMatch(tree.paths, probe);
  if (matched === undefined) return "absent";
  // Only the tree read can name a path, so only it reports one. `onBasenameMatch` is a void
  // return: a caller that passed no sink is not receiving the disclosure, which is the off arm's
  // byte identity, and the judgement it drives is unchanged either way.
  onBasenameMatch?.(matched);
  return "present";
}
