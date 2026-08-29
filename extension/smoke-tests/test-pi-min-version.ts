#!/usr/bin/env bun
/**
 * Minimum Pi version floor for install.sh — issue #578.
 *
 * install.sh used to preflight `pi` with presence only (`command -v`), so a
 * host that had resolved "latest" to a release shipping a live bug (0.84.3's
 * extension-message-order defect) installed fine and then died four /work
 * cycles later. The fix is a FLOOR, not an exact pin: new releases are fine,
 * the known-bug window is not.
 *
 * The floor lives in install-preflight.sh as `MIN_PI_VERSION` — a single
 * source of truth that this test and test-prerequisite-drift.ts both parse,
 * and that the README install line / Dockerfile pin are cross-checked
 * against. No other file hardcodes the value.
 *
 * Method (same shape as test-os-guard.ts): the bash functions are extracted
 * from install-preflight.sh by regex and driven in a fresh `bash -c` with
 * faked `pi --version` output via the PI_VER_OVERRIDE / PI_BIN test seams.
 * The installer itself is never sourced or executed, so no install side
 * effects run, and the test is fully offline (it never calls the real `pi`).
 *
 * The version matrix is the edge cases named in the issue: below-floor,
 * at-floor, above-floor, and unparseable output (which must fail CLOSED —
 * never assume latest). A canary proves the gate CAN fail: a faked
 * below-floor version must actually be rejected.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PREFLIGHT = path.join(REPO_ROOT, "install-preflight.sh");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const preflightSrc = readFileSync(PREFLIGHT, "utf8");
const installSrc = readFileSync(INSTALL_SH, "utf8");

/** The floor, parsed from install-preflight.sh — the single source of truth. */
function parseMinVersion(): string | null {
  const m = preflightSrc.match(/^MIN_PI_VERSION=(\S+)$/m);
  return m ? (m[1] as string) : null;
}

function extractFn(name: string): string {
  const re = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}\\n`, "m");
  const m = preflightSrc.match(re);
  if (!m) throw new Error(`install-preflight.sh: ${name}() not found — removed or renamed`);
  return m[0];
}

/**
 * Drive pi_preflight_status with a faked `pi --version` output.
 * Override semantics mirror install-preflight.sh: PI_VER_OVERRIDE replaces
 * the probe entirely; PI_BIN swaps the binary so the missing path is
 * reachable without touching the real `pi`.
 */
function statusOf(versionOverride: string): string {
  const fn = extractFn("pi_preflight_status");
  const parse = extractFn("parse_pi_version");
  const code = `
    set -o allexport
    MIN_PI_VERSION=${minVersion}
    set +o allexport
    ${parse}
    ${fn}
    pi_preflight_status
  `;
  return execFileSync("bash", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, PI_VER_OVERRIDE: versionOverride, "__PI_TEST_SET": "1" },
  }).trim();
}

function statusOfMissingPi(): string {
  const fn = extractFn("pi_preflight_status");
  const parse = extractFn("parse_pi_version");
  const code = `
    set -o allexport
    MIN_PI_VERSION=${minVersion}
    set +o allexport
    ${parse}
    ${fn}
    pi_preflight_status
  `;
  return execFileSync("bash", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, PI_BIN: "pi-ensemble-test-no-such-binary" },
  }).trim();
}

const minVersion = parseMinVersion();
assert(minVersion !== null, "install-preflight.sh declares MIN_PI_VERSION (single source of truth)");
assert(
  minVersion === "0.84.4",
  `floor is 0.84.4 per the #578 operator decision (got ${minVersion ?? "none"})`,
);
assert(
  !installSrc.match(/^MIN_PI_VERSION=/m),
  "install.sh does not hardcode its own floor — it sources install-preflight.sh",
);
assert(
  installSrc.includes('source "$ENSEMBLE_DIR/install-preflight.sh"'),
  "install.sh sources install-preflight.sh",
);

if (minVersion === null) {
  console.error("cannot continue without a floor — aborting");
  process.exit(1);
}

// ---------------------------------------------- the version matrix

