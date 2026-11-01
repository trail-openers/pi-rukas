#!/usr/bin/env bun
/**
 * Pi version-claim gate support module (#787 / #959).
 *
 * Two pieces moved here VERBATIM from test-pi-version-drift.ts so the gate
 * file could stay under the 500-line cap while restoring its comments
 * (move code, not compress comments — the comments are load-bearing):
 *   - gitRepoFiles — the git ls-files census listing (doc comment intact);
 *   - siteCensus — the full site-census data table (per-site comments
 *     intact, literals updated for the #959 1.x bump).
 *
 * Intentionally NOT named test-*.ts — verify-loop.sh runs only test-*.ts as
 * tests (same shape as glab-arch-check.ts and handoff-provenance-fixtures.ts);
 * coverage comes through test-pi-version-drift.ts, which imports both.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { gitTestEnv } from "./git-test-env.ts";

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
  // -c core.quotepath=false makes the raw-path output explicit: -z already
  // emits unquoted bytes (verified empirically — quoting only applies to the
  // non -z textual path), but the flag guards a config-level surprise in the
  // one place where a quoted path would corrupt the census listing silently.
  // #1145 — `env: gitTestEnv()`. `--exclude-standard` consults the ignore
  // stack, whose topmost source is the host's per-user file: with a host
  // `~/.config/git/ignore` naming a path the census is supposed to list, that
  // file disappears from the listing and the gate fails (or passes) on a
  // property of the machine. `execFileSync` with no `env` inherits the REAL
  // `environ` on bun 1.3, so the isolated set has to be threaded (see
  // lib/git-test-env.ts).
  const out = execFileSync("git", ["-c", "core.quotepath=false", "-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: gitTestEnv(),
  });
  return out
    .split("\0")
    .filter((f) => f.length > 0)
    .map((f) => path.join(repoRoot, f))
    .filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false; // deleted-but-not-committed — not part of the working tree
      }
    });
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
    // The `pi install` verification claim. (Post-#959: the native-MCP
    // walkthrough's pi-1.0 claim.)
    "docs/mcp.md": [...v, "1.0.0"],
    // The sandbox bind-mount table + troubleshooting entries that name the
    // post-#959 config path ("Pi 1.0.0's native MCP").
    "docs/sandbox.md": [...v, "1.0.0"],
    // The two `npm install -g …pi-coding-agent@1.0.0` command lines are the
    // ONLY detected literals in this file — both sit 1 char past the
    // `pi-coding-agent` marker (the `@` in `pi-coding-agent@1.0.0` is that one
    // character), inside the 20-char claim window.
    // Deliberately NOT [...v, "1.0.0"]. The applicable census direction here
    // is **declared ⊆ detected** (the gate's `undetectable` check): a declared
    // literal the detector cannot see is a dead declaration that would pass
    // the gate by silence. The other five 1.0.0s in this file (the upgrade
    // heading, "below 1.0.0", "under Pi 1.0.0", "pi < 1.0.0", "Pi 1.0.0's")
    // all sit outside the 20-char claim window of every marker, so none is a
    // detected
    // claim and a tracked `v` (currently 1.4.0) would be a dead declaration.
    // That decision reverses if a future edit gives this file a Pi-claim-context
    // literal for the tracked verified version — e.g. a `pi-coding-agent@1.4.0`
    // command line — at which point `v` must be added back to this row.
    "docs/troubleshooting.md": ["1.0.0"],
    // The audit code-search policy's config-path reference ("Pi 1.0.0's
    // native MCP config") + the user-global native MCP config path.
    "docs/audit-code-search-policy.md": [...v, "1.0.0"],
    // The AGENTS.md § 4 restatement (+ the date's digits). (Post-#959: the
    // "Last verified against pi" 1.0.0 claim line; the §5 embargo comment's
    // 1.2.20 bun floor is not a claim.)
    "AGENTS.md": v,
    // The dev pins (lockstep; the @earendil-works/pi marker puts the 1.x
    // pins in a Pi-claim context). The 1.2.20 bun engines floor and the
    // 1.9.0 biome floor are 1.x literals with no Pi-claim context, so the
    // detector ignores them — and this row must not declare them.
    "extension/package.json": ["1.4.0"],
    // …plus this gate's own canary literals (0.82.1 stale-verified canary,
    // 0.84.3 floor canary, 0.83.9/0.85.0/0.84.5 numeric-matrix canaries,
    // 0.83.0 --exclude-tools canary, 0.86.0 gitignore-listing canary, 0.87.0
    // undeclared-literal canary — 0.8x.y is detected unconditionally, so all
    // stay visible; the 1.0.1/1.1.0 canaries sit in the
    // "pi-coding-agent"/"@earendil-works" claim-context strings, and the
    // 1.2.20 bun-floor canary string carries no Pi marker, so it is prose
    // to the detector and is not declared here — the 0.99.0 co-pin canary
    // is likewise a prose literal).
    // The floor-rule literals of the gate file (Canary 4b and its inline
    // co-pin fixture) are grounded by the package/CLI markers only. WHICH
    // occurrences are claims, at which marker and at what forward gap, is
    // stated by the gate's census-consistency assertion and re-derived from
    // the detector on every run - this row names no figure of its own. The
    // ~26 lines of hand-copied line numbers, marker names and gaps this block
    // replaced were wrong in three consecutive rounds: a citation transcribed
    // from a detector run rots the moment the cited file moves, and nothing
    // checked it. No comment in this file cites a line address, so none can be
    // off by one; occurrences are identified by their quoted text and marker.
    // Self-census: if this file grows a new canary literal, the list must
    // grow here too — the gate fails otherwise (a self-census that cannot
    // see its own declaration is the "census that passes by silence"
    // failure mode this gate exists to stop).
    "test-pi-version-drift.ts": ["0.84.4", "0.82.0", "0.87.0", "0.84.5", "0.82.1", "0.86.0", "1.0.0", "1.0.1", "1.1.0", "1.4.0", "1.4.1"],
    // The preflight floor (MIN_PI_VERSION = 1.0.0) plus the 0.84.4
    // bug-window literal in the §4 provenance comment (the 0.84.3 in the §5
    // embargo comment is 30+ chars from every marker, so it is not a
    // declared claim).
    "install-preflight.sh": ["1.0.0", "0.84.4"],
    // The install floor on the install line ("Bun ≥ 1.2.20 and Node ≥ 22
    // (Pi's own requirement)") — the 1.2.20 bun floor sits within 20 chars
    // of the "Pi's" marker, detected as claim-adjacent, declared here.
    "README.md": ["1.0.0", "1.2.20"],
    // The floor pin on the install line.
    ".devcontainer/Dockerfile": ["1.0.0"],
    // test-pi-min-version.ts fakes pi --version output (at-floor / bug-window / matrix).
    // (Post-#959: the 0.8x.y literals are the pre-#959 bug-window cases, the 1.x the
    // current-floor matrix + numeric-compare cases.)
    "test-pi-min-version.ts": ["0.84.4", "0.84.3", "0.83.9", "0.85.0"],
    // The existing prerequisite-drift gate + its EXCEPTIONS pin + canary
    // comments. 0.8x.y is detected unconditionally; the 1.x literals sit in
    // "Pi 1.0.0's" claim-context strings within the 20-char window. The
    // 0.84.4/0.84.3 fixtures moved to the prerequisite-drift fixtures
    // themselves, exercised by that gate.
    "test-prerequisite-drift.ts": ["0.84.4", "0.84.3", "1.0.0", "1.1.0"],
    // The Dockerfile-pins gate's canary comment line ("Pi 1.0.0's native
    // MCP") + the fixture "@earendil-works/pi-coding-agent@1.0.0" pin.
    "test-dockerfile-pins.ts": ["1.0.0"],
    // The --exclude-tools rationale (0.83.0, detected unconditionally); the
    // "Under Pi 1.0.0's semantics" childArgsBase() doc comment is 23 chars
    // past the Pi marker, so the 1.0.0 there is prose, not a detected claim.
    "spawn-support.ts": ["0.83.0"],
    // The pi-mcp-adapter-skip doc comment ("On Pi 1.0.0, an installed
    // extension...") sits 22 chars past the "Pi" marker — prose, not a
    // detected claim (the 1.x claim-context canaries live in the
    // version-drift gate, not here).
    "spawn-extension-forward.ts": [],
    // bun.lock resolves the declared pins (lockfile, not a claim — the gate
    // reads the DECLARED pin from package.json; the lock is listed so a
    // lockstep bump is visible here, not silent). The @earendil-works/pi
    // package names put the 1.4.0 pins in a Pi-claim context; the typebox
    // 1.3.27 sits outside the 20-char window of the marker, so it is not
    // declared here.
    "extension/bun.lock": ["1.4.0"],
    // No claim: bump examples are relative (~0.XY.Z → ~0.XY.(Z+1)); the
    // "Pi 1.0.0's native MCP" prose is 23 chars past the marker, so nothing
    // in the file is a detected claim. (Other 1.x literals — bun, npm and
    // release-lease floors — are not Pi claims.)
    "CONTRIBUTING.md": [],
    // The census-table home moved here by #959 (the gate file stays under
    // the 500-line cap by moving code, not compressing comments). The
    // "@earendil-works/pi" marker in its own table literal puts the 1.x
    // row literals in a claim context; the 0.8x.y entries are the canaries
    // copied verbatim from the gate's own row (self-census of the census).
    // 1.4.0 is the floor-rule literal the gate's own row documents; the gate's
    // census-consistency assertion is what states which occurrences in THIS
    // file are claims, at which marker and at what forward gap, and re-derives
    // them from the detector on every run. This row names no count of its own:
    // the "exactly two occurrences each" figure it used to carry was wrong in
    // both directions, and a count written in a comment is a claim about the
    // detector that the detector can contradict. 1.4.1 is not declared here at
    // all because the detector finds no 1.4.1 claim in this file - every one is
    // prose beyond the window.
    // Declared literals are exactly the detected set — the gate's census
    // block proves declared ⊆ detected, so a literal the detector cannot
    // see is a gate failure, not a silent entry.
    "pi-version-census.ts": ["0.82.1", "0.84.3", "0.83.9", "0.85.0", "0.84.5", "0.83.0", "0.86.0", "0.87.0", "0.84.4", "0.82.0", "1.0.0", "1.4.0"],
  };
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

/** The floor rule's verdict shape; `reason` is meaningful only when `violated`. */
export type FloorVerdict = { violated: boolean; reason: "unparseable" | "below-floor" | null };

