#!/usr/bin/env bun
/**
 * lean/verify \342\200\224 the three boundary cases the step's VERDICT-vs-INFRA line rests on.
 *
 * `verify` answers with `green`, `red`, or a THROW, and each case here pins one edge of
 * that line \342\200\224 they were split out of `test-lean-verify.ts`, whose subject is the step
 * as a whole, so the three stay readable next to each other:
 *
 *   - (r) a frozen test whose runner exits non-zero WITHOUT naming the file is a
 *     RED. The file was proven red-and-named at freeze time, so a later non-zero
 *     exit is that failure continuing, not a machine that failed to answer.
 *   - (s) a post-tier HEAD re-check whose `rev-parse` REJECTS is a THROW that
 *     blames the machine. Reporting it as "a verify tier moved HEAD" accuses the
 *     tier for git's silence, exactly as the porcelain re-check does not.
 *   - (t) an injected `readVerifyCmd` that rejects is wrapped the same way the
 *     production reader wraps its own failure \342\200\224 a `VerifyInfraError"'s own words
 *     pass through, anything else is reported as a read that could not answer,
 *     so a test cannot observe a different failure class from the real read.
 */

import { execp } from "../src/exec.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";
import { type VerifyDeps, verifyOutcome } from "../src/lean/verify.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { PASS_TIER, ROOTS, buildFixtureForWiring, runVerify } from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** HEAD of a fixture worktree, read by the real git rather than a stub. */
async function headOf(wt: string): Promise<string> {
  const ran = await execp("git", {
    argv: ["rev-parse", "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: gitTestEnv(),
  });
  return (ran.stdout ?? "").trim();
}
// --------- (r) a frozen test that fails WITHOUT naming itself -> red, not infra
{
  // The file was proven red-and-named at freeze time, so a later non-zero exit
  // that never echoes the path is that same failure continuing — a verdict the
  // developer can act on, not a machine that failed to answer. Reading it as
  // infra handed the run back instead of routing a build round.
  const r = await runVerify({
    issue: 214,
    config: { fast: PASS_TIER },
    silentTestRunner: true,
  });
  assert(
    r.outcome?.kind === "red",
    `(r) a frozen test whose runner is silent is red, not infra (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("tests/AC1-retry.test.sh"),
    `(r) the red still names the frozen file (${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("output did not name it"),
    `(r) the red says the output did not name it (${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(
    /exit 1/.test(r.outcome?.reason ?? ""),
    `(r) the red carries the exit code (${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  assert(r.outcome?.verifiedHead === undefined, "(r) a red records no verified head");
}

// ------------- (s) the post-tier HEAD re-check: a FAILED read is infra, not "moved"
{
  // A `rev-parse` that could not answer is not evidence a tier moved the head:
  // the same distinction the porcelain re-check makes, and blaming the tier for
  // git's silence would hand the run back with a verdict nobody observed.
  //
  // `implement: true` is what makes this case reachable at all: the frozen test
  // is red against the base commit, so without the implementation the step stops
  // at the frozen tests and never gets to the post-tier re-checks.
  const r = await runVerify({
    issue: 215,
    implement: true,
    config: { fast: PASS_TIER },
    // The step reads HEAD twice with byte-identical options (once up front, the
    // ownership probe once too) and the re-check is identifiable only by WHEN it
    // happens: after the tier command has run. Everything before the tier is
    // answered truthfully, so the probe passes; the HEAD read after the tier is
    // the one that goes quiet. Nothing moved — only the read failed — so the step
    // must blame the machine, not accuse the tier of moving HEAD.
    recheckHeadFails: true,
  });
  assert(
    r.threw instanceof VerifyInfraError,
    `(s) a HEAD re-check that could not read throws VerifyInfraError (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    (r.threw?.message ?? "").includes("could not re-check HEAD after the tiers"),
    `(s) the throw names the re-check, not a moved HEAD (got ${r.threw?.message})`,
  );
  assert(
    !(r.threw?.message ?? "").includes("a verify tier moved"),
    `(s) the tier is not accused of moving HEAD (got ${r.threw?.message})`,
  );
  assert(
    (r.threw?.message ?? "").includes("unable to read HEAD"),
    `(s) the throw carries git's own words (got ${r.threw?.message})`,
  );
}

// ------------------- (t) an injected readVerifyCmd rejection is wrapped like the real read
for (const [label, rejection, expect] of [
  [
    "a VerifyInfraError",
    () => {
      throw new VerifyInfraError("the seam said the machine is broken");
    },
    "the seam said the machine is broken",
  ],
  [
    "an ordinary rejection",
    () => {
      throw new Error("seam exploded");
    },
    "could not read .pi/verify-cmd: seam exploded",
  ],
] as const) {
  const f = buildFixtureForWiring(216);
  const deps: VerifyDeps = {
    exec: (cmd, o) => execp(cmd, { ...o, env: gitTestEnv(), cwd: o?.cwd ?? f.wt }),
    loadConfig: async () => ({ verify: { test: "sh {file}", fast: PASS_TIER } }),
    readVerifyCmd: async () => {
      rejection();
      return undefined;
    },
  };
  const thrown: Error | undefined = await verifyOutcome(f.ctx, deps).then(
    () => undefined,
    (err: unknown) => err as Error,
  );
  assert(
    thrown instanceof VerifyInfraError,
    `(t) a rejecting readVerifyCmd (${label}) becomes a VerifyInfraError (got ${thrown?.name}: ${thrown?.message})`,
  );
  assert(
    (thrown?.message ?? "").includes(expect),
    `(t) the ${label} keeps the wording it should (got ${thrown?.message})`,
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
