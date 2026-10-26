/**
 * #1533 — the merged step's head verification: the RULE and its refusals.
 *
 * The defect: an approval covers ONE commit, but the driver's merge asked the
 * forge to merge "this PR" and the forge merged whatever head it held when the
 * command ran. A push landing between review and merge was merged unreviewed.
 *
 * The rule these tests pin: the reviewed head is the LATEST LENS ROW's
 * `headSha` — the commit the driver's own six-lens review recorded (#1039). The
 * adversarial gate an earlier cut read writes no ledger row for a /work cycle
 * and its round-capped rows are `passed: false`, so that check could never be
 * satisfied by the very cycles it was meant to protect. The `passed`
 * re-judgement is gone as well: the lens gate decided it upstream, and a cycle
 * that reaches `merged` already passed it.
 *
 * WHAT THE COMPARISON MEASURES, and the bug that made this file necessary. The
 * first cut computed the patch identity at the VERIFIED head and at the head the
 * fetch had just read back. Under the ordinary sequence — reviewed A, verified B,
 * fetched B — those are the same commit, so the two identities agreed by
 * construction and unreviewed content merged green. These cases therefore always
 * name the reviewed and verified commits SEPARATELY (`commits.reviewed` /
 * `commits.at`); a helper that resolved both from one string re-creates that bug,
 * and the fixture refuses to build such a case.
 *
 * The moved-head cases — the ones where the whole question is whether a patch
 * identity survives a base move — run against `realClone`: real commits, a real
 * bare origin, real `git patch-id`. A fixture that returned one id for every
 * range could make a genuinely-moved head look like a mainline-only move, and the
 * case would only be asserting on its own answer.
 *
 * The comparison that CANNOT run (no branch name, no repository, `skipIdentity`)
 * and the ledger written by PRODUCTION code are covered by their own files in
 * this suite; the forge half of the pin is in
 * test-work-driver-merged-mechanized.ts and the forge argv tests.
 */

import { setupSpawnGuard } from "./test-helpers.ts";
import {
  HEAD,
  MOVED,
  PATCH,
  UNREVIEWED_PLACEHOLDER,
  assert,
  evidence,
  evidenceAt,
  lensRow,
  ledgerAt,
  state,
} from "./lib/merged-head-fixtures.ts";
import { firstWorkCommit, mergeCommitCovering, realClone, realGit } from "./lib/merged-head-git.ts";
import { fakeClone, fetched } from "./lib/merged-head-refusals.ts";
import {
  assertLedgerFileIsHonoured,
  verifyAtReviewedCommit,
} from "./lib/merged-head-verify.ts";
import { reviewedHeadFromEntries } from "../src/work-driver-merged-identity.ts";
import { isFullCommitSha } from "../src/review-head-sha.ts";
import {
  verifiedHeadFromEvidence,
  verifyMergeHead,
} from "../src/work-driver-merged-head.ts";
import type { MergeEvidence } from "../src/work-driver-merge-authority.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { rmSync } from "node:fs";

setupSpawnGuard();

/** Seed both ledgers with the row this case's verdict must come from. */
function ledgerFileFor(c: { dir: string; branch: string }, reviewed: string): string {
  // The named file carries the row the case is about; the clone's own file carries
  // a row naming a commit the branch never had, so the answer cannot be read out of
  // whichever path `ledgerPathFor` happened to take.
  return ledgerAt(lensRow(c.branch, reviewed), c.dir, lensRow(c.branch, UNREVIEWED_PLACEHOLDER));
}

