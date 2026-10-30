#!/usr/bin/env bun
/**
 * lean/publish — the cases where origin's `lean/` ref, not the forge, decides
 * what the step may do. Split out of `test-lean-publish.ts` (which was past the
 * 500-line cap); same fixture, same recorder, same `runPublish`.
 *
 *   (h)  origin holds a FOREIGN commit on the branch -> handback, no PR
 *   (o)  a push whose porcelain output names a rejection, over a ref it did not
 *        move -> REFUSAL, no PR
 *   (p)  a realistic STALE branch (4 commits, cut from an older main) with no
 *        open PR -> replaced under a lease bound to the sha the step read
 *   (p2) the 1-commit stale shape the first version gated on -> still replaced
 *   (p3) a stale tip that already CONTAINS head -> still replaced
 *   (q)  the stale branch is used by an OPEN PR -> refused, reason names the URL
 *   (q2) a PR row whose state is `"open"`, `"Open"`, `""` or `"OPEN"` -> refused;
 *        only `CLOSED`/`MERGED` let the rewrite through (fail-closed)
 *   (q3) a PR row with NO `headRefName` and state OPEN -> refused: a row the
 *        step cannot attribute is a row it has not cleared
 *   (q5) a PR row whose `headRefName` carries a stray space, state OPEN ->
 *        refused: an unsettled row blocks whatever its branch name says
 *   (r)  origin's branch already equals HEAD (seeded) -> no push, still a PR, and
 *        the reason says `already on origin`, never `pushed`
 *   (r2) origin's branch is HEAD~1 -> a FAST-FORWARD lands and the PR opens
 *        (the unbracketed-porcelain regression: no flag parsing is involved)
 *   (r3) a stale branch, the push really runs, and its report says `! [rejected]`
 *        while origin ends at head -> ok: origin, not the porcelain, decides
 *   (s)  the ref moves between the read and the push -> the lease fails and the
 *        run is handed back, never reported ok
 *   (s2) a branch absent on origin -> leased against an ABSENT ref
 *   (t)  a branch absent on origin -> created, origin then equals head
 *
 * The origin is a real bare repo, so "not overwritten" is a fact about the ref
 * origin holds afterwards, not about a stub's transcript.
 */

import { rmSync } from "node:fs";
import type { NormalizedPullRequest } from "../src/forge-types.ts";
import { PublishInfraError } from "../src/lean/publish-deps.ts";
import { execp } from "../src/exec.ts";
import { ROOTS, originHead, runPublish } from "./lib/lean-publish-fixture.ts";
import { fakePr } from "./lib/lean-publish-forge.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A stale-seed case means nothing unless a stale sha was actually planted on
 * origin; the fixture reads it back, and a case asserts it landed before it
 * relies on it, so the case cannot pass vacuously over an empty seed.
 */
function assertSeeded(seededSha: string | undefined, label: string): void {
  assert(
    /^[0-9a-f]{40}$/.test(seededSha ?? ""),
    `${label}: a stale sha was planted on origin (got ${JSON.stringify(seededSha)})`,
  );
}

