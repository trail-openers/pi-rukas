#!/usr/bin/env bun
/**
 * #955 — the PI_ENSEMBLE_REVIEW_LEDGER_FILE override for `ledgerPathFor`.
 *
 * The override is what lets the merge-guard decision-matrix tests point the
 * ledger at a private temp file instead of the real per-clone ledger under
 * the git common dir (which concurrent test runs across worktrees would race
 * on and clobber). This pins the override's contract:
 *
 *   - when the env is set (an absolute path), `ledgerPathFor` returns it
 *     verbatim and makes NO git exec calls (the short-circuit).
 *   - when the env is unset, the existing git-based behaviour is preserved
 *     (the git exec IS made).
 *
 * #1449 adds the OTHER half of the answer, and the reason it exists: because
 * the override short-circuits before any git call, the #912 guard and the
 * writer resolve through the same poisoned `process.env` and agree on the
 * redirected file, so neither can notice the mismatch. Three new contracts:
 *
 *   - `cloneLedgerPathFor` is override-BLIND: the env is set, git is still
 *     consulted, and the clone's own path comes back. It is the "where SHOULD
 *     the row be" answer every comparison is taken against.
 *   - `misdirectedLedgerWrite` reports a resolved path only when it differs
 *     from that answer AND the override is what moved it — so a temp-repo
 *     writer with no override set, and a writer whose override already points
 *     at the clone's own file, are both silent (no false alarms).
 *   - the git read is paid for ONLY while the override is set: with no
 *     override the predicate must not exec at all.
 */

import path from "node:path";
import {
  cloneLedgerPathFor,
  ledgerPathFor,
  MISDIRECTED_LEDGER_NOTE,
  misdirectedLedgerWrite,
} from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CWD = import.meta.dirname;
const OVERRIDE = path.join("/tmp", "pi-ledger-override", "review-ledger.json");
const prevOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;

// ---------------------------------------------------------------- override set
{
  const calls: string[] = [];
  const execFn = async (cmd: string) => {
    calls.push(cmd);
    return { stdout: "/some/git/common/dir\n" };
  };
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = OVERRIDE;
  try {
    const p = await ledgerPathFor(execFn, CWD);
    assert(p === OVERRIDE, "override set → ledgerPathFor returns the env value verbatim");
    assert(calls.length === 0, "override set → no git exec calls are made (short-circuit)");
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  }
}

// --------------------------------------------------------------- override unset
{
  // Ensure the env is unset for this case regardless of the prior state.
  if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  if (process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE !== undefined) {
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  }
  const calls: string[] = [];
  const execFn = async (cmd: string) => {
    calls.push(cmd);
    return { stdout: "/some/git/common/dir\n" };
  };
  try {
    const p = await ledgerPathFor(execFn, CWD);
    assert(
      p === path.join("/some/git/common/dir", "review-ledger.json"),
      "unset → git-based behaviour preserved",
    );
    assert(
      calls.length === 1 && calls[0] === "git rev-parse --git-common-dir",
      "unset → the git rev-parse exec is made",
    );
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  }
}

// ------------------------------------------------- relative override → resolved against cwd
{
  // A relative override path is resolved against the given cwd via
  // path.resolve (the docs say absolute, but be tolerant).
  const relOverride = "custom/ledger.json";
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = relOverride;
  try {
    const expected = path.resolve(CWD, relOverride);
    const p = await ledgerPathFor(async () => { throw new Error("should not be called"); }, CWD);
    assert(p === expected, `relative override → resolved against cwd (${p})`);
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  }
}

