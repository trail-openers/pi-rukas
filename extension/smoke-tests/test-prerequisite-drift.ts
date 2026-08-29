#!/usr/bin/env bun
/**
 * Prerequisite-drift gate — #489.
 *
 * Three sources describe pi-ensemble's prerequisites and they already
 * disagree on main: the README Prerequisites section declares a set of CLIs,
 * install.sh's REQUIRED_CLIS array checks a different set (bun and
 * codebase-memory-mcp are absent from it), and the Dockerfile's
 * global-install lines name yet another. The drift was found by manual audit
 * — nothing detects it. The gate compares the SETS, not hardcoded counts, so
 * docs may reflow freely and only a genuinely missing or unexplained name
 * fails.
 *
 * Directions:
 *   forward  — every REQUIRED_CLIS name appears somewhere in the README
 *              Prerequisites section (a presence check, not markdown-table
 *              row parsing, so prose and formatting stay free to change).
 *   reverse  — every global install in .devcontainer/Dockerfile names either
 *              a REQUIRED_CLIS entry or an EXCEPTIONS key.
 *   versions — every install surface that declares a pi version (install.sh
 *              MIN_PI_VERSION, README install line, Dockerfile global install
 *              pin) declares one, and none is below the install floor (#578;
 *              the #571 incident is the failure this exists to catch).
 *
 * EXCEPTIONS is a Record<string, string> following the NOT_FOR_PM shape
 * (test-pm-tool-permissions.ts): an entry is a decision, not an oversight.
 * It ships PRE-SEEDED with today's three known divergences, each referencing
 * the docs issue to fix it. Each seeded entry is deleted as that docs fix
 * lands — a stale entry is dead config that hides a typo in a live one.
 *
 * Proven in both directions (AGENTS.md §12: "a gate never observed to fail
 * is worthless"): a static fixture pair under fixtures/ where one side
 * declares a tool the other omits is flagged by the SAME exported functions
 * the real check uses.
 *
 * Escape hatch: PI_ENSEMBLE_PREREQ_DRIFT=0.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURES = path.resolve(import.meta.dirname, "fixtures", "prerequisite-drift");

/**
 * Tools deliberately outside the check, each with the reason. Keyed by the
 * name as it appears in the sources. Pre-seeded with today's three known
 * divergences; delete an entry as the referenced docs issue lands.
 */
const EXCEPTIONS: Record<string, string> = {
  // In the Dockerfile (pi install npm:pi-mcp-adapter) but absent from the
  // README Prerequisites table. #488 adds the README row; delete this entry
  // when #488 lands.
  "pi-mcp-adapter": "MCP bridge — Pi core has no native MCP; README row lands in #488",
  // In the Dockerfile (upstream install script) and in the README, but not a
  // CLI on PATH that check_cmd can probe — an MCP server binary loaded via
  // pi-mcp-adapter, wired by install.sh step 6. Never a REQUIRED_CLIS entry.
  "codebase-memory-mcp":
    "MCP server binary, not a PATH CLI — preflighted by install.sh step 6 instead",
  // Declared in the README Prerequisites table (runtime for the extension)
  // but never in REQUIRED_CLIS: install.sh uses bun/npm to install extension
  // deps, so requiring it on PATH would warn the majority of hosts. #488
  // owns the README-side wording; delete this entry when it lands.
  bun: "declared in README as extension runtime, not preflighted on PATH — install.sh falls back to npm",
  // The Dockerfile's npm self-update line — infrastructure, not a prerequisite.
  "npm@latest": "npm self-update in the Dockerfile — not a pi-ensemble prerequisite",
  // The Dockerfile installs the npm package @earendil-works/pi-coding-agent;
  // the REQUIRED_CLIS entry is the binary it installs (`pi`). Same tool, two
  // names — this keeps the reverse direction from flagging a false drift.
  "pi-coding-agent": "npm package name — installs the `pi` binary already in REQUIRED_CLIS",
  // The Dockerfile installs the npm package @earendil-works/pi-coding-agent;
  // the REQUIRED_CLIS entry is the binary it installs (`pi`). Same tool, two
  // names — this keeps the reverse direction from flagging a false drift.
  "@earendil-works/pi-coding-agent":
    "npm package name — installs the `pi` binary already in REQUIRED_CLIS",
  // #578 pins the Dockerfile pi install to the install floor with a semver
  // tag; parseDockerInstalls keeps the full tagged name (it does not strip
  // versions, since other tools version differently). Same package as the
  // untagged entry above. The version-level cross-site consistency is
  // asserted below (parsePiFloors) — this entry keeps the NAME-level reverse
  // direction from flagging a false drift.
  "@earendil-works/pi-coding-agent@0.84.4":
    "npm package name with the #578 floor pin — installs the `pi` binary already in REQUIRED_CLIS",
  // cargo installs the package `double-o`; the binary is `oo` (REQUIRED_CLIS).
  "double-o": "cargo package name — installs the `oo` binary already in REQUIRED_CLIS",
  // npm installs the package `parallel-web-cli`; the binary is `parallel-cli`
  // (REQUIRED_CLIS).
  "parallel-web-cli":
    "npm package name — installs the `parallel-cli` binary already in REQUIRED_CLIS",
};

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/**
 * The REQUIRED_CLIS names in install.sh. Each array element is
 * "name:hint" — the name is everything between the opening quote and the
 * FIRST colon (hints are URLs / shell one-liners that contain further
 * colons). One element per line, so this is plain line scanning. Exported
 * so the canary fixture exercises the same code path.
 */
