#!/usr/bin/env bun
/**
 * #1765 — the converge gate's corrective re-run caps a proven-red base as a
 * red base, not as a code failure.
 *
 * The corrective round's verify re-run computed its own cap with a hand-spread
 * pair of red claims and dropped `baselineRedEstablished`, so the SAME gate
 * result capped `verify-failed:develop` — the one cap a corrective round may
 * earn, and the one that tells a developer to go fix code — on the re-run and
 * `verify-baseline-red:develop` on the first pass. tehas paid for exactly that
 * extra round. All three sites now read `developVerifyCap`, and this case pins
 * the one that drifted: a re-run whose failures hold a `[baseline-red]` entry
 * naming the command beside a foreign entry caps `verify-baseline-red:develop`.
 *
 * Offline: no git, no dispatch — the helper is the seam.
 */
import {
  developVerifyCap,
  plainVerifyFailure,
} from "../src/work-develop-verify-failure.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import { VERIFY_TIMEOUT_LABEL } from "../src/work-driver-verify-develop-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BASE = `${BASELINE_RED_MARKER} verify command \`sh gate.sh\` ALSO FAILS on a clean checkout`;
const FOREIGN = "verify command `sh gate.sh` failed in worktree a: expected 1, got 2";
const TIMEOUT = `${VERIFY_TIMEOUT_LABEL} verify command \`sh gate.sh\` exceeded its 10-min timeout`;

// The converge re-run's shape: established, not the full excuse.
const established = { failures: [BASE, FOREIGN], baselineRedEstablished: true };
assert(
  developVerifyCap(established) === "verify-baseline-red:develop",
  `converge re-run: an established red base beside a foreign failure caps verify-baseline-red (got ${developVerifyCap(established)})`,
);
assert(
  plainVerifyFailure(established) === false,
  "converge re-run: that cap is not one a corrective round may answer",
);
// The pre-fix spread read only `baselineRedOnly`, so this is the regression.
assert(
  developVerifyCap({ failures: [BASE, FOREIGN] }) === "verify-failed:develop",
  "no red claim at all still caps verify-failed:develop — the helper does not invent one",
);
// The excuse claim, unchanged.
assert(
  developVerifyCap({ failures: [BASE, FOREIGN], baselineRedOnly: true }) ===
    "verify-baseline-red:develop",
  "baselineRedOnly raises the cap as it always did",
);
// The no-verdict families keep their precedence over both claims: with every
// failure a run that reached no verdict, `verifyCapFor` decides on the
// no-verdict shape, not on the base claim (#1324).
assert(
  developVerifyCap({
    failures: [TIMEOUT, `${BASELINE_RED_MARKER} ${VERIFY_TIMEOUT_LABEL} verify command \`sh gate.sh\` timed out at base`],
    baselineRedEstablished: true,
    baselineRedOnly: true,
  }) === "verify-timeout:develop",
  "a killed run among no-verdict entries is verify-timeout, not the base cap",
);
assert(
  developVerifyCap({
    failures: [TIMEOUT],
    baselineRedEstablished: true,
  }) === "verify-timeout:develop",
  "a killed run is verify-timeout whatever the base claim says",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
