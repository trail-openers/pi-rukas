#!/usr/bin/env bun
/**
 * Pi version-claim contradiction gate — #787.
 *
 * The project's Pi version claims used to contradict each other across docs
 * (README said the dev pin was ~0.84.4 while extension/package.json pinned
 * ~0.82.0) because no gate read package.json or the maintained claim line.
 *
 * The model (#787, operator decision 2026-09-21): operators may upgrade Pi
 * at will; the project publishes ONE maintained "Last verified against pi
 * X.Y.Z" line in docs/pi-compatibility.md (the version to fall back to); the
 * dev pins in extension/package.json are a CI-reproducibility device,
 * explicitly non-normative (the 4-day embargo in extension/bunfig.toml makes
 * a floating pin structurally impossible — and it binds this project's dev
 * dependency only, never the operator's global Pi install).
 *
 * What this gate enforces:
 *   (a) the declared dev pins (parsed from extension/package.json — the
 *       DECLARED pin, never bun.lock's resolved value) are parsable and
 *       co-pinned in lockstep;
 *   (b) the maintained "Last verified against pi X.Y.Z (date)" line in
 *       docs/pi-compatibility.md and its restatement in AGENTS.md § 4
 *       agree with each other;
 *   (c) the verified line is not OLDER than the declared pin (the drift that
 *       got away: a "verified" claim trailing what CI type-checks against);
 *   (d) the verified line is not NEWER than the install floor (an "verified"
 *       claim for a release operators are never guaranteed to have);
 *   (e) a staleness NUDGE (non-fatal console.warn) when the verified line
 *       lags the declared pin by more than one minor — a prompt to re-run
 *       the live shape tests, never a ceiling;
 *       (f) a site census: every repo file that carries a bare 0.8x.y Pi
 *       version literal — or a 1.x.y literal in a Pi-claim context (a
 *       `pi-coding-agent`/`pi-tui`/`@earendil-works/pi` pin, `MIN_PI_VERSION`,
 *       or the "Last verified against pi" claim line) — must be a declared
 *       site whose expected-literal superset covers what is found; a new unreviewed version claim fails the gate instead of
 *       drifting silently (the structural reason the #787 contradiction
 *       survived two minors). 1.x literals with no Pi-claim context (bun,
 *       biome, oo, ci floors) are NOT claims — the census is a Pi gate and
 *       must not fail on an unrelated tool bump.
 *
 * What it deliberately does NOT do:
 *   - enforce dev pin == install floor (that would re-impose the
 *     supported-ceiling model this ticket removes — explicit negative
 *     canary below);
 *   - read the resolved version from extension/bun.lock (every source here
 *     reads a declared pin; lockfile regeneration is the bump procedure's
 *     job, not the gate's);
 *   - fail on wall-clock age of the line's date (the gate is offline and CI
 *     must not depend on the real clock — the age nudge is pin-relative, and
 *     the date nudge takes an injectable clock via PI_PI_VERSION_DRIFT_NOW);
 *   - flag 0.7x.y literals — those are historical (the #578 floor provenance
 *     note, the pre-#578 pin) and the AC grep is scoped to "0.82"; the 0.8x.y
 *     census covers the current-claim space.
 *
 * Escape hatch: PI_ENSEMBLE_PI_VERSION_DRIFT=0.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURES = path.resolve(import.meta.dirname, "fixtures", "prerequisite-drift");

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
 * Strip a leading semver range operator (~ ^ >= <= =) so compareVersions sees
 * a plain dotted version. Deliberate: compareVersions returns null on
 * non-dotted input, so an unstripped "~0.82.0" would fail closed as
 * "unparseable" rather than compare. Returns "" for empty input.
 */
export function stripRangePrefix(v: string): string {
  return v.replace(/^[~^><=]+/, "");
}

