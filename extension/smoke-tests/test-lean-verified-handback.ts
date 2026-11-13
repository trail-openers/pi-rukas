#!/usr/bin/env bun
/**
 * lean: the verified handback (#2242) — which head a handed-back run left on
 * origin, and what the comment says about it.
 *
 * The defect: a `review` step whose fix wave pushed leaves origin holding bytes no
 * `verify` ever certified, because the table routes `review:fixed` into a
 * re-verification a run that ended before it never ran. The rule therefore reads
 * the LOG, not the stop cause — how the run got to `handback` (deadline, step cap,
 * a handler that threw) changes nothing about what origin holds. So these cases
 * construct the log and drive the rule, the rewind and the step directly; driving
 * the engine's deadline or killing a child mid-replay would test the engine's
 * routing, which `test-lean-engine-review-reverify.ts` and the deadline files own.
 *
 *   (a) the rule over a driven log: a `fixed` review newer than the newest decided
 *       green → applies, and ships that green's head;
 *   (b) a `verify` decided AFTER the fix wave → the run's own gate already spoke for
 *       the head, so the rule is silent;
 *   (c) `review:done` → no fix wave, nothing unverified, silent;
 *   (d) no green `verify`: the rule applies and says there is no verified head,
 *       rather than shipping a head it never saw — driven from a log whose newest
 *       work step is a `fixed` review whose own gate never returned a verdict;
 *   (e) the rewind lands: origin's branch moves to the verified head and the head
 *       the run pushed is kept under `refs/lean/unverified/<issue>`;
 *   (f) the lease refuses: somebody else moved origin after lean's head — nothing
 *       moves, and the record says the lease refused;
 *   (g) no verified head to move to: origin is untouched;
 *   (h) the handback step with the rule ON carries the four head fields and the
 *       comment names both heads and their status;
 *   (h2) the same step whose rewind REFUSED: the shipped head is the unverified one
 *       and the comment says `NOT verified` — the case the operator came to read;
 *   (i) the comment body for this log is `===` to the body the PRE-RULE
 *       `handbackOutcome` posted. The comparison is a rollback guarantee only when
 *       the same log reaches the same renderer, so the arm below that actually
 *       turns the rule off is (j);
 *   (j) `PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK=0`: none of the four fields, no rewind
 *       call at all, origin untouched, and the body is the PRE-RULE body — while
 *       the same log with the rule ON produces a body that differs (the falsification
 *       that keeps (i) from being a comparison of a file with itself).
 *
 * The logs are driven by the engine, not typed (lib/lean-verified-handback-fixture).
 * The repo is real and origin is a real bare repo, so "nothing moved" is a fact
 * about the ref origin holds afterwards. The pre-rule body was captured once from a
 * detached worktree of the commit before the rule (`b740d7213d`) by
 * `tmp/t/capture-off-body.ts`, run inside that tree; a body built by this checkout
 * would compare the rule with itself.
 */

import { rmSync } from "node:fs";
import { handbackHeads } from "../src/lean/handback-heads.ts";
import { NO_HEAD, originBranchHead, rewindToVerified, unverifiedRef } from "../src/lean/handback-rewind.ts";
import { handbackOutcome } from "../src/lean/handback.ts";
import type { Rewind } from "../src/lean/handback-rewind.ts";
import {
  BRANCH,
  FAKE_VERIFIED,
  ISSUE,
  ROOTS,
  exec,
  fixedReviewLog,
  handbackCtx,
  reverifiedLog,
  reviewDoneLog,
  unaskedGateReviewLog,
  undecidedFixLog,
  unverifiedFixLog,
} from "./lib/lean-verified-handback-fixture.ts";
import {
  originBranchSha,
  originRefSha,
  repoWithFixHead,
  strangerOnTop,
} from "./lib/lean-verified-handback-repo.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The comment the pre-rule handback posted for this log, captured at b740d7213d. */
const PRE_RULE_BODY = [
  "work-lean: issue #2242 is handed back — this is still needed:",
  "",
  "```text",
  `all frozen tests green at ${"1".repeat(40)}`,
  "```",
  "",
  "Frozen acceptance tests:",
  "- tests/AC1-verified-head.test.sh",
  "",
  "Branch: `lean/issue-2242`",
  "PR: https://github.com/o/r/pull/1",
].join("\n");