// ------------------------------------------------- #1449: the override-blind twin
//
// The whole fix rests on this: a second resolver that IGNORES the env. If it
// ever reads the same variable, every comparison below silently agrees with
// the writer and a redirected write is invisible again — which is the exact
// defect #1449 reports.
{
  const calls: string[] = [];
  const execFn = async (cmd: string) => {
    calls.push(cmd);
    return { stdout: "/clone/.git\n" };
  };
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = OVERRIDE;
  try {
    const expected = await cloneLedgerPathFor(execFn, CWD);
    assert(
      expected === path.join("/clone/.git", "review-ledger.json"),
      "#1449 cloneLedgerPathFor ignores the override and reports the clone's own ledger",
    );
    assert(
      calls.length === 1 && calls[0] === "git rev-parse --git-common-dir",
      "#1449 the override-blind resolver makes the git call the override would have skipped",
    );
    // The worktree case is the one a reader worries about first — "will every
    // worktree write now look misdirected?" — so it is pinned with git's REAL
    // answer rather than a hypothetical one. Verified against this clone: a
    // query from inside `.worktrees/<wt>` prints the absolute MAIN `.git`
    // (`git -C .worktrees/issue-1449-default rev-parse --git-common-dir` →
    // `/…/pi-rukas/.git`), which does NOT start with `worktrees/` and does end
    // in `.git`. So the answer is the clone's single shared file — one ledger
    // per clone, not one per worktree — and a worktree writer whose override
    // points elsewhere is CORRECTLY reported. The `worktrees/…` collapse arm in
    // the resolver is defensive only: no reachable git answer takes it, so it
    // is not pinned here — pinning an unreachable input would be asserting a
    // behaviour no caller can observe.
    const WT_CWD = "/repo/.git/worktrees/wt";
    const wtMain = await cloneLedgerPathFor(async () => ({ stdout: "/repo/.git\n" }), WT_CWD);
    assert(
      wtMain === "/repo/.git/review-ledger.json",
      `#1449 a worktree's expected ledger is the main clone's file (${wtMain})`,
    );
    // …and the two differ in EXACTLY the way the fix needs: the writer honours
    // the override, the checker ignores it. If these ever came back equal while
    // the override is set to something else, the whole feature would be a no-op
    // — which is the #1449 defect, so it is asserted rather than assumed.
    const wtMainWriter = await ledgerPathFor(async () => ({ stdout: "/repo/.git\n" }), WT_CWD);
    assert(
      wtMainWriter === OVERRIDE && wtMainWriter !== wtMain,
      `#1449 inside a worktree the writer honours the override and the checker does not (${wtMainWriter} vs ${wtMain})`,
    );
    // …and the plain-clone case is the unremarkable one: common dir + fileName.
    const plain = await cloneLedgerPathFor(async () => ({ stdout: ".git\n" }), "/repo");
    assert(
      plain === path.join("/repo/.git", "review-ledger.json"),
      `#1449 a plain clone's expected ledger is <cwd>/.git/review-ledger.json (${plain})`,
    );
    // The load-bearing half of the mirroring, asserted directly: whenever the
    // override is what moved the path, the predicate reports it — and the two
    // arms above (relative and absolute) are exactly where a divergent
    // implementation would start reporting every worktree write as misdirected.
    // And the predicate agrees: inside a worktree, an override pointing at some
    // private file IS a misdirection (the guard would never see the row), while
    // an override that already names the clone's shared file is not.
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = OVERRIDE;
    try {
      const inWorktree = await misdirectedLedgerWrite(
        async () => ({ stdout: "/repo/.git\n" }),
        WT_CWD,
        OVERRIDE,
      );
      assert(
        inWorktree === OVERRIDE,
        `#1449 a worktree write diverted to a private file is reported (${inWorktree})`,
      );
      const sameFile = await misdirectedLedgerWrite(
        async () => ({ stdout: "/repo/.git\n" }),
        WT_CWD,
        wtMain,
      );
      assert(
        sameFile === undefined,
        `#1449 an override naming the clone's own file is not a misdirection (${sameFile})`,
      );
    } finally {
      if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
      else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
    }
    // An unreadable git dir is NOT a misdirection — there is nothing to
    // compare against, and a non-repo cwd is a by-design skip.
    const unreadable = await cloneLedgerPathFor(
      async () => {
        throw new Error("not a git repository");
      },
      CWD,
    );
    assert(unreadable === undefined, "#1449 an unreadable git dir resolves to undefined, never a guess");
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  }
}

// ----------------------------------------- #1449: the misdirection predicate
{
  const CLONE_LEDGER = path.join("/clone/.git", "review-ledger.json");
  const git = async () => ({ stdout: "/clone/.git\n" });
  const counting = (calls: string[]) => async () => {
    calls.push("git rev-parse --git-common-dir");
    return { stdout: "/clone/.git\n" };
  };

  // (a) the misdirection the incident describes: override set, resolved path
  // is the override, the clone's file is elsewhere.
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = OVERRIDE;
  try {
    const reported = await misdirectedLedgerWrite(git, CWD, OVERRIDE);
    assert(
      reported === OVERRIDE,
      `#1449 a write that landed at the overridden path is reported (${reported})`,
    );
    // (b) an override that already points at the clone's own file is NOT a
    // misdirection — setting it to the same path changes nothing.
    const same = await misdirectedLedgerWrite(git, CWD, CLONE_LEDGER);
    assert(same === undefined, "#1449 an override equal to the clone's ledger is not reported");
    // (c) no path, nothing to report.
    const nothing = await misdirectedLedgerWrite(git, CWD, undefined);
    assert(nothing === undefined, "#1449 an unresolved path is never reported as a misdirection");
    // (d) an unreadable clone dir: no expected path → no claim of misdirection.
    const blind = await misdirectedLedgerWrite(
      async () => {
        throw new Error("not a git repository");
      },
      CWD,
      OVERRIDE,
    );
    assert(blind === undefined, "#1449 an unresolvable clone path reports nothing (no false alarm)");
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  }

  // (e) THE common case, and the one that must stay free: no override in the
  // environment at all. The predicate short-circuits before the git exec, so
  // every normal review pays nothing for the check that catches the leak.
  if (process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE !== undefined) {
    // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  }
  const calls: string[] = [];
  const quiet = await misdirectedLedgerWrite(counting(calls), CWD, CLONE_LEDGER);
  assert(quiet === undefined, "#1449 with no override set, nothing is reported");
  assert(
    calls.length === 0,
    `#1449 with no override set the predicate makes NO git exec (calls: ${calls.length})`,
  );
}

// ------------------------------- #1449: the note is distinct from a by-design skip
//
// A misdirected write must be textually distinguishable in the SAME reply from
// the four legitimate no-write outcomes (noReview, carry, no-branch,
// no-patch-id), which say nothing about a path. Pinning the wording here keeps
// the distinction from regressing into prose someone else will rewrite.
{
  assert(
    /MISDIRECTED/i.test(MISDIRECTED_LEDGER_NOTE) && /ledger/i.test(MISDIRECTED_LEDGER_NOTE),
    "#1449 the misdirection note names itself as a ledger misdirection",
  );
  assert(
    /override/i.test(MISDIRECTED_LEDGER_NOTE) && /merge guard/i.test(MISDIRECTED_LEDGER_NOTE),
    "#1449 the note says WHY it matters (the merge guard has no record of it)",
  );
  // The by-design skips must not read as a misdirection: none of their wording
  // appears in the note, and the note's wording appears in none of theirs.
  const byDesign = [
    "no branch to key the ledger entry on",
    "no patch id for the working tree",
    "NO REVIEW — no changes since the last lens review",
  ];
  for (const skip of byDesign) {
    assert(
      !MISDIRECTED_LEDGER_NOTE.toLowerCase().includes(skip.toLowerCase()),
      `#1449 the note is distinguishable from the by-design skip "${skip}"`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
