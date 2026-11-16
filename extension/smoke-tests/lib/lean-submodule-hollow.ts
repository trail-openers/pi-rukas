/**
 * lib/lean-submodule-hollow — one superproject whose submodule can be seeded EMPTY.
 *
 * The state a disclosure has to catch and a stub cannot honestly produce: a submodule
 * checkout at the commit the base's gitlink names, with a real git dir and a real index,
 * whose work tree holds NOTHING. `git submodule status` calls the path populated, the
 * record the reset verifies against is present, and the directory beside it is empty. It
 * is the field shape the feature exists for — the operator's superproject holds the
 * submodule and something about it quietly lost its content — and the reason the
 * disclosure reads the TREE instead of believing the pass's own account.
 *
 * What the fixture therefore supplies is the SITUATION, never the state under test:
 *
 *   - a superproject whose base carries a real submodule at `vendor/lib`, with its objects
 *     in the module store and the remote that mounted them deleted afterwards — so the
 *     store is the only source on this host, and a run that populated the tree from the
 *     network would have failed rather than passed (`.gitmodules` records a URL nothing can
 *     reach, which is the field report this feature came from);
 *   - an EMPTY working base for the case's reset, the way the reset's own `clean -fdx`
 *     leaves a submodule: the path registered as a `160000` gitlink and nothing on disk.
 *     This is the whole point of the fixture's asymmetry — the OPERATOR's checkout keeps
 *     its files, because that is where the seeding reads them from, while the tree the run
 *     works in starts out with none. A fixture that handed the run an already-populated
 *     submodule would let the pass succeed by doing nothing, and the case would report a
 *     disclosure for a state nobody produced.
 *
 * The case then stands in for ONE command — git's populating call, whose clone is the only
 * part of a real pass that can be replaced without touching the judgement — and what it
 * leaves is `git read-tree --empty` + `git checkout-index -a -f`: git's own way to make an
 * empty index and an empty work tree, so the emptiness is git's answer and not a fiction the
 * fixture asserted.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  INSIDE,
  SUB,
  gitEnv,
  gitIn,
  plainRepo,
  remoteRepo,
  retarget,
  severAlternates,
} from "./lean-submodule-local-fixture.ts";

/** The URL the hollow base records: a host nothing answers, so no case can cheat by fetching. */
const HOLLOW_URL = "https://example.invalid/hollow.git";

/**
 * A superproject carrying a real submodule, and an empty working base to reset.
 *
 * `baseSha` is the commit whose tree holds the gitlink and nothing else; `operatorTree` is
 * the operator's own checkout, which keeps the submodule's files and is where the seeding
 * finds them. `wt` is created under `repoRoot` so the shared module store is git's own.
 */
export function hollowSubmoduleRepo(tag: string): {
  repoRoot: string;
  baseSha: string;
  wt: string;
  /** The commit the base's gitlink records — what the disclosure promises to look for. */
  recorded: string;
  /** The submodule's module store: the only source for the submodule on this host. */
  store: string;
  /** The operator's checkout of the base, submodule populated — the seeding's source. */
  operatorTree: string;
} {
  const remote = remoteRepo(`${tag}-sub`);
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
  const store = path.join(repoRoot, ".git", "modules", ...SUB.split("/"));
  if (!existsSync(path.join(store, "objects")))
    throw new Error(`the hollow fixture's module store is missing at ${store}`);
  // The store keeps the local mount as its `origin`, so the seeding has a source git will
  // not complain about, and only `.gitmodules` lies. It is then severed from the mount (an
  // `objects/info/alternates` or a `core.objectsPath` pointing at it), which is deleted
  // below: after that the store answers for its own objects or the case fails loudly.
  gitIn(store, "remote", "set-url", "origin", remote);
  retarget(repoRoot, "submodule", HOLLOW_URL);
  gitIn(store, "remote", "set-url", "origin", HOLLOW_URL);
  severAlternates(store);
  gitIn(repoRoot, "add", "-A");
  gitIn(repoRoot, "commit", "-q", "-m", "carry the submodule with a URL nothing can reach");
  const recorded =
    gitIn(repoRoot, "ls-tree", "HEAD", "--", SUB).split("\t")[0]?.split(/\s+/)?.[2] ?? "";
  if (!/^[0-9a-f]{40}$/.test(recorded))
    throw new Error(`the hollow fixture's base records no gitlink at ${SUB}`);
  // The operator's checkout, submodule and all: the run's base must NOT look like this. A
  // linked worktree checks a submodule out as an empty gitlink and keeps its objects in the
  // shared store, so the checkout is filled from the store the way a real populate does it —
  // this tree is a stand-in for a human's working copy, not the thing under test.
  const operatorTree = path.join(repoRoot, "operator-checkout");
  gitIn(repoRoot, "worktree", "add", "-q", "--detach", operatorTree, "HEAD");
  gitIn(
    operatorTree,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--",
    SUB,
  );
  if (!holds(operatorTree, INSIDE))
    throw new Error(
      `the hollow fixture's operator checkout has no submodule content at ${operatorTree}/${INSIDE} — the seeding would have nothing to copy and every case below would be about an absent submodule`,
    );
  // The empty working base the case resets. `update-index --cacheinfo` writes the gitlink
  // without a fetch, so the base describes the submodule while its tree holds none of it —
  // the same shape a `clean -fdx` leaves behind, and the reason the run's own tree cannot be
  // the source it seeds from.
  // The run's own tree, emptied the way the reset's `clean -fdx` empties it: the path stays
  // registered as a `160000` gitlink, and the bytes are gone. No commit is made for it — the
  // base must stay the base, and a commit whose only change is a submodule's disappearance is
  // the sort of commit git refuses to make anyway, which is why a deletion staged here would
  // have died on `commit` rather than on an assertion.
  const wt = path.join(repoRoot, ".worktrees", `lean-${tag}`);
  gitIn(repoRoot, "worktree", "add", "-q", "--detach", wt, "HEAD");
  rmSync(path.join(wt, SUB), { recursive: true, force: true });
  if (gitIn(wt, "ls-files", "-s", "--", SUB).startsWith("160000 ") === false)
    throw new Error(
      `the hollow fixture's emptied tree no longer registers ${SUB} as a gitlink in ${wt}`,
    );
  const baseSha = gitIn(wt, "rev-parse", "HEAD");
  rmSync(remote, { recursive: true, force: true });
  if (holds(wt, INSIDE))
    throw new Error(`the hollow fixture left submodule content in the run's tree at ${wt}`);
  return { repoRoot, baseSha, wt, recorded, store, operatorTree };
}

/**
 * Whether one argv is the submodule-populating call.
 *
 * Recognised by its shape rather than by a substring of it: `submodule update` addressed at
 * the submodule's own path with `--`. A case that stands in for git's clone matches on the
 * same tokens the product issues, so a step that changed the command it ran would not be
 * intercepted, and the case would say so by failing rather than by quietly passing.
 */
export function isSubmodulePopulate(argv: readonly string[]): boolean {
  return (
    argv.includes("submodule") &&
    argv.includes("update") &&
    argv.includes("--") &&
    argv.includes(SUB)
  );
}

/** Whether `dir`'s work tree holds `rel` — the check a case states as a contradiction. */
export function holds(dir: string, rel: string): boolean {
  try {
    return existsSync(path.join(dir, rel));
  } catch {
    return false;
  }
}

/**
 * git in `dir`, asking a question or making one.
 *
 * The shared environment, not a second one: a case that asks git what a tree holds must ask
 * it the same way the fixture built it, or the answer describes a different repository.
 */
export function gitAsk(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}