/** The rewind seam the handback cases drive: the real rewind over the real origin. */
function rewinder(repoRoot: string): (verifiedHead: string) => Promise<Rewind> {
  return (verifiedHead) =>
    rewindToVerified(
      exec,
      { repoRoot, issue: ISSUE, run: { branch: BRANCH } } as never,
      verifiedHead,
    );
}

/**
 * The read seam the handback step is driven with: the real origin read over the
 * real executor, so the head the comment names is the head origin really holds.
 */
function originReader(repoRoot: string) {
  return (ctx: { repoRoot: string; issue: number; run: { branch: string } }) =>
    originBranchHead(exec, ctx as never);
}

/** Run the handback step, capturing every body its post seam was handed. */
async function driveHandback(
  steps: Awaited<ReturnType<typeof fixedReviewLog>>,
  repoRoot: string,
  rewind: (verifiedHead: string) => Promise<Rewind>,
  readOrigin: (ctx: { repoRoot: string; issue: number; run: { branch: string } }) => Promise<string | undefined> = originReader(repoRoot),
): Promise<{ outcome: Awaited<ReturnType<typeof handbackOutcome>>; posts: string[] }> {
  const posts: string[] = [];
  const outcome = await handbackOutcome(
    handbackCtx(steps, repoRoot),
    async (_repoRoot, _issue, body) => {
      posts.push(body);
    },
    rewind,
    readOrigin,
  );
  return { outcome, posts };
}

// ── (a) a `fixed` review newer than the newest decided green ───────────────
{
  const steps = await fixedReviewLog();
  const heads = handbackHeads(steps);
  assert(heads.applies, "(a) the rule applies to a log whose newest work step is review:fixed");
  assert(
    heads.verifiedHead === FAKE_VERIFIED,
    `(a) the head it ships is the green verify's own head (${String(heads.verifiedHead)})`,
  );
  assert(
    heads.reason === undefined,
    `(a) there is no reason when a verified head exists (${String(heads.reason)})`,
  );
}

// ── (b) a verify decided AFTER the fix wave speaks for the head ─────────────
{
  const steps = await reverifiedLog();
  const heads = handbackHeads(steps);
  assert(
    !heads.applies,
    `(b) a log whose newest work step is a decided verify is not the rule's (${JSON.stringify(heads)})`,
  );
}

// ── (c) review:done left nothing unverified ─────────────────────────────────
{
  const steps = await reviewDoneLog();
  const heads = handbackHeads(steps);
  assert(
    !heads.applies,
    `(c) a clean review (done, no fix wave) does not trigger the rule (${JSON.stringify(heads)})`,
  );
}

