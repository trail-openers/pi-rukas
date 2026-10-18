#!/usr/bin/env bun
/**
 * #1449 — a review that ran and left the merge guard with no record of it.
 *
 * The incident: `isolateLedger` adopted an inherited
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE`, so a test that ran the REAL writer wrote
 * its row to another fixture's file; when that fixture was released the row was
 * deleted; and the merge guard — resolving through the SAME poisoned
 * `process.env` — read the same file, saw nothing, and refused with the wording
 * for "this branch was never reviewed". Two false statements in one message:
 * the branch HAS been reviewed, and the tool DOES have a record of it.
 *
 * Nothing here is mocked beyond `gh`: the writers, the resolvers, the patch-id
 * computation, and the guard all run for real against a real clone (the harness
 * from test-adversarial-ledger-range.ts). The four things the issue asked for:
 *
 *   1. a redirected write is REPORTED as such — `recorded: true` (it really
 *      succeeded) plus `writtenTo`/`landedAtPath` naming where it landed, which is
 *      NOT the clone's ledger;
 *   2. the row itself carries `writtenTo`, so a process that reads the real
 *      ledger later can still be told a review ran elsewhere;
 *   3. the misdirection NOTE is distinct from the four by-design no-write
 *      reasons — a reader can tell "reviewed, wrong file" from "nothing to
 *      record";
 *   4. with NO override set, nothing is flagged and nothing is stamped: the
 *      normal path stays textually and structurally unchanged.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeLedgerWrite } from "../src/adversarial-ledger-capture.ts";
import { misdirectedLedgerNote } from "../src/adversarial-ledger-note.ts";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import { writeLensLedgerEntry } from "../src/lens-ledger.ts";
import { misdirectedWriteOf } from "../src/merge-guard-provenance.ts";
import { lensNotEvaluatedRefusal } from "../src/merge-guard-reads.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { readLedgerFileSafe } from "../src/review-ledger-read.ts";
import { MISDIRECTED_LEDGER_NOTE, readLedgerFile } from "../src/review-ledger.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { BRANCH, forgeExec, ledgerFile, setupRepo } from "./lib/adversarial-ledger-harness.ts";

// ---------------------------------------------------------------------------
// Never touch the real per-clone ledger.
//
// Every writer in this file runs against a temp clone, so its git-path
// resolution already lands in that clone's own .git. The belt is this:
// `appendLedgerEntry` resolves its target through the CALLER's `process.env`
// (review-ledger.ts → `ledgerPathFor`), so if an arm ever ran with the override
// unset while the harness's temp clone was gone, the writer would resolve
// against whatever cwd remained. The arms below set the override explicitly;
// pinning it here, at module scope and before the first writer, means a bug in
// an arm degrades into a stray temp file instead of a write into the main
// clone's shared ledger — the file other PRs' merges depend on.
// ---------------------------------------------------------------------------
const sentinelDir = mkdtempSync(path.join(os.tmpdir(), "pi-1449-sentinel-"));
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(sentinelDir, "never-written.json");

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  try {
    if (!cond) throw new Error("falsy");
    console.log(`\u2713 ${msg}`);
    passed++;
  } catch {
    console.error(`\u2717 ${msg}`);
    failed++;
  }
}

const previousOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
const fixture = setupRepo();
const repo = fixture.dir;

// A minimal approving loop result — the shape `decideLoopAction` returns for an
// approved gate, with just the fields the adversarial writer reads.
const APPROVED_OK = { ok: true, loopOutcome: "approved" } as never;

/** Real git through the writer's executor seam — the harness fakes only `gh`,
 * and the adversarial writer's binding reads are git reads, so they must be
 * real for the row to be recorded rather than refused. `cwd` is HONOURED (the
 * executor receives it in `o.cwd`): a stub that ignored it would run each git
 * call in the Pi process's directory, which is the main clone — and a writer's
 * git reads resolving there is how a fixture ends up reasoning about, or
 * writing, the shared ledger. */
const realGit: VerifyExecFn = async (cmd0, o) => ({
  stdout: o?.argv
    ? execFileSync(cmd0, o.argv, {
        cwd: o?.cwd ?? repo,
        encoding: "utf8",
        stdio: "pipe",
      })
    : execFileSync("/bin/sh", ["-c", cmd0], {
        cwd: o?.cwd ?? repo,
        encoding: "utf8",
        stdio: "pipe",
      }),
});

/**
 * Run `body` with `PI_ENSEMBLE_REVIEW_LEDGER_FILE` genuinely UNSET, and restore
 * the sentinel afterwards. Two arms need the env actually absent (that is the
 * 99% path they characterise); the sentinel outside the window is what stops an
 * unset env from ever being the state a writer sees if this throws.
 */
