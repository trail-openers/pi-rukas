/**
 * #1533 — a head check that CANNOT run still pins, and says so.
 *
 * The merge is pinned to the verified OID whenever the driver has an OID to pin.
 * The reviewed-head comparison is a second, separate judgement, and there are
 * three inputs under which it cannot be made at all:
 *
 *   - no branch name — the key the lens row is looked up by is absent (a resumed
 *     or hand-built state file);
 *   - no repository to read a ledger from (`skipIdentity`, and the driver's
 *     `hasGitDir` guard for the same case);
 *   - no ledger, in either of its two forms.
 *
 * In all three the step must still pin, because an unpinned merge is the original
 * defect — "merge this PR" merges whatever the forge holds at the moment the
 * command runs. But a pass must be honest about what it did not check: the note
 * says the comparison did not run, and the pass carries no claim that the review
 * covered the head. A green merge that quietly asserts coverage it never
 * established is worse than a park, because the park is at least legible.
 *
 * And the refusals that ARE the rule's answers must not be paid for twice: the
 * cheap ones (no OID, no branch name) all run before any network call, so a cycle
 * that can never merge never spends a fetch or a ledger read. Those assertions
 * are the "nothing fetched" lines below, and they are the reason the order of the
 * checks is part of the contract rather than an implementation detail.
 */

import { setupSpawnGuard } from "./test-helpers.ts";
import {
  HEAD,
  assert,
  evidence,


  lensRow,
  ledgerAt,
  state,
} from "./lib/merged-head-fixtures.ts";
import { fakeClone, fetched } from "./lib/merged-head-refusals.ts";
import { verifyMergeHead } from "../src/work-driver-merged-head.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { rmSync } from "node:fs";

setupSpawnGuard();

// ── a comparison that cannot run still pins, and says so ───────────────────

{
  // No branch name: the ledger lookup has no key, so the comparison cannot be
  // made. The step pins anyway and the note admits the comparison is absent —
  // parking such a cycle on "no lens row on file" would be the driver inventing a
  // fault the cycle never had.
  const c = fakeClone();
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, undefined, evidence(), {
    ledgerFile: ledger,
  });
  assert(
    r.ok && !!r.ok && r.note.includes("did not run"),
    `no branch name: pinned, and the note says the comparison did not run (${JSON.stringify(r)})`,
  );
  assert(!fetched(c.calls), "no branch name: nothing fetched");
  assert(
    r.ok && r.headOid === HEAD,
    `no branch name: the pin is still the verified OID (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The caller-level switch: a caller with no repository to read a ledger from
  // pins rather than parking on a fault the cycle never had. It pins WITHOUT even
  // probing for a remote — the comparison is off, so the remote it would need is
  // not asked for, and a cycle whose repository is not a git dir at all is not
  // charged for discovering that.
  const c = fakeClone({ noRemote: true });
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
    skipIdentity: true,
  });
  assert(r.ok && r.headOid === HEAD, `skipIdentity: pinned without the comparison (${JSON.stringify(r)})`);
  assert(
    !c.calls.some((l) => l.includes("remote")),
    "skipIdentity: no remote probe is made",
  );
  assert(
    !!r.ok && r.note.includes("did not run"),
    "skipIdentity: the note is honest that the comparison did not run",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // skipIdentity does not forgive a missing OID. The pin is the whole value of the
  // step, and a pass that pins nothing is a pass that merges whatever the forge
  // holds — so the one input the step cannot do without is refused even when the
  // caller has asked for the cheapest possible path.
  const c = fakeClone();
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: undefined }), {
    skipIdentity: true,
  });
  assert(
    !r.ok && r.refusal.reason.includes("no head OID"),
    `skipIdentity still refuses a cycle with nothing to pin (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // Order matters: a missing head OID is refused before any ledger read or fetch,
  // so a cycle with nothing to pin never touches either. The step's cheapest
  // answer is also its first, and a reordering that put the ledger read first
  // would spend a git call and a file read to reach the same refusal — and, worse,
  // could turn "this clone has no ledger" into the reported cause of a cycle whose
  // real fault is an unreadable evidence read.
  const c = fakeClone();
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: undefined }), {
    ledgerFile: ledger,
  });
  assert(!r.ok, "no verified head: refused before the reviewed-head check");
  assert(
    !fetched(c.calls) && !c.calls.some((l) => l.includes("--git-common-dir")),
    "no verified head: nothing fetched and no ledger read",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The cheap refusals run before the ledger read, so an absent branch name and an
  // absent remote never read a file. That ordering is what makes the "the ledger
  // could not be found" refusal mean what it says: when it fires, a branch name and
  // a remote both existed and the ledger is genuinely the missing piece.
  const c = fakeClone({ noRemote: true });
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(
    !r.ok && r.refusal.reason.includes("no git remote"),
    `no remote: refused before the ledger is consulted (${JSON.stringify(r)})`,
  );
  assert(
    !c.calls.some((l) => l.includes("--git-common-dir")),
    "no remote: the ledger is not read for a refusal the step already has",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // An executor that throws on everything is the worst case a check can be handed,
  // and it is the one most likely to be reported as a pass: a stub that returns
  // `{stdout: ""}` for everything is indistinguishable from a check that answered
  // "no drift". Every read throwing must be a refusal, never a merge.
  const c = fakeClone();
  const throwing: VerifyExecFn = async () => {
    throw new Error("git is not available");
  };
  const r = await verifyMergeHead(throwing, c.dir, "feature/x", evidence());
  assert(
    !r.ok,
    `every git read throwing is a refusal, never a merge (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && !r.refusal.reason.includes("the merge is pinned"),
    "a refused check does not describe itself as having pinned",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
