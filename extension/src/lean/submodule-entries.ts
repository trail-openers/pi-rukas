/**
 * lean/submodule-entries — reading a base's `.gitmodules`, and asking git where its submodule
 * bytes live, without either answer being trusted as a fetch source.
 *
 * Two questions the seeding asks of git before it touches anything, both answered by git
 * rather than by parsing a file:
 *
 *   - WHICH submodules the commit registers (`git config --file .gitmodules --get-regexp
 *     path`). The NAME matters as much as the path: `submodule.<name>` is the section git
 *     reads when an entry is registered or retargeted, so keying on the path would target
 *     nothing while every command exited 0. Exit 1 means the file lists nothing ("none",
 *     ends the pass); above 1 means git could not read it ("could not tell", refuses the
 *     run) — silently skipping an initialisation the base asked for is how a run gets
 *     tested against an empty directory. git's C quoting is undone before anything reaches
 *     an argv, since the name rides on a `-c` and the path on a `git submodule` command.
 *   - WHERE this host holds them: `--git-common-dir` for the shared store,
 *     `--absolute-git-dir` for the tree's own, and the MAIN working tree taken from the
 *     former — never `--show-toplevel`, which inside a linked worktree answers with that
 *     worktree, so the step would seed a submodule from the tree it is populating.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { trim } from "./specify-proof.ts";
import { NO_HOOKS, SpecifyInfraError } from "./specify-reset.ts";

/** The wall clock on the short reads that decide where a submodule comes from. */
const QUICK_GIT_MS = 30_000;

/**
 * One registered submodule: the name `.gitmodules` files it under, its path, and the URL the
 * base records.
 *
 * The URL is read for one purpose — to be handed BACK to git as the value it should look up
 * when retargeting an entry, so the step never invents a `submodule.<name>.url` a later reader
 * could mistake for a source this step chose. It is never a place to fetch from; a seeded
 * submodule's source is always a path of the superproject.
 */
export interface SubmoduleEntry {
  name: string;
  path: string;
  url?: string;
}

/**
 * The registered submodules, in `.gitmodules` order — or `undefined` when the file
 * lists nothing, which is the same as having none and ends the initialisation.
 *
 * `git config --file .gitmodules --get-regexp path` prints `submodule.<name>.path
 * <path>`; the name is what the URL override must be keyed by, since that is the
 * section git reads. Exits 1 on a file that lists nothing and above 1 on a file it
 * could not read, so "could not tell" refuses the run rather than skipping an
 * initialisation it was asked for.
 */