// ---------------- (h) origin holds a FOREIGN commit -> the step never reports ok
//
// The lease is bound to the sha the step read, so git itself accepts a push that
// rewrites a foreign tip — the protection is not "git refuses non-fast-forward".
// It is that the step cannot claim success over a ref it did not move to its own
// verified head, and that the branch under review is cleared against the forge
// first. So the honest assertion is about what the step REPORTS and about the
// branch it refused to touch, not about a porcelain rejection it never sees.
{
  // A foreign tip, and no PR row on the branch: the forge check passes, so the
  // only thing standing between this run and someone else's branch is that
  // origin's ref is NOT this head and the forge never heard of it — which is
  // exactly where the step's own reading of the branch has to stop it.
  const r = await runPublish({
    issue: 408,
    verify: { kind: "green" },
    originForeign: true,
    openPrs: [fakePr(88, "https://forge.example/pull/88", "lean/issue-408", false)],
  });
  assert(
    r.threw instanceof PublishInfraError,
    `(h) a branch under a PR this run did not verify is handed back (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(r.forge.prCreateCalls.length === 0, "(h) a refused push opens no PR");
  assert(
    originHead(r.origin, "lean/issue-408") !== r.head,
    "(h) the step never reports this run's head as the foreign branch's tip",
  );
}

// ------------------- (o) a porcelain rejection is a refusal, never an accepted push
//
// The step no longer reads porcelain flags for success (a fast-forward is printed
// UNBRACKETED, so flag regexes reported landed pushes as failures). It sweeps
// for git's rejection shapes and then reads origin. A stubbed push that claims a
// new branch while the ref is nowhere to be found must still be refused by that
// read — which is what this case pins.
{
  const r = await runPublish({
    issue: 421,
    verify: { kind: "green" },
    // Nothing seeded: the branch is absent on origin, so the stub's claim of a
    // new branch is a claim the post-push read can refute.
    noPush: true,
    execOver: (cmd, opts) =>
      opts?.argv?.includes("push") === true
        ? Promise.resolve({
            stdout: "To origin\n * [new branch]      abc -> lean/issue-421\nDone\n",
            stderr: "",
          })
        : undefined,
  });
  assert(
    r.threw instanceof PublishInfraError && /after the push, expected/.test(r.threw.message),
    `(o) a push that did not move origin is refused by the post-push read (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.forge.prCreateCalls.length === 0 && r.forge.prListCalls === 0,
    "(o) a refused push opens no PR",
  );
}

// ------------- (p) a realistic stale lean/ branch (4 commits, older main) -> replaced
//
// The shape a rerun actually meets: the first run branched off an older main and
// left four commits on the ref; the rerun's head is three new commits on the
// newer main. `rev-list --count ^HEAD <remote>` answers 4, so any gate on that
// number — which the first version had — leaves the stale branch in place and
// the feature does nothing.
{
  const r = await runPublish({ issue: 422, verify: { kind: "green" }, originStale: true });
  assertSeeded(r.seededSha, "(p)");
  assert(
    r.outcome?.kind === "ok",
    `(p) a 4-commit stale lean/ branch with no open PR is replaced (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-422") === r.head,
    "(p) origin's branch now holds this run's head",
  );
  assert(r.forge.prCreateCalls.length === 1, "(p) the PR was opened");
}

// --------------------- (p2) the 1-commit stale shape, kept from the first version
{
  const r = await runPublish({
    issue: 424,
    verify: { kind: "green" },
    originStale: "stale-branch",
  });
  assertSeeded(r.seededSha, "(p2)");
  assert(
    r.outcome?.kind === "ok",
    `(p2) a 1-commit stale lean/ branch is replaced too (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-424") === r.head,
    "(p2) origin's branch now holds this run's head (1-commit shape)",
  );
}

// ------------------------------- (q) the stale branch belongs to an OPEN PR
{
  const r = await runPublish({
    issue: 423,
    verify: { kind: "green" },
    originStale: true,
    openPrs: [fakePr(91, "https://forge.example/pull/91", "lean/issue-423")],
  });
  assertSeeded(r.seededSha, "(q)");
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(q) an open PR on the branch refuses the push (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.threw?.message.includes("https://forge.example/pull/91") === true,
    `(q) the refusal names the open PR's URL (got ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-423") !== r.head,
    "(q) the reviewed branch was not clobbered",
  );
  assert(r.forge.prCreateCalls.length === 0, "(q) no second PR was opened");
}

// -------------------------- (r) origin's branch already equals HEAD -> nothing to push
//
// Each `runPublish` builds its OWN origin, so two runs of one issue are two
// fresh origins and the second never sees the first's ref — the shape has to be
// seeded, not sequenced. `originAtHead` writes the run's own head to origin
// before the step looks, so the no-push path is a fact about the ref, and the
// reason a run that WROTE NOTHING prints must not claim it pushed.
{
  const r = await runPublish({ issue: 425, verify: { kind: "green" }, originAtHead: true });
  assert(
    r.outcome?.kind === "ok",
    `(r) a remote branch equal to HEAD is a no-op push, not a refusal (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-425") === r.head,
    "(r) origin still holds the head after the no-op push",
  );
  assert(r.forge.prCreateCalls.length === 1, "(r) the PR was still opened");
  assert(
    r.outcome?.reason?.includes("already on origin") === true &&
      r.outcome.reason.includes("pushed") === false,
    `(r) a run that wrote nothing says so rather than claiming a push (got ${JSON.stringify(r.outcome?.reason)})`,
  );
  // The converse, so the honesty above is not just "the string always says it":
  // a run that DID write keeps saying `published` and names no `already on origin`.
  const didPush = await runPublish({ issue: 425, verify: { kind: "green" }, noPush: true });
  assert(
    didPush.outcome?.reason?.includes("already on origin") === false &&
      (didPush.outcome?.prUrl ?? "").startsWith("https://"),
    `(r) a run that DID push does not say already on origin (got ${JSON.stringify(didPush.outcome?.reason)})`,
  );
}

// ------------- (q3) a PR row with no headRefName is a row the step cannot clear
//
// The list was asked for THIS branch (`sourceBranch`), so a row that reports no
// head branch is not "no PR on the branch" — it is a row whose attribution the
// adapter lost. Reading it as absent is the exact shape that lets a rewrite land
// over a branch somebody is reviewing, so an unattributed OPEN row blocks.
{
  const unattributed: NormalizedPullRequest = {
    ...fakePr(99, "https://forge.example/pull/99", ""),
    headRefName: undefined,
  };
  const r = await runPublish({
    issue: 441,
    verify: { kind: "green" },
    originStale: true,
    openPrs: [unattributed],
  });
  assertSeeded(r.seededSha, "(q3)");
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(q3) a row with no headRefName and state OPEN refuses the push (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-441") !== r.head,
    "(q3) the unattributed row's branch was not clobbered",
  );
  assert(r.forge.prCreateCalls.length === 0, "(q3) no PR is opened over an unattributed row");
}

// --------- (q5) an unsettled row blocks whatever its headRefName says
//
// The list was asked for THIS branch (`sourceBranch`), so a row the adapter
// reports with a head name that merely LOOKS different — a stray trailing space,
// a trim the adapter did not do — is still a row about this branch. Reading it
// as "another PR" is the shape that force-pushes over a branch somebody is
// reviewing, so the predicate names no head branch at all: only a positively
// CLOSED/MERGED state lets a rewrite through.
{
  const r = await runPublish({
    issue: 443,
    verify: { kind: "green" },
    originStale: true,
    openPrs: [fakePr(97, "https://forge.example/pull/97", "lean/issue-443 ")],
  });
  assertSeeded(r.seededSha, "(q5)");
  assert(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(q5) a row with headRefName "lean/issue-443 " and state OPEN refuses the push (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-443") !== r.head,
    "(q5) the row's branch was not clobbered",
  );
  assert(r.forge.prCreateCalls.length === 0, "(q5) no PR is opened over an unsettled row");
}

// ---------------- (r2) origin's branch is HEAD~1 -> the fast-forward lands, PR opens
//
// `git push --porcelain` prints a fast-forward UNBRACKETED (`abc..def`), which is
// why the old `\[fast-forward\]` regex reported a push that had landed as "no
// success flag" and opened no PR. Success is now origin read back, so this is
// the case that pins the fix against a real push.
{
  const r = await runPublish({
    issue: 427,
    verify: { kind: "green" },
    originStale: "fast-forward",
  });
  assert(
    r.outcome?.kind === "ok",
    `(r2) a fast-forward rerun is not reported as a failed push (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-427") === r.head,
    "(r2) origin advanced from HEAD~1 to this run's head",
  );
  assert(r.forge.prCreateCalls.length === 1, "(r2) the PR was opened after the fast-forward");
}

// ------------- (r3) origin is at head, so a printed rejection is not a refusal
//
// The porcelain is not the success check, and this pins the direction: a push
// whose report says `! [rejected]` while origin genuinely holds this head is a
// LANDED push. Were the step to sweep the rejection shapes before reading origin
// it would hand back a run whose branch is published, sending the next run to
// look in the wrong place.
{
  // The push REALLY runs (origin starts on a stale sha, not at head), so the
  // ref lands at head; the report it prints is then a fabricated rejection.
  const r = await runPublish({
    issue: 444,
    verify: { kind: "green" },
    originStale: true,
    execOver: (cmd, opts) => {
      if (opts?.argv?.includes("push") !== true) return undefined;
      return execp(cmd, { ...opts, env: gitTestEnv() }).then(() => ({
        stdout: "To origin\n ! [rejected]        abc -> lean/issue-444 (stale info)\nDone\n",
        stderr: "",
      }));
    },
  });
  assertSeeded(r.seededSha, "(r3)");
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(r3) a printed rejection over a ref origin holds is still ok (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(originHead(r.origin, "lean/issue-444") === r.head, "(r3) origin holds this run's head");
  assert(
    /^--force-with-lease=refs\/heads\/lean\/issue-444:[0-9a-f]{40}$/.test(r.leaseArg ?? ""),
    `(r3) the push was leased against the stale sha (got ${JSON.stringify(r.leaseArg)})`,
  );
  assert(r.forge.prCreateCalls.length === 1, "(r3) the PR was opened");
}

// ------------- (p3) a stale tip that CONTAINS head -> still replaced
//
// The shape the count gate could never see: the previous run merged this head
// into its branch, so `rev-list --count ^HEAD <remote>` answers 0 and the old
// rule concluded there was nothing to replace while four commits of stale work
// still stood on the branch. The lease is bound to the observed tip, not to a
// distance, so the rerun publishes.
{
  const r = await runPublish({
    issue: 429,
    verify: { kind: "green" },
    originStale: "descendants-reach",
  });
  assertSeeded(r.seededSha, "(p3)");
  assert(
    r.outcome?.kind === "ok",
    `(p3) a stale branch whose tip already contains head is replaced (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-429") === r.head,
    "(p3) origin's branch now holds this run's head, not the merge of it",
  );
}

// ------------------------------------- (t) a branch absent on origin -> created
{
  const r = await runPublish({ issue: 428, verify: { kind: "green" } });
  assert(
    r.outcome?.kind === "ok",
    `(t) a new lean/ branch is created (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    originHead(r.origin, "lean/issue-428") === r.head,
    "(t) origin now holds the new branch at head",
  );
}

// ------------- (q2) the open-PR check is FAIL-CLOSED on an unrecognised state
//
// `mapPrListReply` synthesises `state: ""` for a forge that answered with a bare
// number, and a forge adapter can hand back `"open"`/`"Open"`. An exact
// `=== "OPEN"` comparison reads every one of those as "no PR" and force-pushes
// over a branch that is under review, so only CLOSED/MERGED (case-insensitively)
// may let a rewrite through.
{
  const states: string[] = ["open", "Open", "", "OPEN"];
  for (const [i, state] of states.entries()) {
    const issue = 434 + i;
    const r = await runPublish({
      issue,
      verify: { kind: "green" },
      originStale: true,
      openPrs: [fakePr(90 + i, `https://forge.example/pull/${90 + i}`, `lean/issue-${issue}`)],
      stateOver: state,
    });
    assertSeeded(r.seededSha, `(q2) state ${JSON.stringify(state)}`);
    assert(
      r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
      `(q2) state ${JSON.stringify(state)} on a PR for the branch refuses the push (got ${r.threw?.name}: ${r.threw?.message})`,
    );
    assert(
      originHead(r.origin, `lean/issue-${issue}`) !== r.head,
      `(q2) state ${JSON.stringify(state)}: the reviewed branch was not clobbered`,
    );
  }
  for (const [i, state] of ["CLOSED", "MERGED"].entries()) {
    const issue = 438 + i;
    const number = 95 + i;
    const r = await runPublish({
      issue,
      verify: { kind: "green" },
      originStale: true,
      openPrs: [fakePr(number, `https://forge.example/pull/${number}`, `lean/issue-${issue}`)],
      stateOver: state,
      // A settled PR is not the one this run publishes into — the step treats it
      // as no PR and opens a fresh one — but its state is still read, so the
      // forge is made to say it rather than leaving the step to guess.
      viewIsDraft: { [String(number)]: false },
    });
    assertSeeded(r.seededSha, `(q2) state ${state}`);
    assert(
      r.outcome?.kind === "ok",
      `(q2) state ${state} is settled, so the stale branch is replaced (got ${r.threw?.name}: ${r.threw?.message})`,
    );
    assert(
      originHead(r.origin, `lean/issue-${issue}`) === r.head,
      `(q2) state ${state}: origin now holds this run's head`,
    );
  }
}

// ------------------- (s) the remote ref moves between the read and the push
{
  // A genuine rerun: origin holds four stale commits (`originStale: true`), so
  // the step reads a sha and leases against it — and the race rewinds the ref to
  // main's commit behind its back, which is NOT the sha it read. The lease is what
  // must refuse the write.
  const r = await runPublish({
    issue: 426,
    verify: { kind: "green" },
    originStale: true,
    noPush: true,
    moveRemoteDuringPush: true,
  });
  assertSeeded(r.seededSha, "(s)");
  assert(
    r.threw instanceof PublishInfraError && /could not push/.test(r.threw.message),
    `(s) a ref that moved after the read is handed back by the lease (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  const rewound = originHead(r.origin, "main");
  assert(
    /^[0-9a-f]{40}$/.test(rewound),
    `(s) origin's main is a real sha to rewind to (got ${rewound})`,
  );
  assert(
    originHead(r.origin, "lean/issue-426") === rewound,
    "(s) the lease held: origin keeps the sha it was rewound to, not this head",
  );
  assert(r.forge.prCreateCalls.length === 0, "(s) no PR is claimed for a failed push");
  // The lease is the whole protection here, so pin the argument the step
  // rendered rather than trusting it built one: bound to the sha it read.
  assert(
    r.leaseArg === `--force-with-lease=refs/heads/lean/issue-426:${r.seededSha}`,
    `(s) the push is leased against the seeded sha (got ${JSON.stringify(r.leaseArg)})`,
  );
}

// ------------- (s2) a new branch -> the lease requires the ref to STILL be absent
//
// An empty expected value is git's "must not exist" form: a branch that appeared
// between the read and the push then refuses the push rather than being rewritten.
{
  const r = await runPublish({ issue: 445, verify: { kind: "green" }, noPush: true });
  assert(
    r.outcome?.kind === "ok" && originHead(r.origin, "lean/issue-445") === r.head,
    `(s2) a new lean/ branch is created (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    r.leaseArg === "--force-with-lease=refs/heads/lean/issue-445:",
    `(s2) a new branch is leased against an ABSENT ref (got ${JSON.stringify(r.leaseArg)})`,
  );
}

if (exit === 0) console.log("\nlean publish, origin-side: all assertions passed");
for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a temp dir the OS reaps anyway is not a failing assertion.
  }
}
process.exit(exit);
