import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { assertSpecifyWorktreeOwned } from "../src/lean/specify-tree.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { ROOTS, git, makeRepo } from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The fixture's git view: every git child gets `gitTestEnv()` — the isolated
 * HOME/config and the stripped location variables — exactly as the specify
 * fixture threads it, so the predicate judges this repo and not the host's.
 */
const exec: ExecFn = (cmd, o) => execp(cmd, { ...o, env: { ...gitTestEnv(), ...(o?.env ?? {}) } });

/** Commit `rel` in `dir`, so HEAD moves one step past where it was. */
function commitOne(dir: string, rel: string): string {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), "child work\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "child: my own commit");
  return git(dir, "rev-parse", "HEAD");
}

/** Register a worktree at `ref`, checked out on `branch`; returns its path. */
function worktree(repoRoot: string, ref: string, issue: number, branch: string): string {
  const wt = path.join(repoRoot, ".worktrees", `lean-${String(issue)}`, slug());
  git(repoRoot, "worktree", "add", "-q", "--checkout", "-B", branch, wt, ref);
  return wt;
}

/** Keep one registration per case: a fresh leaf directory name for each tree. */
let seq = 0;
function slug(): string {
  seq++;
  return `t${String(seq)}`;
}

/** Whether HEAD is still a symbolic ref — behind "the tree names a branch". */
function onBranch(wt: string): boolean {
  return (
    spawnSync("git", [...NO_HOOKS, "symbolic-ref", "-q", "HEAD"], {
      cwd: wt,
      encoding: "utf8",
      env: gitTestEnv(),
    }).status === 0
  );
}

