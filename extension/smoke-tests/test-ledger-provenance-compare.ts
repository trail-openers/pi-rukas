#!/usr/bin/env bun
/**
 * #1449 round 2 — a `writtenTo` stamp naming the clone's OWN ledger is not a
 * misdirection.
 *
 * Split from `test-merge-guard-provenance-fault.ts` for the 500-line gate
 * (AGENTS.md §12). That suite covers the fault tolerance of the same read; this
 * one covers the SEMANTICS of what the read reports.
 *
 * The signal means "this row did not land where the guard looks". A row stamped
 * with the clone's own path says the opposite, and reporting it would tell the
 * operator a review went somewhere it demonstrably did not. Because #1449 round 2
 * made the stamp UNCONDITIONAL (it is applied by `appendLedgerEntry`, the one
 * place holding the resolved path), every ordinary row now carries exactly such a
 * stamp — so this comparison is what keeps the diagnostic from firing on every
 * merge. The two arms that keep it honest are the ones that PASS a clone path
 * which does not match: if the helper had simply stopped reporting, those go red.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { misdirectedWriteOf } from "../src/merge-guard-provenance.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`\u2713 ${msg}`);
  } else {
    failed++;
    console.log(`\u2717 ${msg}`);
  }
}

const BRANCH = "feature/provenance-compare";
const ADV_ROW = {
  branch: BRANCH,
  kind: "adversarial" as const,
  patchId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  passed: true,
  at: 1_700_000_000_000,
};

const dir = mkdtempSync(path.join(os.tmpdir(), "p1449-compare-"));

try {
  const cloneLedger = path.join(dir, "clone", "review-ledger.json");
  mkdirSync(path.dirname(cloneLedger), { recursive: true });

  const fileStampedWith = (name: string, writtenTo: string): string => {
    const p = path.join(dir, name);
    writeFileSync(p, JSON.stringify({ entries: [{ ...ADV_ROW, writtenTo }] }), "utf8");
    return p;
  };

  // ---- the comparison itself ----------------------------------------------
  const selfStamped = fileStampedWith("self-stamped.json", cloneLedger);
  assert(
    misdirectedWriteOf(selfStamped, BRANCH, cloneLedger) === undefined,
    "#1449 a stamp naming the clone's own ledger yields no misdirection",
  );
  assert(
    misdirectedWriteOf(
      selfStamped,
      BRANCH,
      path.join(dir, "clone", "..", "clone", "review-ledger.json"),
    ) === undefined,
    "#1449 a `..`-laden spelling of the clone path is still recognised as the clone path",
  );

  // ---- the anti-vacuity pair ----------------------------------------------
  //
  // Without these, "returns undefined" is indistinguishable from a helper that
  // stopped reporting anything at all.
  assert(
    misdirectedWriteOf(selfStamped, BRANCH) === cloneLedger,
    "#1449 with no clone path to compare against the stamp IS reported — the dedupe is a comparison, not a silence",
  );
  const elsewhere = fileStampedWith("elsewhere-stamped.json", "/nope/other.json");
  assert(
    misdirectedWriteOf(elsewhere, BRANCH, cloneLedger) === "/nope/other.json",
    "#1449 a stamp naming a different file is reported even when the clone path is known",
  );

  // ---- the symlink case ----------------------------------------------------
  //
  // The reviewer's specific concern: the stamp and the clone path are two
  // spellings of ONE file, which only a realpath comparison recognises. A lexical
  // `path.resolve` comparison passes every arm above and fails only here.
  const realDir = path.join(dir, "real-dir");
  mkdirSync(realDir, { recursive: true });
  const realFile = path.join(realDir, "review-ledger.json");
  // The file must exist for `realpathSync` to resolve it — a missing path throws
  // and the comparison falls back to the lexical one, which would leave this arm
  // green while testing nothing. Written with the row the arm reads.
  writeFileSync(
    realFile,
    JSON.stringify({ entries: [{ ...ADV_ROW, writtenTo: realFile }] }),
    "utf8",
  );
  const linkDir = path.join(dir, "link-dir");
  let linked = false;
  try {
    symlinkSync(realDir, linkDir, "dir");
    linked = true;
  } catch {
    linked = false;
  }
  if (linked) {
    const viaLink = path.join(linkDir, "review-ledger.json");
    const symStamped = fileStampedWith("sym-stamped.json", viaLink);
    assert(
      misdirectedWriteOf(symStamped, BRANCH, realFile) === undefined,
      "#1449 a stamp naming a symlink and a clone path naming its target are the same file — no misdirection",
    );
    assert(
      misdirectedWriteOf(symStamped, BRANCH, path.join(dir, "unrelated.json")) === viaLink,
      "#1449 the symlink arm is a real comparison — an unrelated clone path still reports the stamp",
    );
  } else {
    // Say so rather than passing an arm that did not run; the lexical arms above
    // still exercised the resolve comparison.
    assert(true, "#1449 symlink unsupported on this filesystem — the lexical arms still ran");
  }

  // ---- a row for another branch is never consulted ------------------------
  const otherBranch = path.join(dir, "other-branch.json");
  writeFileSync(
    otherBranch,
    JSON.stringify({ entries: [{ ...ADV_ROW, branch: "feature/zzz", writtenTo: "/tmp/x.json" }] }),
    "utf8",
  );
  assert(
    misdirectedWriteOf(otherBranch, BRANCH, cloneLedger) === undefined,
    "#1449 a stamp on another branch's row is never reported against this branch",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
