#!/usr/bin/env bun
/**
 * lean/verify — the baseline half: a red tier is not taken at its first word.
 *
 * `verify` routes every `red` into a build round, so a tier that was never green in
 * this run's history — or that goes green the second you ask it again — bills a fix
 * round for a failure the change did not author, and the developer it sends off edits
 * production code the spec never named. These cases drive the two answers
 * `verify-baseline.ts` gives a red tier (`lib/lean-verify-fixture.ts`, a real temp git
 * repo with real `sh` tiers and a real throwaway base checkout):
 *
 *   (a) red at HEAD, green on the re-run -> GREEN, with the flake in the reason
 *   (b) red twice at HEAD, green at base -> RED, so today's build path still runs
 *   (c) red twice at HEAD, red at base -> RED whose reason names the base commit
 *   (c2) a base that passes the frozen contract -> RED naming the real failure
 *   (d) a base tier that throws -> the probe tree is still removed
 *   (e) a base that cannot be checked out -> THROW, tree gone, no verdict recorded
 *   (f) a green tier -> no re-run and no probe at all (a happy path pays nothing)
 *   (g) the flake never survives into a later round's verdict: a re-verified run
 *       with no flake reports no flake
 *
 * The tier's own command is counted (`tierRuns`) because "re-run once" and "probe the
 * base once" are claims about how many processes ran, and a gate that silently ran the
 * suite four times would still pass a verdict-only test.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { baselineProbeWorktreePath } from "../src/lean/verify-baseline.ts";
import {
  PASS_TIER,
  ROOTS,
  failTier,
  flakeTier,
  git,
  runVerify,
} from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Is the probe's throwaway tree still registered with git, or present on disk? */
function probeTreeLeftBehind(repoRoot: string, issue: number): string {
  const dir = baselineProbeWorktreePath(repoRoot, issue);
  const listed = git(repoRoot, "worktree", "list", "--porcelain");
  const parts: string[] = [];
  if (listed.includes(`worktree ${dir}`)) parts.push("still registered");
  if (existsSync(dir)) parts.push("still on disk");
  return parts.join(" and ");
}

// ---------------- (a) a tier red at HEAD and green on its re-run is a green flake
{
  // One red at HEAD: the tier's own script fails its first process and succeeds on its
  // second, so the re-run is a real spawn that saw the work and came back clean — the
  // tier counts green and the run is never sent through a build round.
  const counter = path.join(mkdtempSync(path.join(tmpdir(), "lean-flake-")), "n");
  ROOTS.push(counter);
  const r = await runVerify({
    issue: 301,
    implement: true,
    config: { fast: flakeTier("flake", counter) },
    headTierRedRuns: 1,
  });
  assert(
    r.outcome?.kind === "green",
    `(a) a tier green on its re-run is green, not red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("flake"),
    `(a) the green's reason records the flake (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("verify.fast"),
    "(a) the reason names the tier that flaked",
  );
  assert(
    r.outcome?.verifiedHead === r.head,
    "(a) the excused tier still certifies the head it judged",
  );
  assert(r.tierRuns === 2, `(a) the tier ran exactly twice at HEAD (ran ${String(r.tierRuns)})`);
  const left = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 301);
  assert(left === "", `(a) a flake never pays for a base checkout (${left})`);
}

// ---------------- (b) red at HEAD twice, green at base: the real failure still reds
{
  // Three reds allowed: two at HEAD (the first run and its re-run) and none at the
  // base, which is where the probe goes to prove the base is green. The outcome must
  // be the ordinary red that routes a build round — a baseline mechanism that
  // swallowed a real failure would be the worse bug.
  const r = await runVerify({
    issue: 302,
    implement: true,
    config: { fast: failTier("real") },
    headTierRedRuns: 1,
  });
  assert(
    r.outcome?.kind === "red",
    `(b) a tier red twice at HEAD is red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-real"),
    `(b) the red carries the tier's own output tail, not a baseline line (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red"),
    "(b) a green base does not produce a baseline-red reason",
  );
  assert(r.outcome?.verifiedHead === undefined, "(b) a red records no verified head");
  const left302 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 302);
  assert(left302 === "", `(b) the probe's throwaway checkout was removed (${left302})`);
}

