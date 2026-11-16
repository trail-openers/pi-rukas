/**
 * work-driver-verify-develop-provenance-root — the ONE host-file read the data-provenance gate
 * makes, behind one named seam.
 *
 * The gate's own claim is about a commit, and it makes it with git. But a measurement record
 * legitimately cites a file the project does not track — a run directory under `$HOME/results`,
 * a benchmark tree outside the checkout — and #2295 makes an operator able to say so once, in
 * the environment, rather than have every prose claim in the record disclosed forever. The
 * operator declares that root with `PI_ENSEMBLE_VERIFY_PROVENANCE_ROOT`; this module is the only
 * code that reads it and the only code that touches the filesystem for the gate.
 *
 * That separation is the point. The gate module is git and verdicts and stays free of `node:fs`
 * and `node:path`, so a reviewer checking "this gate cannot read the host" checks one file, and a
 * test that wants a host-root answer injects one function rather than a filesystem. It is also
 * why this is NOT `lean/specify-path.ts`'s `fileProblem`: that helper is rooted at a WORKTREE and
 * requires `nlink === 1`, and the declared root is not a worktree — it is a directory the operator
 * pointed at, whose files arrive by whatever means the project has. Reusing it would either
 * refuse hard links the gate has no basis to refuse or widen a lean boundary that other steps
 * depend on.
 *
 * The three checks a claim has to pass, and the one thing that is deliberately NOT a check:
 *
 *   - the root itself resolves, is a directory, and can be read;
 *   - the named thing is a REGULAR file as `lstat` sees it — not a symlink (a link whose target
 *     lives outside the root is the host answering for the root, which is the escape this seam
 *     exists to close), not a directory, not a fifo;
 *   - its `realpath` stays inside the root's own `realpath`, so no linked parent component walks
 *     out of the declared tree.
 *
 * `nlink` is NOT required — a file the project copied into its run directory is the record's
 * source just as much as one it wrote.
 *
 * A root that is unset, not absolute, missing, or unreadable answers `unusable` with a reason, and
 * a gate whose host-root probe could not answer has no verdict to give: it says it could not tell.
 * It never answers "absent" from a root it could not read, and it never answers "present".
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { isFullCommitSha } from "./commit-sha.ts";

/** The escape hatch's name. Read at call time by {@link declaredProvenanceRoot}, like every other
 * develop-gate switch, so a process that inherited a stale value can be corrected by the caller. */
export const VERIFY_PROVENANCE_ROOT_ENV = "PI_ENSEMBLE_VERIFY_PROVENANCE_ROOT";

/** How far below the declared root a claimed file may sit. A results tree one is expected to
 * reach; an unbounded walk would let one token turn into a filesystem traversal of the host and
 * make the cost of the gate the size of the operator's disk. */
export const PROVENANCE_ROOT_MAX_DEPTH = 6;

/** What the caller asked for, before any filesystem read. */
export type DeclaredRoot =
  | { kind: "unset" }
  | { kind: "usable"; raw: string }
  | { kind: "invalid"; raw: string; why: string };

/** The declared root as the environment holds it. Absolute or nothing: a relative root means a
 * different directory per worktree, and a gate that judged one record against six directories
 * could not say which one its verdict came from. */
export function declaredProvenanceRoot(env: NodeJS.ProcessEnv = process.env): DeclaredRoot {
  const raw = env[VERIFY_PROVENANCE_ROOT_ENV];
  if (raw === undefined || raw.trim() === "") return { kind: "unset" };
  if (!path.isAbsolute(raw)) {
    return { kind: "invalid", raw, why: "it is not an absolute path" };
  }
  return { kind: "usable", raw };
}

/** One host-root probe's answer. `unusable` is not a verdict about the file — it is the gate
 * saying it could not look, and the caller must not turn it into either outcome. */
export type HostRootVerdict =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "unusable"; why: string };

/** The seam {@link checkWorktreeProvenance} takes: given one fragment extracted from a record,
 * say whether the declared root holds it. A test injects one; production passes
 * {@link probeHostRoot}. */
export type HostRootProbe = (fragment: string) => Promise<HostRootVerdict> | HostRootVerdict;

