/**
 * merged-head-fixtures — the shared harness for the #1533 head-verification
 * suite, split out of test-work-driver-merged-head.ts (file-size gate).
 *
 * WHY A LIBRARY AND NOT A COPY. The suite is split across several test files —
 * one per question the check answers — and every one of them needs the same
 * three things: a claim counter that sets the process exit code, evidence shaped
 * the way `gatherMergeEvidence` shapes it, and a lens ledger row shaped the way
 * `writeLensLedgerEntry` (lens-ledger.ts) writes it. Two copies of the row
 * builder is how a fixture drifts away from the writer it claims to imitate, and
 * a row that drifts makes a merge check pass against a ledger no production code
 * could have produced.
 *
 * THE FIXTURE'S THREE COMMIT ROLES, which the whole suite turns on:
 *
 *   - the REVIEWED commit — what the lens row's `headSha` names: the commit the
 *     six-lens review actually covered.
 *   - the VERIFIED commit — what the CI evidence names, and the OID the merge is
 *     pinned to.
 *   - the FORGE head — what `origin/<branch>` points at when the check runs.
 *
 * In an ordinary cycle all three are one commit. The cases that matter make them
 * differ, and each difference is a different question: reviewed ≠ verified asks
 * "did content change after the review"; verified ≠ forge asks nothing at all,
 * because the pin is the verified OID and a forge that moved under it refuses the
 * `--match-head-commit` merge — which is why no case here asserts on a fetched OID.
 *
 * The moved-head drivers at the bottom of this file (`verifyAtReviewedCommit`,
 * `mergeCommitCovering`) keep the reviewed and verified commits as SEPARATE
 * parameters. A helper that resolves both from one string re-creates the bug
 * these files exist to catch: the check compares a commit with itself and approves
 * whatever the review never saw.
 */

import type { LedgerEntry } from "../../src/review-ledger.ts";
import { appendLedgerEntry, readLedgerFileSafe } from "../../src/review-ledger.ts";
import { sameResolvedPath } from "../../src/review-ledger-path.ts";
import { isFullCommitSha, resolveHeadSha } from "../../src/review-head-sha.ts";
import { execp } from "../../src/exec.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import type { MergeEvidence } from "../../src/work-driver-merge-authority.ts";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** The process verdict, shared so every file in the suite exits 1 on any failure. */
export const state: { exit: number } = { exit: 0 };

/** One assertion: prints a line and marks the process failed when it is false. */
export function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    state.exit = 1;
  }
}

/** A plausible full OID that no fixture ever creates (a stub's reviewed head). */
export const HEAD = "1".repeat(39) + "a";
/** A second stub OID, distinct from HEAD, for a row that must not match. */
export const MOVED = "2".repeat(39) + "b";
/**
 * An OID no fixture ever creates, for the rows that must NOT match the head.
 *
 * It cannot collide with a real commit, and a check that read it as a reviewed
 * head would say so rather than quietly agreeing with whatever it was handed.
 */
export const UNREVIEWED_PLACEHOLDER = "2".repeat(39) + "b";
/** The patch id a stubbed `git patch-id` answers with. */
export const PATCH = "abc123def456abc123def456abc123def456abc123de";
/** The merge base a stubbed `git merge-base` answers with. */
export const MERGE_BASE = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** Evidence carrying the head the CI verdict was read at (`HEAD`). */
export function evidence(over: Partial<MergeEvidence> = {}): MergeEvidence {
  return { ok: true, failing: [], inconclusive: [], headOid: HEAD, ...over };
}

/**
 * Evidence whose verified head is `headOid`.
 *
 * The head check's cheap refusals run before its ledger read, so a case cannot
 * reach the ledger branch with a malformed OID: the check parks on "no head OID"
 * and reports a pass that has nothing to do with the ledger. Every case that
 * asserts what a LEDGER does therefore carries an OID the check will accept, and
 * the OID it carries is the one the case is about rather than a placeholder the
 * check happens to tolerate.
 */
