/**
 * lib/lean-submodule-local-fixture — the repos the offline submodule cases are
 * driven over, and the recording `ExecFn` that proves no network was asked for.
 *
 * The field failure this exists for: a lean run's worktree preparation asks git to
 * populate the base's submodules and git answers by CLONING them — from the URL the
 * base's `.gitmodules` records. A trial host with no network (the benchmark shape)
 * then dies with `the worktree's submodules could not be initialised …`, while the
 * repository it cloned already holds those very objects. The fixture therefore
 * builds the two shapes the fix distinguishes: a submodule present in the
 * superproject's checkout, and a submodule present only as a module store under
 * `.git/modules`. Both with a recorded URL nothing can reach, so a run that passes
 * did not use the URL — it used the local objects.
 *
 * The three parts that make "no network" a fact rather than an assumption:
 *
 *   - the recorded URL names a port nothing listens on, so a real attempt fails in
 *     milliseconds rather than hanging (a hanging case reads as a flake, not a
 *     defect);
 *   - the exec under test refuses an argv that could only mean an off-host read —
 *     a scheme, an `ssh`/`scp` form, or a `fetch`/`clone`/`pull`/`push`/`ls-remote`
 *     whose target is not an absolute local path — BEFORE the child spawns, so a
 *     fix that quietly fell back to the recorded URL would be red on a laptop with
 *     internet and red on CI without one;
 *   - every git child runs with `GIT_TERMINAL_PROMPT=0` and an empty proxy set, so
 *     a credential prompt or a proxy detour fails rather than succeeds quietly.
 *
 * Builders here use their own `git` wrapper (identity in the environment, host git
 * config isolated) and never a product module: what they establish is the base
 * commit, which is a precondition of every case, not the thing under test.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { ExecFn } from "../../src/worktree.ts";
import { defaultConfig, type WorkConfig } from "../../src/lean/config.ts";
import { gitTestEnv, trackedTempDir } from "./git-test-env.ts";

/** The submodule's mount point, and the file committed inside it. */
export const SUB = "vendor/lib";
export const INSIDE = `${SUB}/lib`;
/** The submodule's content, asserted verbatim when the tree is populated. */
export const SUB_CONTENT = "the submodule's own content\n";
/** The nested submodule inside the outer one, for the recursive case. */
export const NESTED = "nested/deep";
export const NESTED_INSIDE = `${NESTED}/lib`;

/**
 * A recorded submodule source git can never reach, quickly.
 *
 * Loopback on a port no listener owns: the connection is refused in milliseconds
 * rather than hanging on an unroutable address, which is what keeps an
 * attempts-the-network case distinguishable from a slow host.
 */
export const UNREACHABLE_URL = "http://127.0.0.1:9/vendor/infogami.git";

/** The runner template the step cases configure: `sh {file}`, the shape their test files are. */
export const RUNNER = "sh {file}";

/** A work config with a runner and a no-op fast tier. */
export function configWith(verify: Partial<WorkConfig["verify"]> = {}): WorkConfig {
  return { ...defaultConfig(), verify: { ...defaultConfig().verify, ...verify } };
}