// ── (d) no verified head: three different silences, three different answers ─
{
  // (d1) the gate was ENTERED and never answered. The routing green stays — a run
  // reaches a review only through a decided gate — and the re-verification the table
  // routes the `fixed` review into is appended as the engine would have written it,
  // then left undecided: the log of a run stopped inside that second gate visit.
  const steps = await undecidedFixLog();
  const verifies = steps.filter((s) => s.state === "verify");
  assert(verifies.length > 1, `(d1) the log carries more than one gate step (${verifies.length})`);
  assert(
    verifies.slice(1).every((s) => s.outcome === undefined),
    "(d1) and every gate after the routing green decided nothing",
  );
  assert(
    verifies[0]?.outcome?.kind === "green",
    `(d1) the routing green itself did decide (${String(verifies[0]?.outcome?.kind)})`,
  );
  const entered = handbackHeads(steps);
  assert(entered.applies, "(d1) the rule applies to a handback over an unfinished gate");
  assert(
    entered.verifiedHead === undefined,
    `(d1) and names no head it cannot verify (${String(entered.verifiedHead)})`,
  );
  assert(
    (entered.reason ?? "").includes("never recorded what it decided"),
    `(d1) the reason says the gate was entered and unanswered (${String(entered.reason)})`,
  );
  // What the refusal turns on: the unfinished visit is the NEWEST gate step in the
  // log, ahead of the green the rule must not fall back to.
  assert(
    verifies[verifies.length - 1]?.outcome === undefined,
    "(d1) the newest gate step of the log is the unfinished one",
  );
}
{
  // (d2) the gate answered and named no head — a `green` whose verdict is silent
  // about the bytes it looked at. Same refusal, different sentence: the rule read an
  // answer, and the answer was incomplete.
  const steps = await unverifiedFixLog();
  const heads = handbackHeads(steps);
  assert(heads.applies, "(d2) the rule applies to a green that named no head");
  assert(
    heads.verifiedHead === undefined,
    `(d2) and names no head it cannot verify (${String(heads.verifiedHead)})`,
  );
  assert(
    (heads.reason ?? "").includes("recorded no head"),
    `(d2) the reason says the green named no head (${String(heads.reason)})`,
  );
}
{
  // (d3) the gate never ran at all over a `fixed` review: nothing in the log to read.
  const steps = unaskedGateReviewLog();
  assert(
    steps.every((s) => s.state !== "verify"),
    "(d3) the log holds no gate step",
  );
  const heads = handbackHeads(steps);
  assert(heads.applies, "(d3) the rule applies with no green verify at all");
  assert(
    heads.verifiedHead === undefined,
    `(d3) it names no head it cannot verify (${String(heads.verifiedHead)})`,
  );
  assert(
    (heads.reason ?? "").includes("no verify step of this run decided anything"),
    `(d3) the reason says no verify of this run decided anything (${String(heads.reason)})`,
  );
}

// ── (h) the handback step with the rule ON ──────────────────────────────────
{
  // The rewind is driven over a REAL origin, so the green it rewinds to has to be
  // a commit that repo holds: `fixedReviewLog`'s default head is a fake 40-hex for
  // the cases that only read the rule, and a `git push` of an object origin has
  // never seen fails for a reason that has nothing to do with the lease. The base
  // commit is the verified head here, and the fixture made it reachable on origin
  // before the fix head was pushed over it.
  const repo = repoWithFixHead();
  const steps = await fixedReviewLog(repo.baseSha);
  const { outcome, posts } = await driveHandback(steps, repo.repoRoot, rewinder(repo.repoRoot));
  assert(outcome.kind === "done", `(h) the handback still ends done (${outcome.kind})`);
  assert(posts.length === 1, `(h) exactly one comment was posted (${posts.length})`);
  assert(
    outcome.shippedHead === repo.baseSha,
    `(h) shippedHead is the head origin ends at (${String(outcome.shippedHead)})`,
  );
  assert(
    outcome.shippedVerified === true,
    `(h) shippedVerified is true once origin holds the verified head (${String(outcome.shippedVerified)})`,
  );
  assert(
    outcome.unshippedHead === repo.branchHeadSha,
    `(h) unshippedHead is the fix wave's head (${String(outcome.unshippedHead)})`,
  );
  assert(
    outcome.unshippedReason === undefined,
    `(h) a move that landed records no reason it refused (${String(outcome.unshippedReason)})`,
  );
  const body = posts[0] ?? "";
  assert(
    body.includes(`Shipped head: \`${repo.baseSha}\` (verified)`),
    `(h) the comment names the shipped head as verified (${line(body, "Shipped head")})`,
  );
  assert(
    body.includes(`Unshipped head: \`${repo.branchHeadSha}\``),
    `(h) the comment names the head it moved off (${line(body, "Unshipped head")})`,
  );
  assert(
    originBranchSha(repo.origin) === repo.baseSha,
    "(h) origin's branch really moved — the comment is not the only thing that changed",
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === repo.branchHeadSha,
    "(h) and the unverified head is still reachable on origin",
  );
}

