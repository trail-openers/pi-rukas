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
import { frontmatterField } from "./skill-frontmatter.ts";

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
