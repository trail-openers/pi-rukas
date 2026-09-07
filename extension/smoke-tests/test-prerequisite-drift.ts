#!/usr/bin/env bun
/**
 * Prerequisite-drift gate — #489.
 *
 * Three sources describe pi-ensemble's prerequisites and disagree:
 * README Prerequisites, install.sh REQUIRED_CLIS, Dockerfile global
 * installs. The gate compares the SETS (not counts) so docs may reflow
 * freely and only a genuinely missing or unexplained name fails.
 *
 * Directions:
 *   forward  — every REQUIRED_CLIS name appears in the README Prerequisites
 *              section (presence check, not table parsing).
 *   reverse  — every Dockerfile global install is a REQUIRED_CLIS entry or
 *              an EXCEPTIONS key.
 *   OR gates — the forge CLI (gh OR glab, #608) is satisfied by EITHER
 *              binary on either surface; `parseDockerInstalls` recognises
 *              forge CLIs via apt-get and piped curl one-liners.
 *   versions — every install surface that declares a pi version declares
 *              one, and none is below the install floor (#578; the #571
 *              incident is the failure this exists to catch).
 *
 * EXCEPTIONS is a Record<string, string> (NOT_FOR_PM shape): an entry is a
 * decision, not an oversight. Delete an entry as its docs issue lands.
 *
 * Proven in both directions (AGENTS.md §12): a static fixture pair where
 * one side declares a tool the other omits is flagged by the SAME exported
 * functions the real check uses.
 *
 * Escape hatch: PI_ENSEMBLE_PREREQ_DRIFT=0.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURES = path.resolve(import.meta.dirname, "fixtures", "prerequisite-drift");

/**
 * Tools deliberately outside the check, each with the reason. Keyed by the
 * name as it appears in the sources. Delete an entry as the referenced
 * docs issue lands.
 */
const EXCEPTIONS: Record<string, string> = {
  // In the Dockerfile (pi install npm:) but absent from the README table.
  // #488 adds the README row; delete when it lands.
  "pi-mcp-adapter": "MCP bridge — Pi core has no native MCP; README row lands in #488",
  // MCP server binary loaded via pi-mcp-adapter, not a PATH CLI. Wired by
  // install.sh step 6. Never a REQUIRED_CLIS entry.
  "codebase-memory-mcp":
    "MCP server binary, not a PATH CLI — preflighted by install.sh step 6 instead",
  // In the README (extension runtime) but never in REQUIRED_CLIS: install.sh
  // uses bun/npm, so requiring it on PATH would warn most hosts. #488.
  bun: "declared in README as extension runtime, not preflighted on PATH — install.sh falls back to npm",
  // Dockerfile npm self-update — infrastructure, not a prerequisite.
  "npm@latest": "npm self-update in the Dockerfile — not a pi-ensemble prerequisite",
  // Dockerfile installs the npm package; REQUIRED_CLIS names the binary it
  // installs. Same tool, two names — keeps the reverse direction clean.
  "pi-coding-agent": "npm package name — installs the `pi` binary already in REQUIRED_CLIS",
  "@earendil-works/pi-coding-agent":
    "npm package name — installs the `pi` binary already in REQUIRED_CLIS",
  // #578 floor pin on the Dockerfile pi install. parseDockerInstalls keeps
  // the full tagged name (doesn't strip versions). Version-level consistency
  // is asserted separately (parsePiFloors); this entry keeps the NAME-level
  // reverse direction from flagging a false drift.
  "@earendil-works/pi-coding-agent@0.84.4":
    "npm package name with the #578 floor pin — installs the `pi` binary already in REQUIRED_CLIS",
  // cargo installs `double-o`; the binary is `oo` (REQUIRED_CLIS).
  "double-o": "cargo package name — installs the `oo` binary already in REQUIRED_CLIS",
  // npm installs `parallel-web-cli`; the binary is `parallel-cli` (REQUIRED_CLIS).
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
 * REQUIRED_CLIS names in install.sh. Each element is "name:hint" — the
 * name is between the opening quote and the FIRST colon. One element per
 * line, so this is plain line scanning. Exported for the canary fixture.
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
 * README Prerequisites section: `## Prerequisites` to the next `## `.
 * Spans the `### Install commands` sub-sections so a name in a code block
 * counts as "named" and table reformatting stays free. Exported for the
 * canary fixture.
 */
export function readmePrerequisitesSection(readme: string): string {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => /^## Prerequisites\s*$/.test(l));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && /^## (?!#)/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/**
 * Global installs in the Dockerfile — lines that put a tool on PATH.
 * Recognised: npm global, cargo, pi install npm:, and forge CLIs (gh/glab)
 * via apt-get or piped curl (#608). Comment lines, other apt packages,
 * and the pip artifact puller are excluded. Exported for the canary.
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
    // Forge CLIs via a piped curl one-liner (e.g. glab's official install
    // script, #608). Recognised by the `glab` marker on the line (the
    // piped URL is generic — `installation.sh` — and doesn't name the
    // binary), so a Dockerfile that pipes in glab without ever naming it
    // elsewhere would otherwise be invisible to the reverse direction.
    // Scoped to glab only: gh's official channel is its apt repo (the
    // apt-get rule below); glab's ONLY channel is the piped script.
    if (/\bglab\b/.test(t)) {
      for (const m of t.matchAll(/curl[^&|;]*\|\s*(?:bash|sh)[^&|;]*/g)) {
        if (m[0]) names.push("glab");
      }
    }
    // Forge CLIs via apt-get install -y gh / glab (OR semantics, #608):
    // install.sh's forge check is satisfied by EITHER binary, so the
    // reverse direction accepts either here. Scoped to gh/glab — other
    // apt packages are OS system packages, out of scope by design.
    const a = t.match(/apt-get install -y[^&|;]*/);
    if (a) {
      for (const tok of (a[0] as string).split(/\s+/).slice(3)) {
        if (tok === "gh" || tok === "glab") names.push(tok);
      }
    }
    for (const raw of names) {
      if (raw === "npm" || raw === "npm@latest") continue; // npm self-update, not a prerequisite
      if (!out.has(raw)) out.set(raw, i + 1);
    }
  });
  return [...out.entries()].map(([name, line]) => ({ name, line }));
}

