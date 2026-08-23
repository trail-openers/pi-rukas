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

import { readFileSync } from "node:fs";
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
  // required tools.
  assert(
    fDocker.some((d) => d.name === "mystery-tool"),
    "canary fixture: Dockerfile names mystery-tool",
  );
  const fRequiredSet = new Set(fRequired);
  const fReverseUnknown = fDocker.filter((d) => !fRequiredSet.has(d.name));
  assert(
    fReverseUnknown.length === 1 && fReverseUnknown[0].name === "mystery-tool",
    `canary: reverse direction flags exactly the unexplained tool — ${JSON.stringify(fReverseUnknown)}`,
  );

  const fForwardMissing = fRequired.filter((n) => !fSection.includes(n));
  assert(
    fForwardMissing.length === 1 && fForwardMissing[0] === "jq",
    `canary: forward direction flags exactly the drifted tool — ${JSON.stringify(fForwardMissing)}`,
  );
}

console.log(exit === 0 ? "\nAll prerequisite-drift checks passed." : "\nFAILED");
process.exit(exit);