export async function listSubmodules(
  exec: ExecFn,
  wt: string,
): Promise<SubmoduleEntry[] | undefined> {
  const listed = await exec("git", {
    argv: [...NO_HOOKS, "config", "--file", ".gitmodules", "--get-regexp", "path"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (listed as { __err?: unknown })?.__err;
  if (err !== undefined) {
    const code = (err as { code?: unknown }).code;
    // 0 listed nothing, 1 is how `--get-regexp` reports no match; anything above 1 is
    // git failing to read the file — and "could not tell" refuses rather than silently
    // skipping an initialisation the step was asked to perform.
    if (typeof code === "number" && code <= 1) return undefined;
    throw new SpecifyInfraError(
      `could not tell whether ${wt} has submodules: git config --file .gitmodules --get-regexp path exited ${String(code)}`,
    );
  }
  const entries: SubmoduleEntry[] = [];
  for (const line of (listed as { stdout?: string }).stdout?.split("\n") ?? []) {
    // git's own quoting is undone before any of this reaches an argv: `--get-regexp`
    // prints key and value alike in c-style quotes when they contain unusual bytes, and
    // git accepts octal, hex and unicode escapes inside them. The name goes into a `-c`
    // argument and the path into a `git submodule` argument, so the value git MEANT is
    // what has to be handed back, and a token this cannot unquote is the step not
    // understanding its base — the same refusal as a file it could not read.
    const hit = /^(?:"((?:[^"\\]|\\.)*)"|([^\s]+))\.path\s+(.*)$/.exec(line.trim());
    const rawName = hit?.[1] ?? hit?.[2];
    const rawValue = hit?.[3];
    if (rawName === undefined || rawValue === undefined) continue;
    const name = unquoteGitConfig(rawName);
    const value = unquoteGitConfig(rawValue.trim());
    if (name === undefined || value === undefined || value === "")
      throw new SpecifyInfraError(
        `could not read the submodule list of ${wt}: git config --file .gitmodules --get-regexp path printed ${JSON.stringify(line.trim())}`,
      );
    entries.push({ name, path: value, url: await recordedUrl(exec, wt, name) });
  }
  return entries.length === 0 ? undefined : entries;
}

/**
 * Undo the one-level C quoting `git config --get-regexp` applies to a token, or
 * `undefined` when the token is not well-formed quoted text.
 *
 * Deliberately not JSON.parse: git's quoting is C quoting — octal, hex and unicode
 * escapes, and a bare token accepted — and the two languages differ. What this cannot
 * prove it read is reported rather than guessed.
 */
function unquoteGitConfig(token: string): string | undefined {
  if (!token.startsWith('"')) return token;
  if (!token.endsWith('"') || token.length < 2) return undefined;
  const body = token.slice(1, -1);
  let out = "";
  const at = (k: number): string => body[k] ?? "";
  for (let i = 0; i < body.length; i++) {
    const ch = at(i);
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i++;
    const esc = at(i);
    switch (esc) {
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "v":
        out += "\v";
        break;
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "'":
        out += "'";
        break;
      case "?":
        out += "?";
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        // Up to three octal digits, as git's `unquote_c_style` takes them.
        let digits = esc;
        while (digits.length < 3 && at(i + 1) >= "0" && at(i + 1) <= "7") {
          i++;
          digits += at(i);
        }
        out += String.fromCodePoint(Number.parseInt(digits, 8));
        break;
      }
      case "x":
      case "u":
      case "U": {
        const width = esc === "x" ? 2 : esc === "u" ? 4 : 8;
        const hex = body.slice(i + 1, i + 1 + width);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) return undefined;
        i += width;
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        break;
      }
      default:
        return undefined;
    }
  }
  return out;
}

/**
 * The URL `.gitmodules` records for one submodule name, or `undefined` when it names
 * none.
 *
 * Read only to be handed back to git as the value to look up when retargeting the entry
 * (see {@link SubmoduleEntry}); never used as a fetch source.
 */
async function recordedUrl(exec: ExecFn, wt: string, name: string): Promise<string | undefined> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "config", "--file", ".gitmodules", "--get", `submodule.${name}.url`],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 64 * 1024,
  }).catch(() => undefined);
  const value = trim((r as { stdout?: string } | undefined)?.stdout ?? "");
  return value === "" ? undefined : value;
}

/**
 * Where this host holds `sub`, as a source git can clone from.
 *
 * The module store wins over the checkout because it is the complete object store and
 * the checkout may be a tree someone half-cleaned; both are inside the superproject,
 * which is the rule the caller's disclosure rests on.
 */
export function localSource(
  superproject: string,
  gitDirs: string[],
  sub: string,
  run: { wt: string },
): string | undefined {
  const parts = sub.split("/").filter((p) => p !== "" && p !== "." && !path.isAbsolute(p));
  if (parts.length === 0) return undefined;
  // The run's own tree is refused as a source, by its PATH rather than by its git dirs — a
  // seed must come from bytes the OPERATOR'S superproject holds, the ones the base commit's
  // verify ran against, so nothing this run could have written itself counts. Asked of the
  // PATH rather than of `gitDirs`, because a linked worktree's `--git-common-dir` points at
  // the shared store: comparing git dirs there would refuse the shared store for EVERY run
  // whose worktree lives under the superproject, which is the normal layout, and would turn
  // this fix into a rule that makes every submodule absent.
  const refused = [path.resolve(run.wt)];
  for (const dir of refused) {
    if (dir === path.resolve(superproject)) return undefined;
    if (path.resolve(superproject).startsWith(dir + path.sep)) return undefined;
  }
  for (const dir of gitDirs) {
    const store = path.join(dir, "modules", ...parts);
    // `objects` is what makes it a git dir rather than a leftover directory of that
    // name: a store git created and then emptied still has it, and cloning from
    // something that is not a repository is a failure the step did not cause.
    if (existsSync(path.join(store, "objects"))) return store;
  }
  const checkout = path.join(superproject, ...parts);
  if (existsSync(path.join(checkout, ".git")) || existsSync(path.join(checkout, "HEAD")))
    return checkout;
  return undefined;
}