{
  // [faked `pi --version` output, expected status prefix]
  const cases: Array<[string, string]> = [
    // Below the floor — the #571 incident shape (0.84.3 shipped the bug).
    ["0.84.3", "old"],
    ["0.83.9", "old"],
    ["0.7.9", "old"],
    // Numeric (not lexicographic) compare: 0.8.10 < 0.84.4, 0.9.0 > 0.84.4.
    // Wait: 0.9.0 has minor 9 which is LESS than 84. So 0.9.0 < 0.84.4.
    // Use 0.85.0 for the above-floor numeric case instead.
    ["0.8.10", "old"],
    ["0.85.0", "ok"],
    ["1.0.0", "ok"],
    // At the floor — exactly MIN_PI_VERSION passes.
    [minVersion, "ok"],
    // Above the floor — new releases are fine; a floor, not an exact pin.
    ["0.84.5", "ok"],
    ["0.85.0", "ok"],
    // Suffix tolerance: the first whitespace-separated token is the version.
    [`${minVersion} (dev build)`, "ok"],
    ["0.84.4  ", "ok"],
    // Unparseable output fails CLOSED — never assume latest.
    ["latest", "unparseable"],
    ["garbage", "unparseable"],
    ["", "unparseable"],
  ];
  for (const [version, expected] of cases) {
    const got = statusOf(version);
    assert(
      got.startsWith(expected),
      `pi "${version}" → ${expected}… (got "${got}")`,
    );
  }

  // A below-floor status must NAME the floor and the reason — an upgrade
  // hint that says "upgrade" without the number is the old defect with new
  // words.
  const below = statusOf("0.84.3");
  assert(
    below.includes(minVersion),
    `below-floor message names the floor (${minVersion}): "${below}"`,
  );
  assert(
    /0\.84\.3/.test(below),
    "below-floor message records the reason (the 0.84.3 bug): " + below,
  );
}

// ---------------------------------------------- the missing-pi path

{
  // No binary named PI_BIN on PATH — the presence check must win before the
  // probe, and install.sh's REQUIRED_CLIS entry supplies the install hint.
  const got = statusOfMissingPi();
  assert(got === "missing", `missing pi → "missing" (got "${got}")`);

  const hint = installSrc.match(/"pi:([^"]*pi-coding-agent@\$\{MIN_PI_VERSION\})"/);
  assert(
    hint !== null,
    "REQUIRED_CLIS carries a pi entry (the missing-case install hint)",
  );
  if (hint) {
    assert(
      hint[1].endsWith("@${MIN_PI_VERSION}"),
      `the install hint installs the pinned floor via MIN_PI_VERSION, not unpinned latest (got "${hint[1]}")`,
    );
    assert(
      !/@latest\b/.test(hint[1]),
      "the install hint never installs @latest",
    );
  }
}

// ---------------------------------------------- install.sh wires the check

{
  assert(
    /PI_STATUS="\$\(pi_preflight_status\)"/.test(installSrc),
    "install.sh calls pi_preflight_status and binds it to PI_STATUS",
  );
  assert(
    installSrc.includes('old:*'),
    "install.sh handles the below-floor status with an upgrade branch",
  );
  assert(
    /unparseable:\*/.test(installSrc),
    "install.sh handles the unparseable status with a fail-closed branch",
  );
  const upgradeIdx = installSrc.search(/Upgrade with: bun add -g @earendil-works\/pi-coding-agent@\$\{MIN_PI_VERSION\}/);
  assert(
    upgradeIdx !== -1,
    "install.sh's upgrade hint installs the pinned floor via MIN_PI_VERSION, not a hardcoded value",
  );
}

// ---------------------------------------------- the gate CAN fail

{
  // Same code path, wrong floor: against a floor of 9.9.9 the at-floor case
  // 0.84.4 must be REJECTED. If the gate always passed, this would not.
  const fn = extractFn("pi_preflight_status");
  const parse = extractFn("parse_pi_version");
  const code = `
    set -o allexport
    MIN_PI_VERSION=9.9.9
    set +o allexport
    ${parse}
    ${fn}
    pi_preflight_status
  `;
  const got = execFileSync("bash", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, PI_VER_OVERRIDE: "0.84.4" },
  }).trim();
  assert(
    got.startsWith("old"),
    `canary: with floor 9.9.9, pi 0.84.4 is rejected (got "${got}") — a gate never observed to fail is worthless`,
  );
}

console.log(exit === 0 ? "\nAll pi-min-version checks passed." : "\nFAILED");
process.exit(exit);
