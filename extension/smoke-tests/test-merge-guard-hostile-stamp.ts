#!/usr/bin/env bun
/**
 * #1449 round 2 — a hostile `writtenTo` cannot open the #912 gate.
 *
 * Split from `test-merge-guard-provenance-fault.ts` for the AGENTS.md §12
 * 500-line gate. That suite makes the LEDGER hostile (corrupt, unreadable,
 * missing) and asks whether a fault in the provenance read escapes the
 * `tool_call` handler. This one makes the row's `writtenTo` STAMP hostile — the
 * value on the RIGHT-hand side of the provenance comparison — and asks the
 * question the guard's block actually depends on:
 *
 *   can anything the writer wrote into that field change the VERDICT?
 *
 * It cannot, and the reason it might have is #1449 round 2's own change:
 * `realpathSync` throws ENOENT for a path that does not exist, so a stamp
 * pointing at a dangling symlink, or a clone path whose directory was deleted,
 * lands in the comparison's failure path. Each arm below therefore asserts BOTH
 * halves — the diagnostic still reports (a realpath failure must not become a
 * silence), and the guard still BLOCKS (a diagnostic is not a verdict).
 *
 * Isolation: a fresh temp clone per arm, `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pinned
 * to the arm's own path and restored in `finally`. The main clone's
 * `.git/review-ledger.json` is never a target here.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { misdirectedWriteOf } from "../src/merge-guard-provenance.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import { BRANCH, forgeExec, setupRepo } from "./lib/adversarial-ledger-harness.ts";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`\u2713 ${msg}`);
  } else {
    failed++;
    console.error(`\u2717 ${msg}`);
  }
}

/** A well-formed adversarial row — the stamp is the only thing these arms vary. */
const ADV_ROW: LedgerEntry = {
  branch: BRANCH,
  kind: "adversarial",
  patchId: "a".repeat(40),
  passed: true,
  at: 1_700_000_000_000,
};

/**
 * Drive the REAL #912 guard with only `gh` stubbed, and with the ledger the
 * override names pointed at `ledgerAt`. The guard resolves its path through
 * `ledgerPathFor`, which honours the override before any git call — so that is
 * both what makes the guard read this file and what makes `misdirectedWriteOf`
 * open it. The fetch, head check and patch-id are real git against the fixture,
 * so a refusal here cannot be an artefact of a stub.
 */
async function guardDecision(
  repo: string,
  ledgerAt: string,
): Promise<{ block: boolean; reason: string }> {
  const saved = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerAt;
  let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  try {
    registerMergeGuard(
      // biome-ignore lint/suspicious/noAssignInExpressions: the harness's own capture idiom
      { on: (n: string, fn: typeof handler) => n === "tool_call" && (handler = fn) } as never,
      { execFn: forgeExec(repo, { comments: [] }) },
    );
    const prev = process.cwd();
    process.chdir(repo);
    try {
      const r = (await handler?.({ toolName: "bash", input: { command: "gh pr merge 12" } }, {})) as
        | { block?: boolean; reason?: string }
        | undefined;
      return { block: r?.block === true, reason: r?.reason ?? "" };
    } finally {
      process.chdir(prev);
    }
  } finally {
    // biome-ignore lint/performance/noDelete: unsetting is the state under test
    if (saved === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = saved;
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), "p1449-hostile-stamp-"));
const repo = setupRepo();

/** Write a one-row ledger whose `writtenTo` is `stamp`, and return its path. */
function rowStampedWith(name: string, stamp: string | undefined): string {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify({ entries: [{ ...ADV_ROW, writtenTo: stamp }] }), "utf8");
  return p;
}