/**
 * Pi version floors declared by each install surface. A site that declares
 * no floor returns "" — the drift this gate exists to catch (#571). The
 * install.sh floor lives in install-preflight.sh (sourced, #578); the
 * fixture carries the same line so the canary exercises the full path.
 */
export function parsePiFloors(sources: {
  installSh: string;
  readme: string;
  dockerfile: string;
}): { installSh: string; readme: string; dockerfile: string } {
  // install.sh / install-preflight.sh: MIN_PI_VERSION assignment.
  const m = sources.installSh.match(/\bMIN_PI_VERSION="?([0-9][0-9a-z.+-]*)"?/);
  // README: pi package with an @version suffix (raw-line scan keeps prose free).
  const r = sources.readme.match(/@earendil-works\/pi-coding-agent@([0-9][0-9a-z.+-]*)/);
  // Dockerfile: same package-name shape; name-level reverse gate (EXCEPTIONS)
  // covers the package-vs-binary question; this is the version on that line.
  const d = sources.dockerfile.match(/@earendil-works\/pi-coding-agent@([0-9][0-9a-z.+-]*)/);
  return {
    installSh: m ? m[1] : "",
    readme: r ? r[1] : "",
    dockerfile: d ? d[1] : "",
  };
}

/**
 * Compare two dotted version strings numerically; -1/0/1, or null if
 * either is not a plain dotted-numeric version. MAJOR.MINOR.PATCH is
 * pi's release grammar, so per-field numeric compare is correct without
 * pre-release handling.
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
  // Forge CLIs (gh/glab) map to the `forge` pseudo-name in REQUIRED_CLIS;
  // they are accepted here only when the OR-gate is actually declared (the
  // dedicated block below asserts that) — remove the gate and gh/glab
  // become unexplained again.
  const hasForgeGate = installNames.includes("forge");
  const unknown = dockerInstalls.filter((d) => {
    if (required.has(d.name) || excepted.has(d.name)) return false;
    if (hasForgeGate && (d.name === "gh" || d.name === "glab")) return false;
    return true;
  });
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
  // Forge OR-gate (#608): the forge CLI (gh OR glab) must be present on
  // BOTH surfaces. install.sh side: `forge` in REQUIRED_CLIS is the
  // declaration; the real check is the `command -v gh`/`command -v glab`
  // pair (a check probing only gh would silently pass while the issue's
  // AC — "accepts a system with only glab" — is violated). Dockerfile
  // side: at least one of gh/glab must appear as a global install.
  const installSh = read("install.sh");
  const requiredHasForge = installNames.includes("forge");
  const forgeBlockOk = /command -v gh[\s\S]{0,200}?command -v glab|command -v glab[\s\S]{0,200}?command -v gh/.test(installSh);
  assert(
    requiredHasForge && forgeBlockOk,
    `install.sh declares the forge OR-gate (REQUIRED_CLIS has "forge" AND a "command -v gh"/"command -v glab" pair check is present)`,
  );
  const forgeInDocker = dockerInstalls.filter((d) => d.name === "gh" || d.name === "glab");
  assert(
    forgeInDocker.length >= 1,
    `Dockerfile installs at least one forge CLI (gh OR glab)${
      forgeInDocker.length === 0 ? " — neither found: the sandbox image would have no forge CLI" : ""
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
  // Version-floor consistency (#578): every install surface that declares
  // a pi version must agree with the install floor. Unpinned forms are the
  // drift this gate catches (#571). install.sh declares the floor either
  // inline or in install-preflight.sh (sourced, #578).
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
  // The fixture's pinned pi package name — excepted by the same
  // name-vs-binary reasoning as the real @earendil-works/pi-coding-agent.
  const fExceptedSet = new Set(["@earendil-works/pi-coding-agent@0.99.0"]);
  // The fixture install.sh does NOT have the forge OR-gate, so `gh` from
  // the apt-get line is unexplained here — proving the reverse direction
  // correctly flags forge CLIs when the gate is absent.
  const fHasForgeGate = fRequired.includes("forge");
  const fReverseUnknown = fDocker.filter((d) => {
    if (fRequiredSet.has(d.name) || fExceptedSet.has(d.name)) return false;
    if (fHasForgeGate && (d.name === "gh" || d.name === "glab")) return false;
    return true;
  });
  assert(
    fReverseUnknown.length === 2 &&
      fReverseUnknown.some((d) => d.name === "mystery-tool") &&
      fReverseUnknown.some((d) => d.name === "gh"),
    `canary: reverse direction flags exactly the unexplained tools (mystery-tool + gh, no forge gate in fixture) — ${JSON.stringify(fReverseUnknown)}`,
  );

  const fForwardMissing = fRequired.filter((n) => !fSection.includes(n));
  assert(
    fForwardMissing.length === 1 && fForwardMissing[0] === "jq",
    `canary: forward direction flags exactly the drifted tool — ${JSON.stringify(fForwardMissing)}`,
  );

  // Forge OR-gate canary: the fixture's `apt-get install -y gh` line must
  // be recognised by parseDockerInstalls. The reverse-direction assertion
  // above already proves gh appears in `fDocker` (and is flagged as
  // unexplained without the gate) — without the apt rule it would not
  // appear at all.
  assert(
    fDocker.some((d) => d.name === "gh"),
    "canary fixture: parseDockerInstalls recognises the forge CLI via apt-get (gh)",
  );
  // Piped-curl canary: glab's official install channel is a piped curl
  // one-liner. The `glab` marker must be on the same line as the piped
  // curl (per-line processing), so the realistic shape is a RUN line that
  // both pipes the script and references the binary.
  const pipedCurlLine =
    "RUN curl -fsSL https://gitlab.com/gitlab-org/cli/-/raw/main/docs/installation.sh | bash && command -v glab";
  const pipedCurlInstalls = parseDockerInstalls(pipedCurlLine);
  assert(
    pipedCurlInstalls.some((d) => d.name === "glab"),
    "canary: parseDockerInstalls recognises a forge CLI installed via piped curl (glab)",
  );
  // Negative: a piped curl line with no `glab` marker must NOT produce a
  // `glab` entry (the bun/curl line in the real Dockerfile is such a line
  // and must stay invisible to the reverse direction).
  const bunPipedLine = "RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash";
  const bunPipedInstalls = parseDockerInstalls(bunPipedLine);
  assert(
    !bunPipedInstalls.some((d) => d.name === "glab"),
    "canary: piped curl without a glab marker does not produce a glab entry",
  );

  // Version gate canary: install.sh floor 0.84.4 (fixture preflight),
  // README 0.84.3 (below floor → must flag), Dockerfile 0.99.0 (above
  // floor → must NOT flag). Same exported functions the real check uses.
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
  assert(
    compareVersions("0.84.4", "garbage") === null,
    "canary: unparseable version compares null",
  );
}

console.log(exit === 0 ? "\nAll prerequisite-drift checks passed." : "\nFAILED");
process.exit(exit);
