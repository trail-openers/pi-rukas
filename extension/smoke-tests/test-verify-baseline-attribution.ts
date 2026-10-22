#!/usr/bin/env bun
/**
 * #1765 — the two pure rules the base-health probe's cache and cap rest on.
 *
 * 13 — a bare `[verify-timeout]` entry attributes to NO base. The
 * `red-timed-out` arm of `baselineRedMessage` leads with `[baseline-red]` and
 * then the `[verify-timeout]` label, so "this entry contains the timeout
 * label" cannot tell a base the probe proved red from a fast-tier, smoke or
 * consolidated run the gate itself killed at its bound. Only the latter
 * happens on a healthy base — and reading it as the former raises the develop
 * cap to `verify-baseline-red:develop`, the cap that tells an operator to go
 * fix the base, when the actionable diagnosis is a bound that was too short.
 * So the marker is required, and the timeout label is accepted only alongside
 * it. Each case names the gate's OWN command: position is deliberately not
 * what saves these, since the timed-out arm puts the command after both
 * labels. `verifyCapFor`'s precedence for a killed run is pinned in
 * `test-verify-no-verdict-caps.ts`.
 *
 * 14 — a cache file written BEFORE #1765 dropped `at` still reads as the green
 * it is. The field is ignored, never required: rejecting it would re-pay a
 * full suite run to re-learn a fact about an immutable commit, which is the
 * whole cost argument for the cache.
 *
 * Split out of `test-verify-base-health-probe.ts` for AGENTS.md §12's 500-line
 * cap (that file was sitting at it). Case 13 needs no fixture at all; case 14
 * reuses the probe harness's own repo builder.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import {
  baselineRedForCmd,
  baselineRedForCommand,
} from "../src/work-driver-verify-base-health.ts";
import { baseHealthCacheFile, readBaseHealthCache } from "../src/work-driver-verify-base-health.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import { VERIFY_TIMEOUT_LABEL } from "../src/work-driver-verify-develop-helpers.ts";
import { developTierTimeouts } from "../src/work-driver-verify-budget.ts";
import { PROBE_CMD as CMD, GREEN_GATE, capsOf, probe } from "./lib/base-health-probe-fixture.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const killed = (cmd: string) =>
  `${VERIFY_TIMEOUT_LABEL} verify command \`${cmd}\` exceeded its 10-min timeout`;

// ── 13 — a bare `[verify-timeout]` names no base.
assert(
  baselineRedForCommand(killed(CMD), CMD) === false,
  "attribution: a bare [verify-timeout] naming the command is NOT a red base",
);
assert(
  baselineRedForCmd([killed(CMD), "verify command `x` failed: expected 1, got 2"], CMD) === false,
  "attribution: a killed fast-tier run beside a real failure establishes no red base",
);
assert(
  baselineRedForCmd([killed(CMD)], CMD) === false,
  "attribution: a killed smoke run alone establishes no red base either",
);
assert(
  baselineRedForCommand(
    `${BASELINE_RED_MARKER} ${VERIFY_TIMEOUT_LABEL} verify command \`${CMD}\` exceeded its bound`,
    CMD,
  ) === true,
  "attribution: the timed-out arm (marker + timeout label) still attributes to the base",
);
assert(
  baselineRedForCommand(`${BASELINE_RED_MARKER} verify command \`${CMD}\` ALSO FAILS`, CMD) ===
    true,
  "attribution: the plain red arm still attributes to the base",
);
assert(
  baselineRedForCommand(`${BASELINE_RED_MARKER} verify command \`other.sh\` ALSO FAILS`, CMD) ===
    false,
  "attribution: a marker naming a different command is not this run's base",
);

// ── 14 — a legacy cache file that still carries `at` stays readable.
{
  __setHostBudget({ verifyConcurrency: 0 } as HostBudget);
  const root = mkdtempSync(path.join(tmpdir(), "pi-base-health-legacy-"));
  const f = await redGateFixture(root, "legacy-at", GREEN_GATE, { "notes.md": "x\n" });
  mkdirSync(path.dirname(baseHealthCacheFile(f.repo)), { recursive: true });
  const bound = (await developTierTimeouts(f.repo)).suite;
  writeFileSync(
    baseHealthCacheFile(f.repo),
    JSON.stringify({
      verdict: {
        status: "green",
        baseSha: f.baseSha,
        command: CMD,
        tierBoundMs: bound,
        at: 1_700_000_000_000,
      },
    }),
  );
  const legacy = await readBaseHealthCache(
    async () => readFileSync(baseHealthCacheFile(f.repo), "utf8"),
    f.repo,
  );
  assert(
    legacy?.status === "green" && !("at" in (legacy ?? {})),
    "legacy cache: a file that still carries at is readable, and the extra field is dropped",
  );
  const r = await probe(f);
  assert(
    r.gateRuns.length === 0 && capsOf(r.state).length === 0,
    `legacy cache: the pre-#1765 green answers for the run and costs no suite re-run (got ${r.gateRuns.length})`,
  );
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
