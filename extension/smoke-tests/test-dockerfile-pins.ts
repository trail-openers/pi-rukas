#!/usr/bin/env bun
/**
 * Dockerfile version-pin gate — #713 (inverted by #959).
 *
 * Originally this gate pinned `pi install npm:pi-mcp-adapter@2.32.1` in the
 * .devcontainer/Dockerfile (the #713 EALLOWREMOTE window: 2.33.0 pinned its
 * @modelcontextprotocol/* deps at pkg.pr.new preview tarballs that npm 12's
 * allow-remote=none default rejected).
 *
 * Post-#959 (Pi 1.0.0 native MCP), the adapter is REMOVED from the image —
 * Pi's built-in MCP reads mcp.json directly, and an installed extension that
 * registers `/mcp` would REPLACE the built-in and silently disable native
 * MCP. This gate now asserts the opposite of what it used to: the adapter
 * install line must be ABSENT from the Dockerfile, and the pi version must
 * still be pinned to the install floor (1.0.0, per install-preflight.sh).
 *
 * #2047 adds the image-bloat half of the gate: the build context is the whole
 * repo, so a .dockerignore is what keeps `.git` out of the image, and two
 * heavyweight installs are banned outright — `wigolo` (its npm tree is ~780 MB
 * for an optional /research fallback that reports a failed angle when absent)
 * and the `docker.io` apt package (the engine: dockerd + containerd, ~0.3 GB,
 * when the sandbox only ever talks to the host's bind-mounted socket). Both
 * are apt/npm install sites, so the assertions read executable lines only —
 * prose that explains why the engine is banned must stay free to name it.
 *
 * Proven in both directions (AGENTS.md §12 canary discipline): inline
 * fixture strings with the adapter present fail (the regression shape),
 * with the adapter absent pass.
 *
 * Escape hatch: PI_ENSEMBLE_DOCKERFILE_PINS=0.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DOCKERFILE = path.join(REPO_ROOT, ".devcontainer", "Dockerfile");
const TROUBLESHOOTING = path.join(REPO_ROOT, "docs", "troubleshooting.md");

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
 * The line number (1-based) of an executable `pi install npm:pi-mcp-adapter…`
 * RUN statement, or -1. Comment lines are skipped. Returns the first match
 * so a canary fixture can exercise the "adapter present" shape.
 */
export function findAdapterInstallLine(dockerfile: string): number {
  const lines = dockerfile.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("#")) continue;
    for (const m of t.matchAll(/pi install npm:([\w@/.-]+)/g)) {
      if (m[1] === "pi-mcp-adapter" || m[1].startsWith("pi-mcp-adapter@")) return i + 1;
    }
  }
  return -1;
}

/**
 * The pi version pin in the Dockerfile (`npm install -g … @earendil-works/
 * pi-coding-agent@<version>`), or "" when unpinned.
 */
export function piVersionInDockerfile(dockerfile: string): string {
  const m = dockerfile.match(/@earendil-works\/pi-coding-agent@([0-9][0-9a-z.+-]*)/);
  return m ? (m[1] as string) : "";
}

/**
 * An executable (non-comment) line that installs a heavyweight package the
 * image must not carry: a global npm install of `pkg`, or `pkg` as a bare word
 * in apt-install lines. Comments are skipped so prose may explain the ban.
 * Returns the 1-based line number of the first hit, or -1.
 */
export function findBannedInstallLine(dockerfile: string, pkg: string): number {
  const lines = dockerfile.split("\n");
  // An apt package token: bare `pkg`, optionally followed by a version
  // qualifier, and optionally ending the line with a RUN continuation.
  const pkgToken = new RegExp(`(^|\\s)${pkg}(?:=[\\w.:+~-]+)?(?:\\s|$|\\\\$)`);
  // A global npm install of `pkg` (with or without a version tag).
  const npmInstall = new RegExp(`npm\\s+install\\s+-g[^\\n]*\\b${pkg}(@[\\w.+-]+)?\\b`);
  // A RUN's continuation lines carry the apt package list, so the install
  // context is tracked across the whole instruction, not per line.
  let aptInstall = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("#")) continue;
    if (npmInstall.test(t)) return i + 1;
    if (/^RUN\b/.test(t)) aptInstall = false;
    if (/apt-get\s+install\b/.test(t)) aptInstall = true;
    if (aptInstall && pkgToken.test(t)) return i + 1;
    if (!t.endsWith("\\")) aptInstall = false;
  }
  return -1;
}

/**
 * True when the .dockerignore text ignores `.git` (a leading-exclusion line,
 * not a comment or a negation).
 */
