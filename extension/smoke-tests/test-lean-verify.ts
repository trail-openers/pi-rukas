#!/usr/bin/env bun
/**
 * lean/verify + lean/handback — the run's own gate, and the report it leaves.
 *
 * Every case runs against a real temp git repo whose HEAD holds the frozen
 * acceptance test (lib/lean-verify-fixture.ts), with real `git` probes and real
 * `sh` processes for the frozen test runs and the tiers. Only the project's
 * CONFIG is injected, because a case that wants a tier to exit 1 must not have
 * to rewrite a commit the frozen records were hashed at to ask for one.
 *
 *   (a) the frozen test passes and the tier passes -> green, verifiedHead = HEAD
 *   (b) a frozen test exits non-zero               -> red, naming the file
 *   (c) a frozen file altered on disk              -> red
 *   (d) a frozen blob altered at HEAD              -> red
 *   (e) verify.fast exits 1                        -> red, with the output tail
 *   (f) a tier that hangs                          -> THROW (a timeout is not a red)
 *   (g) a dirty worktree                           -> THROW
 *   (h) nothing configured                         -> the frozen tests decide, and
 *                                                     the reason says there was no command
 *
 * And for handback: one comment built from the record (i-m), carrying the red
 * reason, the frozen tests and the PR URL (or "no PR yet") — and a forge that
 * refuses the post still ends the run `done` (j), because the run was already
 * over and a lost comment is not a reason to change the verdict.
 *
 * The tiers run as shell commands in the worktree AFTER the tree was read clean,
 * so (n-q) re-check the frozen files, the tree and HEAD once they have run: a
 * tier that rewrites the contract is a red, and one that dirties the tree or
 * moves HEAD is infrastructure — never a verdict nobody observed.
 */

