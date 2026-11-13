#!/usr/bin/env bun
/**
 * lean: what a verified-handback handback SAYS and RECORDS (#2242) — the reporting
 * step's two surfaces, driven over a real origin.
 *
 * `test-lean-verified-handback.ts` pins the RULE (what `handbackHeads` reads out of
 * the log) and `test-lean-verified-handback-rewind.ts` pins the WIRE (what a `git
 * push` leaves origin holding). This file is the seam between them: the step that
 * takes the rule's answer, drives the rewind, and then has to make one fact out of
 * it — the four typed fields on the record and the comment that quotes them. A
 * mismatch between the two is the failure the whole feature exists to prevent: an
 * operator reading "NOT verified" beside bytes the gate certified, or a record
 * naming an unshipped head this step never displaced.
 *
 *   (h)  the step with the rule ON carries the four head fields, the comment names
 *        both heads and their status, and origin really moved;
 *   (h2) the step whose rewind was REFUSED: the shipped head is the unverified one,
 *        the comment says `NOT verified`, and the reason names origin's head with
 *        git's own explanation — the case the operator came to read;
 *   (h3) origin ALREADY held the certified head: this step pushed nothing, the
 *        record still calls the shipped head verified, and no unshipped head is
 *        named — the two halves of the record saying one thing;
 *   (i)  the comment body for a no-head log is `===` to the body the PRE-RULE
 *        `handbackOutcome` posted. That equality is a rollback guarantee only if the
 *        same log reaches the same renderer, so the arm that really turns the rule
 *        off is (j);
 *   (j)  `PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK=0`: none of the four fields, no rewind
 *        call at all, origin untouched, and the body is the PRE-RULE body — while the
 *        same log with the rule ON produces a body that DIFFERS (the falsification
 *        that keeps (i) from being a renderer compared with itself).
 *
 * The logs are driven by the engine, not typed (lib/lean-verified-handback-fixture).
 * The repo is real and origin is a real bare repo, so "nothing moved" is a fact about
 * the ref origin holds afterwards. The pre-rule body was captured once from a detached
 * worktree of the commit before the rule (`b740d7213d`) by `tmp/t/capture-off-body.ts`,
 * run inside that tree; a body built by this checkout would compare the rule with
 * itself.
 */

import { rmSync } from "node:fs";
import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import type { Rewind } from "../src/lean/handback-rewind.ts";
import { ISSUE, alreadyAtVerifiedLog } from "./lib/lean-verified-handback-fixture.ts";
import {
  FAKE_VERIFIED,
  ROOTS,
  fixedReviewLog,
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
import { bodyLine, driveHandback, rewinder } from "./lib/lean-verified-handback-step.ts";

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
    `(h) the comment names the shipped head as verified (${bodyLine(body, "Shipped head")})`,
  );
  assert(
    body.includes(`Unshipped head: \`${repo.branchHeadSha}\``),
    `(h) the comment names the head it moved off (${bodyLine(body, "Unshipped head")})`,
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
  // No fetch here, deliberately. `--force-with-lease` is enforced by the CLIENT
  // against this clone's remote-tracking ref (measured on git 2.53: a lease bound to
  // a sha that ref does not name is accepted), so the one command that would make the
  // stranger's objects local — a fetch — is also the command that would refresh the
  // ref and let the rewind rewrite the stranger's work. Leaving the clone untaught is
  // what keeps this a refusal, and git's reason for it is the stranger's own head:
  // `bad object`, because the clone cannot supply the objects the refspecs name.
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
  // The record must not dress this up as a lease it never evaluated, and must not
  // leave the operator without the head that is actually sitting on the branch: git's
  // own reason, beside origin's value, is what makes the line checkable. The
  // `stale info` word itself belongs to a lease the client could evaluate at all, and
  // `test-lean-verified-handback-rewind.ts` (f) pins the distinction from the other
  // side — an outside stranger that stays un-fetched is the refusal, and a lease the
  // clone can satisfy must LAND with the displaced head kept, never lost.
  assert(
    (outcome.unshippedReason ?? "").includes("the rewind push failed"),
    `(h2) with the reason the rewind gave (${String(outcome.unshippedReason)})`,
  );
  assert(
    (outcome.unshippedReason ?? "").includes(stranger.slice(0, 12)),
    `(h2) and it names the head origin really holds (${String(outcome.unshippedReason)})`,
  );
  const body = posts[0] ?? "";
  assert(
    body.includes(`Shipped head: \`${stranger}\` (NOT verified)`),
    `(h2) the comment prints NOT verified beside the shipped head (${bodyLine(body, "Shipped head")})`,
  );
  // The head the run pushed is the one the rewind would have moved off — which on
  // this log it never did, because origin was already holding somebody else's work.
  // The comment therefore has to distinguish the head that IS on the branch (the
  // stranger's, unverified, and named) from the one this run wanted to displace and
  // never got to: the fact the operator needs is that the branch is not this run's.
  assert(
    body.includes("Shipped head:") && !body.includes("Unshipped head:"),
    `(h2) and names no unshipped head this run never moved (${bodyLine(body, "Unshipped head")})`,
  );
}

