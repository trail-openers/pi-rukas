/**
 * #1533 — the merged step's head verification.
 *
 * The defect: an approval covers ONE commit, but the driver's merge asked the
 * forge to merge "this PR" and the forge merged whatever head it held when the
 * command ran. A push landing between review and merge was merged unreviewed.
 *
 * These tests drive `verifyMergeHead` and `verifiedHeadFromEvidence` directly —
 * no cycle, no forge, no child — because every one of their answers is a
 * function of (the evidence's head OID, what `git` answers, what the ledger
 * says), and the refusals are the load-bearing part: each must park, never
 * merge. The forge-side half of the pin (the command carries the flag, a
 * refused pin is not read as success) is covered in
 * test-work-driver-merged-mechanized.ts and the forge argv tests.
 */

import { setupSpawnGuard } from "./test-helpers.ts";
import type { MergeEvidence } from "../src/work-driver-merge-authority.ts";
import {
  verifiedHeadFromEvidence,
  verifyMergeHead,
} from "../src/work-driver-merged-head.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const HEAD = "1".repeat(39) + "a";
const PATCH = "abc123def456abc123def456abc123def456abc123de";
const MERGE_BASE = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** Evidence carrying the head the CI verdict was read at. */
function evidence(over: Partial<MergeEvidence> = {}): MergeEvidence {
  return { ok: true, failing: [], inconclusive: [], headOid: HEAD, ...over };
}

interface FakeGitOpts {
  /** The ledger rows `<dir>/.git/review-ledger.json` carries. */
  entries?: unknown[];
  /** What `git rev-parse <remote>/<branch>` answers (the fetched head). */
  fetchedHead?: string;
  /** What `git patch-id` answers (the head's patch identity). */
  patchId?: string;
  /** Make the network fetch fail. */
  failFetch?: boolean;
  /** Answer no remote at all. */
  noRemote?: boolean;
  /** Answer no mainline at all. */
  noMainline?: boolean;
}

/**
 * A stand-in clone plus its fake executor.
 *
 * Every git read the head verification makes is answered here, so a fault in
 * the check is a fault in the check, not an absence in the fixture. `dir` is
 * returned because the ledger lives under it and each scenario writes its own
 * rows.
 */
function fakeClone(opts: FakeGitOpts = {}): { dir: string; exec: VerifyExecFn; calls: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "head-"));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  writeFileSync(
    path.join(dir, ".git", "review-ledger.json"),
    JSON.stringify({ entries: opts.entries ?? [] }),
  );
  const calls: string[] = [];
  const exec: VerifyExecFn = async (cmd: string, o?: { argv?: string[] }) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    calls.push(line);
    if (line.includes("git config --get remote."))
      return opts.noRemote
        ? Promise.reject(new Error("no remote"))
        : { stdout: "https://example.invalid/r.git\n" };
    if (line.includes("git symbolic-ref"))
      return opts.noMainline
        ? Promise.reject(new Error("no origin/HEAD"))
        : { stdout: "origin/main\n" };
    if (line.includes("git fetch"))
      return opts.failFetch ? Promise.reject(new Error("network down")) : { stdout: "" };
    if (line.includes("git rev-parse --git-common-dir")) return { stdout: `${dir}/.git\n` };
    if (line.includes("git merge-base")) return { stdout: `${MERGE_BASE}\n` };
    if (line.includes("git patch-id")) return { stdout: `${opts.patchId ?? PATCH} x\n` };
    if (line.includes("git rev-parse"))
      return { stdout: `${opts.fetchedHead ?? HEAD}\n` };
    return { stdout: "" };
  };
  return { dir, exec, calls };
}

/** A passing adversarial row for `branch`. */
function passingRow(branch: string, patchId = PATCH): unknown[] {
  return [{ branch, kind: "adversarial", patchId, passed: true, at: 1 }];
}

// ── check 1: the verified head ─────────────────────────────────────────────

