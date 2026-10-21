#!/usr/bin/env bun
/**
 * #1557 — the adversarial smoke arms identify THEIR OWN ledger row by an
 * identity carried in the row, never by a `Date.now()` floor or a positional
 * index.
 *
 * The flake this pins away: the ledger writer is fire-and-forget and stamps
 * `at` at write-START, so a straggler row from an earlier arm can stamp itself
 * at or after any floor a later arm samples and be read as that arm's row —
 * the honest arm-4 row (`passed=true, detail="approved"`) reported as arm 4b's
 * binding refusal. `waitForRowWrittenAfter` was that floor reader and had no
 * canary, so nothing kept a future test from reintroducing the shape.
 *
 * Three layers, each asserted here at the level it lives at:
 *
 *   1. the WRITER: `writeAdversarialLedgerEntry` persists the caller's
 *      `rowNonce` verbatim (the loop threads its `orchestratorJobId` there),
 *      and a row WITHOUT a nonce stays valid — the field is optional, so
 *      `validEntries` must not require it (hand-built and pre-#1557 rows
 *      carry none);
 *   2. the DATA SHAPE: with a decoy `passed=true detail="approved"` row for
 *      the same branch written LATER (higher `at`), the nonce-match selector
 *      returns the refusal row — while the guard readers (`latestEntry` /
 *      `dedupeLatest`) still pick by (branch, kind, max `at`): the nonce is
 *      test-facing provenance, NOT a guard key;
 *   3. the ARMS: a static canary on `lib/arms/loop-behaviour.ts` fails if the
 *      floor selector comes back (a gate never observed to fail is worthless).
 */

import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
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
  });
  return { stdout };
};

const APPROVED = {
  ok: true,
  loopOutcome: "approved",
} as never;

/** A row is a binding refusal iff its detail opens with one of the prefixes
 * the guard itself recognises (same predicate the arms use). */
const isBindingRefusal = (detail: unknown): boolean =>
  typeof detail === "string" &&
  BINDING_REFUSAL_PREFIXES.some((prefix) => detail.startsWith(`${prefix}: `));

const fixture = setupRepo();
const repo = fixture.dir;
// #1069 self-isolation: name the single file every writer in this process
// lands in, so a leaked override from the environment can never redirect the
// rows these assertions read (`ledgerPathFor` returns the override verbatim,
// with zero git calls, in BOTH the reader and the writer of this process).
const LEDGER_FILE = ledgerFile(repo);
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = LEDGER_FILE;

const rowsOnDisk = (): LedgerEntry[] => {
  try {
    return readLedgerFile(LEDGER_FILE).entries;
  } catch {
    return [];
  }
};

try {
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

  // ── 2. the flake's data shape, made deterministic: this arm's refusal row,
  // then the straggler — the SAME branch, a LATER `at`, the decoy content the
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

  // ── 3. the canary: the floor selector must not come back into the arms.
  // `waitForRowWrittenAfter` existed only in the arms file and had no test —
  // the coverage gap the issue names. Read relative to this file's parent
  // (extension/) so the read is cwd-independent; the literal names the repo
  // path so the ALWAYS_RUN detector sees this file as a reader of it.
  const ARMS_REL = "smoke-tests/lib/arms/loop-behaviour.ts";
  // A missing file is a hard canary failure, not a silent pass on empty text.
  const armsSrc = readFileSync(path.resolve(import.meta.dirname, "..", ARMS_REL), "utf8");
  assert(
    !armsSrc.includes("waitForRowWrittenAfter"),
    `arms: the timestamp-floor selector is gone (see ${ARMS_REL})`,
  );
  assert(
    !armsSrc.includes("staleStart"),
    "arms: no `Date.now() - 1` floor remains in the arm script",
  );
  assert(
    /rowNonce\s*===\s*nonce/.test(armsSrc),
    "arms: the row reader selects on rowNonce equality against the arm's own job id",
  );
} finally {
  rmSync(path.dirname(repo), { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
