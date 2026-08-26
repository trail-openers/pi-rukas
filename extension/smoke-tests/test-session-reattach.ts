#!/usr/bin/env bun
/**
 * #543 F3a — session re-attach (capability, DEFAULT-OFF).
 *
 * A crash-resume re-dispatches from scratch by default. When
 * PI_ENSEMBLE_SESSION_REATTACH=1 AND the crashed step is a SINGLE-DISPATCH step
 * (not develop/lens/adversarial fan-out) AND the child's transcript file exists,
 * the driver MAY re-attach the surviving session via `--mode rpc
 * --session <transcriptPath>` with a "continue from your checkpoint" prompt.
 *
 * F3a FAILS OPEN: flag off, fan-out step, or absent transcript → re-dispatch.
 * The offline test asserts the decision + the spawn-args array — no real Pi
 * spawn.
 */

import {
  FAN_OUT_STEPS,
  REATTACH_GRANT_FLOOR_MS,
  reattachArgs,
  reattachPrompt,
  resolveReattach,
  sessionReattachEnabled,
} from "../src/work-driver-resume.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const TS = "/tmp/pi-ensemble/issue-543/test-transcript.json";
const present = { existsSync: (_p: string) => true };
const absent = { existsSync: (_p: string) => false };

// 1. Flag OFF → re-dispatch, even with a transcript present.
{
  delete process.env.PI_ENSEMBLE_SESSION_REATTACH;
  const r = resolveReattach(
    "explore",
    [{ jobId: "j1", transcriptPath: TS }],
    1_000_000,
    3_600_000,
    990_000,
    {
      fs: present,
    },
  );
  assert(r.mode === "re-dispatch", "flag off → re-dispatch (default OFF at ship)");
  assert(!sessionReattachEnabled(), "sessionReattachEnabled() is false by default");
}

// 2. Flag ON + single-dispatch + transcript present → reattach with --session.
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  const r = resolveReattach(
    "explore",
    [{ jobId: "j1", transcriptPath: TS }],
    1_000_000,
    3_600_000,
    990_000,
    {
      fs: present,
    },
  );
  assert(r.mode === "reattach", "flag on + single-dispatch + transcript present → reattach");
  if (r.mode === "reattach") {
    assert(r.transcriptPath === TS, "reattach carries the recorded transcriptPath");
    const args = reattachArgs(r.transcriptPath);
    assert(
      args.join(" ") === `--session ${TS}`,
      "reattach spawn args are exactly `--session <recorded transcriptPath>`",
    );
    // Grant = original timeout (60min) minus elapsed (10min) = 50min, above floor.
    assert(
      r.grantMs === 3_600_000 - (1_000_000 - 990_000),
      "grant = original timeout minus elapsed",
    );
    assert(
      /continue from your checkpoint/i.test(reattachPrompt("explore", "explore")),
      "reattach prompt tells the child to continue from its checkpoint",
    );
  }
}

// 3. Fan-out step, flag on → re-dispatch (no --session).
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  for (const step of ["develop", "lens-review", "adversarial"] as const) {
    const r = resolveReattach(
      step,
      [{ jobId: "j1", transcriptPath: TS }],
      1_000_000,
      3_600_000,
      990_000,
      {
        fs: present,
      },
    );
    assert(r.mode === "re-dispatch", `fan-out step '${step}' → re-dispatch (no --session)`);
    assert(FAN_OUT_STEPS.has(step), `FAN_OUT_STEPS includes '${step}'`);
  }
  // A non-fan-out single-dispatch step still reattaches under the same flag.
  const explore = resolveReattach(
    "explore",
    [{ jobId: "j1", transcriptPath: TS }],
    1_000_000,
    3_600_000,
    990_000,
    {
      fs: present,
    },
  );
  assert(explore.mode === "reattach", "single-dispatch 'explore' reattaches under the flag");
}

// 4. Flag on but transcript ABSENT → re-dispatch (fail open).
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  const r = resolveReattach(
    "explore",
    [{ jobId: "j1", transcriptPath: TS }],
    1_000_000,
    3_600_000,
    990_000,
    {
      fs: absent,
    },
  );
  assert(r.mode === "re-dispatch", "flag on but transcript absent → re-dispatch (fail open)");
}

// 5. No transcriptPath recorded → re-dispatch.
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  const r = resolveReattach("explore", [{ jobId: "j1" }], 1_000_000, 3_600_000, 990_000, {
    fs: present,
  });
  assert(r.mode === "re-dispatch", "no recorded transcriptPath → re-dispatch");
}

// 6. Grant clamps to the 5-min floor.
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  // Elapsed (60min) exceeds the original timeout (10min) → floor.
  const r = resolveReattach(
    "explore",
    [{ jobId: "j1", transcriptPath: TS }],
    1_000_000,
    600_000,
    400_000,
    {
      fs: present,
    },
  );
  assert(
    r.mode === "reattach" && r.grantMs === REATTACH_GRANT_FLOOR_MS,
    "grant clamps to the 5-min floor when elapsed exceeds the original timeout",
  );
  // No original timeout known → floor.
  const r2 = resolveReattach(
    "explore",
    [{ jobId: "j1", transcriptPath: TS }],
    1_000_000,
    undefined,
    undefined,
    {
      fs: present,
    },
  );
  assert(
    r2.mode === "reattach" && r2.grantMs === REATTACH_GRANT_FLOOR_MS,
    "unknown original timeout → grant is the 5-min floor",
  );
}

// 7. Multiple in-flight (fan-out that leaked a transcript) → re-dispatch.
{
  process.env.PI_ENSEMBLE_SESSION_REATTACH = "1";
  const r = resolveReattach(
    "develop",
    [
      { jobId: "j1", transcriptPath: TS },
      { jobId: "j2", transcriptPath: TS },
    ],
    1_000_000,
    3_600_000,
    990_000,
    { fs: present },
  );
  assert(r.mode === "re-dispatch", "N>1 in-flight dispatches → re-dispatch (no child to pick)");
}

// Restore the env for the rest of the suite.
delete process.env.PI_ENSEMBLE_SESSION_REATTACH;

console.log(`\nexit ${exit}`);
process.exit(exit);
