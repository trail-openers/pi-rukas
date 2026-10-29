#!/usr/bin/env bun
/**
 * AC1 (edge) — #1908: `moveToTip` must have NO `byPatchEquivalence` parameter,
 * and the removal must not have taken the result's `movedByPatchEquivalence`
 * field with it.
 *
 * The frozen AC1 file judges the signature (arity, declared parameter names, a
 * whole-tree scan for the bare token). It never calls the function, so the two
 * removal mistakes that actually ship are invisible to it:
 *
 *  1. a removal that also drops `movedByPatchEquivalence: true` from the result —
 *     the frozen scan's needle is a SUBSTRING of that very token, so the field
 *     being deleted cannot make its scan go red, while `work-driver-lens-fix.ts`
 *     reads the field and `test-work-driver-lens-fix-reposition-lagging-ref.ts`
 *     asserts on it;
 *  2. a removal that keeps the value as a defaulted parameter and lets it decide
 *     the field — the reader regains a choice they never had, and the constant
 *     the gate's two cherry arms rely on becomes a caller option. That is exactly
 *     what a `byPatchEquivalence = true` default re-introduces, and an arity
 *     check alone catches it only by luck of where the default sits.
 *
 * So this file drives the REAL exported `moveToTip` through a recording fake
 * `ExecFn` (the argv shape the gate's arms use) and asserts the observable
 * contract on each outcome: refuse-without-git on a bad tip, no checkout when
 * the backup ref could not be created, a landed move carrying the field AND the
 * backup ref, a mis-landed checkout reported as git-failed with the ref kept,
 * and a throwing checkout caught rather than propagated.
 *
 * Plus two structural reads the signature file does not make: the exported
 * function must take EXACTLY eight parameters (the frozen file compares against
 * its own hand-written list, so a ninth dead name could be added to both sides
 * of that comparison), and the dead parameter name must not appear anywhere
 * under `extension/` — the frozen scan is scoped to `extension/src` alone, and
 * it strips comments, so prose is a blind spot in both directions.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { moveToTip } from "../extension/src/work-driver-lens-fix-reposition-move.ts";
import type { ExecFn } from "../extension/src/worktree.ts";

const FILE = "AC1-moveToTip-removal-complete.test.ts";
const TERM = "[0m";
const RED = `[31m`;

let exitCode = 0;
function fail(msg: string): void {
  // The runner's contract: a failing file names itself.
  console.error(`${RED}FAIL ${FILE}: ${msg}${TERM}`);
  exitCode = 1;
}
function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

const EXT = path.resolve(import.meta.dirname, "..", "extension");
const DEAD = "byPatchEquivalence";
/** A token ending in the dead name but NOT the surviving result field. */
const DEAD_REF = /(^|[^a-zA-Z0-9_$])byPatchEquivalence/;

const TIP = "0".repeat(40);
const OLD = "1".repeat(40);

type Call = { argv: string[]; cwd?: string };

/**
 * The git verbs a recording run issued, with `hardenedGitArgv`'s `-c`
 * pre-arguments dropped. The `=false` in `core.fsmonitor=false` must survive the
 * prefix filter, so each `-c <k>=<v>` pair is consumed as a unit rather than
 * filtered token-by-token — filtering on `includes("=")` drops the second half
 * of the pair and turns a `checkout --detach --quiet` into a bare `checkout`.
 */
function verbs(calls: Call[]): string[] {
  return calls.map((c) => {
    const out: string[] = [];
    for (let i = 0; i < c.argv.length; i++) {
      if (c.argv[i] === "-c") {
        i++; // consume the `key=value` that follows as one unit
        continue;
      }
      out.push(c.argv[i]);
    }
    return out.join(" ");
  });
}

/**
 * A `git` stand-in in the argv form the gate's arms use. `headOut` is what
 * `rev-parse HEAD` answers; `failOn` makes the call whose argv contains it throw
 * with a git-shaped stderr (the failed-backup-ref shape); `throwOn` throws a
 * bare Error (the killed-checkout shape).
 */
function fakeGit(opts: { headOut?: string; failOn?: string; throwOn?: string }) {
  const calls: Call[] = [];
  const execFn: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    calls.push({ argv, cwd: o?.cwd });
    if (opts.failOn !== undefined && argv.includes(opts.failOn)) {
      throw Object.assign(new Error(`Command failed: git ${argv.join(" ")}`), {
        stderr: `fatal: ${opts.failOn} refused by the fake`,
      });
    }
    if (opts.throwOn !== undefined && argv.includes(opts.throwOn)) {
      throw new Error(`killed: ${opts.throwOn}`);
    }
    if (argv.includes("rev-parse")) return { stdout: `${opts.headOut ?? TIP}\n` };
    return { stdout: "" };
  };
  return { calls, execFn };
}

