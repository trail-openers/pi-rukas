#!/usr/bin/env bun
/**
 * The project's verify, smoke, verify-full and fast-tier commands run with the
 * driver's knobs scrubbed (verifyChildEnv). Inherited, a headless runner's knobs
 * (PI_ENSEMBLE_HANDOFF_CHANNEL, PI_ENSEMBLE_PARALLEL_WORK, ...) flipped behaviour
 * in unrelated smoke tests and parked a correct change as `change` (#1064, #1557).
 * The verify loop's own knobs (PI_ENSEMBLE_VERIFY_TEST_JOBS, ...) are not driver
 * knobs and must reach the loop.
 *
 * Part 1 is behavioural: the helper, and a real shell run through the verify
 * executor (shell form, and the killGroup form). Part 2 is a source canary: each
 * listed executor site must route its env through the helper. It does not see a
 * NEW call that omits `env` altogether; it catches a site that re-inherits, or
 * one that stops routing through the helper.
 */

import { readFileSync } from "node:fs";
import { buildDriverKnobNames, verifyChildEnv } from "../src/work-driver-verify-cmd.ts";
import { execp as verifyExecp } from "../src/work-driver-verify.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

// A driver knob the inventory lists, and a verify-loop knob it does not.
const LEAK = "PI_ENSEMBLE_HANDOFF_CHANNEL";
const LOOP = "PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S";
const KEEP = "VERIFY_ENV_PROBE_KEEP";
process.env[LEAK] = "host";
process.env[LOOP] = "900";
process.env[KEEP] = "kept";

console.log("1. the helper drops driver knobs and keeps everything else");
const env = verifyChildEnv();
assert(!(LEAK in env), "a driver knob is absent from the default (process.env) scrub");
assert(env[LOOP] === "900", "a verify-loop knob passes through");
assert(env.PATH !== undefined, "PATH is kept");
assert(env[KEEP] === "kept", "a non-driver variable is kept");
const explicit = verifyChildEnv({
  PI_ENSEMBLE_HANDOFF_CHANNEL: "host",
  PI_ENSEMBLE_DRAFT_PR: "1",
  PI_ENSEMBLE_MODEL_DEVELOPER: "x",
  PI_ENSEMBLE_VERIFY_TEST_JOBS: "3",
  KEEP_ME: "x",
});
assert(
  JSON.stringify(explicit) === JSON.stringify({ PI_ENSEMBLE_VERIFY_TEST_JOBS: "3", KEEP_ME: "x" }),
  "an explicit base drops listed driver knobs (incl. a family member) and keeps the loop knob",
);

console.log("2. a shell run through the verify executor sees the scrub, and the loop's knob");
const probe = `echo "[$${LEAK}][$${LOOP}][$${KEEP}]"`;
const shellOut = await verifyExecp(probe, {});
assert(
  shellOut.stdout.trim() === "[][900][kept]",
  `shell form: driver knob scrubbed, loop knob kept (got ${shellOut.stdout.trim()})`,
);
const groupOut = await verifyExecp(probe, { killGroup: true });
assert(
  groupOut.stdout.trim() === "[][900][kept]",
  `killGroup form: driver knob scrubbed, loop knob kept (got ${groupOut.stdout.trim()})`,
);

console.log("3. source canary: every verify executor routes its env through the helper");
const sites: Array<[string, string]> = [
  ["work-driver-verify-shell.ts", "execTree(cmd, { ...opts, env: verifyChildEnv(opts?.env) })"],
  ["work-driver-verify.ts", "return shellExecp(cmd, {"],
  ["work-driver-verify.ts", "groupExecp(cmd, { ...opts, env: verifyChildEnv(opts.env) })"],
  ["work-driver-verify-pr17.ts", ": shellExecp(cmd, opts);"],
  ["work-driver-stepback-ci.ts", "shellExecp(cmd, opts);"],
];
// An env that inherits the driver's whole environment: a spread, a `??` default,
// a bare value (`env: process.env`, `= process.env;`), or a report env built on it.
const inherit =
  /\?\?\s*process\.env\b(?!\.)|\.\.\.process\.env\b|verifyReportEnv\(\s*process\.env\b|[:=]\s*process\.env\b(?![.\w[])/;
const sources = new Map<string, string>();
for (const file of new Set(sites.map(([f]) => f))) {
  sources.set(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
}
for (const [file, snippet] of sites) {
  assert(sources.get(file)?.includes(snippet) === true, `${file} routes its env: ${snippet}`);
}
for (const [file, text] of sources) {
  assert(!inherit.test(text), `${file} has no env that inherits process.env`);
}

console.log("4. the knob-family expansion refuses a family with no members");
assert(
  [...buildDriverKnobNames([{ name: "PI_X_<ROLE>", members: ["A", "B"] }])].join() ===
    "PI_X_A,PI_X_B",
  "a family expands to its members",
);
let threw = false;
try {
  buildDriverKnobNames([{ name: "PI_X_<ROLE>" }]);
} catch {
  threw = true;
}
assert(threw, "a family with no members throws, so it cannot scrub nothing silently");

console.log(
  failures === 0
    ? "\nAll verify child-env checks passed"
    : `\n${failures} verify child-env check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
