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
 * are apt/npm install sites, so the assertions read executable RUN
 * instructions only (backslash continuations joined) — prose that explains
 * why the engine is banned must stay free to name it. A package matches as a
 * whole token with its legal qualifiers (`=ver`, `@ver`, `_arch.deb`), never
 * as a substring of a longer package name.
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
 * The package names that may never be installed into the image (#2047), each
 * with the reason the ban exists. Consumed by the gate loop below and by the
 * canaries, so a new banned package is one entry here.
 */
const BANNED_PACKAGES: readonly (readonly [string, string])[] = [
  ["wigolo", "~780 MB npm tree for an optional /research fallback"],
  ["docker.io", "the docker engine (dockerd + containerd) when only the CLI is used"],
];

/** The install sites that make an instruction an install of `pkg`. */
const INSTALL_PATTERNS: readonly RegExp[] = [
  /\bapt-get\s+install\b/,
  /\bapt\s+install\b/,
  /\bdpkg\s+-i\b/,
  // npm/bun global installs only — a local `npm install wigolo` is not this gate's concern.
  /\bnpm\s+i(?:nstall)?\b[^\n]*(?:\s-g\b|\s--global\b)/,
  /\bbun\s+add\b[^\n]*(?:\s-g\b|\s--global\b)/,
  /\bnpx\b/,
];

/**
 * The executable RUN instructions of a Dockerfile, each joined across its
 * backslash continuations so a package on a continuation line is seen in the
 * same install context as the `apt-get install` that introduced it. Comment
 * lines are dropped (prose may name a banned package to explain the ban) and
 * line numbers are reported against the FIRST line of the instruction.
 */
function runInstructions(dockerfile: string): { startLine: number; text: string }[] {
  const raw = dockerfile.split("\n");
  const instructions: { startLine: number; text: string }[] = [];
  let current: { startLine: number; parts: string[] } | null = null;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].trim();
    if (t.startsWith("#")) continue;
    // A trailing backslash is the continuation marker, not shell text.
    const continued = t.endsWith("\\");
    const body = continued ? t.slice(0, -1).trim() : t;
    if (/^RUN\b/.test(body) && current === null) {
      current = { startLine: i + 1, parts: [] };
    }
    if (current === null) continue;
    current.parts.push(body);
    if (!continued) {
      instructions.push({ startLine: current.startLine, text: current.parts.join(" ") });
      current = null;
    }
  }
  if (current !== null) {
    instructions.push({ startLine: current.startLine, text: current.parts.join(" ") });
  }
  return instructions;
}

/**
 * An executable RUN instruction that installs a package the image must not
 * carry: an apt install / dpkg -i listing it, a global npm or bun install of
 * it, or an `npx` of it. Matching is per whitespace-separated token, so a
 * substring of another package name (`docker-compose-v2`, a future
 * `wigolo-helper`) never trips the ban. Comments never count and
 * `apt-get download` / `dpkg-deb -x` of a deb are not install sites. Returns
 * the 1-based line of the instruction's first line, or -1.
 */
export function findBannedInstallLine(dockerfile: string, pkg: string): number {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A package token is the name plus any of its legal qualifier forms: an apt
  // pin (`=1.2`), an npm tag (`@1.2`), a deb filename (`_24.0.7_amd64.deb`,
  // wildcard included), or a dotted suffix that follows a name character
  // (`.deb`, `.tools`). A hyphen never separates — `wigolo-helper` is another
  // package — so a substring of a longer name never matches.
  const QUALIFIER = "(?:[=@][\\w.+-:~]+|_[^\\s]*|(?<=\\w)\\.(?:[\\w.+-:~]+|deb))";
  const pkgToken = new RegExp(`^${escaped}${QUALIFIER}*$`);
  for (const instr of runInstructions(dockerfile)) {
    if (!INSTALL_PATTERNS.some((re) => re.test(instr.text))) continue;
    for (const token of instr.text.split(/\s+/)) {
      if (pkgToken.test(token)) return instr.startLine;
    }
  }
  return -1;
}