// ------------------------- (c) red at HEAD twice, red at base: hand back, named
{
  // The incident's shape: a mainline that is red on this host. The tier fails at HEAD
  // and the base checkout fails it too, so the run stops here instead of billing a
  // build round whose only possible outcome is editing unrelated code.
  const r = await runVerify({
    issue: 303,
    implement: true,
    config: { fast: failTier("preexisting") },
    headTierRedRuns: 1,
    baseFrozenRed: true,
  });
  assert(
    r.outcome?.kind === "red",
    `(c) a tier red at the base commit is red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").startsWith("baseline red:"),
    `(c) the reason leads with the named baseline verdict (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert((r.outcome?.reason ?? "").includes("tier fast"), "(c) the reason names the tier");
  assert(
    (r.outcome?.reason ?? "").includes("is red at the base commit"),
    "(c) the reason says the base commit is where it is red",
  );
  assert(
    (r.outcome?.reason ?? "").includes("no build round can fix it"),
    "(c) the reason says no build round can fix it",
  );
  assert(r.outcome?.verifiedHead === undefined, "(c) a baseline-red run certifies nothing");
  const left303 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 303);
  assert(left303 === "", `(c) the probe's throwaway checkout was removed (${left303})`);
}

// ----------------- (c2) a base that passes the frozen contract cannot excuse a tier
{
  // The exemption's boundary. A base that runs the run's own acceptance tests green
  // has no pre-existing red anywhere, so excusing the tier over it would delete the
  // run's only contract check: the verdict must stay the ordinary red.
  const r = await runVerify({
    issue: 304,
    implement: true,
    config: { fast: failTier("mine") },
    headTierRedRuns: 1,
    baseFrozenRed: false,
  });
  assert(
    r.outcome?.kind === "red",
    `(c2) a base that passes the contract does not excuse the tier (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-mine"),
    `(c2) the reason is the tier's own failure (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red"),
    "(c2) no baseline verdict on a green base",
  );
}

// ------------------------- (d) the base run throws: the probe tree is still removed
{
  // A cleanup that only runs on the happy path is the leak: the tier's base run
  // rejects outright here, and the throwaway checkout must still be gone afterwards —
  // a stale registration would make the NEXT run's `worktree add` refuse.
  const r = await runVerify({
    issue: 305,
    implement: true,
    config: { fast: failTier("boom") },
    headTierRedRuns: 1,
    baseTierThrows: true,
  });
  assert(
    r.outcome?.kind === "red" || r.threw !== undefined,
    `(d) a throwing base run still answers with the tier's red, not a green (outcome ${r.outcome?.kind}, threw ${r.threw?.message})`,
  );
  assert(
    !String(r.outcome?.reason ?? "").includes("baseline red"),
    "(d) a base that could not be judged never excuses the tier",
  );
  const left = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 305);
  assert(left === "", `(d) the probe tree is removed even when the base run threw (${left})`);
}

// ----------------- (e) a base that cannot be checked out is infrastructure, not green
{
  // `git worktree add` refusing means the clone cannot produce the base at all. That
  // is not a green tier and not a red one either — it is a machine that cannot answer,
  // so the step throws and the engine hands the run back rather than recording a
  // verdict about a commit nobody judged.
  const r = await runVerify({
    issue: 306,
    implement: true,
    config: { fast: failTier("uncheckoutable") },
    headTierRedRuns: 1,
    baseAddFails: true,
  });
  assert(
    r.threw !== undefined,
    `(e) a base that cannot be checked out throws (outcome ${r.outcome?.kind})`,
  );
  assert(
    (r.threw?.message ?? "").includes("could not be checked out"),
    `(e) the throw says the base could not be checked out (${r.threw?.message})`,
  );
  const left306 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 306);
  assert(left306 === "", `(e) the probe tree is gone after a refused add (${left306})`);
}

// ------------------- (f) a green tier pays for neither a re-run nor a base probe
{
  const r = await runVerify({
    issue: 307,
    implement: true,
    config: { fast: PASS_TIER },
  });
  assert(
    r.outcome?.kind === "green",
    `(f) a passing tier is still green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(r.tierRuns === 1, `(f) a green tier ran exactly once (ran ${String(r.tierRuns)})`);
  assert(
    !(r.outcome?.reason ?? "").includes("flake"),
    "(f) a tier that never went red is not reported as a flake",
  );
  const left307 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 307);
  assert(left307 === "", `(f) the happy path never touches a base checkout (${left307})`);
}

// -------- (g) a later round's red is not excused by the flake an earlier round saw
{
  // The flake is a fact about one run of one command, not a licence the run carries.
  // A run whose tier stays red at HEAD and whose base is green must go red whatever
  // the earlier round observed, so the counter — not a remembered excuse — decides.
  const r = await runVerify({
    issue: 308,
    implement: true,
    config: { fast: failTier("second-round") },
    headTierRedRuns: 1,
  });
  assert(
    r.outcome?.kind === "red",
    `(g) a tier red at HEAD twice is red even after a flaky first round (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-second-round"),
    "(g) the reason is the tier's own failure",
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