export function dockerignoreExcludesGit(text: string): boolean {
  return text
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === ".git" || /^\.git\b\/*$/.test(l));
}

/**
 * The troubleshooting.md section for the GHCR pull failure: from the
 * `### … returns `denied`` heading to the next `###` heading (exclusive).
 */
export function ghcrTroubleshootingSection(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^###\s.*ghcr\.io/.test(l.trim()) && /denied/.test(l));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && /^###\s/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

// ---------------------------------------------------------------- the gate

if (process.env.PI_ENSEMBLE_DOCKERFILE_PINS === "0") {
  console.log("PI_ENSEMBLE_DOCKERFILE_PINS=0 — dockerfile-pin gate skipped.");
  process.exit(0);
}

{
  const dockerfile = read(".devcontainer/Dockerfile");
  // The adapter MUST be absent from the Dockerfile (post-#959: native MCP
  // makes the bridge obsolete, and an installed adapter would silently
  // disable native MCP by registering /mcp).
  const adapterLine = findAdapterInstallLine(dockerfile);
  assert(
    adapterLine === -1,
    `Dockerfile does NOT install pi-mcp-adapter (line ${adapterLine === -1 ? "(absent — correct)" : adapterLine}) — Pi 1.0.0's native MCP replaces the bridge (issue #959)`,
  );
  // The pi version must still be pinned (the original #713 concern that
  // unpinned installs drift to a version that breaks the image build).
  const piVersion = piVersionInDockerfile(dockerfile);
  assert(
    piVersion !== "",
    `Dockerfile pi install is version-pinned (got: ${piVersion === "" ? "unpinned — the #713 EALLOWREMOTE window" : piVersion})`,
  );
  // #2047: the two heavyweight installs that made the image ~4.8 GB. Neither
  // may come back as an executable install line.
  for (const [pkg, why] of [
    ["wigolo", "~780 MB npm tree for an optional /research fallback"],
    ["docker.io", "the docker engine (dockerd + containerd) when only the CLI is used"],
  ] as const) {
    const line = findBannedInstallLine(dockerfile, pkg);
    assert(
      line === -1,
      `Dockerfile does NOT install ${pkg} (line ${line === -1 ? "(absent — correct)" : line}) — ${why} (issue #2047)`,
    );
  }
  // #2047: the build context is the whole repo, so .dockerignore is the only
  // thing keeping .git (and other local-only trees) out of the image.
  const dockerignorePath = path.join(REPO_ROOT, ".dockerignore");
  assert(
    existsSync(dockerignorePath),
    ".dockerignore exists at the repo root (the build context of all three build sites)",
  );
  assert(
    existsSync(dockerignorePath) && dockerignoreExcludesGit(read(".dockerignore")),
    ".dockerignore excludes .git from the build context (issue #2047)",
  );
}

{
  const section = ghcrTroubleshootingSection(read("docs/troubleshooting.md"));
  assert(section.length > 0, "docs/troubleshooting.md has the GHCR pull-failure (denied) entry");
  if (section.length > 0) {
    assert(/`?denied`?/.test(section), "GHCR troubleshooting entry names the `denied` daemon error string");
    assert(
      /`?unauthorized`?/.test(section),
      "GHCR troubleshooting entry names the `unauthorized` symptom variant (both point at the private-package fix)",
    );
  }
}

// ---------------------------------------------------------------- the gate CAN fail (canaries, AGENTS.md §12)

{
  // Canary 1: a Dockerfile WITH the adapter install must be flagged.
  const withAdapter = [
    "# Pinned per nicobailon/pi-mcp-adapter#547 (legacy)",
    "RUN npm install -g npm@latest",
    "RUN pi install npm:pi-mcp-adapter@2.32.1 || true \\",
    '    && test -d "$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter" || exit 1;',
  ].join("\n");
  assert(
    findAdapterInstallLine(withAdapter) !== -1,
    "canary: a Dockerfile with the adapter install IS detected (the gate's assert would fail on this)",
  );

  // Canary 2: a Dockerfile WITHOUT the adapter must be clean.
  const withoutAdapter = [
    "# Pi 1.0.0 (native MCP — no bridge needed, issue #959)",
    "RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0",
  ].join("\n");
  assert(
    findAdapterInstallLine(withoutAdapter) === -1,
    "canary: a Dockerfile without the adapter passes the absence check",
  );
  assert(
    piVersionInDockerfile(withoutAdapter) === "1.0.0",
    "canary: the pi version pin parses (1.0.0)",
  );

  // Canary 3: an unpinned pi install is still flagged (the original #713 concern).
  const unpinnedPi = "RUN npm install -g @earendil-works/pi-coding-agent";
  assert(
    piVersionInDockerfile(unpinnedPi) === "",
    "canary: an unpinned pi install parses as empty (the EALLOWREMOTE regression shape)",
  );

  // Canary 4: the npm@latest self-update line must stay invisible to the
  // adapter-absence check (it is not an adapter install).
  const npmLatestOnly = "RUN apt-get install -y x && npm install -g npm@latest";
  assert(
    findAdapterInstallLine(npmLatestOnly) === -1,
    "canary: `npm install -g npm@latest` is not treated as a pi-mcp-adapter install site",
  );

  // Canary 5 (#2047): the banned-install scanner trips on each regression
  // shape, and stays quiet on the shipped forms — the comment that explains
  // the ban, the deb-extraction line, and the compose plugin's apt entry.
  const wigoloMutant = [
    "# wigolo — keyless local web-intelligence CLI",
    "RUN npm install -g --ignore-scripts wigolo@0.2.1 || true",
  ].join("\n");
  assert(
    findBannedInstallLine(wigoloMutant, "wigolo") === 2,
    "canary: a reintroduced wigolo global install IS detected (line 2 of the fixture)",
  );
  const dockerIoMutant = [
    "RUN apt-get update && apt-get install -y --no-install-recommends \\",
    "      git jq \\",
    "      docker.io \\",
    "      tini \\",
    "    && rm -rf /var/lib/apt/lists/*",
  ].join("\n");
  assert(
    findBannedInstallLine(dockerIoMutant, "docker.io") === 3,
    "canary: `docker.io` back in the apt install list IS detected (line 3 of the fixture)",
  );
  const cleanDocker = [
    // The comment names the banned package to explain the ban — comments never count.
    "# `docker.io` is the engine, so we never apt-install it.",
    // The compose plugin is an apt install and must not trip the docker.io check.
    "      docker-compose-v2 \\",
    // The CLI is extracted from the deb; apt only downloads it, never installs.
    "    && apt-get download docker.io \\",
    "    && dpkg-deb -x docker.io_*.deb ./d \\",
    "RUN npm install -g --ignore-scripts ctx7 || true \\",
  ].join("\n");
  assert(
    findBannedInstallLine(cleanDocker, "docker.io") === -1,
    "canary: apt-get download / dpkg-deb of the docker.io deb and its comment are NOT an install site",
  );
  assert(
    findBannedInstallLine(cleanDocker, "wigolo") === -1,
    "canary: a Dockerfile without a wigolo install passes the absence check",
  );

  // Canary 6 (#2047): the .dockerignore scanner rejects a missing/renamed entry.
  assert(
    dockerignoreExcludesGit(".git\nnode_modules\n"),
    "canary: a .dockerignore with `.git` passes the exclusion check",
  );
  assert(
    !dockerignoreExcludesGit("# .git is large\n.gitignore\nnode_modules\n"),
    "canary: a .dockerignore that only comments or names .gitignore fails the exclusion check",
  );
  assert(
    !dockerignoreExcludesGit("!.git\nnode_modules\n"),
    "canary: a negated `!.git` line fails the exclusion check (it un-ignores, not ignores)",
  );
}

{
  const goodSection =
    "### `docker pull ghcr.io/trail-openers/pi-rukas:latest` returns `denied`\n\nSymptom: " +
    "denied (or `unauthorized`) from the docker daemon. Fix: make the package public.\n\n### Next entry\n";
  const s = ghcrTroubleshootingSection(goodSection);
  assert(
    s.includes("denied") && s.includes("unauthorized"),
    "canary: troubleshooting section scanner captures both error strings between heading and next ###",
  );
  const badSection =
    "### `docker pull ghcr.io/trail-openers/pi-rukas:latest` returns `denied`\n\nSymptom: denied only.\n\n### Next entry\n";
  const s2 = ghcrTroubleshootingSection(badSection);
  assert(
    s2.includes("denied") && !s2.includes("unauthorized"),
    "canary: troubleshooting section without the unauthorized variant is detectable (the assertion above flags it)",
  );
  assert(
    ghcrTroubleshootingSection("### unrelated entry\n\nno denied here\n") === "",
    "canary: a doc without the GHCR entry parses as empty (the presence assertion flags it)",
  );
}

console.log(exit === 0 ? "\nAll dockerfile-pin checks passed." : "\nFAILED");
process.exit(exit);
