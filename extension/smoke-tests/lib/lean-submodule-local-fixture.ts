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
import { type WorkConfig, defaultConfig } from "../../src/lean/config.ts";
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
export function retarget(repoRoot: string, name: string, url: string): void {
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

/**
 * Make a module store hold its own objects.
 *
 * `git submodule add` clones with `--reference`/`--dissoc` (or `--local` when the
 * source is on this host), and either leaves the new store reading loose objects from
 * the source it was mounted from — an `objects/info/alternates` file or a
 * `core.objectsPath` — rather than holding them. A fixture that then deletes the
 * source still "passes" while git is reading a vanished directory, so a case that
 * means "the objects are here" has to sever the link and say so: after this, the
 * store answers for itself or the case fails loudly.
 */
export function severAlternates(store: string): void {
  rmSync(path.join(store, "objects", "info", "alternates"), { force: true });
  const config = path.join(store, "config");
  const read = spawnSync("git", ["config", "--file", config, "--get", "core.objectsPath"], {
    encoding: "utf8",
    env: gitEnv(),
  });
  // git's own exit codes for `--get`: 0 found it, 1 found nothing, >1 the file could
  // not be read. Probing before unsetting is what makes the "did I have to edit it"
  // question answerable instead of inferred, and it is the assertion that the store
  // holds its own objects — which is the whole claim of the `"modules"` shape.
  if (read.status !== 0 && read.status !== 1)
    throw new Error(`could not read ${config}: ${(read.stderr ?? "").trim()}`);
  if (read.status === 0) {
    const out = spawnSync("git", ["config", "--file", config, "--unset-all", "core.objectsPath"], {
      encoding: "utf8",
      env: gitEnv(),
    });
    if (out.status !== 0)
      throw new Error(`could not clear core.objectsPath in ${store}: ${(out.stderr ?? "").trim()}`);
  }
}

/** Every git dir `checkout` could be keeping a module store under. */
function moduleDirs(checkout: string): string[] {
  const dirs = new Set<string>();
  for (const arg of ["--git-common-dir", "--git-dir", "--absolute-git-dir"]) {
    const r = spawnSync("git", ["rev-parse", arg], {
      cwd: checkout,
      encoding: "utf8",
      env: gitEnv(),
    });
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
  gitIn(
    repoRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    "--force",
    remote,
    SUB,
  );
  // The module store's own `origin` is the local repo it was mounted from — but the
  // recorded URL is what a `submodule update` asks first, so the origin is set and
  // then the URL is rewritten: the module store keeps a source this host holds,
  // `.gitmodules` keeps the lie the case is about.
  gitIn(
    path.join(repoRoot, ".git", "modules", ...SUB.split("/")),
    "remote",
    "set-url",
    "origin",
    remote,
  );
  retarget(repoRoot, SUB, UNREACHABLE_URL);
  gitIn(
    path.join(repoRoot, ".git", "modules", ...SUB.split("/")),
    "remote",
    "set-url",
    "origin",
    UNREACHABLE_URL,
  );
  // Same reason as the nested case: the module store keeps alternates into the
  // mount it was cloned from, and the case must not depend on that directory.
  severAlternates(path.join(repoRoot, ".git", "modules", ...SUB.split("/")));
  // Re-stage the gitlink BEFORE anything is removed, and restore it if the removal
  // still ate it. `git submodule add` leaves the gitlink STAGED and its checkout
  // holding files; a `git add -A` taken after the checkout was emptied re-reads that
  // path — gitlink now gone from the work tree — as an ordinary deletion and drops it
  // from the index, so the `"modules"` shape silently becomes a base with no submodule
  // at all. Staging first is not enough on its own (measured: the second `add -A` still
  // deletes it), so the entry is written back from the commit that `submodule add`
  // proved, with the recorded gitlink as the value. A base whose tree lost the gitlink
  // would make every assertion below pass for the wrong reason, so the shape is checked
  // rather than assumed.
  gitIn(repoRoot, "add", "-A");
  if (opts.populate === "modules") {
    rmSync(path.join(repoRoot, SUB), { recursive: true, force: true });
    gitIn(repoRoot, "add", "-A");
    restoreGitlink(repoRoot, SUB, submoduleHead);
  }
  gitIn(repoRoot, "commit", "-q", "-m", "carry the submodule with a URL nothing can reach");
  if (gitIn(repoRoot, "ls-files", "-s", "--", SUB) === "")
    throw new Error(`the module-store fixture lost its gitlink at ${SUB}`);
  return { repoRoot, baseSha: gitIn(repoRoot, "rev-parse", "HEAD"), remote, submoduleHead };
}

/**
 * The paths one commit of `dir` tracks.
 *
 * Used to give the submodule's own commit a directory: a fixture that builds an
 * absent-submodule base needs a tracked change in that commit, and a path which is
 * nothing but a gitlink can leave `commit` with nothing to record.
 */
function trackedFiles(dir: string, ...args: string[]): string[] {
  return gitIn(dir, "ls-tree", "-r", "--name-only", "HEAD", ...args)
    .split("\n")
    .filter((l) => l !== "");
}

/**
 * Put a gitlink back in the index when an `add -A` ate it.
 *
 * `git update-index --cacheinfo <mode>,<sha>,<path>` is how git records a submodule
 * entry without a fetch, which is the same shape `submodule add` had already proven
 * against the source. Refused unless the entry is genuinely a `160000` gitlink, so a
 * fixture that wrote a blob here fails loudly instead of building a base with no
 * submodule in it.
 */
function restoreGitlink(repoRoot: string, sub: string, sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no commit to record for the gitlink at ${sub}`);
  gitIn(repoRoot, "update-index", "--add", "--cacheinfo", `160000,${sha},${sub}`);
  if (!gitIn(repoRoot, "ls-files", "-s", "--", sub).startsWith("160000 "))
    throw new Error(`could not record the gitlink at ${sub}`);
}

/**
 * A superproject whose base records a submodule this host never had.
 *
 * The gitlink is written with `update-index --cacheinfo` rather than
 * `git submodule add`: an `add` would fetch and keep objects, and the shape under
 * test is a base with nothing local to initialise from — no module store and no
 * populated path.
 */
export function repoWithAbsentSubmodule(
  tag: string,
  source?: string,
): {
  repoRoot: string;
  baseSha: string;
  submoduleHead: string;
} {
  // A caller that already has the submodule's repo passes it in — the field shape is
  // a superproject that records a submodule whose source lives SOMEWHERE and was
  // never cloned here — otherwise the fixture builds one just to read its HEAD.
  const provided = source !== undefined;
  const remote = provided ? source : remoteRepo(`${tag}-sub`);
  const submoduleHead = gitIn(remote, "rev-parse", "HEAD");
  // Read the source's bytes out before it goes: a provided source stays on disk and its
  // contents are the point of the case, so the fixture must not delete a directory it
  // was handed.
  const contents = trackedFiles(remote);
  const { repoRoot } = plainRepo(tag);
  // Materialise the submodule's tree and then delete it again. A tracked path is what a
  // `git add -A` has to notice, and noticing it is what makes the commit below a real
  // commit — without a change to stage there is no base commit to reset to, and the case
  // silently runs against the plain repo instead. The bytes are removed before the
  // commit, so what the base ends up holding is the gitlink and nothing else.
  for (const rel of contents) putIn(repoRoot, path.join(SUB, rel), `sabotage filler for ${rel}\n`);
  putIn(
    repoRoot,
    ".gitmodules",
    `[submodule "${SUB}"]\n\tpath = ${SUB}\n\turl = ${UNREACHABLE_URL}\n`,
  );
  gitIn(repoRoot, "update-index", "--add", "--cacheinfo", `160000,${submoduleHead},${SUB}`);
  gitIn(repoRoot, "add", "-A");
  rmSync(path.join(repoRoot, SUB), { recursive: true, force: true });
  // The gitlink has to be in the index before the removal can be mistaken for an
  // ordinary deletion of a directory (see `repoWithSubmodule` for the trap).
  restoreGitlink(repoRoot, SUB, submoduleHead);
  gitIn(repoRoot, "commit", "-q", "-m", "record a submodule this host has never had");
  // Nothing may be left holding the objects in the SUPERPROJECT: the case is
  // "absent from the superproject", and a module store the fixture forgot to delete
  // would make it a different case that still passed. A source the caller supplied
  // stays where it is — it is outside the superproject and its existence is the
  // point of the case. The base is then re-committed with the file gone, so the
  // SUPERPROJECT holds neither store nor checkout, which is the shape under test.
  if (!provided) rmSync(remote, { recursive: true, force: true });
  for (const dir of moduleDirs(repoRoot))
    rmSync(path.join(dir, "modules"), { recursive: true, force: true });
  // The base must hold NOTHING of the submodule: no module store and no populated path.
  // The single commit already records exactly that (the filler was deleted before it),
  // so there is nothing further to stage — and the message is what proves the base is
  // that commit rather than an earlier one: `commit` exits 1 on a tree with nothing to
  // stage, and `rev-parse HEAD` would then still name the previous commit quietly.
  const built = gitIn(repoRoot, "rev-parse", "HEAD");
  if (gitIn(repoRoot, "log", "-1", "--format=%s") !== "record a submodule this host has never had")
    throw new Error(`the absent-submodule fixture built no base commit in ${repoRoot}`);
  return { repoRoot, baseSha: built, submoduleHead };
}

/**
 * A two-level submodule: the superproject carries `vendor/lib`, and that submodule's
 * own commit carries `nested/deep` at another local repo.
 *
 * The nested level is the point, and it is the level the fix deliberately does NOT
 * seed: the seeding call is per-path and non-recursive, so a deeper submodule is used
 * only if the superproject already holds it and is otherwise left absent. That is only a
 * testable claim if the nested level could have been populated by some accident of
 * construction, so the inner repo is DELETED once the outer one holds its objects — and
 * the inner checkout inside the outer repo is emptied, so nothing but the module store
 * holds the nested bytes. A fixture that left the source on disk would let a nested
 * level appear populated for a reason the step had nothing to do with.
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
  // The nested level is mounted, its objects are secured in a module store, and THEN
  // every record of its source is rewritten to the unreachable URL. Setting the URL
  // before the mount is the trap: `git submodule add` clones with
  // `--origin <name>`, and a named origin's URL is written at clone time, so
  // `remote set-url` afterwards leaves the clone holding `--reference`/`--dissoc`
  // alternates into the source that is then deleted — and the case goes green while
  // git reads loose objects from a vanished directory.
  gitIn(
    outer,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    "--force",
    inner,
    NESTED,
  );
  severAlternates(path.join(outer, ".git", "modules", ...NESTED.split("/")));
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
  // The nested level now lives in the outer repo's module store and nowhere else this
  // host can fetch from. Emptying the checkout under `nested/deep` is what makes the
  // nested assertion mean something: without it the file is simply there, and a step
  // that populated nothing would still see it.
  rmSync(path.join(outer, NESTED), { recursive: true, force: true });
  gitIn(outer, "add", "-A");
  gitIn(outer, "commit", "-q", "-m", "and leave only the module store holding the nested level");
  if (
    gitIn(outer, "log", "-1", "--format=%s") !==
    "and leave only the module store holding the nested level"
  )
    throw new Error(`the nested fixture's sabotage produced no commit in ${outer}`);
  const outerHead = gitIn(outer, "rev-parse", "HEAD");

  const { repoRoot } = plainRepo(tag);
  gitIn(
    repoRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    "--force",
    outer,
    SUB,
  );
  severAlternates(path.join(repoRoot, ".git", "modules", ...SUB.split("/")));
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
  // The inner source is gone: a nested level that appeared populated afterwards can only
  // have come from bytes the superproject already held — or from nothing at all, which
  // is what this fix deliberately leaves it as.
  rmSync(inner, { recursive: true, force: true });
  return {
    repoRoot,
    baseSha: gitIn(repoRoot, "rev-parse", "HEAD"),
    submoduleHead: outerHead,
    nestedHead,
  };
}
