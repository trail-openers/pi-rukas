/**
 * #1533 — the merged step reads back a lens row the PRODUCTION writer wrote.
 *
 * The sibling file drives the head rule against `seedLedger`, which writes the
 * JSON a case describes. That is the right tool for a case about the RULE — a
 * rule should be judged on the row shape it is documented to read, not on
 * whatever one writer happens to emit today — but it cannot catch the failure
 * this file exists for: the check passing against a row no production code could
 * have produced. `writeLensLedgerEntry` (lens-ledger.ts) builds the row and hands
 * it to `appendLedgerEntry` (review-ledger.ts), the atomic read/merge/rename path
 * that stamps `writtenTo`, takes the ledger lock, and folds a concurrent writer's
 * rows rather than replacing them. If that path stores `headSha` under another
 * key, drops it, or the merge-tolerant append reorders the rounds, the driver's
 * merge would answer "no lens row" for a review that ran — or answer from a row
 * other than the latest — and every hand-written fixture here would stay green.
 *
 * So this file writes the row with the real writer, reads it back with the real
 * reader, and then asks the merge check the same questions the sibling asks, with
 * the row's provenance fixed rather than assumed: the fixture asserts the writer
 * reported landing on the path the check is pointed at, and asserts the file holds
 * exactly one lens row for the branch carrying the reviewed OID. A case whose
 * ledger silently came from somewhere else fails at the fixture, not at the
 * assertion — which is the only version of "the check read what the writer wrote"
 * that means anything.
 */

import { setupSpawnGuard } from "./test-helpers.ts";
import { readLedgerAt } from "../src/review-ledger.ts";
import {
  assert,
  evidenceAt,
  seedLensRowWithProductionWriter,
  state,
} from "./lib/merged-head-fixtures.ts";
import { firstWorkCommit, realClone, realGit } from "./lib/merged-head-git.ts";
import {
  verifiedHeadFromEvidence,
  verifyMergeHead,
} from "../src/work-driver-merged-head.ts";
import { rmSync } from "node:fs";

setupSpawnGuard();

// ── the writer must land where the reader looks, or the case is not a test ──

{
  // The precondition that makes every case below a test rather than a tautology:
  // the fixture isolates the ledger by exporting `PI_ENSEMBLE_REVIEW_LEDGER_FILE`
  // around the write and the read, and the check must resolve the SAME file the
  // writer wrote to. If the production read ever stopped honouring that override —
  // resolving the clone's git dir instead — every case here would still be green
  // while reading an empty ledger and refusing for the wrong reason. `readLedgerAt`
  // on the fixture's own path is the independent confirmation that the row the
  // writer stored is on disk where the check is pointed, before the check is asked
  // anything about it.
  const probe = await realClone();
  const path = await seedLensRowWithProductionWriter(probe.dir, probe.branch, probe.reviewedHead);
  const rows = readLedgerAt(path).filter(
    (e) => e.kind === "lens" && e.branch === probe.branch,
  );
  assert(
    rows.length === 1 && rows[0]?.headSha === probe.reviewedHead,
    `the row the production writer stored is on disk at the path the check reads (${JSON.stringify(rows.map((r) => r.headSha?.slice(0, 8)))})`,
  );
  assert(
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === undefined ||
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE !== path,
    "the fixture restores the environment after the write, so a later test never inherits this ledger",
  );
  rmSync(probe.dir, { recursive: true, force: true });
}

// ── a row the writer wrote is the row the merge step reads ─────────────────