/** moveToTip with the argument order every real caller uses. */
const move = (execFn: ExecFn, extra: unknown[] = []) =>
  moveToTip(
    execFn,
    "/tree",
    "feature/issue-1-x",
    [1],
    "dead param",
    OLD,
    TIP,
    "3 worktree commit(s) already on the branch",
    ...extra,
  ) as Promise<{
    kind: string;
    detail?: string;
    fromSha?: string;
    tipSha?: string;
    movedByPatchEquivalence?: boolean;
    backupRef?: string;
  }>;

// ── 1. A non-commit tip refuses WITHOUT touching git at all.
{
  const { calls, execFn } = fakeGit({});
  const bad = await moveToTip(execFn, "/tree", "feature/issue-1-x", [1], "t", OLD, "nope", "why");
  if (bad.kind !== "git-failed") {
    fail(`a non-commit tip must refuse: expected git-failed, got ${JSON.stringify(bad)}`);
  } else if (calls.length !== 0) {
    fail(`the refusal must precede the backup ref and the checkout, but git ran: ${JSON.stringify(verbs(calls))}`);
  } else if (!bad.detail?.includes("nope")) {
    fail(`the refusal detail must name the bad tip, got "${bad.detail}"`);
  } else {
    pass("a non-commit tip refuses before any git call, naming the bad value");
  }
}

// ── 2. No backup ref means no move (fail closed), and the reason rides along.
{
  const { calls, execFn } = fakeGit({ failOn: "update-ref" });
  const res = await move(execFn);
  if (res.kind !== "diverged") {
    fail(`a tree that could not be backed up must park as diverged, got ${JSON.stringify(res)}`);
  } else if (res.backupRef !== undefined) {
    fail(`a backup ref that was never created must not be reported: ${res.backupRef}`);
  } else if (!res.detail?.includes("refused by the fake")) {
    fail(`the park detail must carry the git error that stopped the backup, got "${res.detail}"`);
  } else if (verbs(calls).some((v) => v.includes("checkout"))) {
    fail(`the tree must NOT be checked out when the backup failed: ${JSON.stringify(verbs(calls))}`);
  } else {
    pass("no backup ref → diverged, no checkout, the git error is in the detail");
  }
}

// ── 3. The accept path: it moved, it verified, and it SAYS how it moved.
{
  const { calls, execFn } = fakeGit({});
  const res = await move(execFn);
  if (res.kind !== "repositioned") {
    fail(`a clean move to a valid tip must report repositioned, got ${JSON.stringify(res)}`);
  } else {
    if (res.fromSha !== OLD) fail(`fromSha must be the tree's old HEAD ${OLD}, got ${res.fromSha}`);
    if (res.tipSha !== TIP) fail(`tipSha must be ${TIP}, got ${res.tipSha}`);
    // The field the removal must have left ALONE. The frozen scan cannot see it
    // go: its needle is a substring of this very token.
    if (res.movedByPatchEquivalence !== true) {
      fail(
        "movedByPatchEquivalence must stay true on every moveToTip result — moveToTip is reached " +
          "only by the two cherry arms, and work-driver-lens-fix.ts plus the lagging-ref smoke test " +
          `branch on it; got ${JSON.stringify(res.movedByPatchEquivalence)}`,
      );
    }
    if (res.backupRef === undefined || !res.backupRef.startsWith("refs/pi-rukas/lens-fix-backup/")) {
      fail(`a moved tree must carry its backup ref, got ${JSON.stringify(res.backupRef)}`);
    }
    const v = verbs(calls);
    if (!v.some((s) => s.includes("update-ref"))) fail(`no backup ref was created: ${JSON.stringify(v)}`);
    if (!v.some((s) => s.includes("checkout --detach") && s.includes(TIP))) {
      fail(`the tree was not detached onto the tip: ${JSON.stringify(v)}`);
    }
    if (v.filter((s) => s.includes("rev-parse HEAD")).length !== 2) {
      fail(`expected the pre-backup HEAD read and the post-checkout verify, got ${JSON.stringify(v)}`);
    }
    if (calls.some((c) => c.cwd !== "/tree")) {
      fail(`every git call must run in the tree it is moving: ${JSON.stringify(calls.map((c) => c.cwd))}`);
    }
    pass("the accept path detaches onto the tip, verifies HEAD, reports patch-equivalence");
  }
}

// ── 4. A checkout that did not land is git-failed WITH the backup ref kept.
{
  const calls: Call[] = [];
  let revParse = 0;
  const execFn: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    calls.push({ argv, cwd: o?.cwd });
    if (argv.includes("rev-parse")) {
      revParse++;
      // First read: the old HEAD (what gets backed up). Second: the wrong place.
      return { stdout: `${revParse === 1 ? OLD : "9".repeat(40)}\n` };
    }
    return { stdout: "" };
  };
  const res = await move(execFn);
  if (res.kind !== "git-failed") {
    fail(`a checkout that landed elsewhere must be git-failed, got ${JSON.stringify(res)}`);
  } else if (res.backupRef === undefined) {
    fail("the tree WAS moved off its old HEAD, so the result must keep the ref to restore from");
  } else if (revParse !== 2) {
    fail(`expected the old-HEAD read and the post-checkout verify, got ${revParse} rev-parse reads`);
  } else {
    pass("a checkout that did not land reports git-failed and keeps the backup ref");
  }
}

