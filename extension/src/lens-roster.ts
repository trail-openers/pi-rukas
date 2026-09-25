/**
 * lens-roster — the data-driven lens roster for the code-review lenses
 * (epic #867, sub-issue 3, #873).
 *
 * The roster is NOT a constant any more: it is parsed from the
 * `code-review-*` SKILL.md files in a skills dir, each lens's precedence
 * declared in that skill's frontmatter (`precedence: 10` …). Adding a
 * seventh lens is a configuration change (drop a `code-review-<x>/SKILL.md`
 * with a unique `precedence:` into the skills dir), not a code change.
 *
 * The scan is ONE pass over the top-level entries of ONE dir, selecting
 * `code-review-*` entries whose SKILL.md stats (symlinks followed —
 * install.sh symlinks skill/* into the installed dir, and the pre-spawn
 * stat in lens-review-child.ts counts a dangling symlink as missing).
 * Everything else in the dir (vipune, api-design, …) is ignored.
 *
 * Lens name derivation (fixed rule, pinned by test): strip the
 * `code-review-` prefix, replace `-` with `_`, uppercase —
 * `code-review-error-handling` → `ERROR_HANDLING`,
 * `code-review-data-privacy` → `DATA_PRIVACY`.
 *
 * Gating (a blocked lens never silently reorders the roster): a
 * `code-review-*` entry that fails to parse blocks that lens with an error
 * naming the skill dir and the problem — SKILL.md missing/unreadable,
 * frontmatter missing, `name:` ≠ directory, `precedence:` missing or not
 * an integer, duplicate precedence (BOTH names in the error). The caller
 * turns blocked entries into blocked LensRunResults → REVIEW_INCOMPLETE.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frontmatterField } from "./skill-frontmatter.ts";
import { trace } from "./trace.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The BUNDLED `code-review-*` skill dirs — the skills this extension ships
 * in `<repo>/skill/`, resolved relative to the extension source the same
 * way `LENS_REPORTER_PATH` is resolved (the source `__dirname`, two levels
 * up). This is the EXPECTED lens set: a lens the bundled dir declares but
 * the installed dir does not (missing or dangling skill) must never silently
 * disappear from the review — it blocks with `skill not installed: …`,
 * feeding REVIEW_INCOMPLETE instead of an APPROVED five-pass review.
 */
export const BUNDLED_SKILL_DIR = path.join(__dirname, "..", "..", "skill");

/** The bundled lens roster — the EXPECTED lenses (one entry per bundled
 * `code-review-*` skill, precedence from its frontmatter). */
export const LENS_ROSTER = buildLensRoster(BUNDLED_SKILL_DIR);

export interface RosterEntry {
  /** Roster-relative lens name (derived from the skill directory). */
  name: string;
  /** Skill directory name — the entry under the skills dir. */
  skill: string;
  precedence?: number;
  /** Set when the entry is unusable; `name` is still derived from the
   * directory so the blocked row names the right lens. */
  error?: string;
}

/**
 * Parse the lens roster from `dir` (see module header for the rules).
 * Entries are ordered by precedence ascending (a lower value wins, as
 * before); a `precedence: 1` added later sorts above SECURITY's 10.
 * `CLAIM_SCAN` stays a code-level pseudo-lens that outranks EVERY declared
 * precedence regardless of values (see CLAIM_SCAN_PRECEDENCE).
 */
