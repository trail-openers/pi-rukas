/**
 * lib/lean-handback-net-git-cases — the shared drive and the table the origin reads are judged on.
 *
 * `src/lean/handback-rewind.ts` reads origin four times on a rewind that pushes: the
 * branch before the push (`originRef` → `quiet`), the branch and its keeping-ref after
 * it (the `Promise.all` pair), and `originBranchHead`, the read the handback step makes
 * for its record. Each is one network `git ls-remote` carrying the same requested
 * ceiling and buffer. A read with no `killGroup` leaves its ssh grandchild holding
 * stdout past that ceiling — the non-group path kills only the direct child — and a
 * read with no non-interactive env lets ssh read a passphrase from /dev/tty. Both are
 * facts about the call, so both are asserted on the call.
 *
 * Both arms drive `rewindToVerified` and `originBranchHead` with one recorder
 * (lib/lean-handback-recording-exec.ts) over one real bare origin, so the reads answer
 * for real and the recorder can be asked what it was handed. The expected env is
 * derived by calling the same `netGitEnv` production calls — an expectation typed out
 * by hand would be a second definition of the wrapper — and `GIT_SSH_COMMAND`/`GIT_SSH`
 * are pinned by the caller before the drive so the derivation has one answer.
 *
 * The arms live in one module because they share the drive and the expectation table,
 * and an off arm that drifts from the call shape it is supposed to reproduce is exactly
 * what the pair exists to catch.
 */

import { originBranchHead, rewindToVerified } from "../../src/lean/handback-rewind.ts";
import { netGitEnv, netGitTimeoutMs } from "../../src/work-driver-net-git.ts";
import type { Rewind } from "../../src/lean/handback-rewind.ts";
import { unverifiedRef } from "../../src/lean/handback-rewind.ts";
import { BRANCH, ISSUE } from "./lean-verified-handback-fixture.ts";
import { repoWithFixHead } from "./lean-verified-handback-repo.ts";
import { type RecordingExec, recordingExec } from "./lean-handback-recording-exec.ts";

/** One executor call as the recorder saw it. */
export type RecordedCall = RecordingExec["calls"][number];

/** The ceiling each in-scope read requests, as the shipped call spells it. */
export const READ_TIMEOUT_MS = 60_000;
/** The buffer cap each in-scope read carries, as the shipped call spells it. */
export const READ_MAX_BUFFER = 4 * 1024 * 1024;
/** The ssh command both arms pin, so the derived env has one answer rather than the host's. */
export const PINNED_SSH = "/usr/bin/ssh -i /dev/null";

/**
 * The env a routed read must carry: `netGitEnv` over the pinned env, from the wrapper itself.
 *
 * `runNetGit` derives it from `process.env`, so the two ssh keys below must already be
 * pinned when this is called — the expectation is then the same function's answer, not a
 * transcription of it.
 */
export function expectedNetEnv(cwd: string): NodeJS.ProcessEnv {
  return netGitEnv(process.env, cwd);
}

/** What the wrapper hands the executor for a {@link READ_TIMEOUT_MS} request. */
export function expectedTimeout(): number {
  return Math.min(READ_TIMEOUT_MS, netGitTimeoutMs());
}

/** A rewind target the fixture's clone can supply, so the push lands and reads back. */
export interface HandbackRepo {
  repoRoot: string;
  /** The head the green verify certified — what the rewind moves the branch back to. */
  baseSha: string;
  /** The head origin's branch holds when the drive starts, which the keeping-ref must keep. */
  branchHeadSha: string;
}

/** One drive, recorded: a real repo, a rewind that pushes, and the record's own read. */
export interface DrivenReads {
  repo: HandbackRepo;
  /** Every `ls-remote` the drive made — the in-scope origin reads, pre- and post-push. */
  reads: RecordedCall[];
  /** The rewind's push, which this module never rewrites. */
  push: RecordedCall | undefined;
  /** What the rewind settled on — the cases assert it shipped, so the reads are real. */
  rewind: Rewind;
  /** What the record read back off origin after the move. */
  head: string | undefined;
}

/**
 * Drive the rewind and the record's read over one real origin with one recorder.
 *
 * `net: true` because that is how production drives it (`rewindFor` in
 * `lean/report-handlers.ts`), which is also what makes the pushed head reachable: the
 * rewind's own push carries the objects, so the post-push reads answer.
 */
export async function driveReads(): Promise<DrivenReads> {
  const repo = repoWithFixHead();
  const recorder = recordingExec();
  const ctx = { repoRoot: repo.repoRoot, issue: ISSUE, run: { branch: BRANCH } };
  const rewind = await rewindToVerified(recorder.exec, ctx as never, repo.baseSha, {
    net: true,
  });
  const head = await originBranchHead(recorder.exec, ctx as never);
  return { repo, reads: recorder.lsRemote(), push: recorder.push(), rewind, head };
}

/** The in-scope read of one ref: the branch pre-push, or either ref of the post-push pair. */
export function readForRef(reads: RecordedCall[], ref: string): RecordedCall | undefined {
  return reads.find((r) => r.argv?.includes(ref) === true);
}

/** A read named the way a reader would name it: the command line it ran. */
export function describeRead(read: RecordedCall): string {
  return `${read.cmd} ${(read.argv ?? []).join(" ")}`;
}

/** The four origin reads one full rewind drive makes, in call order. */
export function expectedReadRefs(issue: number = ISSUE): string[] {
  const branchRef = `refs/heads/${BRANCH}`;
  return [branchRef, branchRef, unverifiedRef(issue), branchRef];
}

/** Every ref the drive was asked to read, in the order the recorder saw them. */
export function readRefs(driven: DrivenReads): string[] {
  return driven.reads.map((r) => r.argv?.[r.argv.length - 1] ?? "<no ref>");
}

/**
 * Whether a read carried no env of its own — the off arm's shape.
 *
 * `execp` forwards `opts.env` and never merges `process.env` into it, so the value that
 * reaches git from an env-less call is nothing at all. Only a read the step handed an env
 * can be judged against `netGitEnv`, which is why the off-arm case asserts absence and
 * the on-arm case asserts the wrapper's answer.
 */
export function hasNoEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  return env === undefined;
}

export { BRANCH, ISSUE };
