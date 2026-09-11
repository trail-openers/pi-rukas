#!/usr/bin/env bun
/**
 * Minimum oo (double-o) version floor for install.sh — issue #715.
 *
 * install.sh used to preflight `oo` with presence only (`command -v`), so a
 * host at 0.3.1 (which lacks the npm/pnpm/yarn/bun test+build compression
 * patterns added in 0.5.0) installed fine and then fell through to UNBOUNDED
 * PASSTHROUGH for those commands — the token-waste the research quantified.
 * The fix is a FLOOR, not an exact pin: new releases are fine, the known-gap
 * window is not.
 *
 * The floor lives in install-preflight.sh as `MIN_OO_VERSION` — a single
 * source of truth that this test and test-prerequisite-drift.ts both parse,
 * and that the README install line / Dockerfile pin are cross-checked
 * against. No other file hardcodes the value.
 *
 * Method (same shape as test-pi-min-version.ts): the bash functions are
 * extracted from install-preflight.sh by regex and driven in a fresh `bash -c`
 * with faked `oo version` output via the OO_VER_OVERRIDE / OO_BIN test seams.
 * The installer itself is never sourced or executed, so no install side
 * effects run, and the test is fully offline (it never calls the real `oo`).
 *
 * The version matrix is the edge cases named in the issue: below-floor,
 * at-floor, above-floor, and unparseable output (which must fail CLOSED —
 * never assume latest). A canary proves the gate CAN fail: a faked
 * below-floor version must actually be rejected.
 *
 * Key difference from the pi parser: `oo version` prints "oo 0.5.0" — the
 * binary name is the FIRST token, the version is the SECOND. The oo parser
 * takes the second whitespace-separated token.
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
  const m = preflightSrc.match(/^MIN_OO_VERSION=(\S+)$/m);
  return m ? (m[1] as string) : null;
}

function extractFn(name: string): string {
  const re = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}\\n`, "m");
  const m = preflightSrc.match(re);
  if (!m) throw new Error(`install-preflight.sh: ${name}() not found — removed or renamed`);
  return m[0];
}

/**
 * Drive oo_preflight_status with a faked `oo version` output.
 * Override semantics mirror install-preflight.sh: OO_VER_OVERRIDE replaces
 * the probe entirely; OO_BIN swaps the binary so the missing path is
 * reachable without touching the real `oo`.
 */
function statusOf(versionOverride: string): string {
  const fn = extractFn("oo_preflight_status");
  const parse = extractFn("parse_oo_version");
  const code = `
    set -o allexport
    MIN_OO_VERSION=${minVersion}
    set +o allexport
    ${parse}
    ${fn}
    oo_preflight_status
  `;
  return execFileSync("bash", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, OO_VER_OVERRIDE: versionOverride, __OO_TEST_SET: "1" },
  }).trim();
}

function statusOfMissingOo(): string {
  const fn = extractFn("oo_preflight_status");
  const parse = extractFn("parse_oo_version");
  const code = `
    set -o allexport
    MIN_OO_VERSION=${minVersion}
    set +o allexport
    ${parse}
    ${fn}
    oo_preflight_status
  `;
  return execFileSync("bash", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, OO_BIN: "oo-ensemble-test-no-such-binary" },
  }).trim();
}

