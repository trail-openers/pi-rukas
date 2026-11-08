/**
 * lean/verify-frozen-defect — is this red gate the FROZEN CONTRACT's fault?
 *
 * `verify` routes every red into a build round, and a build round may not touch a
 * frozen file: that is what "frozen" means. So a red PROJECT TIER plus a project
 * freeze check that fails ON one of the run's frozen paths is not a verdict any
 * round this run has left can act on — the contract itself is defective, and the
 * honest answer is a hand-back that bills nothing.
 *
 * The attribution needs two runs of the same check, because "the gate is red" is
 * not evidence about these files: once at HEAD in the tree the tiers left, and
 * again in a throwaway detached checkout of HEAD with every frozen file deleted.
 * Green without them, red with them, and the check's own output naming one of
 * them, is the only shape that says THESE files broke the gate rather than THIS
 * repository's gate is red.
 *
 * A checkout rather than a delete-and-restore in the run's own worktree: `verify`
 * is a read-only gate, and bytes it removed are bytes its own post-tier re-checks
 * would then report as tampering. The probe tree is provisioned, so a check that
 * loads the project's toolchain sees the one the tiers saw.
 *
 * Every failure to build or judge that tree means "no attribution", never
 * "defective": the tier's own red stands and the run takes the build round it
 * would have taken anyway. A check that could not run is not a colour.
 */

import { rmSync } from "node:fs";
import path from "node:path";
import { trace } from "../trace.ts";
import { verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import type { ExecFn } from "../worktree.ts";
import {
  type FreezeCheck,
  freezeCheckDrops,
  freezeCheckNote,
  namedCandidates,
  runFreezeCheck,
} from "./freeze-check.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import type { VerifyExec } from "./verify-types.ts";

/** The probe's git calls are the driver's, so they get the host-channel env. */
const GIT_BUFFER = 1024 * 1024;

/**
 * Why this red gate is really a DEFECTIVE FROZEN CONTRACT, or `undefined` when
 * nothing here blames the contract.
 *
 * `wt` is the run's worktree as the tiers left it; `head` is the commit `verify`
 * certified. `frozen` is the run's frozen map — the only paths a defect can be
 * attributed to, which is why the check's output naming some OTHER path buys
 * nothing.
 */
export async function defectiveFrozenContract(
  exec: VerifyExec,
  repoRoot: string,
  issue: number,
  wt: string,
  head: string,
  cmd: string,
  frozen: Record<string, string>,
): Promise<string | undefined> {
  const atHead = await runFreezeCheck(cmd, wt, exec);
  if (atHead.kind !== "red") {
    const note = freezeCheckNote(cmd, true, atHead);
    if (note !== "") trace(`lean/verify: ${note}`);
    return undefined;
  }
  const names = Object.keys(frozen);
  if (namedCandidates(atHead.output, names).length === 0) return undefined;
  const without = await runCheckWithoutFrozen(exec, repoRoot, issue, head, cmd, names);
  const drops = freezeCheckDrops(without, atHead, cmd, names);
  if (drops === undefined) {
    if (without.kind === "unknown") trace(`lean/verify: ${freezeCheckNote(cmd, true, without)}`);
    return undefined;
  }
  return `frozen contract defective: ${cmd} fails on frozen file ${drops[0]?.path ?? names[0]}`;
}

/**
 * The project's freeze check, run in a throwaway detached checkout of `head`
 * with every frozen path removed. `unknown` whenever the tree or the check could
 * not be judged — the caller reads that as "no attribution".
 */
async function runCheckWithoutFrozen(
  exec: VerifyExec,
  repoRoot: string,
  issue: number,
  head: string,
  cmd: string,
  names: string[],
): Promise<FreezeCheck> {
  const probe = frozenContractProbePath(repoRoot, issue);
  // The probe's own git calls are the driver's, so they keep the one knob that
  // decides where a host-channel cycle reports (see `verifyHostEnv`); the check
  // itself runs scrubbed, like every other project command.
  const env = verifyHostEnv();
  const git = (argv: string[], cwd: string, timeout: number, maxBuffer: number) =>
    exec("git", {
      argv: [...NO_HOOKS, ...argv],
      cwd,
      timeout,
      maxBuffer,
      env,
    }).catch(() => undefined);
  // Not hygiene: a registration a killed run left behind makes the next `add` at
  // this path refuse, and the attribution would be lost for a tree nothing here
  // is holding.
  await git(["worktree", "remove", "--force", probe], repoRoot, 60_000, 256 * 1024);
  try {
    const added = await exec("git", {
      argv: [...NO_HOOKS, "worktree", "add", "--detach", probe, head],
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: GIT_BUFFER,
      env,
    }).catch((err: unknown) => ({ __err: err }) as never);
    if ((added as { __err?: unknown })?.__err !== undefined) {
      trace(`lean/verify: freeze-check probe tree ${probe} could not be created`);
      return { kind: "unknown", detail: `probe tree ${probe} could not be created` };
    }
    // A tier may have dropped untracked bytes in the run's worktree, and those are
    // not part of HEAD's tree; `clean -fdx` in a throwaway detached checkout costs
    // one spawn and has no consequence anywhere else.
    await git(["clean", "-fdx"], probe, 60_000, 4 * 1024 * 1024);
    // The frozen paths are the ones the contract vouches for, so they leave
    // through git's own index removal plus a delete — never through a path the
    // check's output chose.
    await git(["rm", "-q", "--cached", "--", ...names], probe, 60_000, GIT_BUFFER);
    for (const rel of names) await rmSync(path.join(probe, rel), { force: true });
    await provisionWorktree(exec as ExecFn, repoRoot, probe);
    return await runFreezeCheck(cmd, probe, exec);
  } finally {
    // Visible rather than swallowed: a tree git still holds makes the next run's
    // `add` at this path refuse, and a leak nobody can see is found as a mystery.
    await git(["worktree", "remove", "--force", probe], repoRoot, 60_000, 256 * 1024);
  }
}

/** The throwaway checkout of HEAD the freeze check's attribution run happens in. */
function frozenContractProbePath(repoRoot: string, issue: number): string {
  // SIBLING to the repo, not under it — the rule `baselineProbeWorktreePath` gives
  // the baseline probe for the same reason: a probe tree inside the repository is
  // a stray path every porcelain read of that repository then reports.
  const trimmed = repoRoot.replace(/[/]+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return `${trimmed.slice(0, cut)}/${trimmed.slice(cut + 1)}.freeze-check-lean-verify-${issue}`;
}
