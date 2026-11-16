#!/usr/bin/env bun
/**
 * The handback's origin reads are network git calls, so they carry what every other
 * network git call carries: the non-interactive env and the process-group kill.
 *
 * `src/lean/handback-rewind.ts` reads origin with `git ls-remote` four times on a
 * rewind that pushes — `originBranchHead`, and `quiet()` behind `originRef()` for the
 * held head, the branch after the push, and the keeping-ref — and until #2279 those
 * calls carried neither. The consequence is specific and it is the bug: a read with no
 * `killGroup` is killed only at its direct child, so an ssh grandchild holding stdout
 * outlives the ceiling and the trial it belongs to is lost; a read with no
 * `GIT_TERMINAL_PROMPT=0` and no BatchMode waits on /dev/tty for a passphrase rather
 * than failing. `test-driver-network-git-env.ts` is the enumeration gate for that
 * class, and its blind spot is why the reads shipped unrouted.
 *
 * The assertions are made on the RECORDED CALL. The env-substituting rig
 * (`lib/lean-verified-handback-fixture.ts`'s exec, which overwrites `opts.env`) is not
 * used here, because a case driven through it cannot distinguish an env the code
 * supplied from one the rig substituted. The recorder forwards untouched and the
 * expected env is derived by calling `netGitEnv` itself, so nothing re-types the
 * wrapper. `GIT_SSH_COMMAND`/`GIT_SSH` are pinned before each drive so that derivation
 * has one answer, and `PI_ENSEMBLE_GIT_NET_TIMEOUT_MS` is absent so the ceiling each
 * read ends up carrying is `min(60 s, the shipped net-git bound)` and not a value
 * another case exported.
 *
 * The push is asserted untouched in the same breath: this change routes reads, and a
 * fix that also reached the push would break the `LEAN_REWIND_LEASE_BINDS` off arm's
 * promise to restore the pre-fix push byte for byte.
 */

import { rmSync } from "node:fs";
import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import { resetSshConfigCache } from "../src/work-driver-net-git.ts";
import {
  PINNED_SSH,
  READ_MAX_BUFFER,
  READ_TIMEOUT_MS,
  BRANCH,
  ISSUE,
  describeRead,
  driveReads,
  expectedNetEnv,
  expectedReadRefs,
  expectedTimeout,
  readForRef,
  readRefs,
} from "./lib/lean-handback-net-git-cases.ts";
import { ROOTS } from "./lib/lean-verified-handback-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";

const { assert, failures } = makeAssert();

await withEnv(
  {
    GIT_SSH_COMMAND: PINNED_SSH,
    GIT_SSH: undefined,
    // Absent, so the bound the reads are clamped to is the shipped default and the
    // recorded timeout is `min(60 s, 300 s)` rather than whatever the shell pinned.
    PI_ENSEMBLE_GIT_NET_TIMEOUT_MS: undefined,
    // The lease switch is this change's neighbour, not its subject: pin it on so the
    // on-arm drive measures the routed reads and nothing else.
    PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS: "1",
    PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT: "1",
  },
  async () => {
    // `netGitEnv` caches the repo's `core.sshCommand` for the process's lifetime, so a
    // cached answer from another file in this bun process would be this drive's answer.
    resetSshConfigCache();
    const driven = await driveReads();

    assert(
      driven.rewind.shipped === true,
      `the drive's rewind shipped, so every in-scope read actually ran (${JSON.stringify(driven.rewind)})`,
    );
    assert(
      driven.head === driven.repo.baseSha,
      `the record's own read sees the verified head the rewind moved to (${String(driven.head)})`,
    );
    assert(
      JSON.stringify(readRefs(driven)) === JSON.stringify(expectedReadRefs()),
      `exactly the four in-scope origin reads ran, in call order (${readRefs(driven).join(", ")})`,
    );

    const env = expectedNetEnv(driven.repo.repoRoot);
    for (const read of driven.reads) {
      const what = describeRead(read);
      assert(read.killGroup === true, `${what} runs in its own process group (killGroup)`);
      assert(
        read.env !== undefined && read.env.GIT_TERMINAL_PROMPT === "0",
        `${what} carries GIT_TERMINAL_PROMPT=0, so git cannot prompt (got ${JSON.stringify(read.env?.GIT_TERMINAL_PROMPT)})`,
      );
      assert(
        read.env !== undefined && read.env.GIT_SSH_COMMAND === env.GIT_SSH_COMMAND,
        `${what} carries the wrapper's GIT_SSH_COMMAND, so ssh fails instead of reading a passphrase (got ${JSON.stringify(read.env?.GIT_SSH_COMMAND)})`,
      );
      assert(
        read.timeout === expectedTimeout(),
        `${what} keeps its requested ceiling, clamped by the wrapper to ${String(expectedTimeout())}ms (got ${String(read.timeout)})`,
      );
      assert(
        read.maxBuffer === READ_MAX_BUFFER,
        `${what} keeps its explicit ${String(READ_MAX_BUFFER)}-byte buffer (got ${String(read.maxBuffer)})`,
      );
      assert(
        read.argv?.includes("ls-remote") === true && read.argv.includes("origin") === true,
        `${what} is still the branch read the step needs`,
      );
    }

    // Named individually, so a fix that routed only some of the four is reported as the
    // specific read it missed rather than as "one of the four differs".
    const branchRef = `refs/heads/${BRANCH}`;
    for (const ref of [branchRef, unverifiedRef(ISSUE)]) {
      const reads = driven.reads.filter((r) => r.argv?.includes(ref) === true);
      assert(reads.length > 0, `a read of ${ref} was made`);
      for (const read of reads)
        assert(read.killGroup === true, `the read of ${ref} is a group-killed call`);
    }

    // The push is out of scope and must stay exactly as the lease switch renders it:
    // no env added by this change beyond what `net: true` already handed it.
    const push = driven.push;
    assert(push !== undefined, "the drive pushed, so the post-push reads had a moved branch to read");
    assert(
      push?.killGroup === true,
      `the push still runs in its own group, untouched by this change (got ${String(push?.killGroup)})`,
    );
    assert(
      push?.timeout === 120_000,
      `the push still carries its own 120 s ceiling (got ${String(push?.timeout)})`,
    );
    assert(
      push?.argv?.includes("--force-with-lease") === false &&
        (push?.argv ?? []).some((a) => a.startsWith("--force-with-lease=")) === true,
      `the push argv is still the lease-bound one (${JSON.stringify(push?.argv)})`,
    );
    assert(
      (push?.argv ?? []).some((a) => a.startsWith(`--force-with-lease=${branchRef}:`)) === true,
      `and the lease is still bound to the head the step read (${JSON.stringify(push?.argv)})`,
    );

    for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
  },
);

console.log(`\n${failures() === 0 ? "net-git env green" : "net-git env RED"} (${String(failures())} failing)`);
process.exit(failures());
