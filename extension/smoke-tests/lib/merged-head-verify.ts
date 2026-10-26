/**
 * merged-head-verify — the two DRIVERS the #1533 head-verification suite runs
 * its moved-head cases through, split from lib/merged-head-fixtures.ts (the
 * §12 500-line cap, which exists for code a person has to hold in their head).
 *
 * Both drivers exist to make one class of green test impossible. The check under
 * test compares the commit the lens review recorded (REVIEWED) with the commit the
 * CI evidence names and the merge is pinned to (VERIFIED). Any helper that lets a
 * case express those two roles with one value makes the check compare a commit with
 * itself: it takes its "nothing moved" fast path, returns a note claiming the
 * review covered the head, and the assertions above it pass with the identity
 * comparison never having run. That is not a hypothetical — it is the defect these
 * files were written for, and the first version of this suite shipped a helper that
 * manufactured it.
 *
 * So both drivers take `at` and `reviewed` as SEPARATE parameters, and
 * `verifyAtReviewedCommit` refuses to build a case whose two sides are the same
 * commit. A case that needs the fast path says so by passing no helper at all.
 */

import {
  HEAD,
  MOVED,
  UNREVIEWED_PLACEHOLDER,
  assert,
  cloneLedgerFile,
  evidence,
  lensRow,
  ledgerAt,
  seedLedger,
} from "./merged-head-fixtures.ts";
import { readBranchHead } from "./merged-head-git.ts";
import { fakeClone, fetched } from "./merged-head-refusals.ts";
import { verifyMergeHead } from "../../src/work-driver-merged-head.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import { rmSync } from "node:fs";

/** The first line of a git answer, trimmed — a read that returned a list names no commit. */
function oneLine(value: string | undefined): string | undefined {
  return value?.split("\n")[0]?.trim();
}

/**
 * Drive one moved-head case against real commits.
 *
 * The two commits the case is about are kept apart by the type because they
 * answer different questions and the whole test hinges on their not being
 * conflated:
 *
 * - `at` is the commit CI (and so the lens review) ran on — the OID handed to
 *   the check as the VERIFIED head, the left side of the comparison.
 * - `reviewed` is the commit the lens row records — the right side, what the
 *   approval is claimed to cover.
 *
 * They coincide in the ordinary cycle and differ in exactly the cases that
 * matter here. Passing the row's SHA as the evidence head — which an earlier
 * version of this helper did, resolving both from one string — makes the check
 * compare a commit against itself, take its "nothing moved" fast path, and
 * approve with a note claiming the review covered it. One parameter cannot
 * express both roles; two can.
 */
export async function verifyAtReviewedCommit(
  exec: VerifyExecFn,
  dir: string,
  branch: string,
  ledgerFile: string,
  commits: { at?: string; reviewed?: string } = {},
): Promise<Awaited<ReturnType<typeof verifyMergeHead>>> {
  // The head the forge holds, read HERE rather than handed in from a fixture-side
  // value: a caller-computed OID can be stale by the time the check runs, and the
  // case's own assertions would then compare two values nobody read.
  const headOid = await readBranchHead(dir, branch, exec);
  let verifiedOid: string;
  if (commits.at === undefined || commits.at === "HEAD") {
    // "The commit CI verified is the branch's tip", read at the moment the case
    // runs — which for a clone the fixture has already advanced is a commit the
    // review never covered. A caller that cannot name the OID says so with
    // `"HEAD"`, and the helper reads the tip here rather than quietly reusing the
    // row's SHA.
    verifiedOid = headOid;
  } else {
    const probe = await readBranchHead(dir, branch, exec, oneLine(commits.at));
    verifiedOid = probe === commits.at ? headOid : probe;
  }
  const reviewedOid =
    commits.reviewed === undefined
      ? verifiedOid
      : await readBranchHead(dir, branch, exec, oneLine(commits.reviewed));
  // The pair must be two commits, or the comparison measures one commit twice and
  // its "unchanged" verdict proves nothing. This is the fixture refusing to write a
  // case that would be green while testing nothing — and the one a moved-head case
  // falls into whenever the two roles above are handed the same OID.
  if (verifiedOid === headOid && reviewedOid === headOid) {
    throw new Error(
      `fixture: the verified head and the reviewed head are both the forge head (${headOid.slice(0, 8)}) — the check would answer from its "nothing moved" fast path and these assertions would pass with the identity comparison never run`,
    );
  }
  // The row is written HERE, beside the two reads that fix the comparison, and it
  // names the reviewed commit — the one the approval covers, not the one CI ran on.
  seedLedger(ledgerFile, lensRow(branch, reviewedOid));
  // The clone's own ledger carries a row naming a DIFFERENT commit — one the branch
  // never had. Leaving it equal to the named row would be the hole this file kept
  // falling into: `ledgerPathFor` honours `PI_ENSEMBLE_REVIEW_LEDGER_FILE` before it
  // consults git, so under a harness that exports the override the read lands on a
  // file this helper wrote elsewhere, and if that file happened to name the verified
  // head the check took its "nothing moved" fast path and approved the merge while
  // every assertion here believed the identity comparison had run.
  seedLedger(cloneLedgerFile(dir), lensRow(branch, UNREVIEWED_PLACEHOLDER));
  return verifyMergeHead(
    exec,
    dir,
    branch,
    { ok: true, failing: [], inconclusive: [], headOid: verifiedOid },
    { ledgerFile },
  );
}

/**
 * Proof that `ledgerFile` is honoured, not decoration.
 *
 * Every ledger-reading case passes it, so if `verifyMergeHead` ever ignored the
 * parameter the whole suite would quietly start reading the CLONE's ledger and
 * still pass — the assertions would be about a file nobody chose. This case puts
 * different rows in the two files and requires the one named by `ledgerFile` to
 * decide the verdict, which is the only way to know the parameter is wired to the
 * read it claims to control.
 */
export async function assertLedgerFileIsHonoured(): Promise<void> {
  const c = fakeClone();
  // The clone's ledger says the reviewed head is some other commit; the file
  // named by `ledgerFile` says it is the verified head. Only one of the two can
  // produce "the head has not moved", so the verdict names the file it read.
  const ledger = ledgerAt(lensRow("feature/x", HEAD), c.dir, lensRow("feature/x", MOVED));
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(
    r.ok && r.headOid === HEAD,
    `ledgerFile decides which ledger is read — the clone's own ledger names ${MOVED} and was not consulted (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}
