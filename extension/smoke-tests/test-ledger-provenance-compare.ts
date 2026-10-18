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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  // ---- the first write on a fresh clone: the ledger file does not exist yet ---
  //
  // #1449 round 2, the symptom this fix exists for. `realpathSync` throws ENOENT
  // for a path that does not exist, and a ledger legitimately does not exist
  // before the first review of a branch. The pre-fix `sameResolvedPath` had one
  // blanket `catch { return false }`, so ONE side failing was read as "the two
  // paths differ" — which every caller spells "redirected". The result: the very
  // first review on a fresh clone, with the override pointing at the clone's own
  // file, reported a misdirection that had not happened. Each side now falls back
  // to its own lexical resolve, so the equal case stays equal.
  const freshDir = path.join(dir, "fresh-clone");
  mkdirSync(freshDir, { recursive: true });
  const freshLedger = path.join(freshDir, "review-ledger.json");
  const freshStamped = fileStampedWith("fresh-stamped.json", freshLedger);
  assert(
    !existsSync(freshLedger),
    "#1449 the fixture really leaves the ledger file unwritten (else the arm below proves nothing)",
  );
  assert(
    misdirectedWriteOf(freshStamped, BRANCH, freshLedger) === undefined,
    "#1449 a stamp and a clone path that are the same NOT-YET-EXISTING file are not a redirect — the pre-fix realpath ENOENT made every first review look misdirected",
  );
  // …and the pair is still a real comparison when the unwritten paths differ:
  // "cannot resolve" does not become permission to hide a redirect.
  assert(
    misdirectedWriteOf(freshStamped, BRANCH, path.join(freshDir, "other", "ledger.json")) ===
      freshLedger,
    "#1449 two unwritten paths that differ still report the redirect (the ENOENT fallback is not a silence)",
  );

  // #1449 round 2, the render-time half of the same lesson. `misdirectedWriteOf`
  // sanitises the stamp it RETURNS (it goes into a refusal string) and compares
  // it RAW. The two must not be the same value: sanitising clamps at 240 chars,
  // so a deep clone path compared after sanitising collapses to a prefix of the
  // clone path and an ordinary row reads as redirected. This arm pins that the
  // guard's own comparison is raw (the writer's is
  // `test-ledger-override-provenance.ts` / the deep-path arm below).
  const longLedger = path.join(
    dir,
    "deep",
    // Sized from the measured length of `dir` so the arm is past the cap on any
    // host: macOS temp paths sit ~24 chars under Linux's, and a fixture that is
    // 203 chars here would be 260 there — an arm whose premise depends on the
    // machine's tempdir length tests nothing on half the fleet.
    ...Array.from({ length: 60 }, (_, i) => `d${i}`),
    "review-ledger.json",
  );
  assert(
    longLedger.length > 240,
    `#1449 the long-path fixture is past the sanitiser's cap (${longLedger.length} chars) — otherwise the arm below is the short case twice`,
  );
  const longStamped = fileStampedWith("long-stamped.json", longLedger);
  assert(
    misdirectedWriteOf(longStamped, BRANCH, longLedger) === undefined,
    "#1449 the guard compares the stamp RAW: a clone path past the 240-char cap is still its own file (comparing the sanitised value would truncate it to a prefix and report a redirect)",
  );
  assert(
    misdirectedWriteOf(longStamped, BRANCH, path.join(dir, "unrelated-deep.json")) ===
      longLedger.slice(0, 240),
    "#1449 the same deep stamp IS reported against an unrelated clone path, and reported TRUNCATED — raw for comparing, sanitised for rendering, in one call",
  );
  // The pre-fix bug, asserted positively: a stamp the sanitiser TRUNCATES (a
  // hostile 300-char value) still reports, because the value the guard RENDERS
  // is the truncated one — truncation is a render-time act, not a verdict.
  const overlongStamp = "/x".repeat(200);
  const overlongFile = fileStampedWith("overlong-stamped.json", overlongStamp);
  const reported = misdirectedWriteOf(overlongFile, BRANCH, cloneLedger);
  assert(
    reported === overlongStamp.slice(0, 240) && (reported?.length ?? 0) === 240,
    `#1449 a stamp past the cap is REPORTED, truncated to the cap — sanitising stays a render-time act (${reported?.length})`,
  );

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
