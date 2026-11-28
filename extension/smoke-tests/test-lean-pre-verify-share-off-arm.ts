/**
 * test-lean-pre-verify-share-off-arm — the pre-change golden of #2634, not a mirror of the code
 * under change.
 *
 * `test-lean-pre-verify-share.ts` pins the share bound (AC5: a bounded specify keeps its whole
 * share) and, at the ceiling of `0`, that nothing is kept. Both of those cases called
 * `challengeSkip` — the module under change — to produce their expected bytes. A comparison whose
 * expected value comes from the same module can only ever prove the function equals itself, so
 * "byte-identity at 0" (AC4) had no evidence outside the diff. This suite is that evidence: it
 * compares the switch-at-`0` run against
 * `fixtures/lean-state/pre-verify-share-off-2634.json`, captured once from `c488c87cb2` — origin/main
 * before `pre-verify-share.ts` existed — by a script that ran the same harness from
 * `lib/lean-pre-verify-share-golden.ts` inside a worktree of that commit, so no import in the capture
 * resolved at this checkout's `src/`.
 *
 * The golden covers four surfaces, because the leak AC4 refuses has four ways to show: a `skipped`
 * kind on a step record, a `challenge skipped:` line in the `## Run` section `publish` writes, a
 * fourth `challenge` kind in the headless `gates` projection, and a pair the registry routes that no
 * pre-change edge carried. The first three are compared key for key. The machine's two registry
 * fields are compared against the LIVE registry instead (case (d)), because this issue adds the
 * `skipped` kind and its edge to them by design — a golden that compared them to bytes captured from
 * `main` could only pass by the capture having been taken from this branch, which is the
 * self-reference this suite exists to remove.
 *
 * Two cases sabotage the comparison, because a golden nobody can break is decoration:
 *
 *   (b) deletes a whole step record from the captured bytes — the suite must fail, and name which
 *       record the capture kept that this run did not write;
 *   (c) adds a `challengeSkipped` record to the captured verify outcome — the shape the leak would
 *       actually take — and the suite must fail on the key, not on a masked value.
 *
 * The `skipped` kind itself is exercised live, at values the pre-change tree had no way to reach, by
 * `test-lean-pre-verify-share.ts`. This suite never imports `pre-verify-share.ts` and never builds a
 * `skipped` outcome — there is nothing here for a leaked key to hide behind.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOLDEN_ISSUE,
  SHARE_FIXTURE,
  driveOffArm,
  type ShareGolden,
} from "./lib/lean-pre-verify-share-golden.ts";
import { HANDLER_STATES, OUTCOME_KINDS, hasTransition } from "../src/lean/machine.ts";
import { withEnv } from "./lib/env-scope.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(HERE, SHARE_FIXTURE);

/** The captured bytes, parsed and re-rendered so key ORDER is part of what is compared: a field
 * inserted mid-record is a change to the record, not a change to its contents. */
function fixture(): { golden?: ShareGolden; problem?: string; raw: string } {
  try {
    const raw = readFileSync(GOLDEN_PATH, "utf8");
    return { golden: JSON.parse(raw) as ShareGolden, raw };
  } catch (err) {
    return { problem: (err as Error).message, raw: "" };
  }
}

const { golden: captured, problem, raw } = fixture();
assert(
  captured !== undefined,
  `(fixture) the pre-change record is present at ${SHARE_FIXTURE} (${problem ?? "read"})`,
);
// The fixture is only evidence if it is the record the harness claims to have taken. These three
// read the capture itself, so a golden swapped in for some other run's output fails here rather than
// quietly matching a drive that never reached the surfaces in question.
assert(
  captured?.steps.some((s) => s.state === "publish" && s.outcome?.kind === "ok") === true,
  "(fixture) the captured run reached publish — otherwise the Run section compared here is nothing's",
);
assert(
  captured?.steps.some((s) => s.state === "challenge" && s.outcome?.kind === "none") === true,
  "(fixture) the captured challenge record is the pre-change verdict `none`, with no share beside it",
);
assert(
  captured?.machine.challengeKinds.includes("skipped") === false,
  "(fixture) the captured registry tables are the PRE-CHANGE ones — a `skipped` kind in them means " +
    "the capture ran against the code under change, which is the self-reference this suite exists to remove",
);

/** The three compared surfaces, machine tables excluded — see the header for why those are (d)'s. */
const comparable = (g: ShareGolden): string =>
  JSON.stringify({ steps: g.steps, runSection: g.runSection, gates: g.gates, code: g.code });

const textOf = (g: ShareGolden): string => comparable(g);