{
  assert(
    reviewedHeadFromEntries(lensRow("feature/x"), "feature/x") === HEAD,
    "reviewed head: the latest lens row's headSha is the reviewed commit",
  );
  assert(
    reviewedHeadFromEntries([], "feature/x") === undefined,
    "reviewed head: no row at all is UNKNOWN, never a match",
  );
  assert(
    reviewedHeadFromEntries(lensRow("feature/other"), "feature/x") === undefined,
    "reviewed head: another branch's row does not count",
  );
  assert(
    reviewedHeadFromEntries(lensRow("feature/x", "feature/x"), "feature/x") === undefined,
    "reviewed head: a legacy row recording a BRANCH NAME as headSha is UNKNOWN (#1039 shape)",
  );
  assert(
    reviewedHeadFromEntries(lensRow("feature/x", "abc1234"), "feature/x") === undefined,
    "reviewed head: an abbreviated headSha is UNKNOWN, never matched",
  );
  assert(
    reviewedHeadFromEntries(
      [...lensRow("feature/x", HEAD, { at: 100 }), ...lensRow("feature/x", MOVED, { at: 200 })],
      "feature/x",
    ) === MOVED,
    "reviewed head: the LATEST lens row wins — a re-review re-pins the commit",
  );
  assert(
    reviewedHeadFromEntries(
      [
        {
          branch: "feature/x",
          kind: "adversarial",
          patchId: PATCH,
          passed: true,
          at: 2,
          headSha: HEAD,
        },
      ],
      "feature/x",
    ) === undefined,
    "reviewed head: an adversarial row is NOT a lens row (this check's rule, not the guard's)",
  );
  assert(
    reviewedHeadFromEntries(lensRow("feature/x", HEAD, { passed: false }), "feature/x") === HEAD,
    "reviewed head: a non-passing lens row still names the commit it reviewed (no re-judging)",
  );
  assert(
    reviewedHeadFromEntries(
      [...lensRow("feature/x", HEAD, { at: 1 }), { branch: "feature/x", kind: "not-a-kind", at: 2, headSha: MOVED }],
      "feature/x",
    ) === HEAD,
    "reviewed head: a row of an unknown kind does not displace the lens row",
  );
}

// ── check 1: the verified head ─────────────────────────────────────────────

{
  const cases: Array<[string, Partial<MergeEvidence>, string]> = [
    ["absent", { headOid: undefined }, "no head OID"],
    ["empty", { headOid: "" }, "no head OID"],
    ["abbreviated", { headOid: "abc1234" }, "not a full 40-char SHA"],
    ["non-hex", { headOid: "z".repeat(40) }, "not a full 40-char SHA"],
  ];
  for (const [label, over, want] of cases) {
    const r = verifiedHeadFromEvidence(evidence(over));
    assert(
      !r.ok && r.refusal.reason.includes(want),
      `verified head ${label}: refuses with "${want}" (${JSON.stringify(r)})`,
    );
  }
  const good = verifiedHeadFromEvidence(evidence());
  assert(good.ok && good.headOid === HEAD, "verified head: a full OID is accepted");
  // The read's own words survive: the operator sees WHICH read failed.
  const r = verifiedHeadFromEvidence(
    evidence({ headOid: undefined, headOidError: "the PR-state read for PR #7 failed" }),
  );
  assert(
    !r.ok && r.refusal.reason.includes("PR-state read for PR #7"),
    "verified head: the evidence read's own reason is surfaced verbatim",
  );
}

// ── the ledger a case reads is the ledger it names ────────────────────────

await assertLedgerFileIsHonoured();

// ── check 2: the verified head IS the reviewed one ────────────────────────

{
  // The common case: the branch has not moved since the review. Nothing is
  // fetched — the verified head IS the reviewed head, so a fetch would be a
  // network call whose answer cannot change the verdict.
  const c = fakeClone();
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(r.ok && r.headOid === HEAD, `head unchanged: merges pinned (${JSON.stringify(r)})`);
  assert(
    !!r.ok && r.note.includes("the head the lens review recorded"),
    "head unchanged: the merged note records what was confirmed",
  );
  assert(!fetched(c.calls), "head unchanged: nothing is fetched when the heads agree");
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // A moved mainline is NOT a reason to refuse: the head moved, its patch
  // identity did not, and the merge stays pinned to the verified OID. Real
  // commits, real `git patch-id`.
  //
  // The VERIFIED head is the commit the CI evidence read: the branch head at the
  // moment CI ran, which is the commit the lens review recorded — CI runs on the
  // reviewed commit, and the base moved only afterwards. The branch has since
  // taken the mainline in, so the OID the forge holds now is a third commit. The
  // pin is still the verified OID, never the forge head: if the remote moved
  // under the evidence read, the forge refuses the pinned merge, which is the
  // right outcome and is classified upstream.
  const c = await realClone({ mainlineMoved: true });
  const reviewedCommit = await firstWorkCommit(c.origin, c.branch);
  assert(
    c.forgeHead !== reviewedCommit,
    "mainline merged in: the fixture moved the head, so the comparison actually runs (otherwise this case is the no-op fast path)",
  );
  const verifiedCommit = await mergeCommitCovering(c.origin, c.branch, reviewedCommit);
  // The comparison only runs if the two commits it weighs are two commits: same
  // content, different OIDs, which is the whole reason the rule is a patch identity
  // and not a SHA comparison. Asserted before the call, because a fixture that
  // quietly failed to move the head hands the check its "nothing moved" fast path
  // and every assertion below passes with the identity code never having run.
  assert(
    verifiedCommit !== reviewedCommit,
    "mainline merged in: the verified commit is a different commit from the reviewed one, so the identity comparison actually runs",
  );
  const ledger2 = ledgerFileFor(c, reviewedCommit);
  const r = await verifyMergeHead(
    realGit,
    c.dir,
    c.branch,
    evidenceAt(verifiedCommit),
    { ledgerFile: ledger2 },
  );
  assert(
    r.ok && r.headOid === verifiedCommit,
    `mainline merged in: merges PINNED TO THE VERIFIED OID (${JSON.stringify(r)})`,
  );
  assert(
    !!r.ok && r.note.includes("patch identity is unchanged"),
    "mainline merged in: the note says why the moved head is still the reviewed content",
  );
  rmSync(c.dir, { recursive: true, force: true });
  rmSync(ledger2, { recursive: true, force: true });
}

