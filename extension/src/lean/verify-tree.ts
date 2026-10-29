/**
 * lean/verify-tree — the tree reads behind the `command` criteria tier.
 *
 * A `command` criterion claims behaviour that already held before this run began,
 * so the only file that can evidence it is one the run's base commit already
 * held, byte for byte — and there are THREE places those bytes can differ: the
 * base commit, HEAD, and the working file the runner is about to load. This module
 * is the only place those three reads are expressed, so the tier that judges
 * preservation and the re-check that audits it after the runs cannot drift into
 * asking different questions of the same file.
 *
 * Every refusal here is a *reason*, never a verdict: a criterion the tree refuses
 * is treated like `manual` by the caller — absent from the record, its reason
 * carried to the PR body. An "unreadable" arm is different and deliberately not a
 * string: "could not tell" must never read as "the test is not there", because the
 * first is a machine to re-run and the second is an issue to fix, and collapsing
 * them sends an operator to rewrite a spec that was never the problem.
 */

import { NO_HOOKS } from "./specify-reset.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/** A git blob oid, the only form whose equality means anything. */
const BLOB_OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** What one `ls-tree` line said about the entry that was asked for. */
export type TreeEntry =
  | { kind: "file"; oid: string }
  | { kind: "refuse"; reason: string }
  | { kind: "unreadable" };

/** The two failure arms carry different weights, so both narrows say so once. */
export function entryRefusal(entry: TreeEntry): string {
  return entry.kind === "refuse" ? entry.reason : "";
}

export function entryUnreadable(entry: TreeEntry): boolean {
  return entry.kind === "unreadable";
}

/**
 * One `git ls-tree <ref> -- <rel>` in argv form, with the same hook and fsmonitor
 * guard every other lean git read carries.
 *
 * `-- <rel>` is what makes this a path question rather than a revision question:
 * without the separator a `rel` that also names a ref would answer a different
 * query. An empty string is git answering "this tree holds no such entry" — which
 * is NOT the same fact as a git that refused, and the two are kept apart by
 * throwing for the refusal rather than returning something the caller has to
 * distinguish. Collapsing them would let a broken git read look like an absent
 * test.
 *
 * git's own words travel with the refusal: an operator chasing "the test is not
 * there" needs to see whether git said `not a tree`, `bad object` or nothing, and
 * dropping them would send that operator looking in the wrong tree.
 */
export async function treeEntry(
  exec: VerifyExec,
  wt: string,
  ref: string,
  rel: string,
): Promise<string> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "ls-tree", ref, "--", rel],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not read the tree entry for ${rel} at ${ref} in ${wt}: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  return (r.stdout ?? "").trim();
}

/**
 * The ONE parser for a `git ls-tree <ref> -- <rel>` line.
 *
 * git prints `<mode> <type> <oid>\t<path>`, so the fields are read from the text
 * BEFORE the TAB and the path from after it — splitting the whole line on `/\s+/`
 * would read `"…\tmy script.sh"` as several fields and call a legal entry "not an
 * exact path". The MODE is what decides what the entry is: git prints `blob` for a
 * symlink too, so reading the type alone lets a mode-120000 link through, which is
 * exactly the shape a plain existence probe used to execute. A line this cannot
 * read at all is `unreadable` — a machine to re-run, never a verdict about
 * somebody's test.
 */
export function parseTreeLine(line: string, rel: string): TreeEntry {
  const tab = line.indexOf("\t");
  if (tab < 0) return { kind: "unreadable" };
  const meta = line.slice(0, tab).split(/\s+/);
  const path = line.slice(tab + 1);
  const mode = meta[0] ?? "";
  const type = meta[1] ?? "";
  const oid = meta[2] ?? "";
  if (path !== rel) return { kind: "refuse", reason: `${rel} is not an exact path in the tree` };
  if (meta.length !== 3) return { kind: "unreadable" };
  if (mode === "120000") return { kind: "refuse", reason: `${rel} is a symlink` };
  if (mode === "160000") return { kind: "refuse", reason: `${rel} is a submodule` };
  if (mode !== "100644" && mode !== "100755")
    return { kind: "refuse", reason: `${rel} is not a regular file (mode ${mode})` };
  if (type !== "blob" || !BLOB_OID.test(oid)) return { kind: "unreadable" };
  return { kind: "file", oid };
}

/** Why a tree line git should have printed is infrastructure, not a missing test. */
export function unreadableEntry(rel: string, wt: string): VerifyInfraError {
  return new VerifyInfraError(`could not read the tree entry for ${rel} in ${wt}`);
}

/**
 * The working file's blob oid, or a throw: "could not tell" is never "it differs".
 *
 * `git hash-object` hashes the FILE, not the index, which is the whole point — a
 * tier that trusted `git status` could be shown a file somebody rewrote on disk
 * under `git update-index --assume-unchanged` (a documented way to keep the
 * porcelain quiet about exactly that) and call it the base's own bytes.
 */
export async function workingOid(exec: VerifyExec, wt: string, rel: string): Promise<string> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "hash-object", "--", rel],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not hash the working file ${rel} in ${wt}: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  const oid = (r.stdout ?? "").trim();
  if (!BLOB_OID.test(oid))
    throw new VerifyInfraError(`could not hash the working file ${rel} in ${wt}`);
  return oid;
}