{
  const cases: Array<[string, Partial<MergeEvidence>, string]> = [
    ["absent", { headOid: undefined }, "no head OID"],
    ["empty", { headOid: "" }, "no head OID"],
    [
      "abbreviated",
      { headOid: "abc1234" },
      "not a full 40-char SHA",
    ],
    ["non-hex", { headOid: "z".repeat(40) }, "not a full 40-char SHA"],
  ];
  for (const [label, over, want] of cases) {
    const r = verifiedHeadFromEvidence(evidence(over));
    assert(
      !r.ok && r.refusal.reason.includes(want),
      `verified head ${label}: refuses with "${want}" (${JSON.stringify(r)})`,
    );
  }
  const good = verifiedHeadFromEvidence(evidence());
  assert(good.ok && good.headOid === HEAD, "verified head: a full OID is accepted");
}

{
  // The read's own words survive: the operator sees WHICH read failed.
  const r = verifiedHeadFromEvidence(
    evidence({ headOid: undefined, headOidError: "the PR-state read for PR #7 failed" }),
  );
  assert(
    !r.ok && r.refusal.reason.includes("PR-state read for PR #7"),
    "verified head: the evidence read's own reason is surfaced verbatim",
  );
}

// ── check 2: the reviewed identity ─────────────────────────────────────────

