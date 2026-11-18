#!/usr/bin/env bun
/**
 * #2333 — the ops CI sleep-poll does not trip the success-keyed loop detector,
 * and the doctrine depends on that.
 *
 * The poll the doctrine now prescribes is `sleep 60`, then one forge read,
 * repeated for up to 30 minutes — thirty iterations of the SAME two bash calls.
 * The success-keyed repetition counter (`SUCCESS_STEER_AT = 3`,
 * `SUCCESS_KILL_AT = 6`, loop-detector-success.ts) is fed by every tool RESULT and
 * counts consecutive byte-identical successful re-runs per fingerprint, so a naive
 * reading says a poll longer than six iterations gets the child steered, then
 * killed, mid-wait — the outcome the doctrine exists to prevent.
 *
 * **What actually holds, and what this file pins:**
 *
 *   1. A poll whose reads CHANGE (CI is moving: queued → in_progress → pass) never
 *      accumulates on the READ's fingerprint — a changed output deletes the entry.
 *   2. A fully stalled poll DOES cross BOTH thresholds on both fingerprints — the
 *      steer at `SUCCESS_STEER_AT` and the kill at `SUCCESS_KILL_AT`. That is the
 *      honest finding, reported rather than papered over by widening the
 *      classifier: on its own a 30-minute wait would be killed, not advised.
 *   3. Neither threshold is ever REACHED for the role that runs this poll. ops
 *      children run with `capsOn === false` (spawn-caps.ts guards construction with
 *      `opts.role !== "ops"`), so no detector exists for an ops dispatch. That is
 *      the whole reason "keep polling" and the counter do not collide — and it is
 *      what a future change to that guard would silently break (the kill, per (2),
 *      not the steer), so it is asserted rather than assumed.
 *   4. Because (3) is role-scoped, the sleep-carrying recipe must not reach a
 *      detector-armed role that writes. Read from the manifests, not a list
 *      maintained here.
 *
 * Non-vacuity: a real 30-iteration poll is driven through `createSuccessCounters`
 * with its own fingerprints, so a threshold move or a fingerprinting change flips
 * a result instead of being ignored.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeFingerprint } from "../src/loop-detector.ts";
import {
  SUCCESS_KILL_AT,
  SUCCESS_STEER_AT,
  createSuccessCounters,
} from "../src/loop-detector-success.ts";

const SELF = "test-ci-doctrine-loop-detector.ts";
const ROOT = path.resolve(import.meta.dirname, "..", "..");

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const READ_CMD = "gh pr checks 12 --repo o/r";
const SLEEP_CMD = "sleep 60";
/** 30 minutes at the doctrine's 60 s cadence. */
const POLL_ITERATIONS = 30;

/** One full poll driven through the REAL counter: `sleep 60` then the read,
 * `POLL_ITERATIONS` times, with the read's output supplied per iteration. */
function drivePoll(readOutput: (iteration: number) => string) {
  const registry = new Map<string, number>();
  const counters = createSuccessCounters(() => 0);
  const readFp = normalizeFingerprint("bash", { command: READ_CMD }, registry);
  const sleepFp = normalizeFingerprint("bash", { command: SLEEP_CMD }, registry);
  let readSteered = false;
  let sleepSteered = false;
  let readKilled = false;
  let sleepKilled = false;
  for (let i = 0; i < POLL_ITERATIONS; i++) {
    counters.observeResult(readFp, "bash", readOutput(i), false, () => {
      readKilled = true;
    });
    counters.observeResult(sleepFp, "bash", "", false, () => {
      sleepKilled = true;
    });
    for (const e of counters.entries()) {
      if (e.fingerprint === readFp && e.steered) readSteered = true;
      if (e.fingerprint === sleepFp && e.steered) sleepSteered = true;
    }
  }
  return { readSteered, sleepSteered, readKilled, sleepKilled };
}