// ── (a) the off arm is byte-identical to what origin/main wrote, on the three recorded surfaces
{
  let ran: ShareGolden | undefined;
  let threw: Error | undefined;
  try {
    // The switch unset, the way `c488c87cb2` ran it: that tree had no knob to set, so the OFF arm of
    // this build and the pre-change build must be the same bytes. An empty string is what the
    // release's off arm means; a value inherited from the operator's shell would not be that.
    await withEnv({ PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE: "" }, async () => {
      ran = await driveOffArm(GOLDEN_ISSUE);
    });
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw === undefined,
    `(a) the off run completes on the pre-change recipe (${threw?.message ?? "clean"})`,
  );
  assert(
    (ran as ShareGolden).runSection.startsWith("## Run"),
    "(a) the compared run really reached publish — a run that stopped early matches nothing",
  );
  assert(
    textOf(ran as ShareGolden) === textOf(captured as ShareGolden),
    `(a) at the ceiling of 0 the recorded surfaces differ from the bytes c488c87cb2 wrote:\n` +
      `  captured: ${textOf(captured as ShareGolden)}\n  at 0:     ${textOf(ran as ShareGolden)}`,
  );
  console.log(
    "pre-verify-share: off arm byte-identical to the c488c87cb2 capture (log, Run section, gates)",
  );
}

// ── (b) a step record the run no longer writes is reported, not smoothed over
{
  const mutated = JSON.parse(raw) as ShareGolden;
  const at = mutated.steps.findIndex((s) => s.state === "verify");
  assert(at >= 0, "(fixture) the captured run carries a verify record to remove");
  mutated.steps.splice(at, 1);
  let verdict = "";
  await withEnv({ PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE: "" }, async () => {
    const ran = await driveOffArm(GOLDEN_ISSUE);
    const mine = textOf(ran);
    const theirs = textOf(mutated);
    // Failing is not enough: the failure has to be ABOUT the removed record, or the case passes for
    // an unrelated reason and proves nothing about the comparison's sensitivity.
    verdict =
      mine === theirs
        ? "matched a golden missing a whole step record"
        : mine.includes('"2634:verify:0"') && !theirs.includes('"2634:verify:0"')
          ? "differs, and the difference is the record the capture kept"
          : "differs, but not by the removed record";
  });
  assert(
    verdict === "differs, and the difference is the record the capture kept",
    `(b) deleting the verify record from the golden did not fail the comparison by naming it (${verdict})`,
  );
  console.log("pre-verify-share: a removed step record fails the comparison by name");
}

// ── (c) a leaked key on the captured record fails the comparison — the sabotage the bound exists for
{
  const mutated = JSON.parse(raw) as ShareGolden;
  const verify = mutated.steps.find((s) => s.state === "verify");
  assert(verify?.outcome !== undefined, "(fixture) the captured verify record is present");
  // The exact shape the leak takes: the share's record parked beside a verdict that never had one.
  // Every value is the OFF-arm value — a comparison that noticed only the numbers, or only the
  // reason's wording, and not the key's presence, is the comparison this case refuses to accept.
  (verify?.outcome as Record<string, unknown>).challengeSkipped = {
    kind: "skipped",
    reason: "bounded specify consumed the whole share",
    consumedChildTurns: 0,
    consumedMs: 0,
    ceilingChildTurns: 21,
    ceilingMs: 1800000,
  };
  let matched = true;
  await withEnv({ PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE: "" }, async () => {
    const ran = await driveOffArm(GOLDEN_ISSUE);
    matched = textOf(ran) === textOf(mutated);
  });
  assert(
    matched === false,
    "(c) the off run matched a golden carrying a challengeSkipped record — the comparison would " +
      "not have noticed the leak it exists to catch",
  );
  console.log("pre-verify-share: a leaked-key golden fails the comparison");
}

// ── (d) the two masked registry fields, pinned against the live registry rather than the capture
{
  // The capture recorded three challenge kinds; this branch added the fourth. The pair count moved
  // with it, and the number is the machine suite's own assertion, so the two agree here only because
  // the table says so — not because a byte on disk does.
  assert(
    captured?.machine.challengeKinds.length === 3,
    `(d) the capture saw 3 challenge kinds (got ${String(
      captured?.machine.challengeKinds.length,
    )} — the capture's own table, not this branch's)`,
  );
  assert(
    JSON.stringify([...OUTCOME_KINDS.challenge]) ===
      JSON.stringify([...(captured?.machine.challengeKinds ?? []), "skipped"]),
    `(d) the live challenge registry is the capture's kinds plus exactly \`skipped\` (got ${JSON.stringify(
      OUTCOME_KINDS.challenge,
    )})`,
  );
  let pairs = 0;
  for (const state of HANDLER_STATES) for (const kind of OUTCOME_KINDS[state]) pairs++;
  assert(
    pairs === 30 &&
      captured?.machine.pairs === 27 &&
      OUTCOME_KINDS.challenge.every((k) => hasTransition("challenge", k)),
    `(d) one edge per new kind, and the pair count moved from the capture's 27 to the registry's 30 (got ${String(
      pairs,
    )})`,
  );
  console.log("pre-verify-share: the registry's skipped kind and its edge are pinned to the live table");
}

console.log("lean-pre-verify-share-off-arm: ok");