export function parseRequiredClis(installSh: string): string[] {
  const lines = installSh.split("\n");
  const opener = lines.findIndex((l) => l.includes("REQUIRED_CLIS=("));
  if (opener === -1) return [];
  const out: string[] = [];
  for (let i = opener + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === ")") break;
    const q = line.indexOf('"');
    if (q > 0) {
      const name = line.slice(q + 1, line.indexOf(":", q));
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * The README Prerequisites section: `## Prerequisites` to the next `## `
 * heading. Deliberately wider than the table — it spans the
 * `### Install commands` sub-sections, so a name in a code block counts as
 * "named" and table reformatting stays free. Exported so the canary
 * fixture exercises the same code path.
 */
export function readmePrerequisitesSection(readme: string): string {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => /^## Prerequisites\s*$/.test(l));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && /^## (?!#)/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/**
 * Global installs in the Dockerfile — the lines that put a tool on PATH
 * for the image users. Only three installers are recognised (npm global,
 * cargo, pi install npm:); comment lines, apt system packages and the pip
 * artifact puller are excluded. The npm self-update line
 * (`npm install -g npm@latest`) is dropped below; scoped packages
 * (e.g. @earendil-works/pi-coding-agent) keep their full package name — a
 * binary-name remap would be a hidden assumption about every npm package,
 * and the EXCEPTIONS map is the explicit place to record package-vs-binary
 * name differences. Exported so the canary fixture exercises the same
 * code path.
 */
export function parseDockerInstalls(dockerfile: string): { name: string; line: number }[] {
  const out = new Map<string, number>(); // name → first line (1-based)
  dockerfile.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("#")) return;
    const names: string[] = [];
    // npm global: the package is the first NON-FLAG token after the verb —
    // flags like --ignore-scripts sit between the verb and the package.
    for (const m of t.matchAll(/npm install -g[^&|;]*/g)) {
      for (const tok of (m[0] as string).split(/\s+/).slice(3)) {
        if (tok.startsWith("-")) continue;
        names.push(tok);
        break;
      }
    }
    // pi install npm:<pkg>
    for (const m of t.matchAll(/pi install npm:([\w@/.-]+)/g)) {
      names.push(m[1] as string);
    }
    // cargo install <pkg> — cargo package name == binary name here.
    const c = t.match(/\bcargo install\s+(\S+)/);
    if (c && !(c[1] as string).startsWith("-")) names.push(c[1] as string);
    for (const raw of names) {
      if (raw === "npm" || raw === "npm@latest") continue; // npm self-update, not a prerequisite
      if (!out.has(raw)) out.set(raw, i + 1);
    }
  });
  return [...out.entries()].map(([name, line]) => ({ name, line }));
}