try {
  // (i) a `writtenTo` that is a symlink pointing at nothing. realpath of the
  // stamp throws ENOENT; realpath of the clone path is asked to resolve a
  // directory that was never created, so BOTH sides of the comparison fail at
  // once — the worst case the round-2 per-side fallback has to survive.
  const dangling = path.join(dir, "dangling-link.json");
  symlinkSync(path.join(dir, "target-never-written.json"), dangling, "file");
  const ghostClone = path.join(dir, "gone", "review-ledger.json");
  const danglingStamped = rowStampedWith("dangling-stamped.json", dangling);
  assert(
    misdirectedWriteOf(danglingStamped, BRANCH, ghostClone) === dangling,
    "#1449 a dangling-symlink stamp is still REPORTED — a realpath failure on both sides does not hide the redirect",
  );
  const refusedDangling = await guardDecision(repo.dir, danglingStamped);
  assert(
    refusedDangling.block === true,
    "#1449 a writtenTo pointing at a dangling symlink still refuses the merge — a hostile stamp cannot open the gate",
  );
  assert(
    !/round-cap.*allow/i.test(refusedDangling.reason ?? ""),
    "#1449 the refusal names no path to merging past the missing lens review",
  );

  // (ii) `expectedClonePath` naming a file whose DIRECTORY does not exist. The
  // override-blind resolver can legitimately answer with such a path (the git
  // dir was reachable when it answered, the scratch file was removed after), and
  // the guard must read that as "report the stamp", never as "no redirect, and
  // anyway nothing to refuse".
  const stampedKnown = rowStampedWith("stamped-known.json", "/tmp/somewhere/else.json");
  assert(
    misdirectedWriteOf(stampedKnown, BRANCH, ghostClone) === "/tmp/somewhere/else.json",
    "#1449 an unresolvable expectedClonePath reports the stamp rather than swallowing it (report > hide)",
  );
  assert(
    misdirectedWriteOf(stampedKnown, BRANCH, undefined) === "/tmp/somewhere/else.json",
    "#1449 the guard's own failure shape (undefined clone path) reports the stamp, matching the helper's documented contract",
  );
  const refusedGhost = await guardDecision(repo.dir, stampedKnown);
  assert(
    refusedGhost.block === true,
    "#1449 an unresolvable clone path still refuses the merge — the guard's block does not depend on the diagnostic resolving",
  );

  // (iii) a stamp that is not a string at all (`0`, `[]`, an object). The row is
  // valid enough to survive `validEntries`, so the diagnostic is the only place
  // that can be reached with it — and a value that cannot name a path must not
  // become a crash on the guard's hot path.
  for (const hostile of [0, [], {}, true] as unknown[]) {
    const f = rowStampedWith(`hostile-${typeof hostile}-${String(hostile).length}.json`, hostile as never);
    let threw = false;
    let out: string | undefined;
    try {
      out = misdirectedWriteOf(f, BRANCH, ghostClone);
    } catch {
      threw = true;
    }
    assert(
      !threw && out === undefined,
      `#1449 a non-string writtenTo (${JSON.stringify(hostile)}) yields no claim and no throw (${threw ? "THREW" : String(out)})`,
    );
  }
  const refusedHostile = await guardDecision(repo.dir, rowStampedWith("hostile-obj.json", {} as never));
  assert(
    refusedHostile.block === true,
    "#1449 a row whose stamp is an object still refuses the merge — the verdict never consults the field",
  );

  // (iv) the anti-vacuity pair. Everything above returns "no misdirection" or a
  // refusal; without a stamp that DOES get named, a helper that had simply
  // stopped reporting would keep every arm green.
  const realRedirect = rowStampedWith("real-redirect.json", "/tmp/genuinely/elsewhere.json");
  assert(
    misdirectedWriteOf(realRedirect, BRANCH, path.join(dir, "clone", "review-ledger.json")) ===
      "/tmp/genuinely/elsewhere.json",
    "#1449 the arms above are hostile values answering, not a helper that never reports (anti-vacuity)",
  );

  // (v) a stamp naming a directory that exists but is not a file — the sibling
  // of the dangling case, where realpath SUCCEEDS and tells you nothing about
  // readability.
  const dirAsStamp = path.join(dir, "a-directory");
  mkdirSync(dirAsStamp, { recursive: true });
  const dirStamped = rowStampedWith("dir-stamped.json", dirAsStamp);
  assert(
    misdirectedWriteOf(dirStamped, BRANCH, ghostClone) === dirAsStamp,
    "#1449 a stamp naming a directory still reports (realpath succeeds, so nothing is swallowed)",
  );
  const refusedDirStamp = await guardDecision(repo.dir, dirStamped);
  assert(
    refusedDirStamp.block === true,
    "#1449 a directory-valued stamp still refuses the merge",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.dirname(repo.dir), { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
