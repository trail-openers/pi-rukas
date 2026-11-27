/**
 * lib/lean-handback-net-git-cases — the drive the origin reads are observed through, and
 * the expectation table they are judged on.
 *
 * `src/lean/handback-rewind.ts` reads origin four times on a rewind that pushes: the
 * held head before the push, the branch and its keeping-ref after it (the `Promise.all`
 * pair), and `originBranchHead`, the read the handback step makes for its record. All of
 * them go through the file's single `originRead` helper, so each is one network
 * `git ls-remote` carrying the same requested ceiling and buffer. A read with no
 * `killGroup` leaves its ssh grandchild holding stdout past that ceiling — the non-group
 * path kills only the direct child — and a read with no non-interactive env lets ssh
 * read a passphrase from /dev/tty. Both are facts about the call, so both are asserted on
 * the call.
 *
 * The drive runs `rewindToVerified` and `originBranchHead` against one recorder
 * (lib/lean-handback-recording-exec.ts) over one real bare origin, so the reads answer
 * for real and the recorder can be asked what it was handed. The expected env is derived
 * by calling the same `netGitEnv` production calls — an expectation typed out by hand
 * would be a second definition of the wrapper — and `GIT_SSH_COMMAND`/`GIT_SSH` are
 * pinned by the caller before the drive so the derivation has one answer.
 *
 * WHY THE REWIND IS DRIVEN WITH `net: false`. The three reads the rewind makes name no env
 * of their own when the drive supplies none, so the value that reaches them is the step
 * env `lib/lean-verified-handback-step.ts` hands its executor — `stepGitEnv()`, recorded
 * from the drive's own push so the expectation is what was actually handed rather than a
 * re-derivation of it. The guard's own origin probe (`publish-deps.ts`) does route
 * through the wrapper, but it is a shell-form `git ls-remote --symref origin HEAD`: it is
 * not one of the four reads, and it must not be mistaken for the supplier of their env.
 * With production's `net: true` every read arrives carrying `netGitEnv` before the wrapper
 * is consulted, and only `killGroup` is left to discriminate.
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
/** The ssh command the caller pins, so the derived env has one answer rather than the host's. */
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
  /** The one rewind push, or `undefined` when the arm pushed nothing. */
  push: RecordedCall | undefined;
  /** What the rewind settled on — the cases assert it shipped, so the reads are real. */
  rewind: Rewind;
  /** What the record read back off origin after the move. */
  head: string | undefined;
  /** The recorder behind `reads`/`push`, exposed so a case can name the calls it judged. */
  recorder: RecordingExec;
}

/**
 * Drive the rewind and the record's read over one real origin with one recorder.
 *
 * `opts.net` is passed to `rewindToVerified` verbatim, because whether the rewind's reads
 * arrive with an env already on them decides what the drive can prove: with `net: true`
 * production's net env is on every read before the wrapper is consulted, and only the
 * `killGroup` is left to discriminate.
 *
 * The pushed head is reachable either way: the rewind's own push carries the objects, so
 * the post-push reads answer whatever the reads themselves were handed.
 */
export async function driveReads(opts: { net: boolean } = { net: true }): Promise<DrivenReads> {
  const repo = repoWithFixHead();
  const recorder = recordingExec();
  const ctx = { repoRoot: repo.repoRoot, issue: ISSUE, run: { branch: BRANCH } };
  const rewind = await rewindToVerified(recorder.exec, ctx as never, repo.baseSha, {
    net: opts.net,
  });
  const head = await originBranchHead(recorder.exec, ctx as never);
  return { repo, reads: recorder.lsRemote(), push: recorder.push(), rewind, head, recorder };
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

export { BRANCH, ISSUE };
