#!/usr/bin/env bun
/**
 * #2212 / R1 — the reset `challenge` runs issues no submodule call with the switch at `0`.
 *
 * `challenge` is one of the three callers outside `specify` that reach
 * `resetWorktreeToBase` (its siblings here are `build`'s fold and the review fix
 * round, each with this same file). R1 moved the submodule initialisation inside
 * the switch at the primitive, so the guarantee is made once — but "once, at the
 * primitive" is worth nothing if a caller stopped going through it, and a
 * per-caller gate (the shape #2212 replaces) would look identical from here if one
 * were moved back out. So each file drives its own real step over a base whose
 * submodule source is GONE and reads the git argv the step itself issued.
 *
 *   (a) with the switch at `0`: the round runs, no submodule call appears in the
 *       argv the step issued, and the submodule the reset's `clean -fdx` emptied
 *       stays EMPTY after the step returned;
 *   (b) the control, outside the `withEnv`: the same round issues the call, and the
 *       submodule is POPULATED after it — the fetch is what made the difference.
 *
 * Without (b)'s second half, (a) would be consistent with a fixture that merely
 * never populated anything, and the argv assertion alone would be the only thing
 * separating the arms. Both arms run the identical round — a child that writes the
 * red test the pipeline freezes, so the reset is the pipeline's own step-3
 * `prepare`, the reset a real committed round makes.
 *
 * Real temp repos, real git, the real `execp`; only the model is stubbed.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import {
  INSIDE,
  attachSubmodule,
  makeSubmoduleUnfetchable,
  remoteRepo,
  submoduleCalls,
} from "./lib/lean-submodule-off-fixture.ts";
import {
  type ChallengeBuilt,
  challengeFixture,
  put,
  redEdge,
  runChallenge,
  submit,
} from "./lib/lean-challenge-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const TEST_REL = "tests/AC1-submodule.test.sh";

/** One challenge round over a base that carries a submodule with no source left. */
async function drive(issue: number): Promise<{
  threw?: Error;
  outcome?: { kind?: string };
  submoduleArgv: readonly (readonly string[])[];
  /** Whether the submodule's file exists in the run's tree AFTER the step returned. */
  insideAfter: boolean;
}> {
  const built = challengeFixture(issue) as ChallengeBuilt;
  const remote = remoteRepo("challenge-off");
  // The gitlink joins the run's BRANCH at the build commit — the commit the round
  // resets to and proves red against — which is the state a real run is in: the
  // tree the child works in is the one the reset produced, not the one
  // `worktree add` made. Attaching it IN THE TREE moves the branch with it, so no
  // separate `branch -f` is needed (or allowed: git refuses to force a branch a
  // registered worktree holds).
  attachSubmodule(built.worktree, remote, "add the vendored submodule");
  built.buildSha = built.headBefore;
  makeSubmoduleUnfetchable(remote, built.worktree);

  const r = await runChallenge({
    issue,
    built,
    // A red edge case, so the round commits and its pipeline runs the reset that is
    // under test. What the submodule directory holds AT THIS INSTANT is
    // deliberately not asserted: the dispatch is mid-round, before the reset, so it
    // is empty on both arms and separates nothing. `insideAfter` is the observation
    // that does — read after the step returned, so it is the outcome of the call.
    child: (wt) => {
      put(wt, TEST_REL, redEdge(TEST_REL), 0o755);
    },
    toolUses: [submit("AC1", [TEST_REL])],
  });
  return {
    threw: r.threw,
    outcome: r.outcome,
    // `gitArgvs` is the fixture's own record of every git argv the step issued —
    // the calls the step made, not the calls a wrapper of mine chose to notice.
    submoduleArgv: submoduleCalls(r.gitArgvs),
    insideAfter: existsSync(path.join(built.worktree, INSIDE)),
  };
}

// ── (a) off: the round runs, no call in the argv, and the submodule stays empty
{
  let ran: Awaited<ReturnType<typeof drive>> | undefined;
  let boom: Error | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    try {
      ran = await drive(901);
    } catch (err) {
      boom = err as Error;
    }
  });
  assert(
    boom === undefined,
    `(a) the off arm ran to completion (${boom?.message ?? "clean"})`,
  );
  assert(
    ran?.threw === undefined,
    `(a) the challenge round did not hand back over a submodule it was never asked to fetch (${ran?.threw?.message?.split("\n")[0] ?? "clean"})`,
  );
  assert(
    (ran?.submoduleArgv.length ?? -1) === 0,
    `(a) and the round issued no submodule call of any kind (got ${JSON.stringify(
      ran?.submoduleArgv.map((a) => a.slice(-3)),
    )})`,
  );
  assert(
    ran?.insideAfter === false,
    `(a) and the gitlink the reset emptied stayed empty for the whole round (found ${String(ran?.insideAfter)})`,
  );
  assert(
    ran?.outcome?.kind === "new-tests",
    `(a) and the round still did its job — the adversary's red test was frozen (got ${JSON.stringify(ran?.outcome?.kind)})`,
  );
}

// ── (b) the control: the same round issues the call and populates the submodule
{
  const on = await drive(902);
  assert(
    on.submoduleArgv.length > 0,
    `(b) the same round DOES issue the submodule call with the switch on (got ${JSON.stringify(on.submoduleArgv.map((a) => a.slice(-3)))})`,
  );
  // (b) is the SAME drive as (a) — nothing here reaches into the reset — so its
  // throw is the finding, not the fixture: it says a switch-ON round over a
  // submodule it genuinely cannot fetch is infrastructure, exactly as `specify`
  // already pins (case (e) of test-lean-specify-submodule.ts), and it is the other
  // half of the switch. Asserted as a throw naming the submodule step, which is
  // what makes (a)'s clean run a property of the switch rather than of luck.
  assert(
    on.threw !== undefined && /submodule/i.test(on.threw.message),
    `(b) and it ends as infrastructure naming the submodule step (${on.threw?.constructor.name ?? `outcome ${String(on.outcome?.kind)}`}: ${on.threw?.message.split("\n")[0] ?? "no throw"})`,
  );
  assert(
    on.insideAfter === false,
    `(b) and the call it issued could not put the submodule back (found ${String(on.insideAfter)}) — the source is gone for BOTH arms, so (a)'s empty tree is the switch not asking, not this file's setup`,
  );
}

process.exit(exit);
