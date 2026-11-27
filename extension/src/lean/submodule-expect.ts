/**
 * lean/submodule-expect — one file the seeded submodule's recorded commit holds, so the reset
 * can look for it afterwards.
 *
 * The disclosure this feeds is the one job the seeding cannot fake: a `submodule update` that exits 0 having
 * copied nothing is how a run ends “initialised” with a test collecting zero files. The reset gets a path to
 * look for and asks the tree, not the command, whether it appeared.
 *
 * TWO inventories of the same recorded commit, in two repositories — the pair is the point. The superproject's
 * MODULE STORE answers whether the commit has content at all; the checkout alone cannot, since it is filled
 * FROM that store, so a source emptied by whoever cleaned the host answers “nothing” and the disclosure whose
 * job is catching an empty clone goes silent. The SOURCE this step named answers again from the bytes the
 * checkout was built out of; requiring both keeps either from vouching for the other.
 *
 * A repo that cannot answer, or a commit with no files, yields `undefined` and the reset checks nothing: an
 * absent expectation is never a defect. Both reads are `--no-optional-locks` — a probe taking an index lock
 * could fail a concurrent git in a tree this step does not own.
 */
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import type { SubmoduleEntry } from "./submodule-entries.ts";
import { ask } from "./submodule-reads.ts";

/**
 * One file the submodule's recorded commit holds, for the reset to look for afterwards.
 *
 * `git ls-tree -r <sha>` is git's own inventory of the commit, asked twice over and read for its TYPES, not
 * just names — a name cannot tell a file from a directory. See {@link firstBlob}.
 */
export async function firstTrackedFile(
  exec: ExecFn,
  wt: string,
  entry: SubmoduleEntry,
  source: string,
): Promise<string | undefined> {
  const sha = await recordedGitlink(exec, wt, entry.path);
  if (sha === undefined) return undefined;
  const listing = (dir: string) =>
    ask(exec, dir, [...NO_HOOKS, "--no-optional-locks", "ls-tree", "-r", "-t", sha]);
  const first = firstBlob(await listing(source));
  if (first === undefined) return undefined;
  // The checkout the pass just filled, asked about the commit the superproject RECORDS — not its own HEAD,
  // which is the pass's own claim. The disclosure is built on this read, so ask the tree, not the source.
  return firstBlob(await listing(path.join(wt, entry.path))) === undefined ? undefined : first;
}

/**
 * The first BLOB in an `ls-tree -r -t` answer, or `undefined` for none.
 *
 * Blobs only — the whole reason this reads `<mode> <type> <sha>\t<path>` rather than `--name-only`: `-t` lists
 * a directory's own entry before those under it, so the first name under `dir/` is `dir` itself, and an
 * expectation from a tree line makes the reset flag a good submodule as an empty checkout. The type field
 * separates file from directory; a nested gitlink (`commit`) is nothing the depth rule populates.
 *
 * A name that is absolute, parent-escaping or `.` refuses the whole listing rather than being skipped: a path
 * this step cannot join onto a tree means its reading of the commit is untrustworthy, and checking nothing is
 * the honest answer.
 */
function firstBlob(listed: { stdout?: string } | undefined): string | undefined {
  if (listed === undefined) return undefined;
  for (const line of listed.stdout?.split("\n") ?? []) {
    const entry = line.trim();
    if (entry === "") continue;
    const [meta, name] = entry.split("\t");
    if (name === undefined || name === "") continue;
    if (name === "." || path.isAbsolute(name) || name.startsWith("../")) return undefined;
    // `<mode> <type> <sha>`; anything git did not call a blob is not a file to look for, and a line of a
    // shape this step does not recognise is skipped rather than guessed at.
    if (meta?.split(/\s+/)?.[1] !== "blob") continue;
    return name;
  }
  return undefined;
}

/** The sha the superproject's commit records for `sub`, or `undefined` when it records none. */
async function recordedGitlink(exec: ExecFn, wt: string, sub: string): Promise<string | undefined> {
  const hit = await ask(exec, wt, [...NO_HOOKS, "ls-tree", "HEAD", "--", sub]);
  if (hit === undefined) return undefined;
  // `<mode> commit <sha>\t<path>` — the sha is the third field of the first token.
  const head = (hit.stdout ?? "").split("\n")[0] ?? "";
  const sha = head.split("\t")[0]?.split(/\s+/)?.[2] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}