export function evidenceAt(headOid: string, over: Partial<MergeEvidence> = {}): MergeEvidence {
  return { ok: true, failing: [], inconclusive: [], headOid, ...over };
}

/**
 * Evidence for the MOVED-head stub cases: the CI verdict was read at `MOVED`
 * while the lens row on the ledger still names `HEAD` — the shape the head check
 * exists to examine. `evidence()` alone is the "nothing moved" shape.
 */
export function movedEvidence(): MergeEvidence {
  return evidence({ headOid: MOVED });
}

/** The first line of a git answer, trimmed — a read that returned a list names no commit. */
function oneLine(value: string | undefined): string | undefined {
  return value?.split("\n")[0]?.trim();
}

/**
 * The lens row the driver's lens step writes for `branch`, pinning `headSha`.
 *
 * Field-for-field the shape `writeLensLedgerEntry` builds (kind `lens`, the
 * verdict in `detail`, the OID in `headSha`): a row this builder cannot produce
 * is a row the check would never see in production, so a case that needs a
 * different shape is telling you the check accepts something no writer writes.
 */
export function lensRow(
  branch: string,
  headSha = HEAD,
  over: Record<string, unknown> = {},
): LedgerEntry[] {
  return [
    {
      branch,
      kind: "lens",
      patchId: PATCH,
      passed: true,
      at: 1,
      round: 1,
      hasCritical: false,
      detail: "APPROVED",
      headSha,
      ...over,
    } as unknown as LedgerEntry,
  ];
}

/** Write `entries` as the ledger at `file`, creating its parent directory. */
export function seedLedger(file: string, entries: readonly unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ entries }), "utf8");
}

/** The clone's own ledger — what `ledgerPathFor` resolves to with no override. */
export function cloneLedgerFile(dir: string): string {
  return path.join(dir, ".git", "review-ledger.json");
}

/**
 * Write the lens row through the PRODUCTION writer and return the file the read
 * must then be pointed at.
 *
 * `seedLedger` writes the JSON a case describes; this writes the JSON the
 * `lens` writer actually produces, through `appendLedgerEntry` — the atomic
 * read/merge/rename path that stamps `writtenTo` and takes the ledger lock. A
 * check that only ever reads a hand-written file can pass against a row shape no
 * writer emits (a missing field, a different key, an entry the merge-tolerant
 * append would have folded away), and that is the gap this closes: the row the
 * merge step reads back is the row the lens step's own code wrote.
 *
 * Isolation is the fixture's OWN temp file, exported around the write and restored
 * afterwards. The ledger's isolation marker is `PI_ENSEMBLE_REVIEW_LEDGER_FILE`,
 * which short-circuits `ledgerPathFor` before any git call, so writer and reader
 * agree on one file by construction; the harness does NOT export it globally
 * (`test-ledger-isolation.ts` forbids that), which is why a fixture that read the
 * ambient value would run on a developer's shell and abort in the loop. Each call
 * starts from an empty ledger — `appendLedgerEntry` is deliberately MERGE-TOLERANT,
 * so a leftover row would sit beside this case's row and the check would answer from
 * whichever of the two `latestEntry` prefers — asserts the writer reported landing
 * on the path the read is pointed at (a redirect means the override moved mid-case),
 * and asserts the file then holds exactly ONE lens row for the branch carrying the
 * reviewed OID. Those checks are what make "the check read what the production
 * writer wrote" a fact rather than an intention.
 */
