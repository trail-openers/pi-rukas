/**
 * lib/lean-verify-probe-tree — how the exec stub recognises the BASELINE PROBE's own tree.
 *
 * The stub in `lean-verify-exec.ts` answers a different set of questions inside the probe
 * than it does at HEAD, so everything that decides "is this call the probe" lives here:
 * the canonical path the probe's throwaway checkout is built at, and the one predicate
 * that tells a probe call apart from the run's own worktree. They live apart from the
 * stub because they are facts about a tree rather than arms of a dispatch, and both are
 * read by the fixture directly — the case needs the path to assert the checkout is gone.
 *
 * Prose in this file is read by the unscrubbed-spawn gate in
 * test-verify-loop-git-env.ts, which blanks quoted spans BEFORE it blanks comments. A
 * quote pair that opens on one line and closes on another deletes the lines between them
 * from that analysis, so every quote pair here stays on one line and the git spawn below
 * keeps its scrubbed env in the last argument of the call.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { NO_HOOKS } from "../../src/lean/specify-reset.ts";
import { baselineProbeWorktreePath } from "../../src/lean/verify-baseline.ts";
import type { VerifyExec } from "../../src/lean/verify-types.ts";
import { gitTestEnv } from "./git-test-env.ts";

/**
 * The probe's tree path, canonicalised the way `probeTierAtBase` builds it.
 *
 * On macOS `tmpdir()` is `/var/…`, a symlink to `/private/var`, and a path built from
 * the raw tmpdir is never equal to the one the probe actually runs in — so a probe call
 * would be mistaken for a HEAD run and answered from the run's own red counter. The
 * tree does not exist yet, so `realpathSync` cannot resolve it; its PARENT (which the
 * fixture created) is canonicalised and the leaf re-joined.
 */
export function canonicalProbeDir(repoRoot: string, issue: number): string {
  const probePath = baselineProbeWorktreePath(repoRoot, issue);
  const probeParent = path.dirname(probePath);
  return path.join(realpathSync(probeParent), probePath.slice(probeParent.length + 1));
}

/**
 * The ONE fact that makes an exec call "the probe": it names the probe's own tree, and
 * that tree is REGISTERED with git.
 *
 * Both halves are needed, and each kills one way the fixture could lie to itself.
 *
 * Naming the probe's path is what separates the probe from every other call the step
 * makes: the run's OWN worktree is a registered worktree too, so "is a registered
 * worktree" alone would answer the step's rev-parse HEAD in its own tree as a probe
 * call and every case would die at the very first read.
 *
 * Registration is what keeps a stubbed failure honest. When a case makes a worktree add
 * refuse, the tree was never created; without this check the add itself (whose argv
 * names the path) would be answered from the base options, so the probe would be reading
 * its own add as a red frozen test and the run would surface unusable for the wrong
 * reason. `probeTierAtBase` removes the tree in a finally, so the window in which git
 * lists it is exactly the window in which the probe runs.
 */
export function namesProbeTree(
  repoRoot: string,
  probeDir: string,
  o2: Parameters<VerifyExec>[1] | undefined,
): boolean {
  const named: string[] = [];
  if (typeof o2?.cwd === "string") named.push(o2.cwd);
  if (Array.isArray(o2?.argv)) named.push(...o2.argv.filter((a) => typeof a === "string"));
  if (!named.some((p) => p === probeDir)) return false;
  // The scrubbed env is threaded into the child rather than left to the runner: a direct
  // run of a test starts with the environ the operator exported, where an inherited
  // GIT_DIR would retarget this read into some other repository.
  const listed = spawnSync("git", [...NO_HOOKS, "worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  if (listed.status !== 0) return false;
  const registered = new Set(
    (listed.stdout ?? "")
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length)),
  );
  return named.some((p) => registered.has(p));
}