/**
 * The floor rule (d) itself, as a named predicate so Canary 4b can drive the
 * RULE rather than its input comparator. `compareVersions` is a pure function
 * of its arguments, so an assert on it cannot be flipped by anything the rule
 * does - only this body is sensitive to the comparison direction.
 *
 * The two failure causes are separated: "unparseable" (either side is not
 * plain dotted-numeric, so the rule cannot decide) and "below-floor" (the
 * rule's own verdict). Folding them into one condition lets an unparseable
 * version masquerade as a floor violation - the same trailing-reason split
 * `test-prerequisite-drift.ts` uses for its floor asserts.
 *
 * The rule, as the body states it: violated only when `cmp < 0`, plus the
 * fail-closed `cmp === null` arm. The verified line is a FLOOR, not a ceiling
 * - it must be at or above `MIN_PI_VERSION`, because it is the version an
 * operator downgrades to and ./install.sh must accept it.
 */
export function floorRuleViolated(verifiedV: string, floorV: string): FloorVerdict {
  const cmp = compareVersions(verifiedV, floorV);
  if (cmp === null) return { violated: true, reason: "unparseable" };
  if (cmp < 0) return { violated: true, reason: "below-floor" };
  return { violated: false, reason: null };
}

/**
 * The Pi-claim markers - the package/CLI names whose forward window makes a
 * 1.x literal a Pi CLAIM rather than prose - with index-aligned human names,
 * and the window itself. The gate's detector and the grounding assertion below
 * read this ONE list: an assertion carrying its own copy of the markers could
 * go stale and then assert a fact the detector no longer believes.
 */
