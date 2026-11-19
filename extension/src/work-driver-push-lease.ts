/**
 * work-driver-push-lease — the sha this cycle last pushed to a branch, and the push
 * that leases on it.
 *
 * A cycle can publish its branch and then rewrite it: commit-pr re-runs after a failure
 * past the push, and `integrate()` in create mode rebuilds the branch from the base. A
 * plain `git push` of the rewrite is refused as non-fast-forward. A push that rebuilds
 * a branch this cycle already published therefore carries
 * `--force-with-lease=<branch>:<sha this cycle pushed last>`: it replaces only what this
 * cycle put there. A branch someone else moved since fails the lease (`stale info`) and
 * stays refused. There is never a bare `--force`. A push that only adds commits on top
 * of the remote branch (a followup round, `--continue-pr`) takes no lease: it is a
 * fast-forward or nothing, and commits someone else added on top must not refuse it.
 *
 * The record is `pushed.json` in the cycle's scratch dir (`tmp/issue-<n>/`), a map of
 * branch to sha, written after every push the driver makes of the branch. It survives
 * `--restart`, so a restarted cycle may replace what the earlier cycle of the same issue
 * pushed, and still never what someone else pushed. A missing or
 * unreadable record means no lease: the plain push, which a rewrite cannot get past.
 * A record that failed to write leaves an older sha, so the next lease fails rather
 * than overwriting anything.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExecFn } from "./worktree.ts";

const RECORD = "pushed.json";
const SHA = /^[0-9a-f]{40}$/;

async function readRecord(scratchDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(scratchDir, RECORD), "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The sha this cycle last pushed to `branch`, or undefined when it has not pushed it. */
export async function pushedShaOf(scratchDir: string, branch: string): Promise<string | undefined> {
  const sha = (await readRecord(scratchDir))[branch];
  return typeof sha === "string" && SHA.test(sha) ? sha : undefined;
}

/** Record `sha` as what this cycle pushed to `branch`. Best effort: see the header. */
export async function recordPushedSha(scratchDir: string, branch: string, sha: string) {
  if (!SHA.test(sha)) return;
  const record = { ...(await readRecord(scratchDir)), [branch]: sha };
  await fs
    .mkdir(scratchDir, { recursive: true })
    .then(() => fs.writeFile(path.join(scratchDir, RECORD), `${JSON.stringify(record)}\n`))
    .catch(() => undefined);
}

/** Record the local tip of `branch` after a push of it succeeded. */
export async function recordPushedBranch(
  execFn: ExecFn,
  repoRoot: string,
  scratchDir: string,
  branch: string,
) {
  const sha = await execFn("git", {
    cwd: repoRoot,
    argv: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
  }).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  await recordPushedSha(scratchDir, branch, sha);
}

/** The argv of `git push -u origin <branch>`; a `rebuild` leases when this cycle pushed it. */
export async function pushArgv(
  scratchDir: string,
  branch: string,
  rebuild: boolean,
): Promise<string[]> {
  const lease = rebuild ? await pushedShaOf(scratchDir, branch) : undefined;
  const leaseArg = lease === undefined ? [] : [`--force-with-lease=${branch}:${lease}`];
  return ["push", "-u", ...leaseArg, "origin", branch];
}