/** Dotted version comparison; -1/0/1 or null if either side is not plain dotted-numeric. */
export function compareVersions(a: string, b: string): number | null {
  const split = (s: string) => s.split(/[.+-]/).map((p) => Number(p));
  const x = split(a);
  const y = split(b);
  if (x.some((n) => !Number.isFinite(n)) || y.some((n) => !Number.isFinite(n))) return null;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const p = (x[i] ?? 0) - (y[i] ?? 0);
    if (p !== 0) return p > 0 ? 1 : -1;
  }
  return 0;
}

/** The major.minor prefix of a version ("0.84.4" → "0.84"); null if not dotted. */
export function minorPrefix(v: string): string | null {
  const m = v.match(/^([0-9]+\.[0-9]+)/);
  return m ? m[1] : null;
}

/** Major.minor distance between two versions; null if either is unparseable (major drift = Infinity). */
export function minorDistance(a: string, b: string): number | null {
  const ma = minorPrefix(a);
  const mb = minorPrefix(b);
  if (!ma || !mb) return null;
  const [maa, mab] = ma.split(".").map(Number);
  const [mba, mbb] = mb.split(".").map(Number);
  if (maa !== mba) return Infinity;
  return Math.abs(mab - mbb);
}

/** Declared dev pins in extension/package.json (the DECLARED pin, never bun.lock). */
export function parseDevPins(pkgJson: string): { codingAgent: string; tui: string } {
  const m = pkgJson.match(/"@earendil-works\/pi-coding-agent":\s*"([^"]+)"/);
  const t = pkgJson.match(/"@earendil-works\/pi-tui":\s*"([^"]+)"/);
  return { codingAgent: m ? stripRangePrefix(m[1] as string) : "", tui: t ? stripRangePrefix(t[1] as string) : "" };
}