async function withoutOverride<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  // biome-ignore lint/performance/noDelete: unsetting is the state under test
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  try {
    return await body();
  } finally {
    if (saved === undefined) process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = sentinelFile;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = saved;
  }
}

try {
  // The clone's OWN ledger — where the #912 guard will look, and the answer
  // `cloneLedgerPathFor` must produce even while the override is set.
  const cloneLedger = ledgerFile(repo);

  // ---- 1. the clean baseline: no override, ordinary write -----------------
  const clean = await withoutOverride(() =>
    writeLensLedgerEntry("APPROVED", "MEDIUM", repo, BRANCH, false),
  );
  assert(clean.recorded === true, "baseline: the lens write records on the clone's ledger");
  assert(
    clean.landedAtPath === undefined,
    "baseline: with no override set the outcome carries no misdirection path",
  );
  const cleanRow = existsSync(cloneLedger) ? readLedgerFile(cloneLedger).entries.at(-1) : undefined;
  assert(cleanRow?.kind === "lens", "baseline: the row is on the clone's ledger");
  assert(
    cleanRow?.writtenTo === undefined,
    "baseline: a row on the clone's ledger carries no writtenTo stamp",
  );
  rmSync(cloneLedger, { force: true });

  // ---- 2. the leak: an override pointing at a file outside the clone ------
  //
  // Exactly the #1449 shape — the inherited value names a private file, and the
  // writer, the guard, and the resolver all read the same process.env.
  const leaked = path.join(path.dirname(repo), "adopted-by-the-leaked-override.json");
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = leaked;

  const redirected = await writeLensLedgerEntry("APPROVED", "MEDIUM", repo, BRANCH, false);
  assert(
    redirected.recorded === true,
    "#1449 a redirected write is NOT reported as a failed review — it genuinely succeeded",
  );
  assert(
    redirected.recorded && typeof redirected.landedAtPath === "string",
    "#1449 the outcome carries the path the row actually landed at",
  );
  assert(
    existsSync(leaked),
    "#1449 the row really landed in the overridden file, outside the clone",
  );
  assert(
    !existsSync(cloneLedger),
    "#1449 the clone's ledger — the one the guard reads — stayed empty",
  );

  // The row itself must be self-describing: a LATER process reading the real
  // ledger cannot know a review happened, but a process reading THIS file can.
  const rows = readLedgerFile(leaked).entries;
  const row = rows.at(-1);
  assert(row?.kind === "lens", "#1449 the redirected row is a lens row");
  assert(row?.writtenTo === leaked, `#1449 the row stamps where it landed (${row?.writtenTo})`);
  assert(
    row?.writtenTo !== undefined && row.writtenTo !== cloneLedger,
    "#1449 the stamped path is not the clone's ledger — that is the misdirection",
  );
  // The outcome's path and the row's stamp are the SAME string read from the
  // same resolution — if they ever diverged, the note a reader saw would name a
  // file that does not contain the row.
  assert(
    redirected.recorded &&
      typeof redirected.landedAtPath === "string" &&
      row?.writtenTo === redirected.landedAtPath,
    "#1449 the outcome's landedAtPath is the very path stamped on the row",
  );

  // ---- 3. the adversarial writer behaves identically ---------------------
  //
  // Both halves of the #912 ledger must report the same way, or the guard can be
  // told about one redirect and not the other.
  const leakedAdv = path.join(path.dirname(repo), "adopted-adversarial.json");
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = leakedAdv;
  const adv = await writeAdversarialLedgerEntry(APPROVED_OK, {
    workCwd: repo,
    branch: BRANCH,
    resolvedBranch: BRANCH,
    execFn: realGit,
  });
  assert(adv.recorded === true, "#1449 the adversarial write records (it succeeded somewhere)");
  assert(
    adv.recorded && typeof adv.landedAtPath === "string",
    "#1449 the adversarial outcome carries a misdirection path too",
  );
  const advRow = readLedgerFile(leakedAdv).entries.at(-1);
  assert(
    advRow?.kind === "adversarial" && advRow.writtenTo === leakedAdv,
    "#1449 the adversarial row stamps its redirected landing too",
  );

  // ---- 4. the note is distinguishable from a by-design skip ---------------
  //
  // The four legitimate no-write reasons say nothing about a path. If the note
  // shared their wording, a reader (or a router) could read "the review never
  // ran" out of a reply that says the opposite.
  const byDesign = [
    "no branch to key the ledger entry on",
    "no patch id for the working tree",
    "NO REVIEW — no changes since the last lens review",
    "no git repository detected",
  ];
  for (const phrase of byDesign) {
    assert(
      !MISDIRECTED_LEDGER_NOTE.toLowerCase().includes(phrase.toLowerCase()),
      `#1449 the note does not reuse the by-design wording "${phrase}"`,
    );
  }
  assert(
    /MISDIRECTED/i.test(MISDIRECTED_LEDGER_NOTE) && /ledger/i.test(MISDIRECTED_LEDGER_NOTE),
    "#1449 the note names itself as a ledger misdirection",
  );
  assert(
    /PI_ENSEMBLE_REVIEW_LEDGER_FILE/.test(MISDIRECTED_LEDGER_NOTE),
    "#1449 the note names the env var so the operator can find the leak",
  );
  assert(
    /merge guard|guard/i.test(MISDIRECTED_LEDGER_NOTE),
    "#1449 the note says why it matters — the guard will not find the row",
  );

  // ---- 5. no override, no noise: the 99% path is unchanged ----------------
  //
  // "No override set" is what the arm is testing, so the env is genuinely
  // cleared for the duration — but the sentinel outside the window is what keeps
  // a cleared env from ever being what a writer sees if this arm throws.
  let again: Awaited<ReturnType<typeof writeAdversarialLedgerEntry>>;
  let homeRows: ReturnType<typeof readLedgerFile>["entries"];
  const homePath = ledgerFile(repo);
  await withoutOverride(async () => {
    again = await writeAdversarialLedgerEntry(APPROVED_OK, {
      workCwd: repo,
      branch: BRANCH,
      resolvedBranch: BRANCH,
      execFn: realGit,
    });
    homeRows = existsSync(homePath) ? readLedgerFile(homePath).entries : [];
  });
  assert(
    again.recorded === true,
    "#1449 the adversarial write records normally once the env is clean",
  );
  assert(
    again.recorded && again.landedAtPath === undefined,
    "#1449 with no override set, the normal write reports no misdirection",
  );
  // The clone's ledger is read through the harness's own path resolution, and
  // a missing file there is reported as "no row" rather than throwing — the
  // row's presence is what the arm asserts, and a writer that skipped silently
  // has to fail an assertion, not crash the fixture.
  const home = homeRows.find((e) => e.kind === "adversarial");
  assert(
    home !== undefined,
    `#1449 the clean adversarial row is on the clone's ledger (${homeRows.length} row(s) there)`,
  );
  assert(
    home?.writtenTo === undefined,
    "#1449 a row written to the clone's own ledger carries no writtenTo stamp",
  );
  // …and no row anywhere on the clone's ledger carries one, which is the
  // invariant that makes the stamp meaningful: it appears ONLY on a redirected
  // write, so the guard never has to weigh a stamp on an ordinary row.
  assert(
    homeRows.every((e) => e.writtenTo === undefined),
    "#1449 no row on the clone's ledger carries a writtenTo stamp",
  );

  // ---- 6. the refusal distinguishes "never reviewed" from "redirected" ---
  //
  // The guard cannot detect a redirect itself (same process, same poisoned
  // env, same resolver on both sides). What it CAN do is tell the operator
  // which of the two situations it is in, and that difference lives entirely
  // in this text — so the text is what is asserted.
  const plain = lensNotEvaluatedRefusal(BRANCH, undefined);
  const redirectedRefusal = lensNotEvaluatedRefusal(BRANCH, undefined, {
    redirectedTo: leaked,
  }).reason;
  assert(
    !/DID run/i.test(plain.reason) && /no entry to evaluate/.test(plain.reason),
    "#1449 the plain refusal still reads as never-reviewed, with no claim about a redirect",
  );
  assert(
    /DID run/i.test(redirectedRefusal) && redirectedRefusal.includes(leaked),
    "#1449 the redirected refusal says a review ran and names where its row went",
  );
  assert(
    /unset PI_ENSEMBLE_REVIEW_LEDGER_FILE/.test(redirectedRefusal),
    "#1449 the redirected refusal tells the operator how to fix it",
  );
  assert(
    /round-cap path was not evaluated/.test(redirectedRefusal),
    "#1449 the redirected refusal keeps the #1000 'not evaluated' disclosure intact",
  );
  assert(
    plain.reason !== redirectedRefusal,
    "#1449 the two situations are textually distinguishable, not one message for both",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  if (previousOverride === undefined) {
    // biome-ignore lint/performance/noDelete: restoring the pre-import env is the state under test
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  } else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = previousOverride;
  rmSync(path.dirname(repo), { recursive: true, force: true });
  rmSync(sentinelDir, { recursive: true, force: true });
}