{
  // The head carries a patch the review never covered — THE defect. Same real
  // clone, one extra commit: the only difference from the case above is
  // unreviewed content, so a refusal here can only come from the comparison.
  const c = await realClone({ mainlineMoved: true, unreviewedPush: true });
  assert(
    c.forgeHead !== c.reviewedHead,
    "content changed: the fixture moved the head, so the comparison actually runs",
  );
  // The row names the branch's own first commit, not the fixture's `reviewedHead`
  // after the merge: a row naming a commit on the far side of a mainline merge
  // makes the two diffs describe the same content, because a merge commit's diff
  // against the merge base already contains everything the branch contributed.
  const reviewedCommit = await firstWorkCommit(c.origin, c.branch);
  const ledger = ledgerAt(lensRow(c.branch, reviewedCommit), c.dir, lensRow(c.branch, UNREVIEWED_PLACEHOLDER));
  const r = await verifyAtReviewedCommit(realGit, c.dir, c.branch, ledger, {
    at: "HEAD",
    reviewed: reviewedCommit,
  });
  assert(
    !r.ok && r.refusal.reason.includes("not the reviewed one"),
    `content changed after the review: parks (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reviewedHead === reviewedCommit && r.refusal.foundHead === c.forgeHead,
    `content changed: the park names BOTH heads it compared — the reviewed commit and the head to merge (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
}

{
  // A new commit pushed without the mainline moving at all is the same refusal,
  // and it is the case the guard's `--match-head-commit` alone cannot catch —
  // it pins, it does not verify.
  const c = await realClone({ unreviewedPush: true });
  assert(
    c.forgeHead !== c.reviewedHead,
    "pushed commit, no base move: the fixture moved the head, so the comparison actually runs",
  );
  const reviewedCommit = await firstWorkCommit(c.origin, c.branch);
  const ledger = ledgerAt(lensRow(c.branch, reviewedCommit), c.dir, lensRow(c.branch, UNREVIEWED_PLACEHOLDER));
  const r = await verifyAtReviewedCommit(realGit, c.dir, c.branch, ledger, {
    at: "HEAD",
    reviewed: reviewedCommit,
  });
  assert(
    !r.ok && r.refusal.reason.includes("not the reviewed one"),
    `a pushed commit with no base move: parks (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
}

{
  // No lens row at all: the driver's review never recorded a commit, so nothing
  // licenses the merge — and no fetch is paid for a comparison that has no
  // reviewed head.
  const c = fakeClone();
  const ledger = ledgerAt([], c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(
    !r.ok && !!r.refusal.reason.match(/no lens review row/),
    `no lens row: parks (${JSON.stringify(r)})`,
  );
  assert(!fetched(c.calls), "no lens row: no fetch is paid for a comparison with no reviewed head");
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The head the ledger holds is not a commit, in the two shapes the writer has
  // actually produced: a branch NAME where an OID belongs (the pre-#1039 shape)
  // and an abbreviated OID. Such a row is UNKNOWN and UNKNOWN parks:
  // string-comparing a ref against an OID would call the mismatch evidence of
  // drift and park a cycle whose head is fine. (A row with no `headSha` at all is
  // the `no lens row` case above — JSON drops an undefined field and the
  // production writer omits it too, so both shapes are the same ledger on disk.)
  for (const unusable of [{ headSha: "feature/x" }, { headSha: "abc1234" }]) {
    const ledger = ledgerAt(lensRow("feature/x", unusable.headSha));
    const c = fakeClone();
    const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
      ledgerFile: ledger,
    });
    assert(
      !r.ok && r.refusal.reason.includes("no lens review row"),
      `a lens row whose headSha is ${JSON.stringify(unusable)} is not a reviewed head (${JSON.stringify(r)})`,
    );
    rmSync(c.dir, { recursive: true, force: true });
  }
}

{
  // A row for another kind must not satisfy this branch's lookup even with a
  // matching head: the guard's adversarial rule is not this check's rule.
  const c = fakeClone();
  const ledger = ledgerAt([
    { branch: "feature/x", kind: "adversarial", patchId: PATCH, passed: true, at: 1, headSha: HEAD },
  ]);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(!r.ok, `an adversarial row is not the reviewed head (${JSON.stringify(r)})`);
  rmSync(c.dir, { recursive: true, force: true });
}


{
  // An identity that cannot be COMPUTED is a refusal: "could not tell" is not
  // "equal", and a one-sided comparison must not license a merge. Withheld at the
  // reviewed side (the stub, whose patch-id answers empty) and at the verified
  // side (real git, one answer suppressed) so neither refusal is an artefact of
  // the other side being absent.
  const c = fakeClone({ patchId: "" });
  const ledger = ledgerAt(lensRow("feature/x", MOVED), c.dir, lensRow("feature/x", HEAD));
  const r1 = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: HEAD }), {
    ledgerFile: ledger,
  });
  assert(
    !r1.ok && r1.refusal.reason.includes("at the reviewed head"),
    `an identity that cannot be computed at the reviewed head parks (${JSON.stringify(r1)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The reviewed commit is not in the clone — the shape a row naming a rewritten
  // or garbage-collected commit produces. The refusal names BOTH SHAs: an operator
  // reading the park has to be able to tell the review's commit from the one the
  // merge would have made, and a refusal that says only "an identity failed" makes
  // them guess which of the two git could not describe.
  const c = fakeClone({ missingIdentityOf: MOVED });
  const ledger = ledgerAt(lensRow("feature/x", MOVED), c.dir);
  // The reviewed commit is not in the clone — the shape a row naming a rewritten
  // or garbage-collected commit produces. THE COMPLAINT AND THE TWO SHAs ARE BOTH
  // TESTED HERE, and they are two assertions because they are two requirements:
  // the reason has to say WHICH commit git could not describe (a bare "an identity
  // failed" makes the operator guess which of the two was unreadable), and it has
  // to carry the 8-char prefix of each side so the park can be matched against the
  // branch's history. The structured `reviewedHead`/`foundHead` fields are asserted
  // separately below — a refusal that fills them while printing only one OID is
  // still useless to whoever reads the park.
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: HEAD }), {
    ledgerFile: ledger,
  });
  assert(
    !r.ok && r.refusal.reason.includes("at the reviewed head"),
    `a reviewed commit the clone cannot describe names the reviewed side of the comparison (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reason.includes(MOVED.slice(0, 8)),
    `the refusal prints the reviewed commit it could not read (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reason.includes(HEAD.slice(0, 8)),
    `the refusal prints the head it would have merged (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reviewedHead === MOVED && r.refusal.foundHead === HEAD,
    `a reviewed commit the clone cannot describe reports both SHAs in its refusal (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The same fault on the side that would be merged: the verified commit's
  // identity cannot be computed. Real git, one answer suppressed, so this is
  // git's own "unknown revision" rather than a stub's silence — and the
  // discriminator is the OID the diff names, not the word "patch-id", which
  // matches both sides and would leave the check refusing at the wrong one.
  const c = await realClone({ mainlineMoved: true });
  const reviewedCommit = await firstWorkCommit(c.origin, c.branch);
  assert(
    c.forgeHead !== reviewedCommit,
    "verified identity unavailable: the fixture moved the head, so the comparison actually runs",
  );
  const ledger = ledgerAt(lensRow(c.branch, reviewedCommit), c.dir, lensRow(c.branch, reviewedCommit));
  const exec: VerifyExecFn = async (cmd, o) => {
    const target = o?.argv?.join(" ") ?? cmd;
    if (target.includes("patch-id") && target.includes(c.forgeHead)) return { stdout: "" };
    return realGit(cmd, o);
  };
  const r = await verifyMergeHead(exec, c.dir, c.branch, evidenceAt(c.forgeHead), {
    ledgerFile: ledger,
  });
  assert(
    !r.ok && r.refusal.reason.includes("at the head to merge") && r.refusal.reason.includes(c.forgeHead.slice(0, 8)),
    `an identity that cannot be computed at the head to merge parks, naming it (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
