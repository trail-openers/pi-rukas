#!/usr/bin/env bun
/**
 * lean/freeze-check, `verify` side — a red tier whose failure sits in a FROZEN
 * file hands the run back instead of billing a build round.
 *
 * `verify` routes every red into a build round, and a build round cannot touch a
 * frozen file: that is what "frozen" means. So when the project's freeze check
 * is set, is RED at HEAD, and its own output names one of the run's frozen paths
 * — while the same check is GREEN in a checkout of HEAD without them — the
 * contract is defective, and the honest verdict is a hand-back that bills
 * nothing. A run that took the round instead spent its builders learning a thing
 * no builder could act on.
 *
 *   (v1) a frozen file carrying the marker + a red tier → THROW whose message
 *        starts `frozen contract defective:`, naming the check command and the file;
 *   (v1b) the same throw driven through the real `runLean`: `handed-back`, build
 *        never entered, the round unspent. Its control is the same drive with the
 *        step RETURNING the red — which reaches `build` and pays for it;
 *   (v2) the control on the step itself: the same red tier over a clean contract
 *        → the ordinary `verify:red`, whose reason is the tier's own. Without it
 *        (v1) could be read as "every red tier throws";
 *   (v3a) a check that cannot run → the tier's own red: no colour, no hand-back;
 *   (v3b) a check that runs red but names no frozen path → the tier's own red:
 *        the blame attaches to a contract, not to any file that trips a gate;
 *   (v4) a green gate with the check configured → green, unchanged.
 *
 * Real repo, real git, real `sh`, real `runLean`. The gate's pattern is written
 * SPLIT (`FORBIDDE''N_MARKER`) and the candidate carries the contiguous form, so
 * a green gate has read the tree rather than its own command line.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type LeanHandlers, runLean } from "../src/lean/engine.ts";
import type { Outcome } from "../src/lean/state.ts";
import {
  PASS_TIER,
  ROOTS,
  RED_ACCEPTANCE_TEST,
  buildFixtureForWiring,
  runVerify,
} from "./lib/lean-verify-fixture.ts";
import { assert, testLocationExit } from "./lib/lean-test-location-fixture.ts";

const MARKER = "FORBIDDEN_MARKER";
/**
 * The marker as the gate searches for it: broken by an empty quote pair so the
 * gate's own command line does not contain the token it hunts.
 */
const MARKER_GREP = `${MARKER.slice(0, 8)}''${MARKER.slice(8)}`;
/** The offending spelling, assembled so this repo's own env-clear ratchet stays quiet. */
const OFFENDING = `process.env.${["X", "_OFFENDER"].join("")} = undefined`;
/** The marker as a file carries it: the contiguous token, built the same way. */
const MARKER_TEXT = `${MARKER.slice(0, 8)}${MARKER.slice(8)}`;
const FROZEN = "tests/AC1-retry.test.sh";
/** A frozen file the step's own frozen map does not carry, for (v3b). */
const STRAY = "tests/AC2-stray-marked.test.sh";

/** A frozen acceptance test the project's content gate will refuse. */
function markedFrozen(): string {
  return `${RED_ACCEPTANCE_TEST}# offending form: ${OFFENDING} ${MARKER_TEXT}\n`;
}

/** The project's content gate: green unless a test file carries the marker. */
function gate(): string {
  return `sh -c 'if grep -rl "${MARKER_GREP}" tests >/dev/null 2>&1; then grep -rn "${MARKER_GREP}" tests; exit 1; fi'`;
}

const RED = "sh -c 'echo tier-said-freeze 1>&2; exit 1'";

/** What a defective-contract case needs on disk: the marker inside the frozen file. */
const DEFECTIVE = {
  frozenText: markedFrozen(),
  alwaysRedFrozen: true,
  implement: true,
} as const;

// ── (v1) a red tier + a frozen file the gate names → hand back, no round ─────
{
  const r = await runVerify({
    issue: 2421,
    config: { fast: RED, freezeCheck: gate() },
    ...DEFECTIVE,
  });
  assert(
    r.threw !== undefined && r.threw.message.startsWith("frozen contract defective:"),
    `(v1) hands back with the frozen-contract reason (got ${r.threw?.name}: ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    (r.threw?.message ?? "").includes(gate()),
    `(v1) the reason names the check command (got ${r.threw?.message})`,
  );
  assert(
    (r.threw?.message ?? "").includes(FROZEN),
    `(v1) the reason names the frozen file it blames (got ${r.threw?.message})`,
  );
}

// ── (v1b) the real table: the throw ends the road, a returned red pays ──────
{
  // The two drives differ in one thing only: what the `verify` handler does with
  // the verdict. Same route, same counter, so the gap between them is the throw.
  const thrown = await driveVerify(2425, () => new Error("frozen contract defective: probe"));
  const returned = await driveVerify(2426, () => ({
    kind: "red",
    reason: "verify.fast exited 1",
  }));
  // Both arms share everything but what the step does with the verdict, and each
  // is asked TWO questions: where it went, and what its own record says it paid.
  assert(
    thrown.state === "handed-back" && thrown.reached.verify === 1,
    `(v1b) the throw ends the run handed back, straight out of the one verify it ran (got ${thrown.state}, verify x${String(thrown.reached.verify ?? 0)})`,
  );
  assert(
    thrown.reached.build === 1,
    `(v1b) the throwing arm paid ONLY its way into verify (build x${String(thrown.reached.build ?? 0)})`,
  );
  // The control keeps saying red, so the table spends every round it is allowed
  // and the run arrives at `verify` one last time with nothing left to buy. The
  // claim is the difference, not the number: the throw stops at the round that
  // got it INTO verify, the red pays for each round that follows.
  assert(
    returned.reached.verify === 3 && returned.reached.build === 3,
    `(v1b) the control: the same red, RETURNED, keeps buying rounds (verify x${String(returned.reached.verify ?? 0)}, build x${String(returned.reached.build ?? 0)})`,
  );
  assert(
    returned.run.counters.buildAttempts === 3 && thrown.run.counters.buildAttempts === 1,
    `(v1b) and the record says so too: ${String(returned.run.counters.buildAttempts)} attempt(s) vs the throw's ${String(thrown.run.counters.buildAttempts)}`,
  );
}