// ── (h3) origin already holds the verified head: certified, and unmoved ─────
{
  // The arm a scripted queue cannot hand over, because it is a fact about the REPO:
  // origin's branch already points at the head the gate certified, so the rewind
  // pushes nothing. The record then has to say two things at once — this step moved
  // nothing, and the head it ships IS the verified one. A record that printed
  // `shippedVerified: false` here would tell the operator to go inspect bytes the gate
  // passed, and a record that also named an `Unshipped head` would name one this step
  // never displaced: the two halves disagreeing, which is what the head fields exist
  // to prevent. Reachable on a resumed run whose first rewind landed and died before
  // its read-back, and the step replays.
  const repo = repoWithFixHead();
  const steps = await alreadyAtVerifiedLog(repo.branchHeadSha);
  const before = originBranchSha(repo.origin);
  if (before !== repo.branchHeadSha)
    throw new Error(`the case's origin does not hold the certified head: ${String(before)}`);
  const { outcome, posts } = await driveHandback(steps, repo.repoRoot, rewinder(repo.repoRoot));
  assert(
    outcome.kind === "done" && outcome.posted === true,
    `(h3) the handback still posts and ends the run (${JSON.stringify([outcome.kind, outcome.posted])})`,
  );
  assert(
    outcome.shippedHead === repo.branchHeadSha,
    `(h3) the shipped head is the certified one origin holds (${String(outcome.shippedHead)})`,
  );
  assert(
    outcome.shippedVerified === true,
    `(h3) and the record calls it verified (${String(outcome.shippedVerified)})`,
  );
  assert(
    outcome.unshippedHead === undefined,
    `(h3) with no unshipped head — nothing was displaced (${String(outcome.unshippedHead)})`,
  );
  const body = posts[0] ?? "";
  assert(
    body.includes(`Shipped head: \`${repo.branchHeadSha}\` (verified)`),
    `(h3) the comment prints the shipped head as verified (${bodyLine(body, "Shipped head")})`,
  );
  assert(
    !body.includes("Unshipped head:"),
    `(h3) and names no head this step moved off (${bodyLine(body, "Unshipped head")})`,
  );
  assert(
    originBranchSha(repo.origin) === before,
    "(h3) and origin's branch is exactly where it was — this step pushed nothing",
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    "(h3) with no keeping-ref written for a branch that never moved",
  );
}

// ── (h4) the rule spoke, named a head, and origin read as holding nothing ───
{
  // The `speaks`-only shape, which no other case drives through the STEP. The rule
  // fired and named the green's head, so the rewind was asked and declined to move
  // anything; origin's read then answers nothing (a transport that died, a branch that
  // is simply gone), so there is no head to print as shipped. What must not happen is
  // a half-section: a `Shipped head` line naming bytes this step could not read, an
  // `Unshipped head` naming one it never displaced, or the rule's own no-head prose
  // printed where a head belongs. The renderer's `lines.length === 0` arm is what the
  // operator actually sees here, and nothing else in the suite reaches it.
  const repo = repoWithFixHead();
  // The green names the base commit, the head this fixture's clone really holds: a
  // rewind asked for a head it cannot supply dies on objects, and the case is about
  // the renderer, not about git's transport.
  const steps = unaskedGateReviewLog({ green: { kind: "green", verifiedHead: repo.baseSha } });
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
  assert(rewindCalls === 1, `(h4) the rule named a head, so the rewind WAS asked (${rewindCalls})`);
  const body = posts[0] ?? "";
  assert(
    outcome.shippedHead === undefined &&
      outcome.shippedVerified === undefined &&
      outcome.unshippedHead === undefined &&
      outcome.unshippedReason === undefined,
    `(h4) with no head read, NONE of the four fields is recorded — not a false ${JSON.stringify([outcome.shippedHead, outcome.shippedVerified, outcome.unshippedHead, outcome.unshippedReason])})`,
  );
  assert(
    !body.includes("Shipped head:") && !body.includes("Unshipped head:"),
    `(h4) the comment prints NO head section at all, not a half one (${JSON.stringify(body.split("\n").slice(4, 8))})`,
  );
  assert(
    !body.includes("undefined") && !body.includes("not shipped"),
    `(h4) and no placeholder leaked into the body (${JSON.stringify(body.split("\n").slice(4, 8))})`,
  );
  assert(originBranchSha(repo.origin) === before, "(h4) origin's branch is exactly where it was");
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    "(h4) with no keeping-ref written",
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
  assert(
    rewindCalls === 0,
    `(i) no head to rewind to means the rewind was never called (${rewindCalls})`,
  );
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
  assert(originBranchSha(repo.origin) === before, "(i) and origin's branch is where it was");
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
  let offRun: { outcome: Awaited<ReturnType<typeof driveHandback>>["outcome"]; posts: string[] };
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