/**
 * The superproject whose bytes to copy: the MAIN working tree, asked of git rather than
 * derived from the caller's path or from `--show-toplevel`.
 *
 * `--show-toplevel` is the wrong question here, and the field bug is the reason: asked inside
 * a linked worktree it answers with THAT worktree, so a step seeding "from the superproject"
 * would actually be seeding from the very tree it is about to populate — a clone of a
 * repository into itself, which ends not in an error but in a checkout that quietly holds
 * nothing. `--git-common-dir` answers with the shared store (which for a linked tree is the
 * superproject's `.git`, not the tree's own), and its parent is the main checkout: the one
 * tree on this host whose submodule content the base commit's verify actually ran against,
 * and the only one no run of this harness can have written.
 *
 * git's own answer is then read for its SHAPE — `<…>/.git`, or `<…>/.git/worktrees/<name>` —
 * and the main checkout is taken from THAT, never from the path the caller handed this step.
 * Counting components off the caller's `wt` is the trap: the run's worktree lives under
 * `<repo>/.worktrees/lean-<issue>`, three deep like a linked tree's gitdir, so an answer
 * derived from it points at `<repo>/.worktrees` — a directory that exists, so an existence
 * check cannot catch it, and which then gets asked to supply the submodule the run is
 * populating. Reading git's shape is what makes a run's own scaffolding unpayable as a
 * source: `rev-parse` answers `<…>/.worktrees/lean-1` (or echoes an unrecognised `--git-*`
 * question back verbatim, which is what a smoke test's recording exec hands it) and neither
 * answer has the shape of a common dir, so the step refuses instead of seeding from a
 * directory nobody populated. The same rule is what lets a case stub git and still exercise
 * this path: a stub answers the question the step asks, and the step answers for anything it
 * cannot recognise.
 */
export async function superprojectRoot(exec: ExecFn, wt: string): Promise<string> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "rev-parse", "--git-common-dir"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 64 * 1024,
  }).catch(() => undefined);
  const raw = trim((r as { stdout?: string } | undefined)?.stdout ?? "");
  const dir = raw === "" ? "" : path.isAbsolute(raw) ? raw : path.resolve(wt, raw);
  // The two shapes git's `--git-common-dir` can answer with, matched as PATHS rather than as
  // substrings: `<repo>/.git` for a normal checkout, and `<repo>/.git/worktrees/<name>` for a
  // LINKED one, whose main checkout therefore sits three components up. Both are asked, and
  // both are decided by git's own answer — a bare repository, a `GIT_DIR` pointed at some
  // unrelated directory, or a probe that echoed the question back has neither shape here and
  // is refused rather than guessed at.
  const main =
    path.basename(dir) === ".git"
      ? path.dirname(dir)
      : path.basename(dir) !== "worktrees" && path.basename(path.dirname(dir)) === "worktrees"
        ? path.resolve(dir, "..", "..", "..")
        : "";
  if (main === "" || !path.isAbsolute(main) || !existsSync(main))
    throw new SpecifyInfraError(
      `could not find the superproject of ${wt} to take its submodules from: git rev-parse --git-common-dir produced ${raw === "" ? "nothing" : raw}`,
    );
  return main;
}

/**
 * Every git dir `checkout` could be keeping a module store under.
 *
 * `--git-common-dir` for the shared store of a linked worktree, `--absolute-git-dir`
 * for the tree's own. Both are asked, because git has moved a submodule's objects
 * between those two places across its own versions and a probe that guesses one is a
 * probe that fails quietly.
 */
export async function gitDirsOf(exec: ExecFn, checkout: string): Promise<string[]> {
  const dirs = new Set<string>();
  for (const arg of ["--git-common-dir", "--absolute-git-dir"]) {
    const r = await exec("git", {
      argv: [...NO_HOOKS, "rev-parse", arg],
      cwd: checkout,
      timeout: QUICK_GIT_MS,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
    const dir = trim((r as { stdout?: string } | undefined)?.stdout ?? "");
    if (dir !== "") dirs.add(path.isAbsolute(dir) ? dir : path.resolve(checkout, dir));
  }
  return [...dirs];
}
