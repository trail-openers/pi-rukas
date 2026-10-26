/**
 * #1533 — the merged step's head verification.
 *
 * The defect: an approval covers ONE commit, but the driver's merge asked the
 * forge to merge "this PR" and the forge merged whatever head it held when the
 * command ran. A push landing between review and merge was merged unreviewed.
 *
 * The rule these tests pin: the reviewed head is the LATEST LENS ROW's
 * `headSha` — the commit the driver's own six-lens review recorded (#1039). The
 * adversarial gate the previous rule read writes no ledger row for a /work cycle
 * and its round-capped rows are `passed: false`, so that check could never be
 * satisfied by the very cycles it was meant to protect. The `passed` re-judgement
 * is gone as well: the lens gate decided it upstream, and a cycle that reaches
 * `merged` already passed it.
 *
 * Two executors, because the two halves of the rule need different evidence:
 *
 * - `fakeClone` answers EVERY git read, so each refusal is attributable to the
 *   check and not to an absence in a fixture (an error no test can tell apart
 *   from the fault it is named for is not a test).
 * - `realClone` is a real clone with a real origin and real commits, so the
 *   MOVED-HEAD cases — where the whole question is whether a patch identity
 *   survives a base move — are answered by git, not by a stub. A fixture that
 *   returned one id for every range could make a genuinely-moved head look like
 *   a mainline-only move, and the case would only be asserting on its own answer.
 *
 * The forge half of the pin (the flag on the command, a refused pin not read as
 * success) is in test-work-driver-merged-mechanized.ts and the forge argv tests;
 * the ledger written by PRODUCTION code and read back by the merge step is in
 * test-work-driver-merged-head-real-ledger.ts.
 */

import { setupSpawnGuard } from "./test-helpers.ts";
import type { MergeEvidence } from "../src/work-driver-merge-authority.ts";
import {
  verifiedHeadFromEvidence,
  verifyMergeHead,
} from "../src/work-driver-merged-head.ts";
import { reviewedHeadFromEntries } from "../src/work-driver-merged-identity.ts";
import { isFullCommitSha, resolveHeadSha } from "../src/review-head-sha.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
/**
 * Where a stubbed branch is when it is fetched.
 *
 * Distinct from `HEAD` because the cases that exercise the FETCH half of the
 * rule have to make the head have actually moved: the check returns as soon as
 * the verified head and the reviewed head agree (correctly — that fetch cannot
 * change the verdict), so a stub whose two OIDs were the same would never reach
 * the fetch, the merge-base, or the identity comparison it claims to test.
 */
const MOVED = "2".repeat(39) + "b";
const PATCH = "abc123def456abc123def456abc123def456abc123de";
const MERGE_BASE = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const execFileP = promisify(execFile);

/** Evidence carrying the head the CI verdict was read at. */
function evidence(over: Partial<MergeEvidence> = {}): MergeEvidence {
  return { ok: true, failing: [], inconclusive: [], headOid: HEAD, ...over };
}

/** The lens row the driver's lens step writes for `branch`, pinning `headSha`. */
function lensRow(branch: string, headSha = HEAD, over: Record<string, unknown> = {}): unknown[] {
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
    },
  ];
}

/**
 * The ledger file a scenario reads, carrying `entries`.
 *
 * Passing it as `ledgerFile` is what makes each case state WHICH ledger its
 * check consulted. `ledgerPathFor` honours `PI_ENSEMBLE_REVIEW_LEDGER_FILE`
 * before any git call — that override is the documented isolation every
 * ledger-writing test uses, and this file runs under it in the verify loop — so
 * a scenario that relied on the clone's own path could read another test's rows
 * and report "no lens row" for a row that is on file.
 */
/**
 * A REAL clone with a real origin, for the cases whose variable is what the
 * FETCHED head actually is.
 *
 * `mainlineMoved` merges origin/main into the branch and pushes; `unreviewedPush`
 * adds a commit nobody reviewed. Both leave `reviewedHead` where the review saw
 * it and `fetchedHead` where the forge now holds the branch, so a scenario states
 * the two commits it means instead of asserting over stubs.
 */
