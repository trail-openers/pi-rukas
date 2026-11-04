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
 *   (c3) a green base under a contract it carries -> RED, no baseline verdict
 *   (c4) a base that never carried the contract -> RED (an unjudgeable base excuses
 *       nothing, so the tier's own red stands and the build round is billed)
 *   (d) a base tier that throws -> the probe tree is still removed
 *   (e) a base that cannot be checked out -> THROW, tree gone, no verdict recorded
 *   (f) a green tier -> no re-run and no probe at all (a happy path pays nothing)
 *   (g) the flake never survives into a later round's verdict: a re-verified run
 *       with no flake reports no flake
 *   (h) a tier red once and KILLED on its re-run -> stays RED (an unobserved re-run
 *       is not a pass, so it cannot excuse the tier)
 *   (h2) a tier whose re-run rejected with no code, no kill and no ENOENT -> also RED
 *       ("nobody told us anything" is not "it passed")
 *   (i) the probe's throwaway tree is a SIBLING of the repo, never under it
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
  killOnSecondTier,
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
  // Two reds at HEAD (the first run and its re-run), and the tier is `failTier`, which
  // is red wherever it runs — including the base, where it therefore does NOT look like
  // a pre-existing failure of the base's own: the base passes nothing, but it also is
  // not the run's regressed mainline. What the outcome must be is the ordinary red that
  // routes a build round — a baseline mechanism that swallowed a real failure would be
  // the worse bug.
  const r = await runVerify({
    issue: 302,
    implement: true,
    config: { fast: failTier("real") },
    headTierRedRuns: 2,
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
  // The incident's shape, built out of two real checkouts: the tier asks for a file
  // NEITHER commit holds, so it is red at HEAD and red at the base, and the probe that
  // The incident's shape, made of two real facts: the base commit carries an acceptance
  // test it cannot pass, and the tier is red wherever it runs. The probe therefore has to
  // have stood on the base commit TWICE — once for the contract, once for the tier — to
  // hand the run back, because a probe that secretly ran at HEAD would find the frozen
  // contract GREEN (the run implemented it) and leave the red standing. The run stops
  // here instead of billing a build round whose only outcome is editing code the spec
  // never named.
  const r = await runVerify({
    issue: 303,
    implement: true,
    config: { fast: failTier("preexisting") },
    headTierRedRuns: 2,
    baseRedContract: true,
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

// ---------- (c2) a tier the base PASSES is the run's own failure, not the base's
{
  // The exemption's boundary, and the reason the probe has to run at all: the same tier
  // that is red at HEAD in (c) is GREEN at the base, because the file it asks for is
  // what this run introduced. A base the tier passes has no pre-existing red to blame,
  // so the verdict must stay the ordinary red that bills the build round.
  const r = await runVerify({
    issue: 304,
    implement: true,
    config: { fast: failTier("mine") },
    headTierRedRuns: 2,
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
    "(c2) no baseline verdict where the base passes the tier",
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
    headTierRedRuns: 2,
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
    headTierRedRuns: 2,
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
    headTierRedRuns: 2,
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

// ---------- (c3) a base that is GREEN under the contract cannot excuse a red tier
{
  // The exemption's boundary, stated where the exemption actually lives: the same tier,
  // red at HEAD twice, over a base whose own acceptance tests PASS. There is no red at
  // the base to blame, so the tier stays the ordinary red that bills the build round —
  // and the reason is the tier's own output, which is what a developer can act on.
  const r = await runVerify({
    issue: 311,
    implement: true,
    config: { fast: failTier("mine-too") },
    headTierRedRuns: 2,
    baseRedContract: false,
  });
  assert(
    r.outcome?.kind === "red",
    `(c3) a green base does not excuse the tier (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red"),
    `(c3) no baseline verdict where the base is green (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-mine-too"),
    "(c3) the reason is the tier's own failure, which a build round can act on",
  );
  const left311 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 311);
  assert(left311 === "", `(c3) the probe's throwaway checkout was removed (${left311})`);
}

// --------- (c4) a base that does not carry the contract at all cannot excuse a tier
{
  // The common case the probe must refuse rather than guess: a run's contract is written
  // DURING the run, so the base predates it. A checkout that never held the file cannot
  // be "seen failing" it, and `frozenTestFailure` reads ANY non-zero exit — including a
  // runner that could not even open the file — as the frozen test still failing. Without
  // the probe's carry-check that becomes a red base and excuses the tier over a contract
  // the base never had, deleting the run's only gate. The honest answer is "could not
  // tell", which is not a colour: the tier's own red stands and the build round is billed.
  const r = await runVerify({
    issue: 312,
    implement: true,
    config: { fast: failTier("contract-less-base") },
    headTierRedRuns: 2,
  });
  assert(
    r.outcome?.kind === "red",
    `(c4) a base without the run's contract does not excuse the tier (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red"),
    `(c4) an unjudgeable base produces no baseline verdict (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-contract-less-base"),
    "(c4) the first red is what stands, unchanged",
  );
  const left312 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 312);
  assert(left312 === "", `(c4) the probe's throwaway checkout was removed (${left312})`);
}

// ---- (h) a tier red once whose RE-RUN was killed stays red: an excuse needs a witness
{
  // The shape a hung re-run actually leaves behind: signalled, so `code` is null and no
  // numeric exit exists at all. "No numeric code" is NOT "exited 0", and a gate that
  // read it that way would excuse a tier whose second run nobody saw, then report the
  // whole run green — a pass on work no process ever verified. The first red stands.
  // The tier's own script hangs its SECOND process, so the kill is the executor's real
  // `killGroup` timeout (`killed`, `timedOutKill`, `code: null`) and not a stubbed
  // rejection; `timeoutMs` bounds just that run, so the case waits two seconds.
  const counter = path.join(mkdtempSync(path.join(tmpdir(), "lean-killed-")), "n");
  ROOTS.push(counter);
  const r = await runVerify({
    issue: 309,
    implement: true,
    config: { fast: killOnSecondTier("hung-rerun", counter) },
    headTierRedRuns: 1,
    headRerunKilled: true,
    timeoutMs: 2_000,
  });
  assert(
    r.outcome?.kind !== "green" && r.threw === undefined,
    `(h) a killed re-run does not excuse the tier (outcome ${r.outcome?.kind}, threw ${r.threw?.message})`,
  );
  assert(
    r.outcome?.kind === "red",
    `(h) the first red still stands as the verdict (got ${r.outcome?.kind ?? "threw"})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("flake"),
    `(h) a re-run that observed nothing is never recorded as a flake (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-hung-rerun"),
    "(h) the reason is still the tier's own first red",
  );
  assert(r.outcome?.verifiedHead === undefined, "(h) an excused-nothing run certifies no head");
}

// ---- (h2) a re-run that rejected with NOTHING on it is not a pass either
{
  // The other half of "an excuse needs a witness": a rejection carrying no `code`, no
  // `killed` and no `ENOENT` is a harness speaking, not a gate reporting success. It
  // arrives as an object with no `stdout`, so the only honest reading is that nobody told
  // us anything — and a gate that equated "no exit code" with "exit 0" would call it a
  // flake and certify a tier nobody observed passing.
  const r = await runVerify({
    issue: 313,
    implement: true,
    config: { fast: failTier("silent-reject") },
    headTierRedRuns: 1,
    headRerunSilentReject: true,
  });
  assert(
    r.outcome?.kind === "red" && r.threw === undefined,
    `(h2) a re-run that reported nothing does not excuse the tier (outcome ${r.outcome?.kind}, threw ${r.threw?.message})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("flake"),
    `(h2) a silent rejection is never recorded as a flake (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-silent-reject"),
    "(h2) the tier's own first red is what stands",
  );
}

// -------- (i) the probe's throwaway checkout is a sibling of the repo, never under it
{
  // `verify` sweeps the WHOLE repo with `git status --porcelain --untracked-files=all`
  // before and after its runs, so a throwaway tree checked out under `repoRoot` is
  // itself untracked dirt: the probe would hand the run back for its own checkout, and
  // (worse) a case could pass while the gate corrupted the tree it is judging. The
  // fixture builds `repoRoot` under a fresh temp dir, so "not under repoRoot" is the
  // whole of the invariant this case can state.
  const r = await runVerify({
    issue: 310,
    implement: true,
    config: { fast: failTier("sibling") },
    headTierRedRuns: 2,
  });
  const repoRoot = r.repoRoot ?? r.worktree;
  const dir = baselineProbeWorktreePath(repoRoot, 310);
  assert(
    dir.startsWith(`${repoRoot}/`) === false,
    `(i) the probe tree is a SIBLING of the repo, never inside it (${dir} under ${repoRoot})`,
  );
  assert(
    dir.startsWith(path.dirname(repoRoot)) && dir !== repoRoot,
    `(i) the probe tree sits beside the repo under its parent (${dir})`,
  );
  const left310 = probeTreeLeftBehind(repoRoot, 310);
  assert(left310 === "", `(i) and it is removed afterwards (${left310})`);
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