/** What `git symbolic-ref --short -q HEAD` reports, `""` when it names no branch. */
function branchOf(wt: string): string {
  const r = spawnSync("git", [...NO_HOOKS, "symbolic-ref", "--short", "-q", "HEAD"], {
    cwd: wt,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

/** Whether `sha` is an ancestor of `wt`'s HEAD — git's own answer. */
function descends(wt: string, sha: string): boolean {
  return (
    spawnSync("git", [...NO_HOOKS, "merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: wt,
      encoding: "utf8",
      env: gitTestEnv(),
    }).status === 0
  );
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

const OWNED = /does not own/;
const QUOTES_BASE = (base: string, head: string) => (m: string) =>
  m.includes(`expected ${base}`) && m.includes(head);

/**
 * The predicate's answer as a string: `""` when it accepted the tree, the refusal
 * text when it refused. One shape for the two outcomes keeps every case's
 * assertion about WHAT was said in one place.
 */

async function refusal(
  o: { repoRoot: string; wt: string; baseSha: string; branch: string },
  ahead: boolean,
): Promise<string> {
  try {
    await assertSpecifyWorktreeOwned(exec, {
      ...o,
      ...(ahead ? { allowAheadOfBase: true } : {}),
    });
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

// ─────── (a) the strict predicate still refuses a tree one commit ahead
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const branch = "lean/issue-1";
  const wt = worktree(repoRoot, baseSha, 1, branch);
  const ahead = commitOne(wt, "child.ts");
  const msg = await refusal({ repoRoot, wt, baseSha, branch }, false);
  assert(OWNED.test(msg), `(a) strict: an ahead-of-base tree is refused (got ${msg || "no throw"})`);
  assert(
    QUOTES_BASE(baseSha, ahead)(msg),
    `(a) strict: the refusal names HEAD and the base it expected (got ${msg})`,
  );
  assert(
    git(wt, "rev-parse", "HEAD") === ahead,
    "(a) strict: nothing was mutated — HEAD is still the child's commit",
  );
}

// ─────── (b) the ahead-tolerant predicate owns that same tree
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const branch = "lean/issue-2";
  const wt = worktree(repoRoot, baseSha, 2, branch);
  const ahead = commitOne(wt, "child.ts");
  const msg = await refusal({ repoRoot, wt, baseSha, branch }, true);
  assert(msg === "", `(b) ahead of the base on the run's branch is owned (got ${msg})`);
  assert(git(wt, "rev-parse", "HEAD") === ahead, "(b) nothing was reset either");
}

// ─────── (c) the tolerant predicate still refuses everything else
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const branch = "lean/issue-3";
  // A commit beside the base, made on its own branch in the main checkout: the
  // HEAD the ancestry probe answers git's own "no" to, which is the shape of a
  // rebased or rewound run branch.
  git(repoRoot, "checkout", "-q", "-b", "beside-the-base", baseSha);
  writeFileSync(path.join(repoRoot, "beside.ts"), "beside\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "a commit beside the base");
  const sibling = git(repoRoot, "rev-parse", "HEAD");
  git(repoRoot, "checkout", "-q", "main");
  // `descends` compares a worktree's HEAD against a sha, and here the point is
  // the reverse direction: the base does not lead to this commit.
  assert(
    !spawnSync("git", [...NO_HOOKS, "merge-base", "--is-ancestor", baseSha, sibling], {
      cwd: repoRoot,
      env: gitTestEnv(),
    }).status,
    "(c) seed: the sibling commit is beside the base, not after it",
  );
  for (const [name, act, why] of [
    // The run's branch is moved to a commit the base does not lead to, and the
    // tree follows it: registered and on the run's branch, so ONLY the ancestry
    // probe can refuse it. `branch -f` is refused while a worktree holds a branch,
    // which is why the ref moves from the tree that does hold it.
    [
      "head on another commit",
      (wt: string) => git(wt, "reset", "-q", "--hard", sibling),
      "a HEAD the base does not lead to is not this step's tree",
    ],
    [
      "foreign branch",
      // The same commit, on a branch the run never named — the refusal the
      // ancestry probe cannot reach.
      (wt: string) => {
        git(wt, "checkout", "-q", "-B", "someone-else/branch", sibling);
        git(wt, "branch", "-f", branch, sibling);
      },
      "a tree on a branch this run never named is not its tree",
    ],
  ] as Array<[string, (wt: string) => void, string]>) {
    const wt = worktree(repoRoot, baseSha, 3, `${branch}-${slug()}`);
    // Ahead of the base first, so the only thing left that can refuse the tree
    // is the check this case is about.
    commitOne(wt, "child.ts");
    act(wt);
    assert(
      git(wt, "rev-parse", "HEAD") === sibling && onBranch(wt),
      `(c) ${name}: HEAD is on a branch and off the base's line (seed)`,
    );
    const msg = await refusal({ repoRoot, wt, baseSha, branch }, true);
    assert(OWNED.test(msg), `(c) ${name}: refused — ${why} (got ${msg || "no throw"})`);
  }
  // Registered on NO branch and AHEAD of the base — `worktree add --detach` at
  // the base, then a commit. The ancestry probe says yes, so the only thing left
  // that could refuse it is the branch check, and a detached tree names no branch
  // to compare: AC2 refuses detached trees, so this one goes. A tree detached AT
  // the base is still owned (the callers produce that shape themselves — see the
  // jsdoc of `resetWorktreeToBase`), and the strict case below pins it.
  {
    const wt = path.join(repoRoot, ".worktrees", "lean-3", slug());
    git(repoRoot, "worktree", "add", "-q", "--detach", wt, baseSha);
    const detachedHead = commitOne(wt, "child.ts");
    assert(
      git(repoRoot, "worktree", "list", "--porcelain").includes(wt) &&
        !onBranch(wt) &&
        branchOf(wt) === "" &&
        descends(wt, baseSha) &&
        git(wt, "rev-parse", "HEAD") === detachedHead,
      "(c) detached ahead: registered, on no branch, ahead of the base (seed)",
    );
    const msg = await refusal({ repoRoot, wt, baseSha, branch }, true);
    assert(
      OWNED.test(msg),
      `(c) detached ahead: refused — AC2 requires the run's branch (got ${msg || "no throw"})`,
    );
    assert(
      git(wt, "rev-parse", "HEAD") === detachedHead,
      "(c) detached ahead: nothing was reset",
    );
    // The same tree with the branch probe broken: `symbolic-ref` throws, and the
    // gate's `.catch` reads it as an empty branch name — the second way ahead
    // loses the run's branch, and it reads the same as detached.
    const unreadable: ExecFn = async (cmd, o) => {
      if ((o?.argv ?? []).includes("symbolic-ref")) throw new Error("cannot lock ref 'HEAD'");
      return exec(cmd, o);
    };
    let brokenMsg = "";
    try {
      await assertSpecifyWorktreeOwned(unreadable, {
        repoRoot,
        wt,
        baseSha,
        branch,
        allowAheadOfBase: true,
      });
    } catch (err) {
      brokenMsg = (err as Error).message;
    }
    assert(
      OWNED.test(brokenMsg),
      `(c) symbolic-ref unreadable: refused too (got ${brokenMsg || "no throw"})`,
    );
    // A tree detached exactly AT the base stays owned — the ahead path was
    // never taken, so today's behaviour for that shape is unchanged, and the
    // tolerance is deliberate: `resetWorktreeToBase` leaves its own trees there
    // detached whenever it is handed `branch === ""`.
    const atBase = path.join(repoRoot, ".worktrees", "lean-3", slug());
    git(repoRoot, "worktree", "add", "-q", "--detach", atBase, baseSha);
    assert(
      !onBranch(atBase) && git(atBase, "rev-parse", "HEAD") === baseSha,
      "(c) detached at the base: registered and on no branch (seed)",
    );
    for (const ahead of [false, true]) {
      const msg = await refusal({ repoRoot, wt: atBase, baseSha, branch }, ahead);
      assert(
        msg === "",
        `(c) detached at the base: still owned ${ahead ? "with the ahead option" : "under the strict predicate"} (got ${msg || "no throw"})`,
      );
    }
  }
  // A path that is a git repository but not a worktree of this one — the tree a
  // `clean -fdx` would destroy.
  {
    const foreign = path.join(repoRoot, "not-a-worktree");
    mkdirSync(foreign, { recursive: true });
    git(foreign, "init", "-q", "-b", "main");
    writeFileSync(path.join(foreign, "precious.ts"), "PRECIOUS\n");
    git(foreign, "add", "-A");
    git(foreign, "commit", "-q", "-m", "somebody else's base");
    const foreignHead = git(foreign, "rev-parse", "HEAD");
    const msg = await refusal({ repoRoot, wt: foreign, baseSha: foreignHead, branch: "main" }, true);
    assert(OWNED.test(msg), `(c) unregistered path: refused (got ${msg || "no throw"})`);
    assert(
      existsSync(path.join(foreign, "precious.ts")) &&
        readFileSync(path.join(foreign, "precious.ts"), "utf8") === "PRECIOUS\n",
      "(c) unregistered path: the foreign tree was left exactly as found",
    );
  }
  assert(descends(worktree(repoRoot, baseSha, 3, branch), baseSha), "(c) seed: a fresh tree descends");
}

// ─────── (d) a `worktree list` that will not answer is a refusal, not a pass
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const branch = "lean/issue-4";
  const wt = worktree(repoRoot, baseSha, 4, branch);
  const boom: ExecFn = async (cmd, o) => {
    if ((o?.argv ?? []).includes("list")) throw new Error("fatal: could not read worktrees");
    return exec(cmd, o);
  };
  let msg = "";
  try {
    await assertSpecifyWorktreeOwned(boom, { repoRoot, wt, baseSha, branch });
  } catch (err) {
    msg = (err as Error).message;
  }
  assert(
    OWNED.test(msg),
    `(d) an unreadable worktree list refuses rather than passing (got ${msg || "no throw"})`,
  );
}

// ───── (e) an ancestry probe that could not run is never read as "descends"
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const branch = "lean/issue-5";
  const wt = worktree(repoRoot, baseSha, 5, branch);
  commitOne(wt, "child.ts");
  const broken: ExecFn = async (cmd, o) => {
    if ((o?.argv ?? []).includes("merge-base"))
      throw Object.assign(new Error("fatal: not a valid object name"), { code: 128 });
    return exec(cmd, o);
  };
  let msg = "";
  let threw = false;
  try {
    await assertSpecifyWorktreeOwned(broken, {
      repoRoot,
      wt,
      baseSha,
      branch,
      allowAheadOfBase: true,
    });
  } catch (err) {
    threw = true;
    msg = (err as Error).message;
  }
  assert(threw, `(e) a probe that exits 128 throws (got ${msg || "no throw"})`);
  assert(
    /could not tell whether HEAD/.test(msg),
    `(e) the throw says the predicate could not be established (got ${msg})`,
  );
  assert(
    !/expected/.test(msg),
    `(e) it is NOT reported as the ordinary foreign-tree refusal (got ${msg})`,
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