/** The env every git child of these fixtures runs with. */
export function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** git in `dir`, failing loudly — a fixture that half-built a repo is worse than one that throws. */
export function gitIn(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** `git show <ref>:` a gitlink's recorded sha, or `undefined` when the tree has none. */
export function gitlinkSha(dir: string, rel: string, ref = "HEAD"): string | undefined {
  const r = spawnSync("git", ["ls-tree", ref, rel], { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0) return undefined;
  const hit = (r.stdout ?? "")
    .split("\n")
    .map((l) => l.split("\t")[0]?.split(/\s+/))
    .find((parts) => parts?.[0] === "160000");
  return hit?.[2] === undefined || hit[2] === "" ? undefined : hit[2];
}

/** Write `text` at `rel` under `dir`, making the parents. */
export function putIn(dir: string, rel: string, text: string, mode?: number): void {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, mode === undefined ? undefined : { mode });
}

/**
 * A standalone repo with one committed file, to be mounted as a submodule.
 *
 * Its `origin` is its own path, so a clone of it (which is what a module store is)
 * can be completed from objects this host really holds. That is the state the
 * benchmark is in: everything present, network absent.
 */
export function remoteRepo(tag: string, file = "lib", content = SUB_CONTENT): string {
  const remote = trackedTempDir(`${tag}-remote-`);
  gitIn(remote, "init", "-q", "-b", "main");
  putIn(remote, file, content);
  gitIn(remote, "add", "-A");
  gitIn(remote, "commit", "-q", "-m", "the submodule's content");
  gitIn(remote, "remote", "add", "origin", remote);
  return remote;
}

/** A repo with one committed file and no submodule. */
export function plainRepo(tag: string): { repoRoot: string; baseSha: string } {
  const repoRoot = trackedTempDir(`${tag}-repo-`);
  gitIn(repoRoot, "init", "-q", "-b", "main");
  putIn(repoRoot, "src/retry.ts", "export const retry = () => {};\n");
  gitIn(repoRoot, "add", "-A");
  gitIn(repoRoot, "commit", "-q", "-m", "base");
  return { repoRoot, baseSha: gitIn(repoRoot, "rev-parse", "HEAD") };
}

/** Point one `.gitmodules` entry's `url` at `url`, leaving the rest of the file alone. */
function retarget(repoRoot: string, name: string, url: string): void {
  const file = path.join(repoRoot, ".gitmodules");
  const lines = readFileSync(file, "utf8").split("\n");
  let inside = false;
  const out = lines.map((line) => {
    const nameMatch = /^\[submodule "(.*)"\]/.exec(line);
    if (nameMatch !== null) inside = nameMatch[1] === name;
    return inside && /^\s*url\s*=/.test(line) ? `\turl = ${url}` : line;
  });
  writeFileSync(file, out.join("\n"));
}

/**
 * The module store git kept for `sub`, under `checkout`'s OWN git dir.
 *
 * A submodule added from inside a linked worktree keeps its objects under
 * `<common>/.git/worktrees/<tree>/modules/<path>` rather than the plain
 * `<common>/.git/modules/<path>`, so the location is read from git rather than
 * guessed — guessing wrong here does not fail loudly, it silently makes a control
 * populate from the wrong copy.
 */
export function moduleStore(checkout: string, sub = SUB): string | undefined {
  for (const dir of moduleDirs(checkout)) {
    const cand = path.join(dir, "modules", ...sub.split("/"));
    if (existsSync(path.join(cand, "objects"))) return cand;
  }
  return undefined;
}

/** Every git dir `checkout` could be keeping a module store under. */
function moduleDirs(checkout: string): string[] {
  const dirs = new Set<string>();
  for (const arg of ["--git-common-dir", "--git-dir", "--absolute-git-dir"]) {
    const r = spawnSync("git", ["rev-parse", arg], { cwd: checkout, encoding: "utf8", env: gitEnv() });
    const dir = (r.stdout ?? "").trim();
    if (r.status === 0 && dir !== "") dirs.add(path.resolve(checkout, dir));
  }
  return [...dirs];
}

/**
 * A superproject whose base commit carries a real submodule at `vendor/lib`,
 * mounted from a local path and then re-pointed at an unreachable URL.
 *
 * Mounted locally first, because that is what puts the submodule's objects on this
 * host — the whole situation the fix is about. Re-pointing the URL afterwards (not
 * adding the submodule with the bad URL) leaves the mount itself a plain
 * `git submodule add`, and makes the recorded source one a case can read back.
 *
 * `populate` picks which of the two shapes the base is in:
 *   - `"checkout"` (the default) — the submodule's checkout holds its file, as the
 *     operator's superproject did in the field report;
 *   - `"modules"` — the checkout under `vendor/lib` is removed, so the only copy of
 *     the objects is the module store under `.git/modules`.
 */
export function repoWithSubmodule(
  tag: string,
  opts: { populate?: "checkout" | "modules" } = {},
): { repoRoot: string; baseSha: string; remote: string; submoduleHead: string } {
  const remote = remoteRepo(`${tag}-sub`);
  const submoduleHead = gitIn(remote, "rev-parse", "HEAD");
  const { repoRoot } = plainRepo(tag);
  gitIn(repoRoot, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "--force", remote, SUB);
  // The module store's own `origin` is the local repo it was mounted from — but the
  // recorded URL is what a `submodule update` asks first, so the origin is set and
  // then the URL is rewritten: the module store keeps a source this host holds,
  // `.gitmodules` keeps the lie the case is about.
  gitIn(path.join(repoRoot, ".git", "modules", ...SUB.split("/")), "remote", "set-url", "origin", remote);
  retarget(repoRoot, SUB, UNREACHABLE_URL);
  gitIn(
    path.join(repoRoot, ".git", "modules", ...SUB.split("/")),
    "remote",
    "set-url",
    "origin",
    UNREACHABLE_URL,
  );
  if (opts.populate === "modules") rmSync(path.join(repoRoot, SUB), { recursive: true, force: true });
  gitIn(repoRoot, "add", "-A");
  gitIn(repoRoot, "commit", "-q", "-m", "carry the submodule with a URL nothing can reach");
  return { repoRoot, baseSha: gitIn(repoRoot, "rev-parse", "HEAD"), remote, submoduleHead };
}

/**
 * A superproject whose base records a submodule this host never had.
 *
 * The gitlink is written with `update-index --cacheinfo` rather than
 * `git submodule add`: an `add` would fetch and keep objects, and the shape under
 * test is a base with nothing local to initialise from — no module store and no
 * populated path.
 */
export function repoWithAbsentSubmodule(tag: string): {
  repoRoot: string;
  baseSha: string;
  submoduleHead: string;
} {
  const remote = remoteRepo(`${tag}-sub`);
  const submoduleHead = gitIn(remote, "rev-parse", "HEAD");
  const { repoRoot } = plainRepo(tag);
  putIn(repoRoot, ".gitmodules", `[submodule "${SUB}"]\n\tpath = ${SUB}\n\turl = ${UNREACHABLE_URL}\n`);
  gitIn(repoRoot, "update-index", "--add", "--cacheinfo", `160000,${submoduleHead},${SUB}`);
  gitIn(repoRoot, "add", "-A");
  gitIn(repoRoot, "commit", "-q", "-m", "record a submodule this host has never had");
  // Nothing may be left holding the objects: the case is "absent from the
  // superproject", and a module store the fixture forgot to delete would make it
  // a different case that still passed.
  rmSync(remote, { recursive: true, force: true });
  for (const dir of moduleDirs(repoRoot)) rmSync(path.join(dir, "modules"), { recursive: true, force: true });
  return { repoRoot, baseSha: gitIn(repoRoot, "rev-parse", "HEAD"), submoduleHead };
}

/**
 * A two-level submodule: the superproject carries `vendor/lib`, and that submodule's
 * own commit carries `nested/deep` at another local repo.
 *
 * The nested level is the point — the initialisation asks git for `--recursive`, so
 * its source is reached through the same per-invocation config the fix sets. A fix
 * that only solved the top level passes the flat cases and dies here.
 */
export function repoWithNestedSubmodule(tag: string): {
  repoRoot: string;
  baseSha: string;
  submoduleHead: string;
  nestedHead: string;
} {
  const inner = remoteRepo(`${tag}-inner`);
  const nestedHead = gitIn(inner, "rev-parse", "HEAD");
  const outer = remoteRepo(`${tag}-outer`);
  gitIn(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "--force", inner, NESTED);
  gitIn(
    path.join(outer, ".git", "modules", ...NESTED.split("/")),
    "remote",
    "set-url",
    "origin",
    UNREACHABLE_URL,
  );
  retarget(outer, NESTED, UNREACHABLE_URL);
  gitIn(outer, "add", "-A");
  gitIn(outer, "commit", "-q", "-m", "carry the nested submodule with an unreachable URL");
  const submoduleHead = gitIn(outer, "rev-parse", "HEAD");

  const { repoRoot } = plainRepo(tag);
  gitIn(repoRoot, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "--force", outer, SUB);
  gitIn(
    path.join(repoRoot, ".git", "modules", ...SUB.split("/")),
    "remote",
    "set-url",
    "origin",
    UNREACHABLE_URL,
  );
  retarget(repoRoot, SUB, UNREACHABLE_URL);
  gitIn(repoRoot, "add", "-A");
  gitIn(repoRoot, "commit", "-q", "-m", "carry the outer submodule with an unreachable URL");
  return { repoRoot, baseSha: gitIn(repoRoot, "rev-parse", "HEAD"), submoduleHead, nestedHead };
}

/** One git call the recording exec saw. */
export interface RecordedCall {
  cmd: string;
  argv: string[];
  cwd: string;
}

/**
 * An `ExecFn` that records every call and refuses anything that could reach the
 * network. The refusal happens before the child spawns, so the argv is the evidence
 * and the host's connectivity is not part of the verdict. See the module header.
 */
export function offlineExec(): { exec: ExecFn; calls: RecordedCall[]; network: string[] } {
  const calls: RecordedCall[] = [];
  const network: string[] = [];
  const exec: ExecFn = async (cmd, o) => {
    const argv = o?.argv ?? [];
    const cwd = o?.cwd ?? process.cwd();
    calls.push({ cmd, argv: [...argv], cwd });
    if (isNetworkArgv(argv)) {
      network.push(`${cmd} ${argv.join(" ")}`);
      const err = new Error(`offline exec refused a network-shaped call: ${cmd} ${joined}`) as Error & {
        code?: number;
      };
      err.code = 128;
      throw err;
    }
    return execp(cmd, {
      ...o,
      env: {
        ...gitEnv(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_PROXY_UNKNOWN_PROTOCOL: "abort",
        http_proxy: "",
        https_proxy: "",
        ...(o?.env ?? {}),
      },
    });
  };
  return { exec, calls, network };
}

/**
 * argv shapes that can only mean "ask something off-host".
 *
 * The scheme forms are matched anywhere in the argv — no path on this host is named
 * `http://…`, so a match can only be a remote. The verb forms are matched on the
 * WHOLE argv, not per word, for two reasons: a submodule fetch carries its remote's
 * URL in the same invocation (`fetch --update-shallow -q --progress origin <url>`),
 * and git's own `--recurse-submodules` fetches sit two levels below the verb the
 * caller typed, so judging only the word after `fetch` reads a remote fetch as a
 * local one.
 */
const REMOTE_SHAPE: readonly RegExp[] = [
  /\b(?:https?|git|ssh|ftps?):\/\/\S/,
  /\bgit@\S+:/,
  /\bssh:\S+@\S/,
];
/** The verbs whose whole point is moving commits between hosts. */
const FETCH_VERB = /^(?:fetch|ls-remote|pull|push|clone)$/;

/**
 * Does this argv ask git for commits this host does not already hold?
 *
 * A scheme, an `scp`-style remote, or an `ssh:` form anywhere is a remote: no path on
 * this host is named `http://…`, so only a remote can match, and the match is made
 * on the word as git received it — a path made absolute here would turn a relative
 * one into something that looks local. Beyond that, a fetch-family verb with any
 * operand that is not an option, a `-c k=v` config assignment, or a path is a remote
 * read: git's own submodule fetches carry the remote's URL among the arguments
 * (`fetch --update-shallow -q origin <url>`), so the scan runs over every word and
 * not only the one after the verb. A local `git clone /abs/path` — what the fix
 * issues — answers false.
 */
function isNetworkArgv(argv: string[]): boolean {
  if (argv.some((a) => REMOTE_SHAPE.some((re) => re.test(a)))) return true;
  if (!argv.some((a) => FETCH_VERB.test(a))) return false;
  return argv.some((a) => !a.startsWith("-") && !a.includes("=") && a !== "." && !looksLikePath(a));
}

/** Is `a` a filesystem path rather than a remote name? (Any spelling with a `/`.) */
function looksLikePath(a: string): boolean {
  return a.includes("/") || a.includes(path.sep);
}

/** The submodule's HEAD as the tree reports it, or `undefined` when it has none. */
export function submoduleHead(dir: string, rel = SUB): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: path.join(dir, rel),
    encoding: "utf8",
    env: gitEnv(),
  });
  if (r.status !== 0) return undefined;
  const sha = (r.stdout ?? "").trim();
  return sha === "" ? undefined : sha;
}

/** Does the tree hold `rel` (a submodule's committed file)? */
export function populated(dir: string, rel = INSIDE): boolean {
  return existsSync(path.join(dir, rel));
}

/** Read a file, or `undefined` when it is not there. */
export function readOrNull(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `git -C`-style helper for a case's own assertions. */
export function show(dir: string, ...args: string[]): string {
  return gitIn(dir, ...args);
}