// ── (v2) the control: the same red tier over a clean contract is an ordinary red
{
  const r = await runVerify({
    issue: 2422,
    config: { fast: RED, freezeCheck: gate() },
    implement: true,
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "red",
    `(v2) a clean contract leaves the tier's own red standing (got ${r.outcome?.kind} / ${r.threw?.message})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("verify.fast"),
    `(v2) the reason is the tier's, which is what routes the run into a billed build round (got ${r.outcome?.reason})`,
  );
}

// ── (v3a) a check that never answered is not a colour ───────────────────────
{
  const r = await runVerify({
    issue: 2423,
    config: { fast: RED, freezeCheck: "definitely-not-a-real-binary" },
    ...DEFECTIVE,
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "red",
    `(v3a) a check that never ran earns no hand-back (got ${r.outcome?.kind} / ${r.threw?.message})`,
  );
}

// ── (v3b) a red check that names no frozen path blames no contract ──────────
{
  // The gate is RED and the tier is RED, but the only marked file on disk is one
  // this run never froze — so there is no contract for the failure to be the
  // contract's, and the ordinary red (which a builder CAN act on) stands.
  const stray = mkdtempSync(path.join(tmpdir(), "lean-stray-"));
  try {
    const target = path.join(stray, STRAY);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, markedFrozen(), { mode: 0o755 });
    const r = await runVerify({
      issue: 2427,
      // The gate looks in `tests`, so the stray is reachable only through the
      // frozen-tree read the step performs; pointing the check at the stray's own
      // directory keeps it red while naming a path the frozen map does not carry.
      config: { fast: RED, freezeCheck: `sh -c 'grep -rn "${MARKER_GREP}" "${stray}" >/dev/null 2>&1 && exit 1 || exit 1'` },
      ...DEFECTIVE,
    });
    assert(
      r.threw === undefined && r.outcome?.kind === "red",
      `(v3b) a red check naming no frozen file is the tier's own red (got ${r.outcome?.kind} / ${r.threw?.message})`,
    );
  } finally {
    rmSync(stray, { recursive: true, force: true });
  }
}

// ── (v4) the check configured changes nothing on a green gate ────────────────
{
  const r = await runVerify({
    issue: 2424,
    config: { fast: PASS_TIER, freezeCheck: gate() },
    implement: true,
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "green",
    `(v4) a green gate with the check configured is still green (got ${r.outcome?.kind} / ${r.threw?.message})`,
  );
  assert((r.tierRuns ?? 0) > 0, "(v4) the project tier ran, so green is not an absence of tiers");
}

/**
 * Drive the real engine through the states that lead to a build round, counting
 * every entry. `verdict` is what `verify` says: an Error is the freeze check's
 * hand-back, an Outcome is the ordinary verdict the table routes on.
 */
async function driveVerify(
  issue: number,
  verdict: () => Outcome | Error,
): Promise<{
  state: string;
  run: { counters: { buildAttempts: number }; steps: { state: string }[] };
  reached: Record<string, number>;
}> {
  const reached: Record<string, number> = {};
  const step = (state: string, outcome: () => Outcome | Error) => async () => {
    reached[state] = (reached[state] ?? 0) + 1;
    const o = outcome();
    if (o instanceof Error) throw o;
    return o;
  };
  // The route to a red `verify`: `ready` ok, `specify` ok (the edge that
  // DISPATCHES and therefore bills the first round), `build` ok (which goes to
  // `challenge` first — an unchallenged run has an adversary to face), and
  // `challenge + none` is what finally arrives at `verify`. A `verify + red` then
  // bills the NEXT round on its way back to `build`: that is the payment the
  // control makes and the throwing run never does, so the two arms are charged
  // through the SAME route and differ only in the verdict.
  const handlers = {
    ready: step("ready", () => ({ kind: "ok" })),
    specify: step("specify", () => ({ kind: "ok", frozen: {}, tests: {} })),
    build: step("build", () => ({ kind: "ok", reason: "probe" })),
    challenge: step("challenge", () => ({ kind: "none" })),
    verify: step("verify", verdict),
  } as unknown as LeanHandlers;
  // A fresh drive per arm, in a root of the caller's own: `runLean` takes a
  // process-wide lock on `<repoRoot>/.pi/lean-state/<issue>.json`, and two arms
  // sharing one fixture root would have the second refuse as "already in
  // progress" rather than run. The state file is the only thing the root is for.
  const root = mkdtempSync(path.join(tmpdir(), `lean-drive-${issue}-`));
  try {
    const driven = await runLean({ repoRoot: root, issue, handlers });
    return { state: driven.state, run: driven.run, reached };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(testLocationExit());
