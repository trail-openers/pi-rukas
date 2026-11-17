/**
 * lean/submodule-expect — one file the seeded submodule's recorded commit holds, so the reset
 * can look for it afterwards.
 *
 * The disclosure this feeds is the one job the seeding cannot fake: a `submodule update` that
 * exits 0 having copied nothing is how the field report ended with a run “initialised” and a
 * test collecting zero files. So the reset gets a path to look for and asks the tree, not the
 * command, whether it appeared.
 *
 * TWO inventories of the same recorded commit, in two repositories, and the pair is the
 * point. The superproject's MODULE STORE answers whether the commit has content at all — of
 * the checkout alone it cannot, since the checkout is filled FROM that store, so a source
 * emptied by whoever cleaned the host answers “nothing”, the expectation comes back empty,
 * and the disclosure whose job is to catch a clone that filled nothing goes silent for the
 * case it exists for. The SOURCE this step named answers it again from the bytes the checkout
 * was built out of; requiring both keeps either from vouching for the other.
 *
 * A repo that cannot answer, or a commit holding no files, yields `undefined` and the reset
 * checks nothing: an absent expectation is never a defect, so this read cannot become a way to
 * fail a submodule for its content. Both reads are `--no-optional-locks` — a probe taking an
 * index lock could fail a concurrent git in a tree this step does not own.
 */

import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import type { SubmoduleEntry } from "./submodule-entries.ts";
import { ask } from "./submodule-reads.ts";

/**
 * One file the submodule's recorded commit holds, for the reset to look for afterwards.
 *
 * `git ls-tree -r <sha>` is git's own inventory of the commit, asked twice over — and read for its
 * TYPES, not just its names, because a name alone cannot tell a file from a directory. See
 * {@link firstBlob}.
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
  // The checkout the pass just filled, asked about the commit the superproject RECORDS (not
  // its own HEAD, which is the pass's own claim about where it landed). This is the read the
  // disclosure is built on, so it is asked of the tree rather than of the source.
  return firstBlob(await listing(path.join(wt, entry.path))) === undefined ? undefined : first;
}

/**
 * The first BLOB in an `ls-tree -r -t` answer, or `undefined` for none.
 *
 * Blobs only, which is the whole reason this reader reads `<mode> <type> <sha>\t<path>` rather
 * than `--name-only`: `-t` lists a directory's own entry before the entries under it, so the first
 * name under `dir/` is `dir` itself. A checkout never holds `dir` as a file, so an expectation
 * taken from a tree line makes the reset flag a perfectly good seeded submodule as an empty
 * checkout — the disclosure accusing a submodule that did arrive. `--name-only` cannot answer the
 * question at all; the type field is what separates a file from a directory, and a nested gitlink
 * (`commit`) is likewise not something this step's depth rule ever populates.
 *
 * A name that is absolute, parent-escaping or `.` refuses the whole listing rather than being
 * skipped: a path this step cannot join onto a tree means its reading of the commit is not
 * trustworthy, and checking nothing is the honest answer, not a warning.
 */
function firstBlob(listed: { stdout?: string } | undefined): string | undefined {
  if (listed === undefined) return undefined;
  for (const line of listed.stdout?.split("\n") ?? []) {
    const entry = line.trim();
    if (entry === "") continue;
    const [meta, name] = entry.split("\t");
    if (name === undefined || name === "") continue;
    if (name === "." || path.isAbsolute(name) || name.startsWith("../")) return undefined;
    // `<mode> <type> <sha>`; anything git did not call a blob is not a file to look for, and a
    // line of a shape this step does not recognise is skipped rather than guessed at.
    if (meta?.split(/\s+/)?.[1] !== "blob") continue;
    return name;
  }
  return undefined;
}

/** The sha the superproject's commit records for `sub`, or `undefined` when it records none. */
async function recordedGitlink(exec: ExecFn, wt: string, sub: string): Promise<string | undefined> {
  const hit = await ask(exec, wt, [...NO_HOOKS, "ls-tree", "HEAD", "--", sub]);
  if (hit === undefined) return undefined;
  // `<mode> commit <sha>\t<path>` — the sha is the second field of the first token.
  const head = (hit.stdout ?? "").split("\n")[0] ?? "";
  const sha = head.split("\t")[0]?.split(/\s+/)?.[2] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}