{
  // The happy path, and the one thing it must not do: merge on no ledger row.
  const c = fakeClone({ entries: passingRow("feature/x") });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
  assert(r.ok && r.headOid === HEAD, `identity: a matching head merges (${JSON.stringify(r)})`);
  assert(
    !!r.ok && r.note.includes("reviewed identity confirmed"),
    "identity: the merged note records what was confirmed",
  );
  assert(
    c.calls.some((l) => l.includes("git fetch")),
    "identity: the refs are fetched before any identity is trusted",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // A moved mainline is NOT a reason to refuse: patch identity is exactly the
  // mechanism that survives it, so the comparison must be merge-base based.
  const c = fakeClone({ entries: passingRow("feature/x"), fetchedHead: "2".repeat(40) });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
  assert(
    r.ok,
    `identity: a head that moved only by merging main in still merges (${JSON.stringify(r)})`,
  );
  assert(
    c.calls.some((l) => l.includes("git merge-base")),
    "identity: the patch identity is taken against the merge base, not the head SHA",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The head carries a different patch than the review covered — THE defect.
  const c = fakeClone({ entries: passingRow("feature/x"), patchId: "9".repeat(40) });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
  assert(
    !r.ok && r.refusal.reason.includes("was not the reviewed one"),
    `identity: a different patch parks (${JSON.stringify(r)})`,
  );
  // The park names BOTH SHAs — the reviewed one and the one found — because an
  // operator comparing them is the recovery path.
  assert(
    !r.ok && r.refusal.reviewedHead === HEAD && r.refusal.foundHead === HEAD,
    `identity: the park names the heads it compared (${JSON.stringify(r)})`,
  );
  if (r.ok) rmSync(c.dir, { recursive: true, force: true });
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // No row at all: never reviewed here, so nothing licenses the merge.
  const c = fakeClone({ entries: [] });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
  assert(
    !r.ok && !!r.refusal.reason.match(/no adversarial row/),
    `identity: no ledger row parks (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // A row that did not pass is not a row.
  const c = fakeClone({
    entries: [{ branch: "feature/x", kind: "adversarial", patchId: PATCH, passed: false, at: 1 }],
  });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
  assert(
    !r.ok && !!r.refusal.reason.match(/did not pass/),
    `identity: a non-passing row parks (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The row for another branch must not satisfy this one.
  const c = fakeClone({ entries: passingRow("feature/other") });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
  assert(!r.ok, `identity: another branch's row does not count (${JSON.stringify(r)})`);
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // A lens row is not an adversarial row, however passing.
  const c = fakeClone({
    entries: [{ branch: "feature/x", kind: "lens", patchId: PATCH, passed: true, at: 1 }],
  });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
  assert(!r.ok, `identity: a passing lens row is not adversarial approval (${JSON.stringify(r)})`);
  rmSync(c.dir, { recursive: true, force: true });
}

// ── every unreadable input is a refusal, never a merge ─────────────────────

{
  const cases: Array<[string, FakeGitOpts, string]> = [
    ["fetch failure", { entries: passingRow("feature/x"), failFetch: true }, "git fetch"],
    ["no remote", { entries: passingRow("feature/x"), noRemote: true }, "no git remote"],
    ["no mainline", { entries: passingRow("feature/x"), noMainline: true }, "mainline"],
  ];
  for (const [label, opts, want] of cases) {
    const c = fakeClone(opts);
    const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1);
    assert(
      !r.ok && r.refusal.reason.includes(want),
      `refusal ${label}: parks naming "${want}" (${JSON.stringify(r)})`,
    );
    rmSync(c.dir, { recursive: true, force: true });
  }
}

{
  // No ledger file at all (no git common dir) is a refusal, not an empty ledger.
  const dir = mkdtempSync(path.join(tmpdir(), "noldger-"));
  const exec: VerifyExecFn = async (cmd: string, o?: { argv?: string[] }) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    if (line.includes("git config --get remote.")) return { stdout: "https://x/y.git\n" };
    if (line.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
    if (line.includes("git rev-parse --git-common-dir"))
      return Promise.reject(new Error("not a git repository"));
    // The fetched-head read succeeds: this scenario is about the LEDGER being
    // unresolvable, and a fixture that also fails the head read would assert on
    // the first refusal it happens to hit rather than the one under test.
    if (line.includes("git rev-parse")) return { stdout: `${HEAD}\n` };
    return { stdout: "" };
  };
  const r = await verifyMergeHead(exec, dir, "feature/x", evidence(), 1);
  assert(
    !r.ok && r.refusal.reason.includes("ledger"),
    `refusal: an unresolvable ledger path parks (${JSON.stringify(r)})`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// ── the checks that do NOT apply still pin, and say so ─────────────────────

{
  const c = fakeClone({ entries: passingRow("feature/x") });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 3);
  assert(r.ok && r.headOid === HEAD, `grouped cycle: still pinned (${JSON.stringify(r)})`);
  assert(
    !!r.ok && r.note.includes("did not apply"),
    "grouped cycle: the note says the identity comparison did not apply",
  );
  assert(
    !c.calls.some((l) => l.includes("git fetch")),
    "grouped cycle: no fetch is paid for a comparison that will not run",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  const c = fakeClone({ entries: passingRow("feature/x") });
  const r = await verifyMergeHead(c.exec, c.dir, undefined, evidence(), 1);
  assert(
    r.ok && !!r.ok && r.note.includes("did not run"),
    `no branch name: pinned, and the note says the comparison did not run (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The step-level switch: a caller with no repository to read a ledger from
  // pins rather than parking on a fault the cycle never had.
  const c = fakeClone({ entries: passingRow("feature/x"), noRemote: true });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), 1, {
    identityCheck: false,
  });
  assert(
    r.ok && r.headOid === HEAD,
    `identityCheck:false: pinned without the comparison (${JSON.stringify(r)})`,
  );
  assert(
    !c.calls.some((l) => l.includes("git config --get remote")),
    "identityCheck:false: no remote probe is made",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // Order matters: a missing head OID is refused before any fetch, so a cycle
  // with nothing to pin never reaches the network.
  const c = fakeClone({ entries: passingRow("feature/x") });
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: undefined }), 1);
  assert(!r.ok, "no verified head: refused before the identity check");
  assert(
    !c.calls.some((l) => l.includes("git fetch")),
    "no verified head: nothing fetched",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