// 1. A poll over MOVING CI never counts the read as a repetition — the normal
// case for a 30-minute wait, and the reason the poll is not a loop pathology.
{
  const { readSteered, readKilled } = drivePoll(
    (i) => `checks ci: ${["queued", "in_progress", `pass (${i})`][i % 3]}`,
  );
  assert(
    readSteered === false && readKilled === false,
    "a poll whose check rows change never steers or kills on the read's fingerprint",
  );
}

// 2. The honest finding, reported: a fully stalled poll crosses BOTH thresholds
// on both fingerprints — steer at `SUCCESS_STEER_AT` and kill at
// `SUCCESS_KILL_AT`. That is what the ops exemption in section 3 protects: were
// that exemption narrowed, a stalled 30-minute CI wait would be KILLED, not
// merely steered, and this file would still pass on the steer half alone if the
// kill were not named here too.
{
  const { sleepSteered, readSteered, readKilled, sleepKilled } = drivePoll(
    () => "checks ci: pending",
  );
  assert(
    sleepSteered === true,
    `a stalled poll's \`sleep 60\` reaches SUCCESS_STEER_AT (${SUCCESS_STEER_AT}) on its own fingerprint — reported, not widened away`,
  );
  assert(
    readSteered === true,
    "a stalled poll's identical read reaches the steer threshold too",
  );
  assert(
    readKilled === true && sleepKilled === true,
    `a stalled poll reaches SUCCESS_KILL_AT (${SUCCESS_KILL_AT}) on BOTH fingerprints — the role exemption below, not the threshold margin, is what keeps a 30-minute CI wait from being killed`,
  );
}

// 3. The role exemption that makes the recipe safe is real.
{
  const caps = readFileSync(path.join(ROOT, "extension/src/spawn-caps.ts"), "utf8");
  assert(
    /capsOn\s*=\s*process\.env\.PI_ENSEMBLE_DISPATCH_CAPS\s*!==\s*"0"\s*&&\s*opts\.role\s*!==\s*"ops"/.test(
      caps,
    ),
    'ops children run with capsOn false (spawn-caps gates on `opts.role !== "ops"`), so the success-keyed counter is never armed for the role that runs this poll',
  );
  assert(
    /if \(capsOn && loopDetectorEnabled\(\)\)\s*\{\s*loopDetector = createLoopDetector\(\);/.test(
      caps,
    ),
    "the loop detector is constructed only under capsOn — one exemption gate, not two",
  );
  assert(
    SUCCESS_STEER_AT > 2 && SUCCESS_KILL_AT === SUCCESS_STEER_AT * 2,
    `the thresholds are still steer ${SUCCESS_STEER_AT} / kill ${SUCCESS_KILL_AT} (a move changes this doctrine's margin)`,
  );
}

// 4. The sleep-carrying module must not reach a detector-armed role that writes.
// Read the manifests, so the assertion follows the composition.
{
  const rolesWithModule = [
    "developer",
    "explore",
    "adversarial-developer",
    "code-review-specialist",
  ].filter((role) =>
    readFileSync(path.join(ROOT, "manifests", `${role}.manifest`), "utf8").includes(
      "modules/workflows/ci-monitoring.md",
    ),
  );
  assert(
    rolesWithModule.length === 1 && rolesWithModule[0] === "code-review-specialist",
    `among non-ops roles only the reviewer assembles the sleep-poll module (got: ${rolesWithModule.join(", ") || "none"}) — a reviewer only reads CI, so a mid-wait steer is harmless`,
  );
  assert(
    readFileSync(path.join(ROOT, "manifests", "ops.manifest"), "utf8").includes(
      "modules/workflows/ci-monitoring.md",
    ),
    "ops: its manifest still assembles the CI module that carries the poll",
  );
  assert(
    /sleep 60/.test(readFileSync(path.join(ROOT, "agents-base/ops.md"), "utf8")),
    "ops: the role doc itself still carries the poll",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
