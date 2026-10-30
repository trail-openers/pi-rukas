#!/usr/bin/env bun
/**
 * lean/publish — the four cases where origin's `lean/` ref, not the forge,
 * decides what the step may do. Split out of `test-lean-publish.ts` (which was
 * past the 500-line cap); same fixture, same recorder, same `runPublish`.
 *
 *   (h) origin holds a FOREIGN commit on the branch -> throw, no force, no PR
 *   (o) a push that reports a forced update -> REFUSAL, never an accepted flag
 *   (p) a STALE branch with no open PR -> replaced under a lease bound to the
 *       sha the step read
 *   (q) the stale branch is used by an OPEN PR -> refused, reason names the URL
 *   (r) origin's branch already equals HEAD -> no-op push, not a refusal
 *   (s) the ref moves between the read and the push -> the lease fails and the
 *       run is handed back, never reported ok
 *
 * The origin is a real bare repo, so "not overwritten" is a fact about the ref
 * origin holds afterwards, not about a stub's transcript.
 */

import { PublishInfraError } from "../src/lean/publish-deps.ts";
import { fakePr, originHead, runPublish } from "./lib/lean-publish-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------- (h) origin holds a foreign commit -> no force
{
  const r = await runPublish({ issue: 408, verify: { kind: "green" }, originForeign: true });
  assert(
    r.threw instanceof PublishInfraError,
    `(h) a non-fast-forward push throws (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(r.forge.prCreateCalls.length === 0, "(h) a refused push opens no PR");
  assert(
    originHead(r.origin, "lean/issue-408") !== r.head,
    "(h) origin still holds the foreign commit — the step never forced over it",
  );
}

// ------------------- (o) a `forced update` is a refusal, never an accepted flag
//
// The step never passes `--force`, so git cannot print that flag for a push it
// ran. Anything printing it rewrote history outside the clone, which is the one
// act this step may not take under a success-looking exit code.
{
  const r = await runPublish({
    issue: 421,
    verify: { kind: "green" },
    execOver: (cmd, opts) =>
      opts?.argv?.includes("push") === true
        ? Promise.resolve({
            stdout: "To origin\n * [new branch]      abc -> lean/issue-421 [forced update]\nDone\n",
            stderr: "",
          })
        : undefined,
  });
  assert(
    r.threw instanceof PublishInfraError && /forced update/.test(r.threw.message),
    `(o) a push reporting a forced update is refused (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.forge.prCreateCalls.length === 0 && r.forge.prListCalls === 0,
    "(o) a refused push opens no PR",
  );
}

// ------------------------- (p) a stale lean/ branch with no PR -> replaced under a lease
{
  const r = await runPublish({ issue: 422, verify: { kind: "green" }, originStale: true });
  assert(
    r.outcome?.kind === "ok",
    `(p) a stale lean/ branch with no open PR is replaced (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-422") === r.head,
    "(p) origin's branch now holds this run's head",
  );
  assert(r.forge.prCreateCalls.length === 1, "(p) the PR was opened");
}

// ------------------------------- (q) the stale branch belongs to an OPEN PR
{
  const r = await runPublish({
    issue: 423,
    verify: { kind: "green" },
    originStale: true,
    openPrs: [fakePr(91, "https://forge.example/pull/91", "lean/issue-423")],
  });
  assert(
    r.threw instanceof PublishInfraError && /open PR already uses/.test(r.threw.message),
    `(q) an open PR on the branch refuses the push (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.threw !== undefined && r.threw.message.includes("https://forge.example/pull/91"),
    `(q) the refusal names the open PR's URL (got ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-423") !== r.head,
    "(q) the reviewed branch was not clobbered",
  );
  assert(r.forge.prCreateCalls.length === 0, "(q) no second PR was opened");
}

// -------------------------- (r) origin's branch already equals HEAD -> nothing to push
{
  // Two runs of the same issue: the first creates the ref, the second finds it
  // already at this head, pushes nothing, and still opens its PR.
  const first = await runPublish({ issue: 425, verify: { kind: "green" } });
  const second = await runPublish({ issue: 425, verify: { kind: "green" } });
  assert(
    first.outcome?.kind === "ok" && second.outcome?.kind === "ok",
    `(r) a remote branch equal to HEAD is a no-op push, not a refusal (got ${second.threw?.name}: ${second.threw?.message})`,
  );
  assert(
    originHead(second.origin, "lean/issue-425") === second.head,
    "(r) origin still holds the head after the no-op push",
  );
}

// ------------------- (s) the remote ref moves between the read and the push
{
  const r = await runPublish({
    issue: 426,
    verify: { kind: "green" },
    originStale: true,
    moveRemoteDuringPush: true,
  });
  assert(
    r.threw instanceof PublishInfraError,
    `(s) a ref that moved after the read is handed back (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-426") !== r.head,
    "(s) the lease held: origin was not overwritten on a stale expectation",
  );
  assert(r.forge.prCreateCalls.length === 0, "(s) no PR is claimed for a failed push");
}

if (exit === 0) console.log("\nlean publish, origin-side: all assertions passed");
process.exit(exit);