export async function seedLensRowWithProductionWriter(
  dir: string,
  branch: string,
  headSha: string,
): Promise<string> {
  // Isolation is always this fixture's OWN temp file, exported for the duration of
  // the write and the read that follows. It is not read from the ambient
  // environment, and that is the point: `test-ledger-isolation.ts` forbids the
  // harness from exporting the override globally (a ledger test whose writer must
  // land in a temp repo's git dir would otherwise be redirected to a shared file),
  // so a case that merely *hoped* to find it set would abort in the loop and pass
  // on a developer's shell — a case that runs in one context and not the other is
  // a case that is not being tested. The override short-circuits `ledgerPathFor`
  // before any git call, so writer and reader agree on one file by construction,
  // and the `finally` restores whatever the caller had, so no later test inherits
  // this one's ledger.
  const prior = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const override = path.join(mkdtempSync(path.join(tmpdir(), "mhead-prod-")), "review-ledger.json");
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = override;
  try {
    return await writeAndVerifyLensRow(dir, branch, headSha, override);
  } finally {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prior;
  }
}

/** The body of `seedLensRowWithProductionWriter`, under an isolation path it owns. */
async function writeAndVerifyLensRow(
  dir: string,
  branch: string,
  headSha: string,
  override: string,
): Promise<string> {
  // The one write the fixture makes directly, and the only file it may touch: the
  // ledger the override names, emptied so the single row below is the only row the
  // check can find. Not a seed — `appendLedgerEntry` is the writer under test.
  mkdirSync(path.dirname(override), { recursive: true });
  writeFileSync(override, JSON.stringify({ entries: [] }), "utf8");
  const stamped: { current: LedgerEntry; landedAtPath?: string } = {
    current: { branch, kind: "lens", patchId: PATCH, passed: true, at: Date.now() },
  };
  const failure = await appendLedgerEntry(
    {
      branch,
      kind: "lens",
      patchId: PATCH,
      passed: true,
      at: Date.now(),
      round: 1,
      hasCritical: false,
      detail: "APPROVED",
      headSha,
    } as unknown as LedgerEntry,
    execp,
    dir,
    stamped,
  );
  if (failure)
    throw new Error(`fixture: the production ledger writer refused the row (${failure})`);
  if (stamped.landedAtPath !== undefined && !sameResolvedPath(stamped.landedAtPath, override)) {
    throw new Error(
      `fixture: the row landed at ${stamped.landedAtPath}, outside the path the read is pointed at (${override})`,
    );
  }
  const rows = readLedgerFileSafe(override).entries.filter(
    (e) => e.kind === "lens" && e.branch === branch,
  );
  if (rows.length !== 1) {
    throw new Error(
      `fixture: the production writer left ${rows.length} lens rows for ${branch} in ${override}, expected exactly 1`,
    );
  }
  if (rows[0]?.headSha !== headSha) {
    throw new Error(
      `fixture: the row the production writer stored names ${rows[0]?.headSha?.slice(0, 8)}, not the reviewed commit ${headSha.slice(0, 8)}`,
    );
  }
  return override;
}

/**
 * Seed `entries` into BOTH ledgers a read can legitimately land on, and return
 * the path a caller hands to `verifyMergeHead` as `ledgerFile`.
 *
 * The two are the file named by `ledgerFile` and the clone's own file — the
 * production answer, which is what a caller that passes no `ledgerFile` reads.
 * A case that seeds only the first can be answered out of the second, and then it
 * is testing nothing; a case that seeds only the second cannot say which ledger
 * produced its verdict. `cloneEntries` makes the two differ, which is how the
 * case that must prove the parameter is wired to the read does it.
 *
 * What it deliberately does NOT seed is `PI_ENSEMBLE_REVIEW_LEDGER_FILE`. That
 * override short-circuits `ledgerPathFor` before any git call and is the
 * documented isolation for every ledger-writing test in this suite, so it may
 * point at a file another case filled; writing there would turn these cases into
 * one shared mutable fixture. Every case therefore states the ledger it reads.
 */
export function ledgerAt(
  entries: readonly unknown[],
  dir?: string,
  cloneEntries?: readonly unknown[],
): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mhead-ledger-")), "review-ledger.json");
  seedLedger(file, entries);
  if (dir !== undefined) seedLedger(cloneLedgerFile(dir), cloneEntries ?? entries);
  return file;
}
