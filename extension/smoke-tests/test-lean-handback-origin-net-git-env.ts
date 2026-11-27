#!/usr/bin/env bun
/**
 * The handback's origin reads are network git calls, so they carry what every other
 * network git call carries: the non-interactive env and the process-group kill.
 *
 * `src/lean/handback-rewind.ts` reads origin with `git ls-remote` four times on a rewind
 * that pushes — the held head, the branch after the push, the keeping-ref, and
 * `originBranchHead` for the record — and until #2279 those calls carried neither. The
 * consequence is specific and it is the bug: a read with no `killGroup` is killed only at
 * its direct child, so an ssh grandchild holding stdout outlives the ceiling and the
 * trial it belongs to is lost; a read with no `GIT_TERMINAL_PROMPT=0` and no BatchMode
 * waits on /dev/tty for a passphrase rather than failing. `test-driver-network-git-env.ts`
 * is the enumeration gate for that class, and its blind spot is why the reads shipped
 * unrouted.
 *
 * The assertions are made on the RECORDED CALL. The env-substituting rig
 * (`lib/lean-verified-handback-fixture.ts`'s exec, which overwrites `opts.env`) is not
 * used here, because a case driven through it cannot distinguish an env the code supplied
 * from one the rig substituted. The recorder forwards untouched and the expected env is
 * derived by calling `netGitEnv` itself, so nothing re-types the wrapper.
 *
 * WHY THE REWIND IS DRIVEN WITH `net: false`. `git ls-remote origin <ref>` reaches this
 * file from exactly two places — the rewind's three reads and `originBranchHead` — and
 * both already reach the executor with the wrapper's env on the call through no help from
 * the routed arm: `runNetGit` supplies it on the routed arm, and upstream every one of
 * these callers supplies it too (`handback.ts`'s `readOrigin` →
 * `execGitWithHooks(…, { env: stepGitEnv(), … })` for the record's read; the guard seam
 * in `publish-deps.ts` for the rewind's). So a drive in which the upstream callers hand
 * over the env — production's `net: true`, which is how `report-handlers.ts` drives the
 * rewind — leaves only `killGroup` to tell the two arms apart, and a mutant that routes
 * nothing would still have looked routed. With `net: false` the rewind's reads arrive with
 * no env of their own, so the env this drive sees on them can only have come from the
 * wrapper: on both the env and the group kill, the routed arm is the only supplier, and
 * the suite goes red when it is not taken.
 *
 * The push is asserted untouched in the same breath: this change routes reads, and a fix
 * that also reached the push would move the rewind's `--atomic`, lease-bound argv, which
 * ships with the rule and has no lever of its own.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import { resetSshConfigCache } from "../src/work-driver-net-git.ts";
import {
  PINNED_SSH,
  READ_MAX_BUFFER,
  BRANCH,
  ISSUE,
  describeRead,
  driveReads,
  expectedNetEnv,
  expectedReadRefs,
  expectedTimeout,
  readRefs,
} from "./lib/lean-handback-net-git-cases.ts";
import { ROOTS } from "./lib/lean-verified-handback-fixture.ts";
import { recordingExec } from "./lib/lean-handback-recording-exec.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";

const { assert, failures } = makeAssert();

/** Rewrite a `from "../x.ts"` / `from "./x.ts"` to an absolute path under `extension/src`, so
 *  a copy of the module under test resolves from anywhere. A `../` leaves `lean/` and so
 *  lands in `src/`; a `./` stays inside `lean/`. */
function absoluteImports(source: string): string {
  return source.replace(/from "(\.\.?\/[^"]+)"/g, (_m, spec: string) => {
    const dir = spec.startsWith("../") ? "../src/" : "../src/lean/";
    const name = spec.replace(/^\.\.\//, "").replace(/^\.\//, "");
    return `from "${decodeURIComponent(new URL(dir + name, import.meta.url).pathname)}"`;
  });
}

