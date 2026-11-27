/**
 * lean/submodule-entries — reading a base's `.gitmodules`, and asking git where its submodule
 * bytes live, without either answer being trusted as a fetch source.
 *
 * Two questions the seeding asks before touching anything, both answered by git:
 *
 *   - WHICH submodules the commit registers. The NAME matters as much as the path: `submodule.<name>` is
 *     the section git reads when an entry is registered or retargeted, so keying on the path would target
 *     nothing while every command exited 0. Exit 1 means the file lists nothing; above 1 means git could
 *     not read it, which refuses the run — skipping an initialisation the base asked for would test the
 *     run against an empty directory. git's C quoting is undone before anything reaches an argv.
 *   - WHERE this host holds them: `--git-common-dir` for the shared store, `--absolute-git-dir` for the
 *     tree's own, and the MAIN working tree from the former — never `--show-toplevel`, which inside a
 *     linked worktree answers with that worktree, so the step would seed from the tree it is populating.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { trim } from "./specify-proof.ts";
import { NO_HOOKS, SpecifyInfraError } from "./specify-reset.ts";

/** The wall clock on the short reads that decide where a submodule comes from. */
const QUICK_GIT_MS = 30_000;

/**
 * One registered submodule: the name `.gitmodules` files it under, and its path. `name` is the key git
 * printed minus its `submodule.` prefix and `.path` suffix, so `submodule.<name>.url` is a key git answers.
 * The URL the base records is deliberately NOT held — no arm may use it as a fetch source, and a value
 * nobody may read is safest not read at all.
 */
export interface SubmoduleEntry {
  name: string;
  path: string;
}

/**
 * The registered submodules in `.gitmodules` order, or `undefined` when the file lists nothing.
 * `--get-regexp` exits 1 when nothing is listed and above 1 when git could not read the file, so "could not
 * tell" refuses the run rather than skipping an initialisation it was asked for.
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
    // 0 listed nothing and 1 is `--get-regexp`'s no-match; above 1 is git failing to read the file.
    if (typeof code === "number" && code <= 1) return undefined;
    throw new SpecifyInfraError(
      `could not tell whether ${wt} has submodules: git config --file .gitmodules --get-regexp path exited ${String(code)}`,
    );
  }
  const entries: SubmoduleEntry[] = [];
  for (const raw of (listed as { stdout?: string }).stdout?.split("\n") ?? []) {
    // `--get-regexp` ends its last record with a newline; the empty string after it is not a missed key.
    const line = raw.trim();
    if (line === "") continue;
    // git's quoting is undone before any of this reaches an argv: `--get-regexp` prints key and value in
    // c-style quotes when they hold unusual bytes, and the value git MEANT is what has to come back — a
    // token this cannot unquote is the step not understanding its base.
    //
    // git prints the WHOLE KEY, so the name is the key minus its `submodule.` prefix and `.path` suffix,
    // re-used as `-c submodule.<name>.url=…`. A name still holding the prefix builds a key git never
    // consults: the entry seeds from the recorded URL and the offline rule goes quiet with every case green
    // — so the regex REQUIRES the prefix.
    const hit =
      /^submodule\.(?:"((?:[^"\\]|\\.)*)"|(.+?))\.path\s+(.*)$/u.exec(line.trim()) ??
      /^submodule\."(?<name>.*)"\.path\s+(?<value>.*)$/u.exec(line.trim());
    // The two forms capture at DIFFERENT group numbers, so the answer is read by name as well as position.
    const rawName = hit?.[1] ?? hit?.[2] ?? hit?.groups?.name;
    const rawValue = hit?.[3] ?? hit?.groups?.value;
    // Two alternatives: `--get-regexp` prints a name containing `=` or a space UNQUOTED (measured, git 2.53)
    // and a tab-containing one C-quoted, so neither branch alone reads every key. The unquoted branch cannot be
    // `(.*)` either: `git config` answers a `.`-bearing name as its own section, so a section named
    // `x.path` would read as the name `x.path <path>`.
    // One refusal for both ways a key fails to be a name and a path — with the base's own line verbatim,
    // which is what an operator needs to go look at.
    const name = rawName === undefined ? undefined : unquoteGitConfig(rawName);
    const value = rawValue === undefined ? undefined : unquoteGitConfig(rawValue.trim());
    if (name === undefined || value === undefined || value === "")
      throw new SpecifyInfraError(
        `could not read the submodule list of ${wt}: git config --file .gitmodules --get-regexp path printed a key this step cannot split into a name and a path, so it cannot tell which submodules the base registers: ${JSON.stringify(line.trim())}`,
      );
    // The name is not a label: it is the KEY of the `-c submodule.<name>.url=…` the seeding names its
    // source with, and git splits a command-line assignment at its FIRST `=`. A name carrying one sets a key
    // git never consults (measured, git 2.53), so `submodule update` falls back to the base's URL while
    // `protocol.file.allow=always` on the same call licenses the transport — the offline rule failing OPEN
    // to a network fetch with every case green.
    if (/[="\s]/u.test(name))
      throw new SpecifyInfraError(
        `could not use the submodule name ${JSON.stringify(name)} from ${wt}/.gitmodules: it cannot be named on a command-line config assignment without changing the key git reads, so this step would seed that entry from the URL the base records rather than from this superproject`,
      );
    entries.push({ name, path: value });
  }
  return entries.length === 0 ? undefined : entries;
}

/**
 * Undo the one-level C quoting `git config --get-regexp` applies to a token, or `undefined` when it is not
 * well-formed quoted text. Deliberately not `JSON.parse` — git's quoting is C quoting and the two differ
 * — and what this cannot prove it read is reported, not guessed.
 */