/**
 * Pi version floors declared by each install surface, by source. A site
 * that declares no floor at all is returned as "" — that is the drift this
 * gate exists to catch (the #571 incident: an unpinned install resolved to
 * a release shipping a live bug, eleven hours before the fix landed).
 *
 * The install.sh floor lives in install-preflight.sh (sourced by install.sh,
 * #578) — task-a adds that file; until it lands, an install.sh that has not
 * yet been touched by the pinning work is read as having no floor, and the
 * cross-site comparison below degrades to "each present pin is parseable".
 * The fixture (fixtures/prerequisite-drift/install-preflight.sh) carries the
 * same `MIN_PI_VERSION=` line, so the canary exercises the full path.
 */
export function parsePiFloors(sources: {
  installSh: string;
  readme: string;
  dockerfile: string;
}): { installSh: string; readme: string; dockerfile: string } {
  // install.sh / install-preflight.sh: a MIN_PI_VERSION assignment.
  const m = sources.installSh.match(/\bMIN_PI_VERSION="?([0-9][0-9a-z.+-]*)"?/);
  // README: an install-command line naming the pi package with an @version
  // suffix. Scanning raw lines keeps the prose free to reflow.
  const r = sources.readme.match(
    /@earendil-works\/pi-coding-agent@([0-9][0-9a-z.+-]*)/,
  );
  // Dockerfile: the pi global-install line, same package-name shape as the
  // README. The name-level reverse gate (EXCEPTIONS) covers the
  // package-vs-binary question; this is the version on that line.
  const d = sources.dockerfile.match(
    /@earendil-works\/pi-coding-agent@([0-9][0-9a-z.+-]*)/,
  );
  return {
    installSh: m ? m[1] : "",
    readme: r ? r[1] : "",
    dockerfile: d ? d[1] : "",
  };
}

/**
 * Compare two dotted version strings numerically; -1/0/1, or null if
 * either side is not a plain dotted-numeric version. MAJOR.MINOR.PATCH is
 * pi's release grammar, so per-field numeric compare is a correct compare
 * without pre-release handling — no Bun/Node dependency needed.
 */