const minVersion = parseMinVersion();
assert(
  minVersion !== null,
  "install-preflight.sh declares MIN_OO_VERSION (single source of truth)",
);
assert(
  minVersion === "0.5.0",
  `floor is 0.5.0 per the #715 embargo decision (got ${minVersion ?? "none"})`,
);
assert(
  !installSrc.match(/^MIN_OO_VERSION=/m),
  "install.sh does not hardcode its own oo floor — it sources install-preflight.sh",
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
  // [faked `oo version` output, expected status prefix]
  // `oo version` prints "oo <ver>" — the binary name is the FIRST token.
  // The parser takes the SECOND token, so "oo 0.5.0" parses as version 0.5.0.
  const cases: Array<[string, string]> = [
    // Below the floor — the #715 gap shape (0.3.1 lacks npm/pnpm/yarn patterns).
    ["oo 0.3.1", "old"],
    ["oo 0.4.5", "old"],
    ["oo 0.1.0", "old"],
    // Numeric (not lexicographic) compare.
    ["oo 0.4.9", "old"],
    ["oo 0.6.0", "ok"],
    ["oo 1.0.0", "ok"],
    // At the floor — exactly MIN_OO_VERSION passes.
    [`oo ${minVersion}`, "ok"],
    // Above the floor — new releases are fine; a floor, not an exact pin.
    [`oo ${minVersion}`.replace("0.5.0", "0.5.1"), "ok"],
    // Suffix tolerance: tokens after the version are ignored.
    [`oo ${minVersion} (dev build)`, "ok"],
    ["oo 0.5.0  ", "ok"],
    // Unparseable output fails CLOSED — never assume latest.
    ["latest", "unparseable"],
    ["garbage", "unparseable"],
    ["", "unparseable"],
    // Single-token input: no second token → unparseable (fails closed).
    ["oo", "unparseable"],
  ];
  for (const [version, expected] of cases) {
    const got = statusOf(version);
    assert(got.startsWith(expected), `oo "${version}" → ${expected}… (got "${got}")`);
  }

  // A below-floor status must NAME the floor and the reason — an upgrade
  // hint that says "upgrade" without the number is the old defect with new
  // words.
  const below = statusOf("oo 0.3.1");
  assert(
    below.includes(minVersion),
    `below-floor message names the floor (${minVersion}): "${below}"`,
  );
  assert(
    /0\.3\.1/.test(below),
    "below-floor message records the reason (the 0.3.1 gap): " + below,
  );
}

// ---------------------------------------------- the missing-oo path

{
  // No binary named OO_BIN on PATH — the presence check must win before the
  // probe, and install.sh's REQUIRED_CLIS entry supplies the install hint.
  const got = statusOfMissingOo();
  assert(got === "missing", `missing oo → "missing" (got "${got}")`);

  const hint = installSrc.match(/"oo:[^"]*double-o --version \$\{MIN_OO_VERSION\}[^"]*"/);
  assert(hint !== null, "REQUIRED_CLIS carries an oo entry (the missing-case install hint)");
  if (hint) {
    assert(
      hint[0].includes("--version ${MIN_OO_VERSION}"),
      `the install hint installs the pinned floor via MIN_OO_VERSION, not unpinned latest (got "${hint[0]}")`,
    );
  }
}

// ---------------------------------------------- install.sh wires the check

{
  assert(
    /OO_STATUS="\$\(oo_preflight_status\)"/.test(installSrc),
    "install.sh calls oo_preflight_status and binds it to OO_STATUS",
  );
  assert(
    installSrc.includes("old:*"),
    "install.sh handles the below-floor status with an upgrade branch",
  );
  assert(
    /unparseable:\*/.test(installSrc),
    "install.sh handles the unparseable status with a fail-closed branch",
  );
  const upgradeIdx = installSrc.search(
    /Upgrade with: cargo install double-o --version \$\{MIN_OO_VERSION\}/,
  );
  assert(
    upgradeIdx !== -1,
    "install.sh's upgrade hint installs the pinned floor via MIN_OO_VERSION, not a hardcoded value",
  );
}

// ---------------------------------------------- the gate CAN fail

{
  // Same code path, wrong floor: against a floor of 9.9.9 the at-floor case
  // 0.5.0 must be REJECTED. If the gate always passed, this would not.
  const fn = extractFn("oo_preflight_status");
  const parse = extractFn("parse_oo_version");
  const code = `
    set -o allexport
    MIN_OO_VERSION=9.9.9
    set +o allexport
    ${parse}
    ${fn}
    oo_preflight_status
  `;
  const got = execFileSync("bash", ["-c", code], {
    encoding: "utf8",
    env: { ...process.env, OO_VER_OVERRIDE: "oo 0.5.0" },
  }).trim();
  assert(
    got.startsWith("old"),
    `canary: with floor 9.9.9, oo 0.5.0 is rejected (got "${got}") — a gate never observed to fail is worthless`,
  );
}

console.log(exit === 0 ? "\nAll oo-min-version checks passed." : "\nFAILED");
process.exit(exit);