function unquoteGitConfig(token: string): string | undefined {
  if (!token.startsWith('"')) return token;
  if (!token.endsWith('"') || token.length < 2) return undefined;
  const body = token.slice(1, -1);
  let out = "";
  const at = (k: number): string => body[k] ?? "";
  // The escapes `--get-regexp` emits; anything else is refused below.
  const SIMPLE: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };
  for (let i = 0; i < body.length; i++) {
    const ch = at(i);
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i++;
    const esc = at(i);
    const simple = SIMPLE[esc];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    if (esc >= "0" && esc <= "7") {
      // Up to three octal digits, as git's `unquote_c_style` takes them.
      let digits = esc;
      while (digits.length < 3 && at(i + 1) >= "0" && at(i + 1) <= "7") {
        i++;
        digits += at(i);
      }
      out += String.fromCodePoint(Number.parseInt(digits, 8));
      continue;
    }
    if (esc === "x" || esc === "u" || esc === "U") {
      const width = esc === "x" ? 2 : esc === "u" ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + width);
      if (!/^[0-9a-fA-F]+$/u.test(hex) || hex.length !== width) return undefined;
      i += width;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      continue;
    }
    return undefined;
  }
  return out;
}

/** Is `p` inside `root` (or `root` itself) once `..` and `.` resolve? */
function inside(root: string, p: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(p);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Where this host holds `sub`, as a source git can clone from, or `undefined` when nothing the
 * OPERATOR'S superproject holds has it (module store first, then checkout — the store is complete,
 * the checkout may be half-cleaned). Every returned path is held to the superproject AFTER resolution:
 * `path.join` preserves `..`, and the run's own tree must never be the source.
 */
export function localSource(
  superproject: string,
  gitDirs: string[],
  sub: string,
  run: { wt: string },
): string | undefined {
  const parts = sub
    .split("/")
    .filter((p) => p !== "" && p !== "." && p !== ".." && !path.isAbsolute(p));
  if (parts.length === 0) return undefined;
  const superprojectResolved = path.resolve(superproject);
  const runTree = path.resolve(run.wt);
  // The run's tree is never the source, nor a superproject nested inside it. Only super-inside-run is
  // refused — the normal layout has the run UNDER the superproject.
  if (runTree === superprojectResolved || inside(runTree, superprojectResolved)) return undefined;
  for (const dir of gitDirs) {
    // Skip a store filed under the RUN's gitdir — it holds only this run's commits.
    const resolved = path.resolve(dir);
    if (resolved !== superprojectResolved && inside(runTree, resolved)) continue;
    // `objects` marks a real git dir; containment stops a `..` the filter missed.
    const store = path.join(resolved, "modules", ...parts);
    if (existsSync(path.join(store, "objects")) && inside(superprojectResolved, store))
      return store;
  }
  const checkout = path.join(superprojectResolved, ...parts);
  // No containment test: the `..`/absolute filter makes `parts` non-escaping, so the join is inside by
  // construction. The store branch keeps its own because a git dir the CALLER names can still sit outside.
  if (existsSync(path.join(checkout, ".git")) || existsSync(path.join(checkout, "HEAD")))
    return checkout;
  return undefined;
}

/**
 * The superproject whose bytes to copy: the MAIN working tree, asked of git rather than derived
 * from the caller's path or from `--show-toplevel`.
 *
 * `--show-toplevel` is the wrong question: inside a linked worktree it answers with THAT worktree, so a step
 * seeding "from the superproject" would seed from the very tree it is about to populate. `--git-common-dir`
 * answers with the shared store and its parent is the main checkout — the one tree whose submodule content
 * the base's verify ran against.
 *
 * The main checkout is derived from git's SHAPE — `<…>/.git` or `<…>/.git/worktrees/<name>` — never from
 * the caller's path. Counting components off `wt` is the trap: a run's worktree lives at
 * `<repo>/.worktrees/lean-<issue>`, as deep as a linked tree's gitdir, so an answer derived from it points
 * at `<repo>/.worktrees` — a directory that exists, so no existence check catches it.
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
  // git's two answers, matched as PATHS not substrings: `<repo>/.git` for a normal checkout,
  // `<repo>/.git/worktrees/<name>` for a LINKED one (main three up). Anything else has neither shape and is
  // refused rather than guessed at.
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
 * Every git dir `checkout` could keep a module store under: `--git-common-dir` for the shared store of a
 * linked worktree, `--absolute-git-dir` for the tree's own. Both are asked — git has moved a submodule's
 * objects between those two places across its own versions, and a probe that guesses one fails quietly.
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