{
  // reviewed == verified, end to end through the writer: the merge is pinned to
  // the verified OID and nothing is fetched, because the OID the lens step
  // recorded IS the OID the evidence names. `resolveHeadSha` recorded the row's
  // `headSha` at review time, so both sides of the comparison are git's own answer
  // rather than a fixture's, and the pin is checked against the OID the writer
  // actually stored — read out of the ledger below, not handed in by this case.
  const c = await realClone();
  const ledgerPath = await seedLensRowWithProductionWriter(c.dir, c.branch, c.reviewedHead);
  const r = await verifyMergeHead(realGit, c.dir, c.branch, evidenceAt(c.reviewedHead), {
    ledgerFile: ledgerPath,
  });
  assert(
    r.ok && r.headOid === c.reviewedHead,
    `a production-written lens row licenses the merge, pinned to the reviewed OID (${JSON.stringify(r)})`,
  );
  assert(
    !!r.ok && r.note.includes("the head the lens review recorded"),
    "a production-written lens row: the note names the review as the authority for the pin",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The defect, with the row produced by the writer rather than described by the
  // case: the review covered A, a content commit landed afterwards, and the CI
  // evidence — read later — names B. The check must refuse, and the refusal must
  // name A and B, because an operator reading the park has to be able to tell the
  // commit the review covered from the commit the merge would have made.
  //
  // This is the case the previous implementation passed: it measured the verified
  // head and the head the fetch had just read back, and under this exact sequence
  // those are the same commit B, so the two identities agreed by construction and
  // B merged unreviewed. Nothing but a real content commit distinguishes the two
  // implementations, which is why this case runs against real git.
  const c = await realClone({ unreviewedPush: true });
  const reviewedCommit = await firstWorkCommit(c.origin, c.branch);
  assert(
    c.forgeHead !== reviewedCommit,
    "the fixture pushed a commit the review never covered, so the comparison has two commits to weigh",
  );
  const ledgerPath = await seedLensRowWithProductionWriter(c.dir, c.branch, reviewedCommit);
  const r = await verifyMergeHead(realGit, c.dir, c.branch, evidenceAt(c.forgeHead), {
    ledgerFile: ledgerPath,
  });
  assert(
    !r.ok && r.refusal.reason.includes("not the reviewed one"),
    `a commit pushed after a production-recorded review parks (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reason.includes(reviewedCommit.slice(0, 8)),
    `the refusal names the reviewed commit A the approval covers (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reason.includes(c.forgeHead.slice(0, 8)),
    `the refusal names the head B it would have merged (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reviewedHead === reviewedCommit && r.refusal.foundHead === c.forgeHead,
    `the refusal's structured SHAs are A and B — the reviewed commit and the head to merge (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && !r.refusal.reason.includes("passed"),
    `the park does not re-judge the lens verdict; it says the approval does not cover the head (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The same refusal when the mainline ALSO moved: a base move is forgiven and an
  // unreviewed content push is not, and a rule that got the order of those two
  // judgements wrong would pass one of the two cases above. The row is the one the
  // writer stored; the verified head is the branch's tip after both moves.
  const c = await realClone({ mainlineMoved: true, unreviewedPush: true });
  const reviewedCommit = await firstWorkCommit(c.origin, c.branch);
  const ledgerPath = await seedLensRowWithProductionWriter(c.dir, c.branch, reviewedCommit);
  const r = await verifyMergeHead(realGit, c.dir, c.branch, evidenceAt(c.forgeHead), {
    ledgerFile: ledgerPath,
  });
  assert(
    !r.ok && r.refusal.reason.includes("not the reviewed one"),
    `a base move does not excuse unreviewed content (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The reviewed commit is not in the clone at all. This is the shape a force-push
  // or a garbage-collected object produces, and the check cannot compute an identity
  // over a commit git cannot describe — so it refuses rather than reporting the two
  // sides equal. Both SHAs appear in the refusal, and the structured fields carry
  // them, because "an identity failed" alone cannot be acted on.
  const c = await realClone({ mainlineMoved: true });
  // An OID from a different history entirely: git's own `unknown revision`, not a
  // fixture's silence. It is a full 40-char SHA so the row survives the shape check
  // and the refusal that follows is the identity's, which is the case being posed.
  const absent = "f".repeat(40);
  const ledgerPath = await seedLensRowWithProductionWriter(c.dir, c.branch, absent);
  const r = await verifyMergeHead(realGit, c.dir, c.branch, evidenceAt(c.forgeHead), {
    ledgerFile: ledgerPath,
  });
  assert(
    !r.ok && r.refusal.reason.includes("at the reviewed head"),
    `a reviewed commit the clone does not have parks at the reviewed side (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reason.includes(absent.slice(0, 8)) && r.refusal.reason.includes(c.forgeHead.slice(0, 8)),
    `the refusal names BOTH SHAs — the commit git could not read and the head it would have merged (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reviewedHead === absent && r.refusal.foundHead === c.forgeHead,
    `a missing reviewed commit still reports both SHAs structurally (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The pin's own claim, checked against the ledger rather than asserted: whatever
  // the check returns as `headOid` is the OID the merge command will match, so a
  // pass must be a full 40-char SHA that the row and the evidence agree on — not a
  // ref name, an abbreviation, or a value the check re-derived from the remote.
  const c = await realClone();
  const ledgerPath = await seedLensRowWithProductionWriter(c.dir, c.branch, c.reviewedHead);
  const r = await verifyMergeHead(realGit, c.dir, c.branch, evidenceAt(c.reviewedHead), {
    ledgerFile: ledgerPath,
  });
  assert(
    r.ok && /^[0-9a-f]{40}$/.test(r.headOid),
    `the pin is a full OID, never a ref or an abbreviation (${JSON.stringify(r)})`,
  );
  const cheap = verifiedHeadFromEvidence(evidenceAt(c.reviewedHead));
  assert(
    r.ok && cheap.ok && r.headOid === cheap.headOid,
    "the pinned OID is exactly the OID the merge evidence names — the check re-derives nothing",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
