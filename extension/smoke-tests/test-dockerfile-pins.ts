#!/usr/bin/env bun
/**
 * Dockerfile version-pin gate — #713.
 *
 * .devcontainer/Dockerfile used to install pi-mcp-adapter unpinned
 * (`pi install npm:pi-mcp-adapter`), so pi-mcp-adapter@2.33.0 (published
 * 2026-09-10, whose @modelcontextprotocol/* deps point at pkg.pr.new
 * preview tarballs) broke every publish-image CI build with EALLOWREMOTE
 * under npm 12 (allow-remote defaults to `none`). The pin is now
 * @2.32.1 (last confirmed-clean release) with a comment citing
 * nicobailon/pi-mcp-adapter#547 directly above the RUN line.
 *
 * This gate asserts, on the REAL Dockerfile:
 *   1. the executable `pi install npm:pi-mcp-adapter` RUN line carries an
 *      explicit @version suffix — a full-file `includes()` would trivially
 *      pass, because the comment block above the RUN line repeats the
 *      unpinned literal `pi install npm:pi-mcp-adapter` in its
 *      verification notes. The assertion anchors on `pi install npm:`
 *      tokens that are NOT preceded by `#`, and `npm install -g npm@latest`
 *      (the accepted exception at line ~86) must stay invisible.
 *   2. a comment citing `#547` (and the npm-12 allow-remote default)
 *      appears directly ABOVE the RUN line — the window is measured from
 *      the comment to the start of the RUN statement and tolerates the
 *      multi-line shell-continuation recipe that follows.
 *   3. docs/troubleshooting.md's GHCR-pull-failure entry names BOTH the
 *      `denied` and the `unauthorized` daemon error strings between its
 *      heading and the next `###` section.
 *
 * Proven in both directions (AGENTS.md §12 canary discipline): inline
 * fixture strings with the pin present pass, with the pin removed/reverted
 * to unpinned fail — exercised through the same exported helpers the real
 * check uses.
 *
 * Escape hatch: PI_ENSEMBLE_DOCKERFILE_PINS=0.
 */

import { readFileSync } from "node:fs";
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
 * The line number (1-based) of the executable `pi install npm:pi-mcp-adapter…`
 * RUN statement, or -1. Comment lines (`#` first char after trim) are
 * skipped — the Dockerfile's verification notes above the RUN line repeat
 * the unpinned literal and must not count as the install site. The line is
 * the START of the RUN statement; continuation lines (shell `…\` recipes)
 * are not scanned, which also keeps the install token inside the post-install
 * guard's `echo "…'pi install npm:pi-mcp-adapter'…"` text invisible.
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
 * The version suffix on the pi-mcp-adapter install line, or "" when the
 * install is unpinned (or absent). Anchored on `pi install npm:` in
 * non-comment lines only, so the comment block and the npm@latest
 * self-update line can never fool this.
 */
export function adapterInstallVersion(dockerfile: string): string {
  const line = findAdapterInstallLine(dockerfile);
  if (line === -1) return "";
  const t = dockerfile.split("\n")[line - 1].trim();
  for (const m of t.matchAll(/pi install npm:pi-mcp-adapter@?([\w.-]*)/g)) {
    if (m[1]) return m[1];
  }
  return "";
}

/**
 * The N lines directly ABOVE the install RUN line, comment lines only,
 * joined. Returns "" when the install line is missing.
 */
export function linesAboveInstall(dockerfile: string, n: number): string {
  const line = findAdapterInstallLine(dockerfile);
  if (line === -1) return "";
  const lines = dockerfile.split("\n");
  const out: string[] = [];
  for (let i = line - 2; i >= 0 && out.length < n; i--) {
    const t = lines[i].trim();
    if (t.startsWith("#")) out.push(t);
  }
  return out.join("\n");
}

/**
 * The troubleshooting.md section for the GHCR pull failure: from the
 * `### … returns \`denied\`` heading to the next `###` heading (exclusive).
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
  const version = adapterInstallVersion(dockerfile);
  assert(
    version !== "",
    `Dockerfile pi-mcp-adapter install is version-pinned (got: ${
      version === "" ? "unpinned — the #713 EALLOWREMOTE window" : version
    })`,
  );
  // 2.32.1 is the last confirmed-clean release; a later version is acceptable
  // only if it is a confirmed-clean registry release (see #547 tracking).
  assert(
    version === "2.32.1" || /^2\.(3[3-9]|[4-9][0-9])\.[0-9]+$|^[3-9]\./.test(version),
    `Dockerfile pi-mcp-adapter pin ${version || "(missing)"} is a confirmed-clean version (2.32.1 or later)`,
  );

  const citation = linesAboveInstall(dockerfile, 15);
  assert(
    citation.includes("#547"),
    "a comment within the 15 lines directly above the RUN line cites nicobailon/pi-mcp-adapter#547",
  );
  assert(
    /allow-remote|npm 12|npm12|npm-12/i.test(citation),
    "the #547 citation comment also names the npm-12 allow-remote default (the EALLOWREMOTE mechanism)",
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
  const pinnedFixture = [
    "# Pinned per nicobailon/pi-mcp-adapter#547: 2.33.0 pins its @modelcontextprotocol/*",
    "# deps at pkg.pr.new tarball URLs, which npm 12's allow-remote=none default",
    "# rejects with EALLOWREMOTE. 2.32.1 is the last confirmed-clean release.",
    "RUN npm install -g npm@latest",
    "RUN pi install npm:pi-mcp-adapter@2.32.1 || true \\",
    '    && test -d "$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter" || { \\',
    "         echo \"ERROR: we explicitly run 'pi install npm:pi-mcp-adapter@2.32.1'\" >&2; \\",
    "         exit 1; \\",
    "       }",
  ].join("\n");
  assert(
    adapterInstallVersion(pinnedFixture) === "2.32.1",
    "canary: fixture with the pin present parses as 2.32.1",
  );
  assert(
    linesAboveInstall(pinnedFixture, 15).includes("#547"),
    "canary: fixture citation comment is visible in the window above the RUN line",
  );

  const unpinnedFixture = pinnedFixture
    .replace("npm:pi-mcp-adapter@2.32.1", "npm:pi-mcp-adapter")
    .replace(
      "we explicitly run 'pi install npm:pi-mcp-adapter'",
      "we explicitly run 'pi install npm:pi-mcp-adapter'",
    );
  assert(
    adapterInstallVersion(unpinnedFixture) === "",
    "canary: fixture with the pin reverted to unpinned parses as empty (the EALLOWREMOTE regression)",
  );

  const commentOnlyFixture = [
    "# Verified: pi install npm:pi-mcp-adapter@2.32.1 works on pi 0.84.4",
    "RUN pi install npm:pi-mcp-adapter || true",
  ].join("\n");
  assert(
    adapterInstallVersion(commentOnlyFixture) === "",
    "canary: a comment-only mention of the pin does not count (the install line itself must be pinned)",
  );

  // The npm@latest self-update line must stay invisible to the pin check.
  const npmLatestOnly = "RUN apt-get install -y x && npm install -g npm@latest";
  assert(
    findAdapterInstallLine(npmLatestOnly) === -1 && adapterInstallVersion(npmLatestOnly) === "",
    "canary: `npm install -g npm@latest` is not treated as the pi-mcp-adapter install site",
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
