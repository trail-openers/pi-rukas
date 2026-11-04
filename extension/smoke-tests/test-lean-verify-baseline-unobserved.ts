#!/usr/bin/env bun
/**
 * lean/verify — a base run that observed nothing has no colour.
 *
 * The sibling of `test-lean-verify-baseline.ts`, split out because these cases all share
 * one subject: a run at the BASE that was killed, timed out, truncated, or whose blob read
 * could not be made. None of them is a colour, and the whole point is that none of them may
 * colour a tier — a base the probe never watched cannot be the green that excuses a red
 * tier nor the red that hands a run back.
 *
 *   (h3)  a base tier run that TIMED OUT -> RED with no `baseline red:`
 *   (h3b) a base tier run that OVERFLOWED its bound -> also RED, no `baseline red:`
 *   (h4)  a base-blob read that failed with a NON-128 code -> RED, no `baseline red:`
 *   (h5)  the classifier's OWN verdict: killed/truncated is `unknown`, while an observed
 *         exit-0 is still green and an observed non-zero-with-output is still red
 *
 * (h5) is asserted on the classifier directly because `verify` reads `unknown` and `green`
 * identically — both leave the tier's red standing — so the distinction those end-to-end
 * cases cannot see has to be judged where it is made. The green/red pair at the end of it
 * is what makes the ORDER load-bearing rather than merely cautious: a "fix" that coloured
 * everything `unknown` would fail there.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execp } from "../src/exec.ts";
import { baselineProbeWorktreePath, classifyBaseRun } from "../src/lean/verify-baseline.ts";
import { ROOTS, failTier, git, runVerify } from "./lib/lean-verify-fixture.ts";

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

// ---- (h3) a base tier run that TIMED OUT does not excuse the tier
{
  // The shape a hung base run really leaves behind: the executor's group kill, so
  // `killed`/`timedOutKill` with `code: null` and no numeric exit at all. Ask the exit
  // code BEFORE asking whether the run observed anything and a kill has "no non-zero
  // exit", which reads as a GREEN base — and on a base that genuinely carries a red gate
  // (here: the base holds the frozen path with other bytes, and the tier is red wherever
  // it runs) that green is what turns a real hand-back into a tier excused for free. A
  // run that judged nothing has no colour: the tier's own red must stand, and the reason
  // must not claim the base is red either.
  const r = await runVerify({
    issue: 314,
    implement: true,
    config: { fast: failTier("base-hung") },
    // The same base as case (c), where a tier the probe SAW red at the base is handed back
    // with a `baseline red:` reason. Here the very same base is presented to the same
    // probe, but the base's tier run was KILLED: it observed nothing. Read that absence as
    // a missing exit code and the probe calls the base green, which is a different verdict
    // about the same commit — and read it as a red it is not, and the run is handed back
    // for a gate nothing watched. The only honest answer is `unknown`, and the proof it was
    // given is that this run keeps the tier's own red rather than (c)'s hand-back.
    headTierRedRuns: 2,
    baseRedContract: true,
    baseRunTimesOut: true,
    // The base holds OTHER bytes at the frozen path, so the probe's contract arm says
    // "this run's contract is not what the mainline carries" and the probe goes on to run
    // the tier at the base — which is the run this case is about. Without a readable blob
    // the probe stops on its contract arm and the classifier is never reached, so the case
    // would pass without ever testing the thing it names.
    baseBlobBytes: "#!/bin/sh\nexit 1\n",
    timeoutMs: 2_000,
  });
  // The probe's tier run at the base hung, so nothing observed the base — but it is not
  // the contract's bytes that decide this case. Had the classifier asked its exit code
  // before asking whether the run observed anything, a killed run (no code at all) would
  // read as "no non-zero exit", i.e. a GREEN base; and because the base really does carry
  // a red contract, green is the one answer that turns this run into a tier excused for
  // nothing. `unknown` is the honest answer, and it changes what the probe says: green
  // means an ordinary red, unknown means the build-retry path this asserts.
  assert(
    r.outcome?.kind === "red" && r.threw === undefined,
    `(h3) a base run that timed out does not excuse the tier (outcome ${r.outcome?.kind}, threw ${r.threw?.message})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red"),
    `(h3) an unobserved base run produces no baseline verdict (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-base-hung"),
    "(h3) the tier's own red at HEAD is what stands",
  );
  // The discriminator, stated as the pair that makes it one: (c) hands THIS base back with
  // a `baseline red:` reason because the probe saw the tier red there; a killed base run
  // must not, because it saw nothing. Green would silently pass (c)'s sibling without a
  // hand-back, and red would hand back for a gate nobody watched — so both directions are
  // asserted, and neither is satisfiable by a stub that answered the probe without running.
  assert(
    !(r.outcome?.reason ?? "").startsWith("baseline red:"),
    `(h3) a killed base run is not read as a red the run must hand back for (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(
    r.outcome?.verifiedHead === undefined,
    "(h3) a run with no base colour certifies nothing",
  );
  const left314 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 314);
  assert(left314 === "", `(h3) the probe's throwaway checkout was removed (${left314})`);
  // The probe must have gone on to RUN its tier at the base rather than settling on the
  // contract arm — the case is about the classifier, and a case that never reached it would
  // pass without testing it. Two tier processes at HEAD plus one at the base.
  // The probe must have gone on to RUN its tier at the base rather than settling on an
  // earlier arm: the case is about the classifier, and a case that never reached it would
  // pass without ever testing it. This is also what makes the pair below a real gate — a
  // classifier that handed the base the wrong colour from a run nobody watched would be
  // read here as a base that simply never ran the tier.
  assert(
    r.baseTierRuns === 1,
    `(h3) the probe reached its tier classifier and ran the tier at the base (base tier ran ${String(r.baseTierRuns)}x, expected 1)`,
  );
}

// ---- (h3b) a base tier run that OVERFLOWED its output bound is no colour either
{
  // The sibling shape, produced by the same real executor rather than a stub: the tier
  // wrote past its `maxBuffer`, so `overflow` is stamped and `timedOutKill` deliberately
  // is not. Truncated output is not evidence of anything, and it is emphatically not a
  // pass — so the tier's own red stands here too, with no baseline verdict on it.
  const r = await runVerify({
    issue: 317,
    implement: true,
    config: { fast: failTier("base-chatty") },
    // As (h3): the same base as (c), with the base's tier run truncated past its output
    // bound instead of hung. Truncated output holds no evidence, so it is no more a colour
    // than a kill is — and the same two wrong answers are available: green (no hand-back,
    // a silent change of verdict about the same commit) or red (a hand-back for a gate
    // nobody read). `overflow` is stamped and `timedOutKill` deliberately is not, so this
    // exercises the classifier's second no-colour family rather than its first.
    headTierRedRuns: 2,
    baseRedContract: true,
    baseRunOverflows: true,
    baseBlobBytes: "#!/bin/sh\nexit 1\n",
    timeoutMs: 2_000,
  });
  assert(
    r.outcome?.kind === "red" && r.threw === undefined,
    `(h3b) a base run that overflowed does not excuse the tier (outcome ${r.outcome?.kind}, threw ${r.threw?.message})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red"),
    `(h3b) a truncated base run produces no baseline verdict (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-base-chatty"),
    "(h3b) the tier's own red at HEAD is what stands",
  );
  assert(
    !(r.outcome?.reason ?? "").startsWith("baseline red:"),
    `(h3b) a truncated base run is not read as a red the run must hand back for (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  const left317 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 317);
  assert(left317 === "", `(h3b) the probe's throwaway checkout was removed (${left317})`);
  assert(
    r.baseTierRuns === 1,
    `(h3b) the probe reached its tier classifier and ran the tier at the base (base tier ran ${String(r.baseTierRuns)}x, expected 1)`,
  );
}

// ---- (h4) a base-blob read that failed for a reason other than "no such path"
{
  // The probe reads the base's bytes at the frozen paths with `git show`. A rejection
  // that is not git's own exit-128 "does not exist" is the EXECUTOR speaking (a timeout,
  // an overflow), and "I could not look" is neither "it was not there" nor a colour: the
  // `unreadable` arm must not excuse the tier. Mistaken for a base that carries the
  // contract and fails it, this becomes a hand-back for a gate the probe never read.
  const r = await runVerify({
    issue: 315,
    implement: true,
    config: { fast: failTier("blob-unreadable") },
    headTierRedRuns: 2,
    baseBlobReadFails: true,
  });
  assert(
    r.outcome?.kind === "red" && r.threw === undefined,
    `(h4) an unreadable base blob does not excuse the tier (outcome ${r.outcome?.kind}, threw ${r.threw?.message})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red"),
    `(h4) a failed base read produces no baseline verdict (${(r.outcome?.reason ?? "").slice(0, 200)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tier-said-blob-unreadable"),
    "(h4) the tier's own red at HEAD is what stands",
  );
  const left315 = probeTreeLeftBehind(r.repoRoot ?? r.worktree, 315);
  assert(left315 === "", `(h4) the probe's throwaway checkout was removed (${left315})`);
}

// ---- (h5) the base classifier itself: a run that observed nothing has no colour
{
  // The cases above can only show what the RUN makes of the probe's answer, and `verify`
  // reads "could not tell" and "the base passes" the same way — both leave the tier's red
  // standing. So the distinction those cases cannot see is judged where it is made: on the
  // classifier's own verdict, for the two shapes the executor really produces. A killed or
  // truncated base run is not a colour: `green` is a claim about a commit that a run which
  // watched nothing cannot make, and it is exactly the claim an exit-code test asked before
  // the observation test hands out for free.
  //
  // The pair at the end is what makes the ORDER load-bearing rather than merely cautious:
  // asking observation first must still colour an observed exit-0 green and an observed
  // non-zero-with-output red, so a "fix" that coloured everything `unknown` fails here too.
  const killed = await execp("sh -c 'exec sleep 60'", {
    killGroup: true,
    timeout: 1_500,
    maxBuffer: 16 * 1024 * 1024,
    cwd: tmpdir(),
    env: process.env,
  }).catch((err: unknown) => err);
  assert(
    (killed as { code?: unknown })?.code === null &&
      (killed as { killed?: unknown })?.killed === true,
    `(h5) the hung run is the executor's own kill shape, not a stub (code ${String((killed as { code?: unknown })?.code)})`,
  );
  const killedVerdict = classifyBaseRun(killed, true);
  assert(
    killedVerdict.status === "unknown",
    `(h5) a killed base run is not a colour (got ${JSON.stringify(killedVerdict)})`,
  );
  assert(
    (killedVerdict as { reason?: string }).reason?.includes("killed, timed out") === true,
    `(h5) the killed base run says why it has no colour (${(killedVerdict as { reason?: string }).reason})`,
  );

  const truncated = await execp("sh -c 'yes x'", {
    killGroup: true,
    timeout: 20_000,
    maxBuffer: 8 * 1024,
    cwd: tmpdir(),
    env: process.env,
  }).catch((err: unknown) => err);
  assert(
    (truncated as { overflow?: unknown })?.overflow !== undefined,
    `(h5) the chatty run is the executor's own overflow shape (overflow ${String((truncated as { overflow?: unknown })?.overflow)})`,
  );
  const truncatedVerdict = classifyBaseRun(truncated, true);
  assert(
    truncatedVerdict.status === "unknown",
    `(h5) a truncated base run is not a colour (got ${JSON.stringify(truncatedVerdict)})`,
  );

  const greenVerdict = classifyBaseRun({ stdout: "ok", stderr: "" }, true);
  assert(
    greenVerdict.status === "green",
    `(h5) an observed run that exited 0 is still green (got ${JSON.stringify(greenVerdict)})`,
  );
  const redVerdict = classifyBaseRun(
    Object.assign(new Error("failed"), { code: 1, stdout: "", stderr: "suite failed\n" }),
    true,
  );
  assert(
    redVerdict.status === "red",
    `(h5) an observed non-zero run with output is still red (got ${JSON.stringify(redVerdict)})`,
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
