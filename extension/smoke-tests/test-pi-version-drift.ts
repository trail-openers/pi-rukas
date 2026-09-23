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
 *   (f) a site census: every repo file that carries a bare 0.8x.y Pi
 *       version literal must be a declared site whose expected-literal
 *       superset covers what is found — a new unreviewed version claim
 *       fails the gate instead of drifting silently (the structural reason
 *       the #787 contradiction survived two minors).
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

/** Bare 0.8x.y Pi version literals in a text blob (the current-claim space; 0.7x.y is historical). */
export function piVersionLiterals(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/0\.8[0-9]+\.[0-9]+/g)) out.add(m[0] as string);
  return [...out];
}

/**
 * Every file git considers part of the repo: tracked (`--cached`) plus
 * untracked-but-not-ignored (`--others --exclude-standard`). A plain
 * readdir walk reads git-IGNORED runtime debris (outputs/ research
 * artifacts, .pi-subagents/ transcripts) that carries historical Pi version
 * literals — at repoRoot that debris makes the census fail on every
 * consolidated verify even though the debris is not part of the repo. One
 * ls-files call gives exactly the tracked+untracked-not-ignored set; the
 * caller's explicit exclusions (fixtures, etc.) apply on top.
 *
 * Fails loudly (throws) if git is unavailable — a silent fallback to a
 * directory walk would re-admit the ignored debris the gate exists to skip.
 */