/** Why a declared root cannot be asked anything, or undefined when it can. */
function rootProblem(raw: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(raw);
  } catch (err) {
    return `the declared root \`${raw.slice(0, 120)}\` could not be resolved (${(err as Error)?.message?.slice(0, 80) ?? "unreadable"})`;
  }
  try {
    if (!lstatSync(real).isDirectory())
      return `the declared root \`${raw.slice(0, 120)}\` is not a directory`;
  } catch (err) {
    return `the declared root \`${raw.slice(0, 120)}\` could not be read (${(err as Error)?.message?.slice(0, 80) ?? "unreadable"})`;
  }
  return undefined;
}

/** Is `rel` safe to resolve under the root at all? The fragment came from a record a develop
 * child wrote, so traversal and an absolute re-spelling are refused here as well as by the
 * classifier — defence in depth against a fragment that reached this function by a path the
 * classifier did not approve. */
function relProblem(rel: string): boolean {
  if (rel === "" || path.isAbsolute(rel)) return true;
  return rel.split(/[\\/]+/).some((seg) => seg === "" || seg === "..");
}

/** The basename of a fragment, in the spelling the record used. */
function basenameOf(fragment: string): string {
  const parts = fragment.split(/[\\/]+/);
  return parts[parts.length - 1] ?? fragment;
}

/**
 * Does the declared root hold this fragment as a regular file?
 *
 * Two shapes, because the two candidate kinds claim different things. A fragment that carries a
 * `/` claims a path, so it is looked for at exactly `<root>/<path>`. A bare basename claims only
 * that a file of that name was read, so it is looked for anywhere below the root within
 * {@link PROVENANCE_ROOT_MAX_DEPTH} — the same asymmetry the commit probe applies, where a bare
 * name is answered by a tree-wide basename match.
 *
 * Everything that is not an executed answer is `unusable`, including a root that turned out to be
 * unreadable between the check and the read: the caller writes a could-not-tell note, and the
 * record's claim stays unjudged rather than becoming a failure invented by the environment.
 */
export function probeHostRoot(raw: string, fragment: string): HostRootVerdict {
  const broken = rootProblem(raw);
  if (broken !== undefined) return { kind: "unusable", why: broken };
  let real: string;
  try {
    real = realpathSync(raw);
  } catch (err) {
    return {
      kind: "unusable",
      why: `the declared root \`${raw.slice(0, 120)}\` could not be resolved (${(err as Error)?.message?.slice(0, 80) ?? "unreadable"})`,
    };
  }
  if (fragment.includes("/")) {
    if (relProblem(fragment)) return { kind: "absent" };
    return regularInside(real, fragment) ? { kind: "present" } : { kind: "absent" };
  }
  const name = basenameOf(fragment);
  if (relProblem(name) || name === "") return { kind: "absent" };
  for (const candidate of walkFor(real, name, PROVENANCE_ROOT_MAX_DEPTH)) {
    if (regularInside(real, candidate)) return { kind: "present" };
  }
  return { kind: "absent" };
}

/** Is `<root>/<rel>` a regular file whose realpath stayed inside `real`? */
function regularInside(real: string, rel: string): boolean {
  const abs = path.join(real, rel);
  try {
    const st = lstatSync(abs);
    // `lstat`, so a symlink is a symlink. Following one would let a single link in the operator's
    // run directory answer for any file on the host, which is the whole escape this check exists
    // to refuse — and `isFile()` on the followed target would report a regular file for it.
    if (!st.isFile() || st.isSymbolicLink()) return false;
    const realFile = realpathSync(abs);
    return realFile === real || realFile.startsWith(real + path.sep);
  } catch {
    return false;
  }
}

/** The repo-relative paths under `real` whose basename is `name`, to `depth` levels. Directory
 * symlinks are not descended: descending one is following the operator's tree out of itself. */
function* walkFor(real: string, name: string, depth: number): Generator<string> {
  if (depth < 1) return;
  let entries: string[];
  try {
    entries = readdirSync(real);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "." || entry === ".." || entry === "node_modules" || entry === ".git") continue;
    if (entry === name) yield entry;
    if (depth <= 1) continue;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path.join(real, entry));
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    for (const inner of walkFor(path.join(real, entry), name, depth - 1)) {
      yield `${entry}/${inner}`;
    }
  }
}