// ── (h2) a refused rewind: the shipped head is NOT verified ─────────────────
{
  const repo = repoWithFixHead();
  const steps = await fixedReviewLog(repo.baseSha);
  // Somebody else moved the branch after lean pushed it, so the lease the rewind
  // is bound to no longer matches and origin must not be rewritten.
  const stranger = strangerOnTop(repo, repo.branchHeadSha, "someone else's work");
  if (originBranchSha(repo.origin) !== stranger)
    throw new Error(
      `the stranger push did not land: origin holds ${String(originBranchSha(repo.origin))}, not ${stranger}`,
    );
  // Read AFTER the stranger's push and BEFORE the rewind: the head origin holds is
  // the one at risk, and a case that read it afterwards could not tell a refused
  // move from a silently accepted one.
  const held = originBranchSha(repo.origin);
  if (held !== stranger) throw new Error(`origin does not hold the stranger head: ${String(held)}`);
  const { outcome, posts } = await driveHandback(steps, repo.repoRoot, rewinder(repo.repoRoot));
  assert(
    outcome.kind === "done" && outcome.posted === true,
    `(h2) a refused rewind still posts and still ends the run (${JSON.stringify([outcome.kind, outcome.posted])})`,
  );
  assert(
    outcome.shippedHead === stranger,
    `(h2) the shipped head is what origin really holds (${String(outcome.shippedHead)} vs ${stranger})`,
  );
  assert(
    outcome.shippedVerified === false,
    `(h2) and the record says it is not verified (${String(outcome.shippedVerified)})`,
  );
  assert(
    (outcome.unshippedReason ?? "").includes("the lease refused the rewind"),
    `(h2) with the reason the rewind gave (${String(outcome.unshippedReason)})`,
  );
  const body = posts[0] ?? "";
  assert(
    body.includes(`Shipped head: \`${stranger}\` (NOT verified)`),
    `(h2) the comment prints NOT verified beside the shipped head (${line(body, "Shipped head")})`,
  );
  // The head the run pushed is the one the rewind would have moved off — which on
  // this log it never did, because origin was already holding somebody else's work.
  // The comment therefore has to distinguish the head that IS on the branch (the
  // stranger's, unverified, and named) from the one this run wanted to displace and
  // never got to: the fact the operator needs is that the branch is not this run's.
  assert(
    body.includes("Shipped head:") && !body.includes("Unshipped head:"),
    `(h2) and names no unshipped head this run never moved (${line(body, "Unshipped head")})`,
  );
}

// ── (i) the off-arm body is the PRE-RULE body, byte for byte ────────────────
{
  // The renderer comparison. It belongs to the OFF arm and nowhere else: with the
  // rule on, a log whose newest work step is a `fixed` review has head facts to
  // record whatever its rewind did, and a body that printed none of them would be
  // the pre-rule body — which is the very rollback (V5/AC3) this case proves. The
  // arm that turns the rule off is (j); (i) pins the RENDERER, so it reaches it the
  // only way a no-head log can: the rule fires, it finds no green `verify` and so
  // names no head, the rewind is never asked to move anything, and with no head
  // read there is no head section. The log's green names `FAKE_VERIFIED`, which is
  // what the captured `needed:` line quotes. The same log shape WITH a green gate
  // must NOT print this body — that half is (j)'s control, and without it this
  // equality would be a comparison of a renderer with itself.
  const repo = repoWithFixHead();
  const steps = await unverifiedFixLog();
  const before = originBranchSha(repo.origin);
  let rewindCalls = 0;
  const { outcome, posts } = await driveHandback(
    steps,
    repo.repoRoot,
    async () => {
      rewindCalls++;
      return { shipped: false };
    },
    async () => undefined,
  );
  assert(rewindCalls === 0, `(i) no head to rewind to means the rewind was never called (${rewindCalls})`);
  assert(posts.length === 1, `(i) one comment was posted (${posts.length})`);
  assert(
    posts[0] === PRE_RULE_BODY,
    `(i) the comment is the body the PRE-RULE handback posted for this log, byte for byte (got ${JSON.stringify((posts[0] ?? "").split("\n").slice(-4).join(" / "))})`,
  );
  assert(
    outcome.shippedHead === undefined &&
      outcome.shippedVerified === undefined &&
      outcome.unshippedHead === undefined &&
      outcome.unshippedReason === undefined,
    `(i) a handback that moved nothing and has no unverified head to name carries NONE of the four fields (${JSON.stringify([outcome.shippedHead, outcome.shippedVerified, outcome.unshippedHead, outcome.unshippedReason])})`,
  );
  assert(
    originBranchSha(repo.origin) === before,
    "(i) and origin's branch is where it was",
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    "(i) with no keeping-ref written",
  );
}