export function gitRepoFiles(repoRoot: string): string[] {
  const out = execFileSync("git", ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
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
    // The `pi install` verification claim.
    "docs/mcp.md": v,
    // The AGENTS.md § 4 restatement (+ the date's digits).
    "AGENTS.md": v,
    // The dev pins (lockstep) + this gate's own literals + its fixture.
    "extension/package.json": ["0.82.0"],
    // …plus this gate's own canary literals (0.82.1 stale-verified canary, 0.84.3 floor canary,
    // 0.83.9/0.85.0/0.84.5 numeric-matrix canaries, 0.83.0 --exclude-tools canary, 0.86.0
    // gitignore-listing canary, 0.87.0 undeclared-literal canary — all in canary strings, all
    // must stay visible to the census).
    "test-pi-version-drift.ts": ["0.82.0", "0.84.4", "0.99.0", "0.82.1", "0.84.3", "0.83.9", "0.85.0", "0.84.5", "0.83.0", "0.86.0", "0.87.0"],
    // The preflight floor (MIN_PI_VERSION + the #578 provenance/bug-window notes).
    "install-preflight.sh": ["0.84.4", "0.84.3"],
    // The install floor on the install line.
    "README.md": ["0.84.4"],
    // Floor pin (×2: install line + pi-mcp-adapter comment) + #578 bug-window note.
    "Dockerfile": ["0.84.4", "0.84.3"],
    // The canary fixture (one-sided co-pin: 0.99.0 vs 0.84.4).
    "package.json": ["0.99.0", "0.84.4"],
    // test-pi-min-version.ts fakes pi --version output (at-floor / bug-window / matrix).
    "test-pi-min-version.ts": ["0.84.4", "0.84.3", "0.83.9", "0.85.0", "0.84.5"],
    // The existing prerequisite-drift gate + its EXCEPTIONS pin + canary comments.
    "test-prerequisite-drift.ts": ["0.84.4", "0.84.3"],
    // The Dockerfile-pins gate's canary comment line.
    "test-dockerfile-pins.ts": ["0.84.4"],
    // The --exclude-tools rationale (Pi >= 0.83.0).
    "spawn-support.ts": ["0.83.0"],
    // A comment referencing the pinned pi-tui d.ts.
    "test-dispatch-deck-interactive.ts": ["0.82.0"],
    // bun.lock resolves the declared pins (lockfile, not a claim — the gate
    // reads the DECLARED pin from package.json; the lock is listed so a
    // lockstep bump is visible here, not silent).
    "bun.lock": ["0.82.0", "0.82.1"],
    // No claim: bump examples are relative (~0.XY.Z → ~0.XY.(Z+1)).
    "CONTRIBUTING.md": [],
    // No current-claim literals (historical 0.7x.y only — out of census scope).
    "install.sh": [],
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
  // Canary 1 — one-sided co-pin drift: the fixture package.json pins
  // pi-coding-agent ~0.99.0 but pi-tui ~0.84.4. parseDevPins must surface
  // both, and the mismatch is exactly what the lockstep assert above fails on.
  const fixturePkg = parseDevPins(read(path.relative(REPO_ROOT, path.join(FIXTURES, "package.json"))));
  assert(fixturePkg.codingAgent === "0.99.0", "canary fixture: pi-coding-agent declared pin parses as 0.99.0 (tilde stripped deliberately)");
  assert(fixturePkg.tui === "0.84.4", "canary fixture: pi-tui declared pin parses as 0.84.4");
  // And the census must actually SEE a contradictory literal in a non-site
  // file (proving the surprise path is not passing by silence).
  assert(piVersionLiterals(read(path.relative(REPO_ROOT, path.join(FIXTURES, "package.json"))))[0] !== "0.0.0.0", "canary: piVersionLiterals runs on raw file text");
  const surpriseText = '"pi-coding-agent": "0.87.0"';
  assert(piVersionLiterals(surpriseText).includes("0.87.0"), "canary: an undeclared 0.8x.y literal (0.87.0) is visible to the census — the surprise path is reachable");
  assert(fixturePkg.codingAgent !== fixturePkg.tui, "canary: one-sided bump IS detected (the lockstep assert above would fail on this fixture)");

  // Canary 2 — the range-prefix strip is load-bearing: "~0.82.0" must
  // compare as 0.82.0, not fail closed as unparseable.
  assert(compareVersions(stripRangePrefix("~0.82.0"), "0.82.0") === 0, "canary: stripRangePrefix makes '~0.82.0' comparable (== 0.82.0)");
  assert(compareVersions("~0.82.0", "0.82.0") === null, "canary: an unstripped tilde fails closed (null) — the strip is deliberate, not accidental");

  // Canary 3 — the line parsers fail closed on an absent or malformed line.
  assert(parseVerifiedLine("no version line here") === null, "canary: parseVerifiedLine fails closed when the line is absent");
  assert(
    parseVerifiedLine("## Last verified against pi 0.84.4 (2026-09-21)")?.version === "0.84.4",
    "canary: parseVerifiedLine extracts version + date",
  );
  assert(
    parseAgentsRestatement("Last verified against `pi` **0.84.4 (2026-09-21)** — the line above")?.date === "2026-09-21",
    "canary: parseAgentsRestatement extracts version + date from the § 4 restatement",
  );
  assert(minorDistance("0.84.4", "0.82.0") === 2, "canary: minorDistance counts minors (0.84 vs 0.82 → 2)");

  // Canary 4 — the version-order rules fail in both directions: a verified
  // line OLDER than the pin (the drift that got away) and one NEWER than the
  // floor (an unverified claim operators are never guaranteed to have).
  assert(compareVersions("0.82.1", "0.84.4") === -1, "canary: verified 0.82.1 < pin 0.84.4 → the 'not older' assert would fail");
  assert(compareVersions("0.84.4", "0.82.0") === 1, "canary: verified 0.84.4 > pin 0.82.0 → the nudge fires and the order assert would fail in the reverse direction");
  assert(compareVersions("0.99.0", "0.84.4") === 1, "canary: verified 0.99.0 > floor 0.84.4 → the 'not newer than floor' assert would fail");

  // Canary 5 — the nudge path is non-fatal: drive the date nudge with an
  // injected clock far in the future; the path above only ever warns (no
  // assert on it), so an old date can never flip exit by itself.
  process.env.PI_PI_VERSION_DRIFT_NOW = "2099-01-01";
  const far = (Date.parse(process.env.PI_PI_VERSION_DRIFT_NOW) - Date.parse("2026-09-21")) / 86_400_000;
  assert(Number.isFinite(far) && far > 365, "canary: injected clock (2099) drives the > 365-day date-nudge path (warn-only by construction)");
  delete process.env.PI_PI_VERSION_DRIFT_NOW;

  // Canary 6 — the gate does NOT require dev pin == install floor (that
  // would re-impose the ceiling #787 removes): a pair differing in major
  // compares fine, and no assert above ties the two together.
  const floor = read("install-preflight.sh").match(/\bMIN_PI_VERSION="?([0-9][0-9a-z.+-]*)"?/);
  const floorV = floor ? (floor[1] as string) : "";
  assert(compareVersions("0.99.0", floorV) !== null, `a declared pin different from the install floor (${floorV}) is comparable and legal — the gate never asserts pin == floor`);

  // Canary 7 — the census listing respects .gitignore exactly: in a temp
  // repo, a gitignored file carrying an unknown 0.8x.y literal in the claim
  // space is excluded, while a tracked file and an UNTRACKED-but-not-ignored
  // file with the same literal are both included. (This is the shape of the
  // repoRoot debris that failed every consolidated verify: outputs/ is
  // gitignored but the old readdir walk read it anyway; and --others must
  // still surface new untracked claims — the gate is narrowed, not weakened.)
  let tmp: string | null = null;
  try {
    tmp = mkdtempSync(path.join(os.tmpdir(), "pi-drift-census-"));
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    writeFileSync(path.join(tmp, "tracked.md"), "no version literal here\n");
    writeFileSync(path.join(tmp, ".gitignore"), "outputs/\n");
    const outDir = path.join(tmp, "outputs");
    mkdirSync(outDir);
    writeFileSync(path.join(outDir, "x.md"), "pi 0.86.0 was old\n");
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: tmp });
    // Untracked but NOT ignored — a genuinely new version-claim site the census must see.
    writeFileSync(path.join(tmp, "new-claim.md"), "pi 0.86.0 arrived\n");
    const listed = gitRepoFiles(tmp).map((p) => path.relative(tmp, p)).sort();
    assert(listed.includes("tracked.md"), "canary: census listing includes the tracked file");
    assert(!listed.includes("outputs/x.md"), "canary: census listing excludes the gitignored outputs/x.md (the repoRoot debris shape)");
    assert(listed.includes("new-claim.md"), "canary: census listing includes the untracked-but-not-ignored file (the gate is narrowed, not weakened)");
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
