#!/usr/bin/env bun
/**
 * #1557 (fixture half) — the row-nonce identity, exercised on real rows.
 *
 * Split out of `test-adversarial-ledger-row-identity.ts` (which is an
 * ALWAYS_RUN member of the #1647 develop-verify selection and must therefore
 * stay git-free): this file pays the git cost — a real clone fixture, the
 * REAL `writeAdversarialLedgerEntry`, and three `appendLedgerEntry` writes —
 * and it is selected by the import graph instead of running on every develop
 * round regardless of the diff.
 *
 * Two layers, each asserted at the level it lives at:
 *
 *   1. the WRITER: `writeAdversarialLedgerEntry` persists a well-formed
 *      caller `rowNonce` verbatim (the loop threads its `orchestratorJobId`
 *      there), bounds a malformed one to nothing (it is the merge guard's
 *      authority record — arbitrary caller text never rides into every future
 *      reader), and a row WITHOUT a nonce stays valid — the field is
 *      optional, so `validEntries` must not require it (hand-built and
 *      pre-#1557 rows carry none);
 *   2. the DATA SHAPE: with a decoy `passed=true detail="approved"` row for
 *      the same branch written LATER (higher `at`), the nonce-match selector
 *      returns the refusal row — while the guard readers (`latestEntry` /
 *      `dedupeLatest`) still pick by (branch, kind, max `at`): the nonce is
 *      test-facing provenance, NOT a guard key.
 *
 * The canary half (`test-adversarial-ledger-row-identity.ts`) pins the
 * mechanism that consumes these rows in the smoke arms.
 */

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import {
  type LedgerEntry,
  appendLedgerEntry,
  dedupeLatest,
  latestEntry,
  readLedgerFile,
} from "../src/review-ledger.ts";
import {
  APPROVED,
  BINDING_REFUSAL_PREFIXES,
  ledgerFile,
  setupRepo,
} from "./lib/adversarial-ledger-harness.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execp = async (
  cmd: string,
  opts?: { cwd?: string; maxBuffer?: number },
): Promise<{ stdout: string }> => {
  const stdout = execSync(cmd, {
    cwd: opts?.cwd,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    encoding: "utf8",
    env: gitTestEnv(),
    // Bounded subprocess I/O: a hung git call (lock contention on the shared
    // fixture, an fs stall) must surface as a named failure here, not as the
    // harness wall clock killing the whole smoke test.
    timeout: 30_000,
  });
  return { stdout };
};

/** A row is a binding refusal iff its detail opens with one of the prefixes
 * the guard itself recognises (same predicate the arms use). */
const isBindingRefusal = (detail: unknown): boolean =>
  typeof detail === "string" &&
  BINDING_REFUSAL_PREFIXES.some((prefix) => detail.startsWith(`${prefix}: `));

// The fixture's own creation is fallible — setupRepo() and ledgerFile() are
// git subprocess calls — so they run INSIDE the try that owns cleanup: a
// setup failure must not leak the temp directory past the run, nor crash
// with a bare exception no assertion names.
let repo = "";
let LEDGER_FILE = "";

/**
 * The rows on disk, with a read failure kept DISTINCT from an empty ledger.
 * Returning `[]` on a failed read would make every absence assertion below
 * vacuously true — the "nothing matched vs could not ask" collapse. A failure
 * therefore fails the run AT the read.
 */
const rowsOnDisk = (): LedgerEntry[] => {
  try {
    return readLedgerFile(LEDGER_FILE).entries;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    assert(
      false,
      `ledger: reading ${LEDGER_FILE} failed (${reason}) — an unreadable file is not an empty one`,
    );
    return [];
  }
};