export function compareVersions(a: string, b: string): number | null {
  const split = (s: string) => s.split(/[.+-]/).map((p) => Number(p));
  const x = split(a);
  const y = split(b);
  if (x.some((n) => !Number.isFinite(n)) || y.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const p = (x[i] ?? 0) - (y[i] ?? 0);
    if (p !== 0) return p > 0 ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------- the gate

if (process.env.PI_ENSEMBLE_PREREQ_DRIFT === "0") {
  console.log("PI_ENSEMBLE_PREREQ_DRIFT=0 — prerequisite-drift gate skipped.");
  process.exit(0);
}

// Premise canaries: if a parser finds nothing, the rest is a pass-by-silence.
const installNames = parseRequiredClis(read("install.sh"));
const readmeSection = readmePrerequisitesSection(read("README.md"));
const dockerInstalls = parseDockerInstalls(read(".devcontainer/Dockerfile"));

assert(
  installNames.length >= 5,
  `parsed ${installNames.length} REQUIRED_CLIS entries from install.sh (expected ≥5)`,
);
assert(readmeSection.length > 100, "parsed a non-trivial README Prerequisites section");
assert(
  dockerInstalls.length >= 4,
  `parsed ${dockerInstalls.length} Dockerfile global installs (expected ≥4): ${dockerInstalls.map((d) => d.name).join(", ")}`,
);

const required = new Set(installNames);
const excepted = new Set(Object.keys(EXCEPTIONS));

{
  // Forward: every REQUIRED_CLIS name is named in the README Prerequisites
  // section. Presence, not table parsing — formatting is free to change.
  const missing = installNames.filter((n) => !readmeSection.includes(n));
  assert(
    missing.length === 0,
    `every REQUIRED_CLIS name appears in the README Prerequisites section${
      missing.length
        ? ` — missing: ${missing.join(", ")} (add a README row, or drop the check from REQUIRED_CLIS with an EXCEPTIONS entry)`
        : ""
    }`,
  );
}

{
  // Reverse: every Dockerfile global install is either required or excepted.
  const unknown = dockerInstalls.filter((d) => !required.has(d.name) && !excepted.has(d.name));
  assert(
    unknown.length === 0,
    `every Dockerfile global install is in REQUIRED_CLIS or EXCEPTIONS${
      unknown.length
        ? ` — unexplained: ${unknown.map((d) => `${d.name} (line ${d.line})`).join(", ")} (add to REQUIRED_CLIS, or to EXCEPTIONS with a reason)`
        : ""
    }`,
  );
}

{
  // Exception hygiene: every EXCEPTIONS key has a non-empty reason. The
  // entries ship pre-seeded with today's known divergences (each comment
  // names the issue that resolves it); the reasons are the record, and a
  // bare key is a decision that hasn't been made yet.
  const empty = Object.entries(EXCEPTIONS).filter(([, reason]) => reason.trim() === "");
  assert(
    empty.length === 0,
    `every EXCEPTIONS entry has a reason${empty.length ? ` — missing: ${empty.map(([k]) => k).join(", ")}` : ""}`,
  );
}

{
  // Version-floor consistency (#578): every install surface that declares a
  // pi version must agree with the install floor. The #571 incident is why
  // this exists — an unpinned install resolved to a release shipping a live
  // bug eleven hours before the fix landed. Unpinned forms are the drift
  // this gate catches; a site declaring no floor at all fails.
  //
  // install.sh declares the floor either inline or in install-preflight.sh
  // (sourced by install.sh, #578 — task-a adds that file). In this
  // workstream's standalone worktree the floor file is not yet present,
  // so the install-side floor is absent and the cross-site compare degrades
  // to "each present pin parses". The canary fixture below exercises the
  // full three-source path (floor + two pins) against the same exported
  // parsePiFloors/compareVersions, so the compare logic is proven even
  // before task-a's file lands; post-integration all three real sources
  // are present and the full assertion runs.
  const installShFloors = [read("install.sh")];
  const preflightPath = path.join(REPO_ROOT, "install-preflight.sh");
  if (existsSync(preflightPath)) installShFloors.push(read("install-preflight.sh"));
  const floors = parsePiFloors({
    installSh: installShFloors.join("\n"),
    readme: read("README.md"),
    dockerfile: read(".devcontainer/Dockerfile"),
  });
  if (existsSync(preflightPath)) {
    assert(
      floors.installSh !== "",
      `install.sh (or install-preflight.sh it sources) declares MIN_PI_VERSION (got: unpinned — the #571 known-bug window is why this gate exists)`,
    );
  }
  assert(
    floors.readme !== "",
    "README install line pins a pi version (unpinned — pin the floor @0.x.y on the install command)",
  );
  assert(
    floors.dockerfile !== "",
    "Dockerfile pi global install pins a version (unpinned — pin the floor @0.x.y on the RUN npm install -g line)",
  );
  if (floors.installSh && floors.readme && floors.dockerfile) {
    const cmp = compareVersions(floors.readme, floors.installSh);
    assert(
      cmp !== null && cmp >= 0,
      `README pi pin ${floors.readme} is at or above the install floor ${floors.installSh}${
        cmp === null ? " (unparseable version)" : cmp < 0 ? " (below floor)" : ""
      }`,
    );
    const cmpD = compareVersions(floors.dockerfile, floors.installSh);
    assert(
      cmpD !== null && cmpD >= 0,
      `Dockerfile pi pin ${floors.dockerfile} is at or above the install floor ${floors.installSh}${
        cmpD === null ? " (unparseable version)" : cmpD < 0 ? " (below floor)" : ""
      }`,
    );
  }
}

// ---------------------------------------------------------------- the gate CAN fail

{
  const fixtureInstall = read(path.relative(REPO_ROOT, path.join(FIXTURES, "install.sh")));
  const fixtureReadme = read(path.relative(REPO_ROOT, path.join(FIXTURES, "README.md")));
  const fixtureDocker = read(path.relative(REPO_ROOT, path.join(FIXTURES, "Dockerfile")));

  const fRequired = parseRequiredClis(fixtureInstall);
  assert(
    fRequired.length === 3,
    `canary fixture: parsed 3 REQUIRED_CLIS entries (got ${fRequired.length})`,
  );

  const fSection = readmePrerequisitesSection(fixtureReadme);
  // The fixture README names git and pi, and omits jq — the forward drift.
  assert(
    fSection.includes("git") && fSection.includes("pi") && !fSection.includes("jq"),
    "canary fixture: README omits jq, names git and pi",
  );

  const fDocker = parseDockerInstalls(fixtureDocker);
  // The fixture Dockerfile names mystery-tool (reverse drift) plus the
  // required tools (the pi pin is excepted at the version-task canary pin).
  assert(
    fDocker.some((d) => d.name === "mystery-tool"),
    "canary fixture: Dockerfile names mystery-tool",
  );
  const fRequiredSet = new Set(fRequired);
  const fExceptedSet = new Set([
    // The fixture's pinned pi package name — excepted by the same
    // name-vs-binary reasoning as the real @earendil-works/pi-coding-agent
    // entry, at the fixture's above-floor canary pin.
    "@earendil-works/pi-coding-agent@0.99.0",
  ]);
  const fReverseUnknown = fDocker.filter(
    (d) => !fRequiredSet.has(d.name) && !fExceptedSet.has(d.name),
  );
  assert(
    fReverseUnknown.length === 1 && fReverseUnknown[0].name === "mystery-tool",
    `canary: reverse direction flags exactly the unexplained tool — ${JSON.stringify(fReverseUnknown)}`,
  );

  const fForwardMissing = fRequired.filter((n) => !fSection.includes(n));
  assert(
    fForwardMissing.length === 1 && fForwardMissing[0] === "jq",
    `canary: forward direction flags exactly the drifted tool — ${JSON.stringify(fForwardMissing)}`,
  );

  // Version gate canary — all three sources present but diverged:
  //   install.sh floor 0.84.4 (fixture install-preflight.sh), README pins
  //   0.84.3 (below floor → must flag), Dockerfile pins 0.99.0 (above floor
  //   → must NOT flag). The same exported parsePiFloors/compareVersions the
  //   real check uses are exercised, so a regression in either function
  //   fails here before it fails on the real (pinned) tree.
  const fFloors = parsePiFloors({
    installSh: read(path.relative(REPO_ROOT, path.join(FIXTURES, "install-preflight.sh"))),
    readme: fixtureReadme,
    dockerfile: fixtureDocker,
  });
  assert(
    fFloors.installSh === "0.84.4",
    `canary fixture: install floor parses as 0.84.4 (got: ${JSON.stringify(fFloors.installSh)})`,
  );
  assert(
    fFloors.readme === "0.84.3",
    `canary fixture: README pin parses as 0.84.3 (got: ${JSON.stringify(fFloors.readme)})`,
  );
  assert(
    fFloors.dockerfile === "0.99.0",
    `canary fixture: Dockerfile pin parses as 0.99.0 (got: ${JSON.stringify(fFloors.dockerfile)})`,
  );
  const fCmpReadme = compareVersions(fFloors.readme, fFloors.installSh);
  assert(
    fCmpReadme !== null && fCmpReadme < 0,
    "canary: below-floor README pin is detected (below floor)",
  );
  const fCmpDocker = compareVersions(fFloors.dockerfile, fFloors.installSh);
  assert(
    fCmpDocker !== null && fCmpDocker > 0,
    "canary: above-floor Dockerfile pin is detected (above floor)",
  );

  // Unpinned forms must fail, not pass silently: a surface with no pi pin
  // anywhere parses to "" and the version gate asserts it is non-empty.
  const fUnpinned = parsePiFloors({ installSh: fixtureInstall, readme: "", dockerfile: "" });
  assert(
    fUnpinned.readme === "" && fUnpinned.dockerfile === "" && fUnpinned.installSh === "",
    "canary: unpinned surfaces parse as empty (the drift the gate flags)",
  );

  // compareVersions edge cases: equal versions are 0; non-dotted input is
  // null (never silently treated as 0).
  assert(compareVersions("0.84.4", "0.84.4") === 0, "canary: equal versions compare 0");
  assert(compareVersions("0.84.4", "garbage") === null, "canary: unparseable version compares null");
}

console.log(exit === 0 ? "\nAll prerequisite-drift checks passed." : "\nFAILED");
process.exit(exit);