import { handbackOutcome } from "../src/lean/handback.ts";
import {
  GREEN_TEST,
  HANG_TIER,
  PASS_TIER,
  ROOTS,
  decided,
  failTier,
  handbackCtx,
  redLog,
  runVerify,
  writeTier,
} from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------- (a) frozen test passes, tier passes -> green
{
  // `implement` commits the code the frozen test was red against, so the gate's
  // whole contract is satisfied and it records the head it judged.
  const r = await runVerify({ issue: 201, implement: true, config: { fast: PASS_TIER } });
  assert(
    r.outcome?.kind === "green",
    `(a) a passing contract and a passing tier are green (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(
    r.outcome?.verifiedHead === r.head,
    `(a) verifiedHead is the HEAD the step judged (${r.outcome?.verifiedHead} vs ${r.head})`,
  );
  assert(/^[0-9a-f]{40}$/.test(r.outcome?.verifiedHead ?? ""), "(a) verifiedHead is a 40-hex sha");
  assert(
    (r.outcome?.reason ?? "").includes(String(r.head)),
    "(a) the green reason names the commit it judged",
  );
}

// ---------------------------------------------- (b) a frozen test fails -> red
{
  const r = await runVerify({ issue: 202, config: { fast: PASS_TIER } });
  assert(r.outcome?.kind === "red", `(b) a failing frozen test is red (got ${r.outcome?.kind})`);
  assert(
    (r.outcome?.reason ?? "").includes("tests/AC1-retry.test.sh"),
    `(b) the red reason names the file (${(r.outcome?.reason ?? "").slice(0, 120)})`,
  );
  assert(r.outcome?.verifiedHead === undefined, "(b) a red records no verified head");
}

// ------------------------------------ (c) a frozen file altered on disk -> red
{
  // Both tamper cases assert the SAME reason wording, deliberately: an edited
  // file and a rewritten blob are one fault to the developer — "the file you are
  // about to test is not the file we froze" — and a case that accepted a vague
  // 'tree is dirty' would let the step stop distinguishing the contract from any
  // other stray edit.
  const r = await runVerify({
    issue: 203,
    implement: true,
    editDisk: GREEN_TEST,
    config: { fast: PASS_TIER },
  });
  assert(
    r.outcome?.kind === "red",
    `(c) a frozen file edited on disk is red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("frozen files not as frozen"),
    `(c) the reason says the frozen file is not as frozen (${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert((r.outcome?.reason ?? "").includes("AC1-retry.test.sh"), "(c) the reason names the file");
}

// ------------------------------------- (d) a frozen blob altered at HEAD -> red
{
  // The committed rewrite makes HEAD's blob hash differently from the frozen
  // record while the working tree stays clean — the case that proves the step
  // asks git about the commit and not about the filesystem.
  const r = await runVerify({
    issue: 204,
    implement: true,
    editAtHead: GREEN_TEST,
    config: { fast: PASS_TIER },
  });
  assert(
    r.outcome?.kind === "red",
    `(d) a frozen blob rewritten at HEAD is red (got ${r.outcome?.kind})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("frozen tests altered"),
    `(d) the reason says the frozen tests were altered (${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
}

// ------------------------------------- (e) verify.fast exits 1 -> red with tail
{
  const r = await runVerify({
    issue: 205,
    implement: true,
    config: { fast: failTier("boom") },
  });
  assert(r.outcome?.kind === "red", `(e) a failing tier is red (got ${r.outcome?.kind})`);
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-boom"),
    `(e) the red reason carries the output tail (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert((r.outcome?.reason ?? "").includes("verify.fast"), "(e) the reason names the tier");
}

// -------------------------------------------- (f) a tier that hangs -> THROW
{
  const started = Date.now();
  const r = await runVerify({
    issue: 206,
    implement: true,
    config: { fast: HANG_TIER },
    timeoutMs: 500,
  });
  const ms = Date.now() - started;
  assert(
    r.threw !== undefined,
    `(f) a hung tier throws rather than reporting a verdict (got ${r.outcome?.kind})`,
  );
  assert(
    (r.threw?.message ?? "").toLowerCase().includes("timed out"),
    `(f) the throw says it timed out (${r.threw?.message})`,
  );
  assert(ms < 20_000, `(f) the bound actually fired (${ms}ms)`);
}

// ------------------------------------------------ (g) a dirty tree -> THROW
{
  const r = await runVerify({ issue: 207, dirty: true, config: { fast: PASS_TIER } });
  assert(r.threw !== undefined, `(g) a dirty worktree throws (got ${r.outcome?.kind})`);
  assert(
    (r.threw?.message ?? "").includes("not clean"),
    `(g) the throw says the tree is not clean (${r.threw?.message})`,
  );
}

// ------------------------------ (h) no verify command -> frozen tests decide
{
  const red = await runVerify({ issue: 208, noCommand: true });
  assert(
    red.outcome?.kind === "red",
    `(h) with no project command the frozen tests still decide (got ${red.outcome?.kind ?? red.threw?.message})`,
  );
  const green = await runVerify({ issue: 209, noCommand: true, implement: true });
  assert(
    green.outcome?.kind === "green",
    `(h) and a passing contract is green with no command at all (got ${green.outcome?.kind ?? green.threw?.message})`,
  );
  assert(
    (green.outcome?.reason ?? "").includes("no project verify command"),
    `(h) the green reason says there was no project command (${(green.outcome?.reason ?? "").slice(0, 160)})`,
  );
}

// --------------------------------------- (i) handback posts one needed-comment
{
  const posts: Array<{ repoRoot: string; issue: number; body: string }> = [];
  const ctx = handbackCtx(7, redLog("https://example.test/pr/7"), "/tmp/lean-repo-7");
  const outcome = await handbackOutcome(ctx, async (repoRoot, issue, body) => {
    posts.push({ repoRoot, issue, body });
  });
  assert(outcome.kind === "done", `(i) handback returns done (got ${outcome.kind})`);
  assert(posts.length === 1, `(i) exactly one comment was posted (got ${posts.length})`);
  const body = posts[0]?.body ?? "";
  assert(body.includes("frozen tests failing"), "(i) the comment carries the red verify reason");
  assert(body.includes("tests/AC1-retry.test.sh"), "(i) the comment lists the frozen test");
  assert(body.includes("https://example.test/pr/7"), "(i) the comment carries the PR URL");
  assert(body.includes("lean/issue-7"), "(i) the comment names the branch");
  assert(posts[0]?.repoRoot === "/tmp/lean-repo-7", "(i) the post targeted the run's repo");
  assert(posts[0]?.issue === 7, "(i) the comment went on the run's issue");
}

// -------------------------------- (j) a failed post still ends the run 'done'
{
  let posted = 0;
  const ctx = handbackCtx(8, redLog());
  const outcome = await handbackOutcome(ctx, async () => {
    posted++;
    throw new Error("no forge adapter");
  });
  assert(outcome.kind === "done", `(j) a failed post still ends done (got ${outcome.kind})`);
  assert(posted === 1, "(j) the post was attempted once");
  assert(
    (outcome.reason ?? "").includes("NOT posted") &&
      (outcome.reason ?? "").includes("no forge adapter"),
    `(j) the reason says the comment never went out (${outcome.reason})`,
  );
}

// ------------------------------- (k) handback without a PR says "no PR yet"
{
  const posts: string[] = [];
  const ctx = handbackCtx(9, redLog());
  await handbackOutcome(ctx, async (_r, _i, body) => {
    posts.push(body);
  });
  assert(
    (posts[0] ?? "").includes("no PR yet"),
    `(k) a pre-publish handback says there is no PR (${(posts[0] ?? "").slice(-40)})`,
  );
}

// --------------------- (l) the gate's own red outranks a later round's ci red
{
  const posts: string[] = [];
  const steps = [
    ...redLog(),
    decided("verify", { kind: "green", reason: "passed", verifiedHead: "b".repeat(40) }, 1),
    decided("ci", { kind: "red", reason: "the full suite failed on the runner" }, 0),
  ];
  const ctx = handbackCtx(10, steps);
  await handbackOutcome(ctx, async (_r, _i, body) => {
    posts.push(body);
  });
  assert(
    (posts[0] ?? "").includes("frozen tests failing"),
    "(l) the gate's own red is the answer a developer can act on",
  );
  const ciOnly: string[] = [];
  const steps2 = redLog().filter((s) => s.state !== "verify" || s.outcome?.kind !== "red");
  const ctx2 = handbackCtx(12, [
    ...steps2,
    decided("ci", { kind: "red", reason: "the full suite failed on the runner" }),
  ]);
  await handbackOutcome(ctx2, async (_r, _i, body) => {
    ciOnly.push(body);
  });
  assert(
    (ciOnly[0] ?? "").includes("the full suite failed on the runner"),
    "(l) with no red gate, the red ci is what gets reported",
  );
}

// ------------------------ (m) no red verdict: the newest error step is the cause
{
  // The cause comes from the log, not from `run.result`: the engine stamps the
  // step itself with `{kind: "error", message}` and only afterwards writes a
  // summary into the run, so the step is the closer account of what broke.
  const posts: string[] = [];
  const ctx = handbackCtx(11, [
    decided("ready", { kind: "ok" }),
    decided("build", { kind: "error", message: "the child died" }),
  ]);
  ctx.run = { ...ctx.run, result: { code: 10, reason: "a stale summary" } };
  await handbackOutcome(ctx, async (_r, _i, body) => {
    posts.push(body);
  });
  assert(
    (posts[0] ?? "").includes("the child died"),
    `(m) with no red verdict the newest error step is reported (${(posts[0] ?? "").slice(0, 120)})`,
  );
  assert(
    !(posts[0] ?? "").includes("a stale summary"),
    "(m) the run's summary does not override what the step said",
  );
}

// ----------------- (n) a tier that rewrites the frozen test after the tiers -> red
{
  // The tiers run as shell commands IN the worktree, so a tier is exactly as
  // able to tamper with the contract as the developer was. The pre-tier checks
  // all pass here; only the re-check after them can see this.
  const r = await runVerify({
    issue: 210,
    implement: true,
    config: { fast: PASS_TIER },
    full: writeTier("tests/AC1-retry.test.sh", "#!/bin/sh\nexit 0\n# rewritten\n"),
  });
  assert(
    r.outcome?.kind === "red",
    `(n) a tier that rewrites the frozen test is red, not green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("a verify tier altered frozen tests"),
    `(n) the reason says the TIER did it (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(r.outcome?.verifiedHead === undefined, "(n) a red records no verified head");
}

// ------------------- (o) a tier that dirties the tree -> THROW, never a verdict
{
  // Uncommitted bytes are not a verdict about any commit, and they are not the
  // developer's code failing either: the tier broke the invariant, so the run
  // is handed back rather than sent through a build round.
  const r = await runVerify({
    issue: 211,
    implement: true,
    config: { fast: PASS_TIER },
    full: writeTier("stray-from-tier.txt", "dirt\n"),
  });
  assert(
    r.threw !== undefined,
    `(o) a tier that leaves the tree dirty throws (got ${r.outcome?.kind})`,
  );
  assert(
    (r.threw?.message ?? "").includes("left the worktree dirty"),
    `(o) the throw names the tier as the author (${r.threw?.message})`,
  );
}

// ------------------------- (p) a tier that commits -> THROW (HEAD moved)
{
  // The green this step records is a claim about `head`; a tier that committed
  // has made the tree something the frozen tests were never run against.
  const r = await runVerify({
    issue: 212,
    implement: true,
    config: { fast: PASS_TIER },
    full: writeTier("tier-file.txt", "committed by a tier\n", true),
  });
  assert(r.threw !== undefined, `(p) a tier that commits throws (got ${r.outcome?.kind})`);
  assert(
    (r.threw?.message ?? "").includes("moved HEAD"),
    `(p) the throw says HEAD moved (${r.threw?.message})`,
  );
}

// --------------- (q) the re-check does not disturb a run that really is green
{
  const r = await runVerify({
    issue: 213,
    implement: true,
    config: { fast: PASS_TIER, full: PASS_TIER },
  });
  assert(
    r.outcome?.kind === "green",
    `(q) passing tiers still green after the re-check (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(
    r.outcome?.verifiedHead === r.head && /^[0-9a-f]{40}$/.test(r.outcome?.verifiedHead ?? ""),
    `(q) the green still carries verifiedHead === HEAD (${r.outcome?.verifiedHead} vs ${r.head})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