try {
  const fixture = setupRepo();
  repo = fixture.dir;
  LEDGER_FILE = ledgerFile(repo);
  // #1069 self-isolation: name the single file every writer in this process
  // lands in, so a leaked override from the environment can never redirect
  // the rows these assertions read (`ledgerPathFor` returns the override
  // verbatim, with zero git calls, in BOTH the reader and the writer of this
  // process).
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = LEDGER_FILE;

  // ── 1. the writer threads the nonce end-to-end and persists it verbatim.
  // This is the production half of #1557: `runAdversarialLoop` hands its
  // `orchestratorJobId` to `makeLedgerWrite`, which passes it here; a row
  // whose field came from anywhere else is not the identity the arms trust.
  const written = await writeAdversarialLedgerEntry(APPROVED, {
    workCwd: repo,
    resolvedBranch: "feature/x",
    rowNonce: "job-writer-1557",
  });
  assert(written.recorded === true, `writer: the row was recorded (${JSON.stringify(written)})`);
  const nonceRow = rowsOnDisk().filter((e) => e.rowNonce === "job-writer-1557");
  assert(
    nonceRow.length === 1 && nonceRow[0]?.passed === true,
    `writer: exactly one row carries the caller-supplied nonce and stays PASSING (got ${JSON.stringify(nonceRow)})`,
  );

  // The nonce is caller-supplied text landing in the guard's authority
  // record, so the write boundary bounds it to a job-id shape: anything else
  // is dropped, never persisted. (Control characters and megabytes must not
  // ride into every future reader; `validEntries` deliberately does not
  // police this field.) ESC/BEL written as escapes, and a 200-char run — a
  // shape no `newJobId` can mint.
  const smuggled = await writeAdversarialLedgerEntry(APPROVED, {
    workCwd: repo,
    resolvedBranch: "feature/smuggled",
    rowNonce: `x\u001b]0;x\u0007${"A".repeat(200)}`,
  });
  assert(
    smuggled.recorded === true &&
      rowsOnDisk().every((e) => e.branch !== "feature/smuggled" || e.rowNonce === undefined),
    "writer: a malformed nonce is dropped at the write boundary, never persisted verbatim",
  );

  // A hand-built row WITHOUT a nonce must stay valid: the field is optional
  // provenance, so `validEntries` (which every read applies) must never
  // require it — a required nonce would delete every pre-#1557 row.
  const handReason = await appendLedgerEntry(
    {
      branch: "feature/no-nonce",
      kind: "adversarial",
      patchId: "handbuilt-patch-id",
      passed: true,
      at: Date.now(),
      detail: "approved",
    },
    execp,
    repo,
  );
  assert(handReason === undefined, "writer: a row without a nonce is accepted");
  const handRow = rowsOnDisk().find((e) => e.branch === "feature/no-nonce");
  assert(
    handRow !== undefined && handRow.rowNonce === undefined,
    "writer: the nonce-less row survives `validEntries` with no nonce field",
  );

  // ── 2. the flake's data shape, made deterministic: the refusal row, then
  // the straggler — the SAME branch, a LATER `at`, the decoy content the
  // CI failure read as "approved". Fixed stamps: no clock in the fixture, so
  // the straggler is later BY CONSTRUCTION, exactly as in the observed run.
  const T = 1_760_000_000_000;
  const refusalReason = await appendLedgerEntry(
    {
      branch: "feature/decoy",
      kind: "adversarial",
      patchId: "decoy-patch-id",
      passed: false,
      at: T,
      detail: "head-moved: the capture is not the current tip",
      rowNonce: "arm-own-refusal",
    },
    execp,
    repo,
  );
  const decoyReason = await appendLedgerEntry(
    {
      branch: "feature/decoy",
      kind: "adversarial",
      patchId: "decoy-patch-id",
      passed: true,
      at: T + 10_000,
      detail: "approved",
      rowNonce: "arm-straggler",
    },
    execp,
    repo,
  );
  assert(
    refusalReason === undefined && decoyReason === undefined,
    "fixture: both decoy-scenario rows were recorded",
  );
  const rows = rowsOnDisk();

  // The identity selector (the shape `waitForRowsWithNonce` applies in the
  // arms): a nonce match returns THIS row, decoy notwithstanding.
  const own = rows.filter((e) => e.rowNonce === "arm-own-refusal");
  assert(
    own.length === 1 && own[0]?.passed === false && isBindingRefusal(own[0]?.detail),
    `selector: the nonce match returns the refusal row, never the later approved decoy (got ${JSON.stringify(own.map((r) => ({ passed: r.passed, detail: r.detail })))})`,
  );

  // Pin the flake's mechanism: the OLD floor reader would have returned the
  // decoy. If this ever goes green the other way, the fixture stopped
  // resembling the observed failure and the selector arm above proves nothing.
  const floored = rows.filter((e) => e.branch === "feature/decoy" && e.at >= T - 1);
  assert(
    floored[floored.length - 1]?.rowNonce === "arm-straggler" &&
      floored[floored.length - 1]?.passed === true,
    "fixture: the last row at-or-after the floor is the passing decoy — the exact false reading the floor selector produced",
  );

  // Absence is reported as absence: a nonce nobody wrote matches NOTHING.
  // The arms' poll returns [] on a miss (never "the latest row"), so their
  // "this arm's row was written" assertion fails loudly on a real regression.
  assert(
    rows.filter((e) => e.rowNonce === "arm-never-written").length === 0,
    "selector: a missing nonce match reads as absence, never as the latest row",
  );

  // The guard's readers are UNMOVED by the field: (branch, kind, max `at`)
  // still decides. The nonce is test-facing provenance, not a guard key.
  assert(
    latestEntry(rows, "feature/decoy", "adversarial")?.rowNonce === "arm-straggler",
    "guard: latestEntry still selects by max `at` — the decoy, not the earlier refusal",
  );
  const deduped = dedupeLatest(rows.filter((e) => e.branch === "feature/decoy"));
  assert(
    deduped.length === 1 && deduped[0]?.rowNonce === "arm-straggler",
    "guard: dedupeLatest still collapses one row per (branch, kind) by max `at` — the nonce is not a dedupe key",
  );
} finally {
  if (repo) rmSync(path.dirname(repo), { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