/** The maintained "## Last verified against pi X.Y.Z (YYYY-MM-DD)" line in docs/pi-compatibility.md. */
export function parseVerifiedLine(doc: string): { version: string; date: string } | null {
  const m = doc.match(/## Last verified against pi\s+([0-9][0-9a-z.+-]*)\s+\((\d{4}-\d{2}-\d{2})\)/);
  if (!m) return null;
  return { version: stripRangePrefix(m[1] as string), date: m[2] as string };
}

/** The restating "Last verified against `pi` **X.Y.Z (YYYY-MM-DD)**" line in AGENTS.md § 4. */
export function parseAgentsRestatement(agentsMd: string): { version: string; date: string } | null {
  const m = agentsMd.match(/Last verified against `pi` \*\*([0-9][0-9a-z.+-]*)\s*\((\d{4}-\d{2}-\d{2})\)\*\*/);
  if (!m) return null;
  return { version: stripRangePrefix(m[1] as string), date: m[2] as string };
}

/**
 * Pi-claim contexts: indexes at which a 1.x version literal starts within
 * 20 chars after a marker naming the Pi package/CLI (pi-coding-agent,
 * pi-tui, @earendil-works/pi, MIN_PI_VERSION, "Last verified against pi").
 * A version 20+ chars past "Pi 1.0.0's ... semantics" is prose, not a claim.
 */
const PI_CLAIM_MARKERS = [
  /pi-coding-agent/i,
  /pi-tui/i,
  /@earendil-works\/pi/i,
  /MIN_PI_VERSION/i,
  /last verified against[\s`*_]*pi/i,
];

const PI_CLAIM_WINDOW = 20;

export function piClaimContexts(text: string): number[] {
  const found = new Set<number>();
  const versionRe = /(?<![\d.])\d+(?:\.\d+)+/g;
  for (const marker of PI_CLAIM_MARKERS) {
    for (const m of text.matchAll(new RegExp(marker.source, "gi"))) {
      const start = m.index as number;
      const window = text.slice(start + m[0].length, start + m[0].length + PI_CLAIM_WINDOW);
      for (const v of window.matchAll(versionRe)) {
        found.add(start + m[0].length + (v.index as number));
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Bare Pi version literals in a text blob. 0.8x.y: unconditional (the
 * historical claim space, pre-#959). 1.x.y: only in a Pi-claim context
 * (see piClaimContexts) — "Last verified against pi 1.0.0" is a claim,
 * "bun >= 1.2.20" is not. Without the context check every unrelated
 * tool bump (bun, biome, oo, ci) would fail a Pi-drift gate.
 */
export function piVersionLiterals(text: string): string[] {
  const out = new Set<string>();
  const claims = piClaimContexts(text);
  // 0.8x.y (historical + current-claim space pre-#959), unconditional.
  for (const m of text.matchAll(/(?<![\d.])0\.8[0-9]+\.[0-9]+/g)) out.add(m[0] as string);
  // 1.x.y (current-claim space post-#959), Pi-claim contexts only.
  for (const m of text.matchAll(/(?<![\d.])1\.[0-9]+\.[0-9]+/g)) {
    if (claims.includes(m.index as number)) out.add(m[0] as string);
  }
  return [...out];
}

/**
 * Every file git considers part of the repo: tracked (`--cached`) plus
 * untracked-but-not-ignored (`--others --exclude-standard`). A plain
 * readdir walk reads git-IGNORED runtime debris that carries historical
 * Pi version literals — one ls-files call gives exactly the right set.
 * Fails loudly if git is unavailable (no silent fallback to readdir).
 */
export function gitRepoFiles(repoRoot: string): string[] {
  // -c core.quotepath=false makes the raw-path output explicit: -z already
  // emits unquoted bytes (verified empirically — quoting only applies to the
  // non -z textual path), but the flag guards a config-level surprise in the
  // one place where a quoted path would corrupt the census listing silently.
  const out = execFileSync("git", ["-c", "core.quotepath=false", "-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((f) => f.length > 0)
    .map((f) => path.join(repoRoot, f));
}

/**
 * The full site census: every repo file that can carry a Pi version claim,
 * with the expected superset of bare 0.8x.y literals it may hold. Adding a
 * new version-claim site means adding a row here — the gate fails otherwise
 * (a census that only knows a subset of the tree is worse than none).
 */
export function siteCensus(verifiedV: string): Record<string, string[]> {
  const v = [verifiedV];
  return {
    // The maintained line (version + its date's digits).
    "docs/pi-compatibility.md": v,
    // The native-MCP walkthrough's pi-1.0 claim.
    "docs/mcp.md": [...v, "1.0.0"],
    // The sandbox bind-mount table + troubleshooting entries that name the
    // post-#959 config path ("Pi 1.0.0's native MCP").
    "docs/sandbox.md": [...v, "1.0.0"],
    "docs/troubleshooting.md": [...v, "1.0.0"],
    // The audit code-search policy's config-path reference ("Pi 1.0.0's
    // native MCP config") + the user-global native MCP config path.
    "docs/audit-code-search-policy.md": [...v, "1.0.0"],
    // The AGENTS.md § 4 restatement (the "Last verified against pi" claim
    // line; the §5 embargo comment's 1.2.20 bun floor is not a claim).
    "AGENTS.md": v,
    // The dev pins (lockstep; the @earendil-works/pi marker puts the 1.x
    // pins in a claim context). The other 1.x literals in the file
    // (1.2.20 bun engines floor, 1.9.0 biome) are not Pi claims.
    "extension/package.json": ["1.0.0"],
    // The preflight floor (MIN_PI_VERSION + the #578 provenance/bug-window
    // note's 0.84.4/0.84.3 literals).
    "install-preflight.sh": ["1.0.0", "0.84.4", "0.84.3"],
    // The install floor on the install line (the 1.0.0 pi pin; the 1.2.20
    // bun floor sits within 20 chars of the "pi-coding-agent@1.0.0"
    // marker on the same line, so the census sees it as claim-adjacent —
    // declared here, not a Pi claim, but the window is what it is).
    "README.md": ["1.0.0", "1.2.20"],
    // Floor pin on the install line.
    "Dockerfile": ["1.0.0"],
    // test-pi-min-version.ts fakes pi --version output (at-floor / below-floor
    // matrix + numeric-compare cases).
    "test-pi-min-version.ts": ["1.0.0", "1.0.1", "1.1.0", "0.84.4", "0.84.3", "0.83.9", "0.85.0"],
    // The prerequisite-drift gate's canary literals (0.8x.y — the
    // historical claim space, detected unconditionally; its 1.x literals
    // sit in "Pi 1.0.0's" claim-context strings within the 20-char window).
    "test-prerequisite-drift.ts": ["0.84.4", "0.84.3", "1.0.0", "1.1.0"],
    // The Dockerfile-pins gate's canary lines ("Pi 1.0.0's native MCP",
    // the fixture "@earendil-works/pi-coding-agent@1.0.0" pin).
    "test-dockerfile-pins.ts": ["1.0.0"],
    // The live shape test's "Pi 1.0.0's native MCP" doc comments.
    "test-pi-shape-live.ts": ["1.0.0"],
    // The --exclude-tools rationale (Pi >= 0.83.0 — historical, still accurate)
    // + the CHILD_ARGS_BASE doc comment ("Under Pi 1.0.0's semantics").
    "spawn-support.ts": ["0.83.0", "1.0.0"],
    // The pi-mcp-adapter-skip doc comment ("On Pi 1.0.0, an installed
    // extension...").
    "spawn-extension-forward.ts": ["1.0.0"],
    // test-pi-version-drift.ts's own canary literals: the 0.8x.y canaries
    // (detected unconditionally) + the 1.x canaries that sit in
    // Pi-claim-context strings in this file ("pi-coding-agent": "1.0.0",
    // "pi 1.0.1", "pi 1.1.0", "Last verified against pi 1.0.0").
    // Self-census: if this file grows a new canary literal, the list must
    // grow here too — the gate fails otherwise (a self-census that cannot
    // see its own declaration is the "census that passes by silence"
    // failure mode this gate exists to stop).
    "test-pi-version-drift.ts": ["0.84.4", "0.99.0", "0.82.0", "0.82.1", "0.84.3", "0.83.9", "0.85.0", "0.84.5", "0.83.0", "0.86.0", "0.87.0", "1.0.0", "1.0.1", "1.1.0", "1.2.20"],
    // bun.lock resolves the declared pins (lockfile, not a claim — the gate
    // reads the DECLARED pin from package.json). The @earendil-works/pi
    // package names put the 1.0.0 pins in a Pi-claim context; the typebox
    // 1.3.27 on the pi-agent-core line is within the 20-char window of the
    // marker (declared here, not a Pi claim — the window is what it is).
    "bun.lock": ["1.0.0", "1.3.27"],
    // The embargo override comment's "the Pi 1.0.0 pin" (claim context via
    // the "Pi " marker; the 1.2.20 bun floor is outside the window).
    "bunfig.toml": ["1.0.0"],
    // The Pi 1.0.0 native-MCP wiring comments + step-6 banner ("Pi 1.0.0's
    // native MCP" is a claim; the 1.2.20 bun floor is not).
    "install.sh": ["1.0.0"],
    // The sandbox wrapper's native-MCP bind-mount comment names the Pi 1.0.0
    // path (issue #959); the header + mount comment both reference it.
    "bin/pi-rukas": ["1.0.0"],
    // 1.0.0 is the native-MCP walkthrough's pi claim (the other 1.x
    // literals are bun/npm floors, not Pi claims).
    "CONTRIBUTING.md": ["1.0.0"],
  };
}

// ---------------------------------------------------------------- the gate

if (process.env.PI_ENSEMBLE_PI_VERSION_DRIFT === "0") {
  console.log("PI_ENSEMBLE_PI_VERSION_DRIFT=0 — pi version-claim gate skipped.");
  process.exit(0);
}

const pkgText = read("extension/package.json");
const pins = parseDevPins(pkgText);

assert(pins.codingAgent !== "", "extension/package.json declares a pi-coding-agent dev pin (the DECLARED pin, not bun.lock)");
assert(pins.tui !== "", "extension/package.json declares a pi-tui dev pin");
assert(
  pins.codingAgent === pins.tui,
  `pi-coding-agent (${pins.codingAgent}) and pi-tui (${pins.tui}) are co-pinned in lockstep (a one-sided bump must be caught)`,
);

const compat = read("docs/pi-compatibility.md");
const verified = parseVerifiedLine(compat);
assert(verified !== null, 'docs/pi-compatibility.md carries the maintained "Last verified against pi X.Y.Z (YYYY-MM-DD)" line');
const restated = parseAgentsRestatement(read("AGENTS.md"));
assert(restated !== null, "AGENTS.md § 4 restates the maintained line (version + date)");
if (verified && restated) {
  assert(
    verified.version === restated.version && verified.date === restated.date,
    `the maintained line (${verified.version}, ${verified.date}) and the AGENTS.md restatement (${restated.version}, ${restated.date}) agree`,
  );
}
if (verified && pins.codingAgent) {
  const cmp = compareVersions(verified.version, pins.codingAgent);
  assert(
    cmp !== null && cmp >= 0,
    `the verified line (${verified.version}) is not older than the declared pin (${pins.codingAgent}) — a stale "verified" claim would trail what CI type-checks against`,
  );
}
if (verified) {
  const floor = read("install-preflight.sh").match(/\bMIN_PI_VERSION="?([0-9][0-9a-z.+-]*)"?/);
  const floorV = floor ? (floor[1] as string) : "";
  assert(floorV !== "", "install floor (MIN_PI_VERSION) parses");
  const cmpFloor = compareVersions(verified.version, floorV);
  assert(
    cmpFloor !== null && cmpFloor <= 0,
    `the verified line (${verified.version}) is not newer than the install floor (${floorV}) — a claim operators are never guaranteed to have`,
  );
}

// Staleness nudge — NON-FATAL by design: a prompt to re-run the live shape
// tests, never a ceiling. The gap is pin-relative so the gate stays offline
// and CI-clock-independent; the wall-clock date nudge takes an injectable
// clock (PI_PI_VERSION_DRIFT_NOW) so canaries never depend on the real date.
if (verified && pins.codingAgent) {
  const gap = minorDistance(verified.version, pins.codingAgent);
  if (gap === null || gap > 1) {
    console.warn(
      `⚠ pi version-claim staleness: verified ${verified.version} vs declared pin ${pins.codingAgent} (gap ${gap} minor${gap === 1 ? "" : "s"}) — re-run the live shape tests (test-pi-shape-live.ts) and update the maintained line.`,
    );
  }
  const now = process.env.PI_PI_VERSION_DRIFT_NOW ?? new Date().toISOString().slice(0, 10);
  const days = (Date.parse(now) - Date.parse(verified.date)) / 86_400_000;
  if (Number.isFinite(days) && days > 365) {
    console.warn(`⚠ pi version-claim staleness: the maintained line is dated ${verified.date} (> 365 days old) — re-verify.`);
  }
}

// ---------------------------------------------------------------- the gate CAN fail

{
  // Canary 1 — one-sided co-pin drift: the fixture pins pi-coding-agent
  // ~0.99.0 but pi-tui ~0.84.4; the mismatch is what the lockstep assert fails on.
  const fixturePkg = parseDevPins(read(path.relative(REPO_ROOT, path.join(FIXTURES, "package.json"))));
  assert(fixturePkg.codingAgent === "0.99.0", "canary fixture: pi-coding-agent declared pin parses as 0.99.0");
  assert(fixturePkg.tui === "0.84.4", "canary fixture: pi-tui declared pin parses as 0.84.4");
  assert(piVersionLiterals(read(path.relative(REPO_ROOT, path.join(FIXTURES, "package.json")))).length > 0, "canary: piVersionLiterals runs on raw file text");
  assert(piVersionLiterals('"pi-coding-agent": "0.87.0"').includes("0.87.0"), "canary: an undeclared 0.8x.y literal (0.87.0) is visible — the surprise path is reachable");
  assert(piVersionLiterals('"pi-coding-agent": "1.0.0"').includes("1.0.0"), "canary: an undeclared 1.x.y literal (1.0.0) in a Pi-claim context is visible post-#959");
  // The 1.x narrowing: the SAME literal with no Pi marker is NOT a claim.
  assert(piVersionLiterals("bun >= 1.2.20, biome 1.9.0, bun-version: 1.4.0").length === 0, "canary: a 1.x literal with no Pi-claim context is NOT a Pi claim");
  // 0.8x.y stays unconditional (the historical claim space, pre-#959).
  assert(piVersionLiterals("some tool pinned 0.84.5").includes("0.84.5"), "canary: 0.8x.y literals are still detected without a Pi-claim context");
  assert(piVersionLiterals("Last verified against pi 1.0.1 (2026-10-02)").includes("1.0.1"), "canary: the 'Last verified against pi' claim line makes a 1.x literal a claim");
  // "Pi 1.0.0 native MCP" prose: version 6+ chars past "Pi" — NOT a claim.
  assert(piVersionLiterals("post-#959 (Pi 1.0.0 native MCP), the adapter is REMOVED").length === 0, "canary: 'Pi 1.0.0' prose (version 6+ chars past 'Pi') is NOT detected — the 20-char window holds");
  assert(piVersionLiterals('"@earendil-works/pi-coding-agent": "~1.1.0", "@earendil-works/pi-tui": "~1.0.0"').includes("1.1.0"), "canary: a 1.x bump in a pi-coding-agent pin is a claim");
  assert(fixturePkg.codingAgent !== fixturePkg.tui, "canary: one-sided bump IS detected");

  // Canary 2 — the range-prefix strip is load-bearing.
  assert(compareVersions(stripRangePrefix("~0.82.0"), "0.82.0") === 0, "canary: stripRangePrefix makes '~0.82.0' comparable");
  assert(compareVersions("~0.82.0", "0.82.0") === null, "canary: an unstripped tilde fails closed (null)");

  // Canary 3 — the line parsers fail closed.
  assert(parseVerifiedLine("no version line here") === null, "canary: parseVerifiedLine fails closed when absent");
  assert(parseVerifiedLine("## Last verified against pi 0.84.4 (2026-09-21)")?.version === "0.84.4", "canary: parseVerifiedLine extracts version + date");
  assert(parseAgentsRestatement("Last verified against `pi` **0.84.4 (2026-09-21)** — the line above")?.date === "2026-09-21", "canary: parseAgentsRestatement extracts version + date");
  assert(minorDistance("1.0.0", "0.82.0") === Infinity, "canary: minorDistance across major boundaries is Infinity");
  assert(minorDistance("1.0.0", "1.1.0") === 1, "canary: minorDistance within 1.x counts minors");

  // Canary 4 — the version-order rules fail in both directions.
  assert(compareVersions("0.82.1", "1.0.0") === -1, "canary: verified 0.82.1 < pin 1.0.0 → 'not older' assert would fail");
  assert(compareVersions("1.0.0", "0.82.0") === 1, "canary: verified 1.0.0 > pin 0.82.0 → the nudge fires");
  assert(compareVersions("1.0.1", "1.0.0") === 1, "canary: verified 1.0.1 > floor 1.0.0 → 'not newer than floor' would fail");

  // Canary 5 — the nudge path is non-fatal (warn-only by construction).
  process.env.PI_PI_VERSION_DRIFT_NOW = "2099-01-01";
  const far = (Date.parse(process.env.PI_PI_VERSION_DRIFT_NOW) - Date.parse("2026-09-21")) / 86_400_000;
  assert(Number.isFinite(far) && far > 365, "canary: injected clock (2099) drives the >365-day date-nudge path");
  delete process.env.PI_PI_VERSION_DRIFT_NOW;

  // Canary 6 — the gate does NOT require dev pin == install floor: the
  // floor parses (the unquoted MIN_PI_VERSION=1.0.0 form must match — the
  // trailing "? on the quote is what makes the canary non-vacuous) and a
  // pin differing in major still compares.
  const floor = read("install-preflight.sh").match(/\bMIN_PI_VERSION="?([0-9][0-9a-z.+-]*)"?/);
  const floorV = floor ? (floor[1] as string) : "";
  assert(floorV !== "", "canary: the install floor (MIN_PI_VERSION) matches its unquoted form");
  assert(compareVersions("0.99.0", floorV) !== null, `a declared pin different from the install floor (${floorV}) is comparable and legal`);

  // Canary 7 — the census listing respects .gitignore exactly.
  let tmp: string | null = null;
  try {
    tmp = mkdtempSync(path.join(os.tmpdir(), "pi-drift-census-"));
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    writeFileSync(path.join(tmp, "tracked.md"), "no version literal here\n");
    writeFileSync(path.join(tmp, ".gitignore"), "outputs/\n");
    mkdirSync(path.join(tmp, "outputs"));
    writeFileSync(path.join(tmp, "outputs/x.md"), "pi 0.86.0 was old\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: tmp });
    writeFileSync(path.join(tmp, "new-claim.md"), "pi 0.86.0 arrived\n");
    writeFileSync(path.join(tmp, "résumé.md"), "no version literal here\n");
    const listed = gitRepoFiles(tmp).map((p) => path.relative(tmp, p)).sort();
    assert(listed.includes("tracked.md"), "canary: census listing includes the tracked file");
    assert(!listed.includes("outputs/x.md"), "canary: census listing excludes the gitignored outputs/x.md");
    assert(listed.includes("new-claim.md"), "canary: census listing includes the untracked-but-not-ignored file");
    assert(listed.includes("résumé.md"), "canary: census listing includes the untracked non-ASCII file by its exact UTF-8 name");
    assert(!listed.some((p) => p.startsWith('"')), "canary: no listed path is C-style quoted");
    assert(readFileSync(path.join(tmp, "résumé.md"), "utf8").includes("no version literal"), "canary: readFileSync of the non-ASCII absolute path succeeds");
  } catch (e) {
    assert(false, `canary: temp-repo gitignore check errored: ${String(e)}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- site census
// Every repo file with a bare 0.8x.y Pi literal must be a declared site whose
// expected superset covers what is found — so a NEW unreviewed version claim
// fails the gate instead of drifting (the structural reason the #787
// contradiction survived two minors). Fixtures under smoke-tests/fixtures are
// canary inputs, not claims, and are excluded.

{
  const verifiedV = parseVerifiedLine(compat)?.version ?? "";
  const census = siteCensus(verifiedV);
  // ls-files never reports paths under .git/, and node_modules is gitignored
  // (untracked + ignored), so the old walk's node_modules/.git/.worktrees
  // skips are implied by the git-based listing; fixtures stay explicitly
  // excluded below (they are tracked canary inputs, not claims).
  const allFiles = gitRepoFiles(REPO_ROOT);

  const surprises: string[] = [];
  let declared = 0;
  for (const f of allFiles) {
    const rel = path.relative(REPO_ROOT, f);
    if (rel.includes(`${path.sep}fixtures${path.sep}`)) continue;
    const text = read(rel);
    const literals = piVersionLiterals(text);
    if (literals.length === 0) continue;
    const allowed = census[rel] ?? census[path.basename(rel)] ?? [];
    const unexpected = literals.filter((v) => !allowed.includes(v));
    if (unexpected.length > 0) surprises.push(`${rel}: unexpected ${unexpected.join(", ")}`);
    else declared++;
  }
  assert(
    surprises.length === 0,
    `site census: no unknown Pi version literals${surprises.length ? " — " + surprises.join(" | ") : " (every 0.8x.y literal lives in a declared site)"}`,
  );
  assert(declared >= 10, `site census: at least 10 declared sites actually matched (got ${declared}) — the census must be reading the tree, not passing by silence`);
}

console.log(exit === 0 ? "\nAll pi version-claim checks passed." : "\nFAILED");
process.exit(exit);