export function buildLensRoster(dir: string): RosterEntry[] {
  const raw: RosterEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  for (const entryName of names) {
    if (!entryName.startsWith("code-review-")) continue;
    const skillPath = path.join(dir, entryName);
    let isDir = false;
    try {
      isDir = statSync(skillPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const name = deriveLensName(entryName);
    const skillMd = path.join(skillPath, "SKILL.md");
    let text: string | undefined;
    try {
      text = readFileSync(skillMd, "utf8");
    } catch {
      raw.push({
        name,
        skill: entryName,
        error: `${entryName}: no readable SKILL.md`,
      });
      continue;
    }
    const fmName = frontmatterField(text, "name");
    if (fmName === null) {
      raw.push({
        name,
        skill: entryName,
        error: `${entryName}: SKILL.md has no parseable frontmatter name`,
      });
      continue;
    }
    if (fmName !== entryName) {
      raw.push({
        name,
        skill: entryName,
        error: `${entryName}: frontmatter name \`${fmName}\` ≠ directory \`${entryName}\``,
      });
      continue;
    }
    const precStr = frontmatterField(text, "precedence");
    if (precStr === null || !/^-?\d+$/.test(precStr)) {
      raw.push({
        name,
        skill: entryName,
        error: `${entryName}: missing or invalid \`precedence:\` in frontmatter`,
      });
      continue;
    }
    raw.push({ name, skill: entryName, precedence: Number(precStr) });
  }
  // Duplicate precedence blocks BOTH lenses with both names in the error —
  // the roster is never silently reordered.
  const byPrec = new Map<number, RosterEntry[]>();
  for (const e of raw) {
    if (e.precedence === undefined) continue;
    const bucket = byPrec.get(e.precedence) ?? [];
    bucket.push(e);
    byPrec.set(e.precedence, bucket);
  }
  for (const [prec, entries] of byPrec) {
    if (entries.length > 1) {
      const who = entries.map((e) => `${e.skill} (${e.name})`).join(" and ");
      for (const e of entries) {
        e.error = `duplicate precedence ${prec} between ${who}`;
      }
    }
  }
  return [...raw].sort((a, b) => {
    const ap = a.precedence ?? Number.MAX_SAFE_INTEGER;
    const bp = b.precedence ?? Number.MAX_SAFE_INTEGER;
    if (ap !== bp) return ap - bp;
    return a.skill.localeCompare(b.skill);
  });
}

/**
 * The runtime roster (#873 safety fix): the INSTALLED dir's roster, plus a
 * blocked entry for every expected lens (from the bundled `skill/` dir) that
 * is absent from the installed dir or whose installed SKILL.md does not stat
 * (dangling symlink — `statSync` follows symlinks). The blocked row carries
 * `skill not installed: <abs installed path> (not spawned)` and attempts 0
 * — the same shape the pre-spawn stat in lens-review-child.ts produces. Extra
 * `code-review-*` skills present only in the installed dir are allowed
 * (a seventh lens by configuration); the installed entries' precedence /
 * duplicate / name checks apply exactly as before.
 *
 * Two deliberate exceptions keep the #872 install-message path unchanged:
 * an installed dir that holds NO healthy `code-review-*` skill at all
 * (missing dir, empty, unrelated-only) still blocks every row with the
 * single install message, and when the bundled dir cannot be read the
 * expected set is unavailable — fall back to the installed-only roster and
 * trace it.
 */
export function buildExpectedRoster(installedDir: string): RosterEntry[] {
  let expected: RosterEntry[];
  try {
    expected = buildLensRoster(BUNDLED_SKILL_DIR);
  } catch (err) {
    trace(
      `expected lens set unavailable (bundled skill dir ${BUNDLED_SKILL_DIR} unreadable: ${String(err)}); installed-only roster`,
    );
    return buildLensRoster(installedDir);
  }
  const installed = buildLensRoster(installedDir);
  const healthyInstalled = installed.filter(
    (e) => e.error === undefined && e.precedence !== undefined,
  );
  if (healthyInstalled.length === 0) return installed;
  const installedSkills = new Set(healthyInstalled.map((e) => e.skill));
  const missing: RosterEntry[] = [];
  for (const e of expected) {
    if (e.error !== undefined || e.skill === undefined || !e.skill.startsWith("code-review-"))
      continue;
    const skillMd = path.join(installedDir, e.skill, "SKILL.md");
    let readable = true;
    try {
      statSync(skillMd);
    } catch {
      readable = false;
    }
    if (!readable || !installedSkills.has(e.skill)) {
      missing.push({
        name: e.name,
        skill: e.skill,
        error: `skill not installed: ${path.join(installedDir, e.skill)} (not spawned)`,
      });
    }
  }
  return [...installed, ...missing];
}

/** Derive the lens name from a `code-review-*` directory name (module header). */
export function deriveLensName(dirName: string): string {
  return dirName
    .replace(/^code-review-/, "")
    .replaceAll("-", "_")
    .toUpperCase();
}

export const CLAIM_SCAN = "CLAIM_SCAN" as const;

/**
 * The pseudo-lens that outranks every declared precedence whatever the
 * values are (the fixed -1 only worked while values were 0..5). Its
 * findings are deterministic lookups, not judgments — see the CLAIM_SCAN
 * override in `dedupeFindings`.
 */
export const CLAIM_SCAN_PRECEDENCE = Number.NEGATIVE_INFINITY;