export const PI_CLAIM_MARKERS: readonly RegExp[] = [/pi-coding-agent/i, /pi-tui/i, /@earendil-works\/pi/i, /MIN_PI_VERSION/i, /last verified against[\s`*_]*pi/i];
export const PI_CLAIM_MARKER_NAMES: readonly string[] = ["pi-coding-agent", "pi-tui", "@earendil-works/pi", "MIN_PI_VERSION", "last verified against pi"];
export const PI_CLAIM_WINDOW = 20;

const ELLIPSIS = "\u2026";

/** One cited grounding: the text named around an occurrence, its marker, its gap. */
export type GroundingCitation = { quoted: string; marker: string; gap: number };

/**
 * The claim-context detector, injected by the gate. This module cannot import
 * the file that imports it, so `piClaimContexts` is wired in at load rather
 * than duplicated - one detector answers for the whole gate.
 */
export type ClaimDetector = (text: string) => number[];

/**
 * Pi-claim occurrences of one literal: the positions the wired detector calls
 * claims, each paired with the NEAREST marker whose forward window contains it
 * and that marker's gap (chars from the marker's end to the literal's start,
 * always 0..PI_CLAIM_WINDOW for a claim). This is what lets the census table's
 * grounding comments be CHECKED instead of transcribed.
 */
export function piLiteralClaims(text: string, literal: string, detect: ClaimDetector): { index: number; marker: string; gap: number }[] {
  const claimSet = new Set(detect(text));
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out: { index: number; marker: string; gap: number }[] = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, "g"))) {
    const index = m.index as number;
    if (!claimSet.has(index)) continue;
    let best: { marker: string; gap: number } | null = null;
    for (let i = 0; i < PI_CLAIM_MARKERS.length; i++) {
      for (const hit of text.matchAll(new RegExp((PI_CLAIM_MARKERS[i] as RegExp).source, "gi"))) {
        const gap = index - ((hit.index as number) + hit[0].length);
        if (gap >= 0 && gap <= PI_CLAIM_WINDOW && (best === null || gap < best.gap)) best = { marker: PI_CLAIM_MARKER_NAMES[i] as string, gap };
      }
    }
    // A claim index always comes from some marker's window, so `best` cannot be
    // null; the throw makes that invariant a failure, not a silent skip.
    if (best === null) throw new Error(`piLiteralClaims: claim at ${index} (${literal}) has no marker in the window - detector invariant broken`);
    out.push({ index, marker: best.marker, gap: best.gap });
  }
  return out;
}

/**
 * The census-consistency assertion, replacing the hand-transcribed grounding
 * block. For each (file, literal) it checks the DETECTED CLAIM SET is exactly
 * the cited set - no more (a claim nothing grounds), no fewer (a citation whose
 * text has gone), no duplicates (one occurrence counted twice) - and pairs each
 * citation to a distinct claim whose marker name and forward gap it names
 * correctly. `quoted` is the text just BEFORE the literal, ending in an
 * ellipsis for "the literal follows": quoting the digits themselves would put
 * the citation, which lives inside the file under inspection, in a marker's
 * window and manufacture the claim it was meant to describe. Every message
 * carries the detector's own answer, so a failure is readable without a probe.
 * `detect` is the gate's detector; passing a detector that finds nothing shows the
 * block fails closed, i.e. is observed to redden rather than assumed to.
 */

export function censusGroundingErrors(textByFile: Record<string, string>, expected: Record<string, Record<string, GroundingCitation[]>>, detect: ClaimDetector): string[] {
  const errors: string[] = [];
  for (const [rel, byLiteral] of Object.entries(expected)) {
    const text = textByFile[rel];
    if (text === undefined) {
      errors.push(`${rel}: no text read - cannot check its grounding citations`);
      continue;
    }
    for (const [literal, citations] of Object.entries(byLiteral)) {
      const detectClaims = detect;
      const detected = piLiteralClaims(text, literal, detectClaims);
      void detectClaims;
      const say = (list: { marker: string; gap: number }[]) => list.map((d) => `${d.marker}@${d.gap}`).join(", ");
      const sayCit = (list: GroundingCitation[]) => list.map((x) => `${x.quoted}=${x.marker}@${x.gap}`).join(", ");
      if (detected.length !== citations.length) {
        errors.push(`${rel} ${literal}: detector found ${detected.length} claim(s) [${say(detected)}] but the citations declare ${citations.length} [${sayCit(citations)}]`);
        continue;
      }
      // One-to-one pairing, fewest-candidates-first so an unambiguous citation
      // claims its occurrence before an ambiguous one can take it.
      const taken = new Set<number>();
      const cands = citations.map((cit) => ({ cit, opts: detected.map((_, i) => i).filter((i) => anchors(text, detected[i] as number, cit)) }));
      for (const c of cands.sort((x, y) => x.opts.length - y.opts.length)) {
        const free = c.opts.filter((i) => !taken.has(i));
        if (free.length === 0) {
          errors.push(`${rel} ${literal}: cited ${JSON.stringify(c.cit.quoted)} matches no claim at marker \`${c.cit.marker}\` gap ${c.cit.gap} (detector says [${say(detected)}])`);
          continue;
        }
        taken.add(free[0] as number);
      }
    }
  }
  return errors;
}