// ── 5. A throwing checkout is caught, reported, and the ref is retained.
{
  const { calls, execFn } = fakeGit({ throwOn: "checkout" });
  let res;
  try {
    res = await move(execFn);
  } catch (e) {
    fail(`a throwing git checkout must be caught and reported, not propagated: ${e}`);
  }
  if (res !== undefined) {
    if (res.kind !== "git-failed") {
      fail(`a throwing checkout must be git-failed, got ${JSON.stringify(res)}`);
    } else if (res.backupRef === undefined) {
      fail("the tree was backed up before the failed checkout, so the result must carry the ref");
    } else if (!verbs(calls).some((s) => s.includes("update-ref"))) {
      fail("the backup must be created before the checkout is attempted");
    } else {
      pass("a throwing checkout is caught, reported as git-failed, backup ref retained");
    }
  }
}

// ── 6. The value the dead parameter carried is NOT a caller option, not even a
//     positional one.
//
// `Function.prototype.length` stops at the first default or rest, so a soft
// reintroduction (`byPatchEquivalence = true` appended after `why`) reports the
// SAME arity as a real removal and every signature check stays green. Neither
// can an object-shaped argument be caught by a type — the pre-#1908 caller could
// only have passed the flag positionally, so that is exactly the call a stale
// caller in the tree still makes. It must not change what the function returns.
{
  // (a) the flag in its old slot, ahead of the tip: `tipSha` arrives as a
  //     boolean, which is not a commit id, so the guard must refuse — and must
  //     REFUSE, not throw. A `tipSha.slice(0, 12)` in the refusal message on a
  //     boolean is a crash, which would be reported as a dispatch error rather
  //     than a park.
  const { calls, execFn } = fakeGit({});
  let crashed: unknown;
  let shifted;
  try {
    shifted = await (moveToTip as unknown as (...args: unknown[]) => Promise<unknown>)(
      execFn, "/tree", "feature/issue-1-x", [1], "t", OLD, true, TIP, "why",
    );
  } catch (e) {
    crashed = e;
  }
  if (crashed !== undefined) {
    fail(
      "a stale 9-argument call (the flag ahead of the tip) must be refused as a bad tip, not " +
        `propagated as a crash: ${crashed instanceof Error ? `${crashed.constructor.name}: ${crashed.message}` : String(crashed)}`,
    );
  } else if (shifted === undefined || shifted.kind !== "git-failed") {
    fail(`a stale 9-argument call must be refused as a bad tip, got ${JSON.stringify(shifted)}`);
  } else if (calls.length !== 0) {
    fail(`the stale call must be refused before git runs, but it ran: ${JSON.stringify(verbs(calls))}`);
  } else {
    pass("a stale 9-argument call is refused as a bad tip, no git, no crash");
  }

  // (b) the flag as a trailing extra argument: ignored, and it cannot switch the
  //     patch-equivalence constant off.
  const ok = fakeGit({});
  const res = await move(ok.execFn, [false]);
  if (res.kind !== "repositioned") {
    fail(`a ninth argument must be ignored, not change the outcome: got ${JSON.stringify(res)}`);
  } else if (res.movedByPatchEquivalence !== true) {
    fail(
      "a ninth argument must not be able to switch movedByPatchEquivalence off — that is the " +
        `choice #1908 removed; a caller passing false got ${JSON.stringify(res.movedByPatchEquivalence)} ` +
        `and ${JSON.stringify(verbs(ok.calls))}`,
    );
  } else {
    pass("a ninth argument cannot switch patch-equivalence off — it is a constant, not a parameter");
  }
}

// ── 7. The dead name is gone from ALL of extension/, prose included.
{
  // The needle excludes the surviving result field by requiring the name to
  // start a token, so `movedByPatchEquivalence` cannot satisfy it and a
  // reintroduced parameter — or a comment still explaining it — does.
  const offenders = listTs(EXT)
    .filter((f) => DEAD_REF.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(EXT, f))
    .sort();
  if (offenders.length !== 0) {
    fail(`files under extension/ still mention the dead byPatchEquivalence: ${offenders.join(", ")}`);
  } else {
    pass("no file under extension/ mentions the dead byPatchEquivalence (comments included)");
  }
}

function listTs(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.includes("node_modules"))
    .map((f) => path.join(dir, f));
}

process.exit(exitCode);
