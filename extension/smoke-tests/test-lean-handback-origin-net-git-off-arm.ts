#!/usr/bin/env bun
/**
 * `PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT=0` is the operator's escape hatch, and the promise
 * an escape hatch makes is that the arm it restores is the arm that shipped.
 *
 * The four origin reads in `src/lean/handback-rewind.ts` (`originBranchHead`, and
 * `quiet()` behind `originRef()` for the held head, the branch after the push and the
 * keeping-ref) go through the driver's network-git wrapper when the switch is on. With
 * `"0"` each one is handed to the executor in the shape it had at the base commit: the
 * same argv, no `env` at all, no `killGroup`, the same 60 s `timeout`, the same 4 MiB
 * `maxBuffer`. That is the off arm's whole contract, and it is the reason the switch can
 * ship on by default — an operator whose origin needs a credential helper, or whose
 * `core.sshCommand` the wrapper would outrank, has a value to set that puts the reads
 * back rather than a rebuild to ask for.
 *
 * The base shape is spelled out here as a literal because that is what makes the case
 * red on a bad switch rather than self-confirming: a fixture that computed the expected
 * call from the code under test would compare the code with itself. The values are the
 * shipped call sites' own numbers, and `test-lean-report-bound-ceiling.ts` reads the
 * same literals out of the source, so a change to one is caught twice.
 *
 * `PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS` is pinned ON for both arms: the two switches
 * are independent, and the off arm of this one leaves the push argv exactly as `binds`
 * renders it today — which is what the push assertions below check.
 */

import { rmSync } from "node:fs";
import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import {
  BRANCH,
  ISSUE,
  PINNED_SSH,
  READ_MAX_BUFFER,
  READ_TIMEOUT_MS,
  describeRead,
  driveReads,
  expectedNetEnv,
  readRefs,
} from "./lib/lean-handback-net-git-cases.ts";
import { ROOTS } from "./lib/lean-verified-handback-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";
import type { RecordedCall } from "./lib/lean-handback-recording-exec.ts";

const { assert, failures } = makeAssert();

/** The three `-c` flags every lean git call carries, spelled as the call site spells them. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * The base commit's call shape for one origin read — the off arm's golden value.
 *
 * `env` is spelled as the two arms of the shipped code produce it, not as one rule:
 * the three reads the rewind makes go through `assertPublishableBranch`'s seam
 * (`lean/publish-deps.ts`), which hands `netGitEnv(process.env, cwd)` to every `git` call
 * that arrives without one, while `originBranchHead` — the handback step's own read —
 * supplies no env at all. A case that asserted "no env" for both would be asserting a
 * shape the pre-fix code never had, and would go red on a fix that changed nothing.
 */
function baseShape(ref: string, env: NodeJS.ProcessEnv | undefined): RecordedCall {
  return {
    cmd: "git",
    argv: [...NO_HOOKS, "ls-remote", "origin", ref],
    env,
    killGroup: undefined,
    timeout: READ_TIMEOUT_MS,
    maxBuffer: READ_MAX_BUFFER,
  };
}

/** One field at a time, so a failure names the field that moved rather than the object. */
function compare(
  call: RecordedCall,
  want: RecordedCall,
  what: string,
  readEnv: (env: NodeJS.ProcessEnv | undefined) => boolean,
): void {
  for (const key of ["cmd", "killGroup", "timeout", "maxBuffer"] as const) {
    assert(
      call[key] === want[key],
      `${what}: ${key} is ${JSON.stringify(want[key])} with the switch off (got ${JSON.stringify(call[key])})`,
    );
  }
  assert(
    JSON.stringify(call.argv) === JSON.stringify(want.argv),
    `${what}: argv is byte-for-byte the base call (got ${JSON.stringify(call.argv)})`,
  );
  // The env assertion is about what the CALL supplied, and it is made on the recorder's
  // copy — the rig forwards untouched, so an env the code did not supply cannot appear.
  assert(
    readEnv(call.env) &&
      JSON.stringify(Object.keys(call.env ?? {})) === JSON.stringify(Object.keys(want.env ?? {})),
    `${what}: the env is the base call's (got ${JSON.stringify(call.env === undefined ? undefined : Object.keys(call.env).slice(0, 6))})`,
  );
}

/** The reads of one off-arm drive, in call order: held head, branch, keeping-ref, then the record's. */
const OFF_ARM_REFS = [`refs/heads/${BRANCH}`, `refs/heads/${BRANCH}`, unverifiedRef(ISSUE)];

await withEnv(
  {
    GIT_SSH_COMMAND: PINNED_SSH,
    GIT_SSH: undefined,
    PI_ENSEMBLE_GIT_NET_TIMEOUT_MS: undefined,
    PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS: "1",
    PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT: "0",
  },
  async () => {
    const driven = await driveReads();
    // Derived inside the pinned block, from the drive's own repo, so the expectation is
    // `netGitEnv` over the env the reads actually ran in — the same call `publish-deps`'s
    // seam makes for every git call that reaches it without one.
    const guardEnv = expectedNetEnv(driven.repo.repoRoot);
    assert(
      driven.rewind.shipped === true,
      `the off arm still performs the rewind, so the reads are the real ones (${JSON.stringify(driven.rewind)})`,
    );
    assert(
      driven.reads.length === OFF_ARM_REFS.length + 1,
      `the same four origin reads are made with the switch off (${readRefs(driven).join(", ")})`,
    );

    driven.reads
      .slice(0, OFF_ARM_REFS.length)
      .forEach((read, i) =>
        compare(
          read,
          baseShape(OFF_ARM_REFS[i] as string, guardEnv),
          `read #${String(i + 1)} (rewind arm, through the guard's seam)`,
          (env) => env !== undefined && env.GIT_TERMINAL_PROMPT === "0",
        ),
      );

    // The handback step's own read — the one that produces the record's `shippedHead`. It
    // is driven through `originBranchHead` directly, which supplies no env: on both arms
    // of the switch it is an env-less call, and that is the half of the off arm's promise
    // no guard-seam env can stand in for.
    const record = driven.reads[driven.reads.length - 1];
    if (record === undefined) assert(false, "the record's origin read was made");
    else
      compare(record, baseShape(`refs/heads/${BRANCH}`, undefined), "originBranchHead (the record's read)", (
        env,
      ) => env === undefined);

    // Independence from the lease switch: the push is what `binds` renders, on both arms.
    const push = driven.push;
    assert(
      push?.argv?.includes("--atomic") === true &&
        (push?.argv ?? []).some((a) => a.startsWith("--force-with-lease=")) === true &&
        (push?.argv ?? []).some((a) => a.startsWith("+")) === false,
      `the push argv is unchanged by this switch, so LEAN_REWIND_LEASE_BINDS still owns it (${JSON.stringify(push?.argv)})`,
    );
    assert(
      push?.killGroup === true && push.timeout === 120_000,
      `the push still carries its own group kill and 120 s ceiling (killGroup ${String(push?.killGroup)}, timeout ${String(push?.timeout)})`,
    );
    assert(
      push?.env !== undefined && push.env.GIT_TERMINAL_PROMPT === "0",
      "the push still gets the net env that `net: true` has always handed it",
    );

    for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
  },
);

console.log(`\n${failures() === 0 ? "off-arm green" : "off-arm RED"} (${String(failures())} failing)`);
process.exit(failures());