/**
 * True when the .dockerignore text ignores the VCS tree: one of the accepted
 * exclusion forms below, on a line that is neither a comment nor a negation
 * (a leading `!` un-ignores rather than ignores).
 */
const GIT_IGNORE_FORMS: readonly RegExp[] = [
  /^\.git$/,
  /^\/\.git$/,
  /^\.git\/$/,
  /^\.git\/\*\*$/,
  /^\*\*\/\.git$/,
];

export function dockerignoreExcludesGit(text: string): boolean {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .some((l) => !l.startsWith("!") && GIT_IGNORE_FORMS.some((re) => re.test(l)));
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
  for (const [pkg, why] of BANNED_PACKAGES) {
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
    assert(
      /`?denied`?/.test(section),
      "GHCR troubleshooting entry names the `denied` daemon error string",
    );
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
    findBannedInstallLine(dockerIoMutant, "docker.io") === 1,
    "canary: `docker.io` back in the apt install list IS detected (the RUN instruction at line 1 of the fixture)",
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

  // Canary 7 (#2047 fix wave): the reinstall gate reads whole RUN instructions,
  // so every common way of bringing a banned package back is an install site —
  // not just the `apt-get install` / `npm install -g` the first revision knew.
  const reinstallMutants: readonly (readonly [string, string, string])[] = [
    ["`npm i -g wigolo@0.2.1`", "RUN npm i -g wigolo@0.2.1 || true", "wigolo"],
    ["`npm install --global wigolo`", "RUN npm install --global wigolo", "wigolo"],
    ["`bun add -g wigolo`", "RUN bun add -g wigolo", "wigolo"],
    [
      "a multi-line `npm install -g` with the package on the next line",
      "RUN npm install -g \\\n      wigolo \\\n      && true",
      "wigolo",
    ],
    ["`npx wigolo`", "RUN npx wigolo --version", "wigolo"],
    ["a bare `apt install docker.io`", "RUN apt install -y docker.io", "docker.io"],
    ["`dpkg -i docker.io_*.deb`", "RUN dpkg -i docker.io_*.deb", "docker.io"],
  ];
  for (const [shape, src, pkg] of reinstallMutants) {
    assert(
      findBannedInstallLine(src, pkg) === 1,
      `canary: ${shape} IS detected as an install site (issue #2047)`,
    );
  }
  // The ban matches whole package tokens, so lookalikes never trip it and a
  // banned name inside a longer one is not mistaken for the package.
  assert(
    findBannedInstallLine(
      "RUN apt-get install -y --no-install-recommends docker-compose-v2 wigolo-helper",
      "docker.io",
    ) === -1 &&
      findBannedInstallLine(
        "RUN apt-get install -y --no-install-recommends docker-compose-v2 wigolo-helper",
        "wigolo",
      ) === -1,
    "canary: `docker-compose-v2` / `wigolo-helper` are NOT the banned packages (whole-token match, not substring)",
  );
  // A comment between the instruction and a continuation must not split the
  // install context, and must not itself count as an install site.
  assert(
    findBannedInstallLine(
      [
        "# wigolo is banned (issue #2047) — this comment must not trip the gate",
        "RUN apt-get update && apt-get install -y --no-install-recommends \\",
        "      git jq \\",
        "    && rm -rf /var/lib/apt/lists/*",
      ].join("\n"),
      "wigolo",
    ) === -1,
    "canary: a comment naming the banned package is still not an install site",
  );

  // Canary 8 (#2047 fix wave): every .dockerignore spelling that excludes the
  // VCS tree counts; comments and negations still do not.
  for (const form of [".git", "/.git", ".git/", "**/.git", ".git/**"]) {
    assert(
      dockerignoreExcludesGit(`node_modules\n${form}\ndist\n`),
      `canary: a .dockerignore entry \`${form}\` counts as the .git exclusion`,
    );
  }
  assert(
    !dockerignoreExcludesGit("# .git/\n# **/.git\n"),
    "canary: commented-out .git exclusion forms do NOT count",
  );
  assert(
    !dockerignoreExcludesGit("!.git/\n!**/.git\n"),
    "canary: negated .git exclusion forms do NOT count",
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