/**
 * Does `cit` describe claim `d`? The quote names the text immediately BEFORE
 * the literal, so with the trailing ellipsis stripped it must END exactly
 * `gap` chars before the literal starts - and it must name that claim's marker.
 * Anchoring to the position rather than searching for the string anywhere is
 * what stops one occurrence's surroundings being cited for another.
 */
function anchors(text: string, d: { index: number; marker: string; gap: number }, cit: GroundingCitation): boolean {
  if (d.marker !== cit.marker) return false;
  const body = cit.quoted.endsWith(ELLIPSIS) ? cit.quoted.slice(0, -ELLIPSIS.length) : cit.quoted.replace(/\u002e\u002e\u002e$/, "");
  // Two positions satisfy a citation, and BOTH are honest: the text the comment
  // names can be read as ending where the claimed marker ends (`gap` chars
  // before the literal), or as ending where the literal itself starts (the
  // marker name is then inside the quote). The second reading is what lets one
  // citation describe an occurrence whose marker occurs again closer to the
  // literal than the marker the gate names - the fixture object whose own
  // `pi-tui` name grounds both pins in it, for example.
  for (const end of [d.index - cit.gap, d.index]) {
    if (end >= body.length && text.slice(end - body.length, end) === body) return true;
  }
  return false;
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

/** The restating "Last verified against `pi` **X.Y.Z (YYYY-MM-DD)**" line in AGENTS.md § 4. */
export function parseAgentsRestatement(agentsMd: string): { version: string; date: string } | null {
  const m = agentsMd.match(/Last verified against `pi` \*\*([0-9][0-9a-z.+-]*)\s*\((\d{4}-\d{2}-\d{2})\)\*\*/);
  if (!m) return null;
  return { version: stripRangePrefix(m[1] as string), date: m[2] as string };
}

export const GROUNDING_BLOCK_MARK = "// " + "-".repeat(64) + " " + "census" + " consistency";


/** Strip the source quotes around a parsed `quoted:` literal. */
export function unquote(raw: string): string {
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.slice(1, -1).replace(/\\'/g, "'");
}

/**
 * The grounding facts the census comments rely on. They live in the GATE, not in
 * the file they describe: the gate re-derives every one of them from the detector
 * on each run, so the described file has no say in them and a stale figure fails.
 */
export function declaredGroundingTable(
  gateRel: string,
  censusRel: string,
): Record<string, Record<string, GroundingCitation[]>> {
  return {
      [gateRel]: {
        // 1.4.0 — the floor-rule / co-pin literal, exactly as the detector sees
        // it: Canary 1's MIN_PI_VERSION floor prose, Canary 4b's floor-comment
        // prose, and BOTH pins of Canary 1's inline co-pin fixture — the second
        // pin's nearest marker is the fixture's own pi-tui name, ahead of it, so
        // it is a claim of its own, cited separately from the first.
        // The 1.4.0s in the canary ASSERT MESSAGES and in the no-Pi-marker prose
        // strings are NOT claims and nothing cites them: `detected == declared`,
        // or the assert below reddens.
        "1.4.0": [
          { quoted: "MIN_PI_VERSION floor of ", marker: "MIN_PI_VERSION", gap: 10 },
          { quoted: "// floor ", marker: "MIN_PI_VERSION", gap: 12 },
          { quoted: 'pi-tui":"~', marker: "pi-tui", gap: 4 },
          { quoted: 'pi-tui":"~', marker: "pi-tui", gap: 4 },
        ],
        // 1.4.1 — the above-floor literal: Canary 1's fixture pin and its prose
        // mention, the same pin quoted in Canary 4b's prose, and the literal in
        // that arm's assert message. One grounding per occurrence, never two.
        "1.4.1": [
          { quoted: "pi-coding-agent ~", marker: "pi-coding-agent", gap: 2 },
          { quoted: 'works/pi-coding-agent":"~', marker: "pi-coding-agent", gap: 4 },
          { quoted: "pi-coding-agent line (", marker: "pi-coding-agent", gap: 7 },
          { quoted: "pi-coding-agent verified ", marker: "pi-coding-agent", gap: 11 },
        ],
      },
      [censusRel]: {
        // 1.4.0 — the ONE claim in the census file: the pi-coding-agent example
        // in the docs/troubleshooting.md row's "that decision reverses if..."
        // prose. Every other 1.4.0 there (the package.json, bun.lock and
        // floor-rule rows) sits beyond the 20-char window of every marker, so the
        // detector calls them prose and nothing invents them here. 1.4.1 has NO
        // claim in the census file, which is why that row declares 1.4.0 and not
        // 1.4.1.
        "1.4.0": [{ quoted: "a `pi-coding-agent", marker: "pi-coding-agent", gap: 1 }],
      },
    };;
}