await withEnv(
  {
    GIT_SSH_COMMAND: PINNED_SSH,
    GIT_SSH: undefined,
    // Absent, so the bound the reads are clamped to is the shipped default and the
    // recorded timeout is `min(60 s, 300 s)` rather than whatever the shell pinned.
    PI_ENSEMBLE_GIT_NET_TIMEOUT_MS: undefined,
  },
  async () => {
    // `netGitEnv` caches the repo's `core.sshCommand` for the process's lifetime, so a
    // cached answer from another file in this bun process would be this drive's answer.
    resetSshConfigCache();
    const driven = await driveReads({ net: false });
    const env = expectedNetEnv(driven.repo.repoRoot);

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
      for (const read of reads) {
        assert(read.killGroup === true, `the read of ${ref} is a group-killed call`);
        assert(
          read.env?.GIT_TERMINAL_PROMPT === "0" && read.env.GIT_SSH_COMMAND === env.GIT_SSH_COMMAND,
          `the read of ${ref} carries the wrapper's env`,
        );
      }
    }

    // The push is out of scope and must stay exactly as the lease switch renders it.
    // `killGroup: true` and the 120 s ceiling are the rewind push's own literals, in the
    // argv-form call `rewindToVerified` makes directly. Its env is the one exception to
    // "this change routed reads and nothing else", and it is named here because it is the
    // upstream supplier this suite has to reason about: `handback-rewind.ts` computes
    // `netGitEnv(process.env, repoRoot)` itself and hands it to the push when driven with
    // `net: true`, which is how `report-handlers.ts`'s `rewindFor` drives it in
    // production. This drive passes `net: false`, so the push's env is the caller's own
    // step env rather than the wrapper's answer — supplied, asserted, and never taken as
    // evidence about a read.
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

    // ── the mutant: an unrouted read has to turn this suite red.
    //
    // Every assertion above says what a routed read carries. This one asks the other
    // question — whether the suite would notice a read that stopped being routed — because
    // the enumeration gate cannot: that gate counts `runNetGit(` sites, and a site that is
    // textually present but never reached passes it. So a COPY of the module under test is
    // driven with its one routed call handed straight to the executor. The copy is
    // written to a fresh path under the system temp root, which is what keeps it out of
    // bun's module cache (a module is keyed by resolved path, so a name no run has used is
    // a module bun has never compiled) and, more importantly, keeps the tracked file
    // unmutated: a mutation applied in place is a mutation a later run could be graded on.
    // The copy's relative imports are rewritten to absolute paths under `extension/src`, so
    // it resolves from anywhere.
    //
    // The mutant still ships its rewind — routing a read is not what makes it answer — so
    // what is asserted is what the reads were handed. With the wrapper bypassed and
    // the drive giving the rewind no env of its own, no supplier is left: an unrouted read
    // carries neither `killGroup` nor `GIT_TERMINAL_PROMPT`, and all four must be reported
    // as carrying neither. Green here would mean this suite was proving the drive's call
    // shape rather than the wrapper's.
    const scratchDir = mkdtempSync(join(tmpdir(), "lean-handback-mutant-"));
    let unrouted: string[] = [];
    let mutantReadCount = -1;
    let mutantShipped = false;
    try {
      const source = readFileSync(
        new URL("../src/lean/handback-rewind.ts", import.meta.url).pathname,
        "utf8",
      );
      const ROUTED_ARM = 'const ran = await runNetGit(exec, "git", {';
      const arms = source.split(ROUTED_ARM).length - 1;
      assert(
        arms === 1,
        `the module has exactly one routed arm for the mutant to switch off (found ${String(arms)})`,
      );
      const mutantPath = join(scratchDir, "handback-rewind-unrouted.ts");
      writeFileSync(
        mutantPath,
        absoluteImports(source).replace(
          ROUTED_ARM,
          'const ran = await exec("git", {',
        ),
      );
      const mutated = await import(`${mutantPath}?unrouted=${String(Date.now())}`);
      const repo = (await import("./lib/lean-verified-handback-repo.ts")).repoWithFixHead();
      const recorder = recordingExec();
      const ctx = { repoRoot: repo.repoRoot, issue: ISSUE, run: { branch: BRANCH } };
      const rewind = await mutated.rewindToVerified(recorder.exec, ctx as never, repo.baseSha, {
        net: false,
      });
      await mutated.originBranchHead(recorder.exec, ctx as never);
      const mutantReads = recorder.lsRemote();
      mutantShipped = rewind.shipped === true;
      mutantReadCount = mutantReads.length;
      unrouted = mutantReads
        .filter((r: { killGroup?: boolean; env?: NodeJS.ProcessEnv }) => r.killGroup === true || r.env?.GIT_TERMINAL_PROMPT === "0")
        .map((r: { cmd: string; argv?: string[] }) => describeRead(r));
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    assert(
      mutantShipped,
      "the mutant drove a rewind that pushed, so its reads are the same four calls and not an early return",
    );
    assert(
      mutantReadCount === 4,
      `the mutant made the same four origin reads the real drive made (${String(mutantReadCount)})`,
    );
    assert(
      unrouted.length === 0,
      `an unrouted read is reported by this suite: no mutant read carries the wrapper's kill or env (unexpectedly carried them: ${unrouted.join(" | ") || "none"})`,
    );

    for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
  },
);

console.log(`\n${failures() === 0 ? "net-git env green" : "net-git env RED"} (${String(failures())} failing)`);
process.exit(failures());
