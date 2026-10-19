#!/usr/bin/env bun
/**
 * The project's verify, smoke, verify-full and fast-tier commands run with the
 * driver's `PI_ENSEMBLE_*` knobs scrubbed (verifyChildEnv). Inherited, a
 * headless runner's knobs (PI_ENSEMBLE_HANDOFF_CHANNEL, PI_ENSEMBLE_PARALLEL_WORK,
 * ...) flipped behaviour in unrelated smoke tests and parked a correct change
 * as `change` (#1064, #1557).
 *
 * Part 1 is behavioural: the helper, and a real shell run through the verify
 * executor. Part 2 is a source canary: every verify executor site must route
 * its env through the helper, so a new site cannot silently re-inherit it.
 */

import { readFileSync } from "node:fs";
import { verifyChildEnv } from "../src/work-driver-verify-cmd.ts";
import { execp as verifyExecp } from "../src/work-driver-verify.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

const LEAK = "PI_ENSEMBLE_VERIFY_ENV_PROBE";
const KEEP = "VERIFY_ENV_PROBE_KEEP";
process.env[LEAK] = "leaked";
process.env[KEEP] = "kept";

console.log("1. the helper drops PI_ENSEMBLE_* and keeps everything else");
const env = verifyChildEnv();
assert(!(LEAK in env), "PI_ENSEMBLE_* key is absent from the default (process.env) scrub");
assert(env.PATH !== undefined, "PATH is kept");
assert(env[KEEP] === "kept", "a non-driver variable is kept");
const explicit = verifyChildEnv({
  PI_ENSEMBLE_A: "1",
  PI_ENSEMBLE_B: "2",
  KEEP_ME: "x",
});
assert(
  JSON.stringify(explicit) === JSON.stringify({ KEEP_ME: "x" }),
  "an explicit base is scrubbed the same way",
);

console.log("2. a shell run through the verify executor sees no driver knob");
const out = await verifyExecp(`echo "[$${LEAK}][$${KEEP}]"`, {});
assert(
  out.stdout.trim() === "[][kept]",
  `child env is scrubbed of the knob (got ${out.stdout.trim()})`,
);

console.log("3. source canary: every verify executor routes its env through the helper");
const sites: Array<[string, string]> = [
  ["work-driver-verify-pr17.ts", "execTree(cmd, { ...opts, env: verifyChildEnv(opts?.env) })"],
  ["work-driver-stepback-ci.ts", "execTree(cmd, { ...opts, env: verifyChildEnv(opts?.env) })"],
  ["work-driver-verify.ts", "env: verifyChildEnv(rest.env)"],
  ["work-driver-integrate-verify.ts", "const baseEnv: NodeJS.ProcessEnv = verifyChildEnv();"],
  ["work-driver-verify-select-exec.ts", "let env = verifyChildEnv(opts?.env);"],
  ["work-driver-verify-select-exec.ts", "verifyReportEnv(verifyChildEnv(), probeReportFile)"],
];
const inherit =
  /\?\?\s*process\.env\b(?!\.)|\.\.\.process\.env\b|verifyReportEnv\(\s*process\.env\b/;
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

console.log(
  failures === 0
    ? "\nAll verify child-env checks passed"
    : `\n${failures} verify child-env check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