async function realClone(
  opts: { mainlineMoved?: boolean; unreviewedPush?: boolean } = {},
): Promise<{ dir: string; reviewedHead: string; fetchedHead: string; branch: string }> {
  // `commit.gpgsign=false` on the command line, not `git config`: the fixture
  // harness isolates `HOME` and `XDG_CONFIG_HOME` away from any host config
  // (git-test-env.ts) so a test cannot be changed by what is on the machine it
  // runs on — and that same isolation means a host `gpgSign = true` is NOT
  // picked up. The fixture repos in this repo therefore pin the setting they
  // need where git will read it regardless of HOME (headless-s5-fixture.ts pins
  // the opposite). Without it this fixture's verdict would depend on a host
  // signing key, and a signature failure here looks exactly like the
  // "lens row does not match the head" bug this file is about.
  const git = (args: string[]) =>
    execFileP("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir });
  const root = mkdtempSync(path.join(tmpdir(), "head-real-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "repo");
  const branch = "feature/x";
  await execFileP("git", ["-c", "commit.gpgsign=false", "init", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["-c", "commit.gpgsign=false", "init", "--initial-branch=main", dir]);
  await git(["config", "user.email", "t@example.invalid"]);
  await git(["config", "user.name", "T"]);
  writeFileSync(path.join(dir, "base.txt"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "base"]);
  await git(["remote", "add", "origin", origin]);
  await git(["push", "-q", "-u", "origin", "main"]);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(["checkout", "-q", "-b", branch]);
  writeFileSync(path.join(dir, "work.txt"), "the reviewed work\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "work"]);
  await git(["push", "-q", "-u", "origin", branch]);
  const reviewedHead = await forgeHead(dir, branch);
  if (opts.mainlineMoved) {
    await git(["checkout", "-q", "main"]);
    writeFileSync(path.join(dir, "mainline.txt"), "mainline moved\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "mainline moved"]);
    await git(["push", "-q", "origin", "main"]);
    await git(["checkout", "-q", branch]);
    await git(["merge", "-q", "--no-edit", "origin/main"]);
    await git(["push", "-q", "origin", branch]);
  }
  if (opts.unreviewedPush) {
    writeFileSync(path.join(dir, "sneaked.txt"), "pushed after the review\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "unreviewed push"]);
    await git(["push", "-q", "origin", branch]);
  }
  return {
    dir,
    reviewedHead,
    fetchedHead: await forgeHead(dir, branch),
    branch,
  };
}

/**
 * The head the FORGE holds, read the way production reads it.
 *
 * `resolveHeadSha` is the repo's own ref-to-OID resolution (`rev-parse --verify
 * --quiet <ref>^{commit}`, argv, bounded) — the same call the driver uses for
 * every head it trusts. A bare `rev-parse origin/<branch>` prints an OID for a
 * tag or a tree as well, and a fixture whose `fetchedHead` was not a commit
 * would be a head the driver could never have pinned.
 */
async function forgeHead(dir: string, branch: string): Promise<string> {
  const oid = await resolveHeadSha(dir, `origin/${branch}`, realGit);
  if (oid === undefined || !isFullCommitSha(oid))
    throw new Error(`fixture: origin/${branch} did not resolve to a commit`);
  // The resolution must be THIS clone's, not some repository up the tree: a bare
  // `rev-parse` walks upward out of a temp dir into whatever repository the test
  // process happens to sit in and answers with a real OID from the wrong repo,
  // which looks exactly like a working fixture. Ancestry against this clone's own
  // HEAD is the local proof that the OID came out of this repository.
  try {
    await execFileP("git", ["merge-base", "--is-ancestor", oid, "HEAD"], { cwd: dir });
  } catch {
    throw new Error(
      `fixture: origin/${branch} resolved to ${oid.slice(0, 8)}, not a commit in ${dir} — the read left this repository`,
    );
  }
  return oid;
}

/** An executor that runs REAL git against `dir`; every read is git's own answer. */
const realGit: VerifyExecFn = async (cmd: string, o?: { argv?: string[]; cwd?: string }) => {
  // The `-C <dir>` a caller puts in `argv` (the shape `resolveHeadSha` uses, to
  // name the repository while `cwd` carries something else) is honoured here
  // rather than handed to git as a plain argument: git honours it, but this
  // harness must resolve its own `cwd` the same way git will, or a caller that
  // named one repository gets an answer about whichever one the test happened to
  // be running in. That mix-up made every real-clone case below read the
  // *fixture host's* repository and report "the verified head is the reviewed
  // head" for commits from another tree — a green test verifying nothing, and the
  // kind of error no assertion on the verdict catches, because the verdict was
  // wrong in a plausible way.
  const args = [...(o?.argv ?? cmd.split(" ").slice(1))];
  let cwd = o?.cwd ?? process.cwd();
  if (args[0] === "-C" && args[1] !== undefined) {
    cwd = args[1];
    args.splice(0, 2);
  }
  const { stdout } = await execFileP("git", args, { cwd });
  return { stdout };
};

/**
 * Evidence for the MOVED-head cases: the CI verdict was read at `MOVED`, and the
 * lens row on the ledger still names `HEAD` — the shape the head check exists to
 * examine. `evidence()` alone is the "nothing moved" shape.
 */
function movedEvidence(): MergeEvidence {
  return evidence({ headOid: MOVED });
}

interface FakeGitOpts {
  /** What the fetched-head rev-parse answers. */
  fetchedHead?: string;
  /** What `git patch-id` answers. `""` is "the identity could not be computed". */
  patchId?: string;

  /** Make the network fetch fail. */
  failFetch?: boolean;
  /** Answer no remote at all (the honest answer: no URL, and no remotes listed). */
  noRemote?: boolean;
  /** Answer no mainline at all. */
  noMainline?: boolean;
}

/**
 * A stand-in clone answering every git read the head verification makes, so each
 * refusal below is attributable to the check and not to an absent fixture. The
 * moved-head cases use `realClone` instead, for the reason given there.
 *
 * Reads are matched on their WORDS, not their shape: `execp` runs an argv call
 * through `execFile` and a string call through a shell, and the check under test
 * uses both — a matcher keyed to one shape answers nothing for the other.
 */
function fakeClone(opts: FakeGitOpts = {}): { dir: string; exec: VerifyExecFn; calls: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "head-"));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  const calls: string[] = [];
  const exec: VerifyExecFn = async (cmd: string, o?: { argv?: string[] }) => {
    const args = o?.argv ?? cmd.split(" ").slice(1);
    const line = ["git", ...args].join(" ");
    calls.push(line);
    const verb = args[0];
    if (args.includes("--git-common-dir")) return { stdout: `${dir}/.git\n` };
    if (verb === "config" && args.some((a) => a.startsWith("remote.")))
      return opts.noRemote
        ? Promise.reject(new Error("no such remote"))
        : { stdout: "https://example.invalid/r.git\n" };
    if (verb === "remote")
      return opts.noRemote ? { stdout: "" } : { stdout: "origin\n" };
    if (verb === "symbolic-ref")
      return opts.noMainline
        ? Promise.reject(new Error("no origin/HEAD"))
        : { stdout: "origin/main\n" };
    if (verb === "fetch")
      return opts.failFetch ? Promise.reject(new Error("network down")) : { stdout: "" };
    if (verb === "merge-base") return { stdout: `${MERGE_BASE}\n` };
    if (line.includes("patch-id")) {
      // `""` from the seam is "the identity could not be computed", which is its
      // own refusal case: one side missing is not evidence of equality.
      return { stdout: opts.patchId === "" ? "" : `${opts.patchId ?? PATCH} x\n` };
    }
    // Only ONE rev-parse remains at this point in the sequence — the read of the
    // fetched head, after the fetch and before any identity — which is why the
    // cases drive it through `fetchedHead`. An answer that is not a commit OID is
    // how the "the fetched head could not be resolved" case is posed, and it is
    // refused as it stands: inventing an OID here would test a different branch
    // and report a pass.
    if (verb === "rev-parse") {
      const wanted = opts.fetchedHead ?? HEAD;
      return { stdout: isFullCommitSha(wanted) ? `${wanted}\n` : "\n" };
    }
    return { stdout: "" };
  };
  return { dir, exec, calls };
}

/**
 * Seed `entries` into BOTH ledgers a read could land on, and return the path the
 * caller hands to `verifyMergeHead`.
 *
 * The clone's own ledger beside its git dir is what `ledgerPathFor` resolves to
 * when no override is set — the production answer — while `ledgerFile` is the
 * file the caller names. Seeding only one of the two lets a case be answered out
 * of the file it did not intend, which is how a fixture silently tests nothing:
 * that is exactly the confusion this helper removes.
 */
/**
 * Seed `entries` into the two places a read can legitimately land, and return
 * the path the caller hands to `verifyMergeHead` as `ledgerFile`.
 *
 * The two are the file named by `ledgerFile` and the file `ledgerPathFor`
 * resolves from the clone's git dir — the production answer, which is what a
 * caller that passes no `ledgerFile` reads. A case that seeds only the first can
 * be answered out of the second, and then it is testing nothing; a case that
 * seeds only the second cannot say which ledger produced its verdict.
 *
 * What it deliberately does NOT seed is `PI_ENSEMBLE_REVIEW_LEDGER_FILE`. That
 * override short-circuits `ledgerPathFor` before any git call, and it is the
 * documented isolation for every ledger-writing test in this suite, so it can be
 * pointing at a file another case filled. Writing there would turn this file's
 * cases into a shared mutable fixture — one case's rows deciding another's
 * verdict — which is exactly the confusion the parameter exists to remove. Every
 * case here therefore states the ledger it reads, and nothing else is consulted.
 */
/**
 * Seed `entries` into the two places a read can legitimately land, and return
 * the path the caller hands to `verifyMergeHead` as `ledgerFile`.
 *
 * The two are the file named by `ledgerFile` and the file `ledgerPathFor`
 * resolves from the clone's git dir — the production answer, which is what a
 * caller that passes no `ledgerFile` reads. A case that seeds only the first can
 * be answered out of the second, and then it is testing nothing; a case that
 * seeds only the second cannot say which ledger produced its verdict. Where the
 * two differ, `ledgerRow` says which side holds what.
 *
 * What it deliberately does NOT seed is `PI_ENSEMBLE_REVIEW_LEDGER_FILE`. That
 * override short-circuits `ledgerPathFor` before any git call, and it is the
 * documented isolation for every ledger-writing test in this suite, so it can be
 * pointing at a file another case filled. Writing there would turn this file's
 * cases into a shared mutable fixture — one case's rows deciding another's
 * verdict — which is exactly the confusion the parameter exists to remove. Every
 * case here therefore states the ledger it reads, and nothing else is consulted.
 */
function ledgerAt(
  entries: unknown[],
  dir?: string,
  /** Rows for the CLONE's own ledger, when the case wants the two to differ. */
  cloneEntries?: unknown[],
): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "head-ledger-")), "review-ledger.json");
  seedLedger(file, entries);
  if (dir !== undefined) seedLedger(path.join(dir, ".git", "review-ledger.json"), cloneEntries ?? entries);
  return file;
}

/**
 * `ledgerAt` for the cases that must prove WHICH file the check read.
 *
 * The path carries a `#<tag>` the check strips before reading and echoes into its
 * refusal, so a park names the ledger it consulted. Two things follow, and both
 * are why these cases are posed this way: the tag is proof the named file was the
 * one consulted (a refusal that does not name it never read it), and the clone's
 * own ledger deliberately holds a DIFFERENT row — so the "nothing moved" fast path
 * is unreachable through it, and the only route to the expected verdict is the
 * read this case is actually about.
 */
function namedLedger(entries: unknown[], dir: string, cloneEntries: unknown[]): string {
  return `${ledgerAt(entries, dir, cloneEntries)}#named-ledger:case-named-file`;
}

/**
 * Proof that `ledgerFile` is honoured, not decoration.
 *
 * Every ledger-reading case in this file passes it, so if `verifyMergeHead` ever
 * ignored the parameter the whole file would quietly start reading the CLONE's
 * ledger and still pass — the assertions would be about a file nobody chose. This
 * case puts different rows in the two files and requires the one named by
 * `ledgerFile` to decide the verdict, which is the only way to know the parameter
 * is wired to the read it claims to control.
 */
async function assertLedgerFileIsHonoured(): Promise<void> {
  const c = fakeClone();
  // The clone's ledger says the reviewed head is some other commit; the file
  // named by `ledgerFile` says it is the verified head. Only one of the two can
  // produce "the head has not moved", so the verdict names the file it read.
  const ledger = ledgerAt(lensRow("feature/x", HEAD), c.dir, lensRow("feature/x", MOVED));
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(
    r.ok && r.headOid === HEAD,
    `ledgerFile decides which ledger is read — the clone's own ledger names ${MOVED} and was not consulted (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

function seedLedger(file: string, entries: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ entries }), "utf8");
}

// ── the reviewed head is the latest lens row's, not anything else ──────────

{
  assert(
    reviewedHeadFromEntries(lensRow("feature/x") as never, "feature/x") === HEAD,
    "reviewed head: the latest lens row's headSha is the reviewed commit",
  );
  assert(
    reviewedHeadFromEntries([], "feature/x") === undefined,
    "reviewed head: no row at all is UNKNOWN, never a match",
  );
  assert(
    reviewedHeadFromEntries(lensRow("feature/other") as never, "feature/x") === undefined,
    "reviewed head: another branch's row does not count",
  );
  assert(
    reviewedHeadFromEntries(lensRow("feature/x", "feature/x") as never, "feature/x") === undefined,
    "reviewed head: a legacy row recording a BRANCH NAME as headSha is UNKNOWN (#1039 shape)",
  );
  assert(
    reviewedHeadFromEntries(lensRow("feature/x", "abc1234") as never, "feature/x") === undefined,
    "reviewed head: an abbreviated headSha is UNKNOWN, never matched",
  );
  assert(
    reviewedHeadFromEntries(
      [...lensRow("feature/x", HEAD, { at: 100 }), ...lensRow("feature/x", MOVED, { at: 200 })] as never,
      "feature/x",
    ) === MOVED,
    "reviewed head: the LATEST lens row wins — a re-review re-pins the commit",
  );
  assert(
    reviewedHeadFromEntries(
      [
        {
          branch: "feature/x",
          kind: "adversarial",
          patchId: PATCH,
          passed: true,
          at: 2,
          headSha: HEAD,
        },
      ] as never,
      "feature/x",
    ) === undefined,
    "reviewed head: an adversarial row is NOT a lens row (this check's rule, not the guard's)",
  );
  assert(
    reviewedHeadFromEntries(
      lensRow("feature/x", HEAD, { passed: false }) as never,
      "feature/x",
    ) === HEAD,
    "reviewed head: a non-passing lens row still names the commit it reviewed (no re-judging)",
  );
  assert(
    reviewedHeadFromEntries(
      [
        ...lensRow("feature/x", HEAD, { at: 1 }),
        { branch: "feature/x", kind: "not-a-kind", at: 2, headSha: MOVED },
      ] as never,
      "feature/x",
    ) === HEAD,
    "reviewed head: a row of an unknown kind does not displace the lens row",
  );
}

// ── check 1: the verified head ─────────────────────────────────────────────

{
  const cases: Array<[string, Partial<MergeEvidence>, string]> = [
    ["absent", { headOid: undefined }, "no head OID"],
    ["empty", { headOid: "" }, "no head OID"],
    ["abbreviated", { headOid: "abc1234" }, "not a full 40-char SHA"],
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

// ── the ledger a case reads is the ledger it names ────────────────────────

await assertLedgerFileIsHonoured();

// ── check 2: the head the forge holds IS the reviewed one ──────────────────

{
  // The common case: the branch has not moved since the review. Nothing is
  // fetched — the verified head IS the reviewed head, so a fetch would be a
  // network call whose answer cannot change the verdict.
  const c = fakeClone();
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(r.ok && r.headOid === HEAD, `head unchanged: merges pinned (${JSON.stringify(r)})`);
  assert(
    !!r.ok && r.note.includes("the head the lens review recorded"),
    "head unchanged: the merged note records what was confirmed",
  );
  assert(
    !c.calls.some((l) => l.includes("fetch")),
    "head unchanged: nothing is fetched when the reviewed and verified heads agree",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // A moved mainline is NOT a reason to refuse: the head moved, its patch
  // identity did not, and the merge pins the NEW OID — not the reviewed one,
  // which the forge no longer holds. Real commits, real `git patch-id`.
  const c = await realClone({ mainlineMoved: true });
  // The verified head is what CI read — the commit the branch was at THEN — and
  // the lens row names the same commit. The branch has since taken the mainline
  // merge, so the two sides of the comparison really are two different OIDs. If
  // the fixture ever stopped moving the head, these two values would be equal,
  // the check would short-circuit on "nothing moved", and this case would pass
  // without the identity comparison running at all. So the fixture's own
  // precondition is asserted here, before the call it protects.
  const ciHead = c.reviewedHead;
  // Only the NAMED file holds a row: the clone's own ledger is left with none, so the
  // "nothing moved" fast path is unreachable through it and the verdict can only
  // come from the ledger this case names.
  const ledger = ledgerAt(lensRow(c.branch, ciHead), undefined, []);
  assert(
    c.fetchedHead !== ciHead,
    "mainline merged in: the fixture moved the head, so the comparison actually runs (otherwise this case is the no-op fast path)",
  );
  const r = await verifyMergeHead(realGit, c.dir, c.branch, {
    ok: true,
    failing: [],
    inconclusive: [],
    headOid: ciHead,
  }, { ledgerFile: ledger });
  assert(
    r.ok && r.headOid === c.fetchedHead,
    `mainline merged in: merges PINNED TO THE NEW OID (${JSON.stringify(r)})`,
  );
  assert(
    !!r.ok && r.note.includes("patch identity is unchanged"),
    "mainline merged in: the note says why the moved head is still the reviewed content",
  );
  rmSync(c.dir, { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
}

{
  // The head carries a patch the review never covered — THE defect. Same real
  // clone, one extra commit: the only difference from the case above is
  // unreviewed content, so a refusal here can only come from the comparison.
  const c = await realClone({ mainlineMoved: true, unreviewedPush: true });
  // As above: the review covered `reviewedHead`, the branch is now at
  // `fetchedHead`, and the two differ by a commit nobody reviewed. Asserting the
  // difference first is what keeps this case from silently becoming the fast path.
  const ciHead = c.reviewedHead;
  assert(
    c.fetchedHead !== ciHead,
    "content changed: the fixture moved the head, so the comparison actually runs",
  );
  // Only the NAMED file holds a row: the clone's own ledger is left with none, so the
  // "nothing moved" fast path is unreachable through it and the verdict can only
  // come from the ledger this case names.
  const ledger = ledgerAt(lensRow(c.branch, ciHead), undefined, []);
  const r = await verifyMergeHead(realGit, c.dir, c.branch, {
    ok: true,
    failing: [],
    inconclusive: [],
    headOid: ciHead,
  }, { ledgerFile: ledger });
  assert(
    !r.ok && r.refusal.reason.includes("not the reviewed one"),
    `content changed after the review: parks (${JSON.stringify(r)})`,
  );
  assert(
    !r.ok && r.refusal.reviewedHead === c.reviewedHead && r.refusal.foundHead === c.fetchedHead,
    `content changed: the park names BOTH heads it compared (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
}

{
  // A new commit pushed without the mainline moving at all is the same refusal,
  // and it is the case the guard's `--match-head-commit` alone cannot catch —
  // it pins, it does not verify.
  const c = await realClone({ unreviewedPush: true });
  const ciHead = c.reviewedHead;
  assert(
    c.fetchedHead !== ciHead,
    "pushed commit, no base move: the fixture moved the head, so the comparison actually runs",
  );
  // Only the NAMED file holds a row: the clone's own ledger is left with none, so the
  // "nothing moved" fast path is unreachable through it and the verdict can only
  // come from the ledger this case names.
  const ledger = ledgerAt(lensRow(c.branch, ciHead), undefined, []);
  const r = await verifyMergeHead(realGit, c.dir, c.branch, {
    ok: true,
    failing: [],
    inconclusive: [],
    headOid: ciHead,
  }, { ledgerFile: ledger });
  assert(
    !r.ok && r.refusal.reason.includes("not the reviewed one"),
    `a pushed commit with no base move: parks (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
}

{
  // No lens row at all: the driver's review never recorded a commit, so nothing
  // licenses the merge.
  const c = fakeClone();
  const ledger = ledgerAt([], c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(
    !r.ok && !!r.refusal.reason.match(/no lens review row/),
    `no lens row: parks (${JSON.stringify(r)})`,
  );
  assert(
    !c.calls.some((l) => l.includes("fetch")),
    "no lens row: no fetch is paid for a comparison that has no reviewed head",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The head the ledger holds is not a commit, in the two shapes the writer has
  // actually produced: a branch NAME where an OID belongs (the pre-#1039 shape)
  // and an abbreviated OID. Each parks with the same refusal — there is no
  // reviewed commit to compare against — so the check cannot be satisfied by a
  // row that records the branch instead of a commit.
  for (const unusable of [{ headSha: "feature/x" }, { headSha: "abc1234" }]) {
    // The row records a BRANCH NAME / an abbreviated OID where a full commit
    // belongs — the pre-#1039 shape the writer used to store. Such a row is
    // UNKNOWN and UNKNOWN parks: string-comparing a ref against an OID would call
    // the mismatch evidence of drift and park a cycle whose head is fine. (A row
    // with no `headSha` at all is the `no lens row` case above — JSON drops an
    // undefined field and the production writer omits it too, so both shapes are
    // the same ledger on disk.)
    const entries = lensRow("feature/x", unusable.headSha as never);
    // The same rows in BOTH ledgers a read could land on — the file `ledgerFile`
    // names and the clone's own, which is what `ledgerPathFor` resolves to by
    // default. Seeding one of them lets the case be answered out of the file it
    // did not intend, which is how a fixture silently tests nothing.
    const ledger = ledgerAt(entries);
    const c = fakeClone();
    const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
      ledgerFile: ledger,
    });
    assert(
      !r.ok && r.refusal.reason.includes("no lens review row"),
      `a lens row whose headSha is ${JSON.stringify(unusable)} is not a reviewed head (${JSON.stringify(r)})`,
    );
    rmSync(c.dir, { recursive: true, force: true });
  }
}

{
  // A row for another kind must not satisfy this branch's lookup even with a
  // matching head: the guard's adversarial rule is not this check's rule.
  const c = fakeClone();
  const ledger = ledgerAt([
    {
      branch: "feature/x",
      kind: "adversarial",
      patchId: PATCH,
      passed: true,
      at: 1,
      headSha: HEAD,
    },
  ]);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
  });
  assert(!r.ok, `an adversarial row is not the reviewed head (${JSON.stringify(r)})`);
  rmSync(c.dir, { recursive: true, force: true });
}

// ── every unreadable input is a refusal, never a merge ─────────────────────

{
  const cases: Array<[string, FakeGitOpts, string]> = [
    ["fetch failure", { failFetch: true }, "git fetch"],
    ["no remote", { noRemote: true }, "no git remote"],
    ["no mainline", { noMainline: true }, "mainline"],
  ];
  for (const [label, opts, want] of cases) {
    const c = fakeClone(opts);
    const ledger = ledgerAt(lensRow("feature/x"), c.dir);
    const r = await verifyMergeHead(c.exec, c.dir, "feature/x", movedEvidence(), {
      ledgerFile: ledger,
    });
    assert(
      !r.ok && r.refusal.reason.includes(want),
      `refusal ${label}: parks naming "${want}" (${JSON.stringify(r)})`,
    );
    rmSync(c.dir, { recursive: true, force: true });
  }
}

{
  // Two ways to have no ledger to read, and both are refusals: the file is
  // absent, and the clone's common dir cannot be resolved at all. Neither is
  // ever "no rows", which is a real answer about the review rather than about
  // the repository — and an environment override the harness carries must not
  // turn either into a silent pass, which is why the absent-file case pins the
  // path it reads instead of trusting the resolver.
  const c = fakeClone();
  // An absent ledger is a refusal, and the refusal says so rather than reporting
  // "the review recorded nothing": the first is a broken or redirected clone and
  // the second is a cycle that was never reviewed, and an operator following the
  // park needs to know which one to go and look at.
  const absentFile = path.join(c.dir, "absent", "review-ledger.json");
  const r1 = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: absentFile,
  });
  assert(
    !r1.ok && r1.refusal.reason.includes(`no review ledger at ${absentFile}`),
    `an absent ledger parks, naming the file it looked in (${JSON.stringify(r1)})`,
  );

{
  // The clone's own git dir cannot resolve, so the ledger path cannot be
  // resolved either — which is a refusal, not "no rows", and NOT the "no remote"
  // refusal the step's first check already covers. The two faults are separate
  // assertions on purpose: collapsing them would let a broken remote lookup read
  // as a missing ledger and vice versa, and an operator would chase the wrong one.
  const c = fakeClone();
  const exec: VerifyExecFn = async (cmd, o) => {
    const args = o?.argv ?? cmd.split(" ").slice(1);
    if (args.includes("--git-common-dir")) throw new Error("not a git repository");
    return c.exec(cmd, o);
  };
  const r2 = await verifyMergeHead(exec, c.dir, "feature/x", evidence());
  assert(
    !r2.ok && r2.refusal.reason.includes("ledger"),
    `refusal no ledger path: parks naming the ledger (${JSON.stringify(r2)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The fetch answered, but the branch ref resolves to nothing git can call a commit:
  // the stub refuses to invent an OID. The clone's OWN ledger names `MOVED`, so the
  // only way the check can still report the "head has not moved" fast path is by
  // reading the file `ledgerFile` points at — which makes this case, and every case
  // below that depends on the named file, an assertion that the parameter is wired
  // to the read rather than decoration.
  const c = fakeClone({ fetchedHead: "not-an-oid" });
  const ledger = namedLedger(lensRow("feature/x", MOVED), c.dir, lensRow("feature/x", HEAD));
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: HEAD }), {
    ledgerFile: ledger,
  });
  assert(
    !r.ok && r.refusal.reason.includes("could not read the fetched head"),
    `an unresolvable fetched head parks (${JSON.stringify(r)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // An identity that cannot be COMPUTED is a refusal: "could not tell" is not
  // "equal", and a one-sided comparison must not license a merge. Withheld at
  // the verified head (the stub) and at the fetched head (real git, one answer
  // suppressed) so neither refusal is an artefact of the other side being absent.
  const c = fakeClone({ fetchedHead: MOVED, patchId: "" });
  // The named ledger names the VERIFIED head; the clone's own ledger names the
  // branch head, which is NOT the verified one. Only the named file decides this
  // case, and only the identity comparison can answer "could not compute" — a
  // row naming the verified head in both files would take the fast path and let
  // the assertion pass with the identity code never run.
  const ledger = namedLedger(lensRow("feature/x", MOVED), c.dir, lensRow("feature/x", HEAD));
  const r1 = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: HEAD }), {
    ledgerFile: ledger,
  });
  assert(
    !r1.ok && r1.refusal.reason.includes("at the verified head"),
    `an identity that cannot be computed at the verified head parks (${JSON.stringify(r1)})`,
  );
  rmSync(c.dir, { recursive: true, force: true });

  const real = await realClone({ mainlineMoved: true });
  const ciHead = real.reviewedHead;
  assert(
    real.fetchedHead !== ciHead,
    "fetched identity unavailable: the fixture moved the head, so the comparison actually runs",
  );
  const ledger2 = ledgerAt(lensRow(real.branch, ciHead), undefined, []);
  const exec: VerifyExecFn = async (cmd, o) => {
    const args = o?.argv ?? cmd.split(" ").slice(1);
    if (args.join(" ").includes("patch-id")) return { stdout: "" };
    return realGit(cmd, o);
  };
  const r2 = await verifyMergeHead(exec, real.dir, real.branch, {
    ok: true,
    failing: [],
    inconclusive: [],
    headOid: ciHead,
  }, { ledgerFile: ledger2 });
  assert(
    !r2.ok && r2.refusal.reason.includes("at the fetched head"),
    `an identity that cannot be computed at the fetched head parks (${JSON.stringify(r2)})`,
  );
  rmSync(real.dir, { recursive: true, force: true });
  rmSync(ledger2, { recursive: true, force: true });
}

// ── a comparison that cannot run still pins, and says so ───────────────────

{
  const c = fakeClone();
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, undefined, evidence(), {
    ledgerFile: ledger,
  });
  assert(
    r.ok && !!r.ok && r.note.includes("did not run"),
    `no branch name: pinned, and the note says the comparison did not run (${JSON.stringify(r)})`,
  );
  assert(!c.calls.some((l) => l.includes("fetch")), "no branch name: nothing fetched");
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // The caller-level switch: a caller with no repository to read a ledger from
  // pins rather than parking on a fault the cycle never had.
  const c = fakeClone({ noRemote: true });
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence(), {
    ledgerFile: ledger,
    skipIdentity: true,
  });
  assert(r.ok && r.headOid === HEAD, `skipIdentity: pinned without the comparison (${JSON.stringify(r)})`);
  assert(
    !c.calls.some((l) => l.includes("remote")),
    "skipIdentity: no remote probe is made",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

{
  // Order matters: a missing head OID is refused before any ledger or fetch, so
  // a cycle with nothing to pin never touches either.
  const c = fakeClone();
  const ledger = ledgerAt(lensRow("feature/x"), c.dir);
  const r = await verifyMergeHead(c.exec, c.dir, "feature/x", evidence({ headOid: undefined }), {
    ledgerFile: ledger,
  });
  assert(!r.ok, "no verified head: refused before the reviewed-head check");
  assert(
    !c.calls.some((l) => l.includes("fetch")) && !c.calls.some((l) => l.includes("--git-common-dir")),
    "no verified head: nothing fetched and no ledger read",
  );
  rmSync(c.dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