// ── (j) the switch OFF: no rewind, no fields, same body ────────────────────
{
  // THREE arms, so each gets its own repo: with one shared origin the control's
  // rewind would move the branch the off arm is meant to leave exactly where it was,
  // and the case would pass on the control's work. The CONTROL's green names its own
  // base commit, because that is the head its rewind has to be able to push.
  // The OFF arm's log is the driven default — green at `FAKE_VERIFIED` — which is
  // the log the pre-rule capture was taken from, and the body it prints is the
  // string the capture recorded. An off arm built from a different head would be
  // compared against a body no run ever posted.
  const control = repoWithFixHead();
  const off = repoWithFixHead();
  const on = await driveHandback(
    await fixedReviewLog(control.baseSha),
    control.repoRoot,
    rewinder(control.repoRoot),
  );
  let rewindCalls = 0;
  const noMove = async (): Promise<Rewind> => {
    rewindCalls++;
    return { shipped: false };
  };
  // The control for (i): the same log shape with the rule on and the real rewind
  // moves origin and prints a head section, so the equality in (i) is not a body
  // the rule would have produced anyway.
  assert(
    on.posts[0] !== PRE_RULE_BODY,
    "(j) control: the same log with the rule ON does NOT print the pre-rule body",
  );
  assert(
    on.outcome.shippedHead === control.baseSha,
    `(j) control: and the rule's rewind really moved origin (${String(on.outcome.shippedHead)})`,
  );
  assert(
    originBranchSha(control.origin) === control.baseSha,
    "(j) control: and origin's branch stands at the verified head",
  );

  const before = originBranchSha(off.origin);
  if (before !== off.branchHeadSha)
    throw new Error(`the off arm's origin does not hold the fix head: ${String(before)}`);

  // Pin the switch for this block alone and put it back exactly as it was: a leak
  // here would silently switch the rule off in every later file of the run.
  const saved = process.env.PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK;
  process.env.PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK = "0";
  let offRun: { outcome: Awaited<ReturnType<typeof handbackOutcome>>; posts: string[] };
  try {
    offRun = await driveHandback(await fixedReviewLog(FAKE_VERIFIED), off.repoRoot, noMove);
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK;
    else process.env.PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK = saved;
  }
  assert(rewindCalls === 0, `(j) with the switch off the rewind was never called (${rewindCalls})`);
  assert(
    originBranchSha(off.origin) === before,
    `(j) origin's branch is untouched by the off arm (${String(originBranchSha(off.origin))} vs ${before})`,
  );
  assert(
    originRefSha(off.origin, unverifiedRef(ISSUE)) === undefined,
    "(j) and no keeping-ref was written",
  );
  assert(
    offRun.posts[0] === PRE_RULE_BODY,
    `(j) the off-arm comment is the PRE-RULE body too, byte for byte (got ${JSON.stringify((offRun.posts[0] ?? "").split("\n").slice(-4).join(" / "))})`,
  );
  assert(
    offRun.outcome.shippedHead === undefined &&
      offRun.outcome.shippedVerified === undefined &&
      offRun.outcome.unshippedHead === undefined &&
      offRun.outcome.unshippedReason === undefined,
    `(j) and its record carries NONE of the four fields (${JSON.stringify([offRun.outcome.shippedHead, offRun.outcome.shippedVerified, offRun.outcome.unshippedHead, offRun.outcome.unshippedReason])})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);

/** One rendered line of the comment, for a failure message that shows the truth. */
function line(body: string, prefix: string): string {
  return body.split("\n").find((l) => l.startsWith(prefix)) ?? `<no ${prefix} line>`;
}

/** What one rewind attempt settled on, spelled out for a failure message. */
function show(r: Rewind): string {
  return `${String(r.shipped)}${r.reason === undefined ? "" : `: ${r.reason}`}`;
}
