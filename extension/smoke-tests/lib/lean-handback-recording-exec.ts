/**
 * lib/lean-handback-recording-exec — a recorder that can answer what the origin reads
 * were RUN with, not only what they were asked to run.
 *
 * `src/lean/handback-rewind.ts` reads origin's branch with `git ls-remote` on the
 * injected executor: `originBranchHead`, and `quiet()` behind `originRef()` — the
 * pre-push held read and the post-push pair. A hung read keeps its ssh grandchild
 * alive when the call carries no `killGroup`, because the non-group path kills only
 * the direct child; and it keeps prompting for a passphrase when the call carries no
 * non-interactive env. Both are facts about the CALL, so the assertion has to be made
 * on the call — and the pre-existing rigs that reach these reads alter it:
 * `lib/lean-verified-handback-fixture.ts` replaces `opts.env` with `stepGitEnv()`
 * before the executor sees it, so a case driven through it could never tell an env the
 * caller supplied from an env the rig substituted; `lib/exec-fake.ts` and
 * `lib/worktree-sweep-fixture.ts` merge env and record `cmd`/`cwd`/`argv` alone.
 *
 * So this records and forwards untouched — `cmd`, `argv`, `env`, `killGroup`,
 * `timeout`, `maxBuffer` — and otherwise forwards to the fixture's real executor, so
 * origin still decides every ref the cases assert on. The recorder is a spy, not a
 * stub: nothing here answers a git question.
 */

import type { VerifyExec } from "../../src/lean/verify-types.ts";
import { execp } from "../../src/exec.ts";

/** One executor call, as the code under test handed it to the seam. */
export interface RecordedCall {
  cmd: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  killGroup?: boolean;
  timeout?: number;
  maxBuffer?: number;
}

/** A recorder plus the real executor behind it; `calls` is in call order. */
export interface RecordingExec {
  exec: VerifyExec;
  calls: RecordedCall[];
  /** Every `ls-remote` the drive made — the in-scope origin reads, pre- and post-push. */
  lsRemote(): RecordedCall[];
  /** The one rewind push, or `undefined` when the arm pushed nothing. */
  push(): RecordedCall | undefined;
}

const names = (argv: string[] | undefined, want: string): boolean =>
  argv?.includes(want) === true;

/** The recorder's own view of the seam's options: both executor signatures, and `killGroup`. */
type SpyOpts = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  killGroup?: boolean;
  timeout?: number;
  maxBuffer?: number;
};

/** New recorder per case: one drive, one call log. */
export function recordingExec(): RecordingExec {
  const calls: RecordedCall[] = [];
  const spy = ((cmd: string, opts?: SpyOpts) => {
    calls.push({
      cmd,
      argv: opts?.argv === undefined ? undefined : [...opts.argv],
      env: opts?.env,
      killGroup: opts?.killGroup,
      timeout: opts?.timeout,
      maxBuffer: opts?.maxBuffer,
    });
    return execp(cmd, opts ?? {});
  }) as VerifyExec;
  return {
    exec: spy,
    calls,
    lsRemote: () => calls.filter((c) => names(c.argv, "ls-remote")),
    push: () => calls.find((c) => names(c.argv, "push")),
  };
}
