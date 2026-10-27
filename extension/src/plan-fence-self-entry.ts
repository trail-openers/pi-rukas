/**
 * plan-fence-self-entry — #1862 round 1: the ONE predicate that answers "may
 * this fence entry be dropped because it fences this workstream's own files?".
 *
 * Two sites ask that question and they must give one answer: the tool boundary
 * (`workstreamFromArgs`, which stores a reported `outOfScope`) and the fold
 * (`foldTwo`, which unions both halves' fences). Before this module each had its
 * own prose reader, and neither asked the whole question. A fence entry is ONE
 * instruction: dropping it removes every path it names. So the drop is refused
 * unless EVERY path token the entry names belongs to this workstream, and one
 * token that does not — a sibling's file, a protected path, a subtree nobody
 * declared — keeps the WHOLE entry. That is what makes a mixed self+sibling
 * sentence ("Every file under agents/ and tests/, plus src/legacy/") survive.
 *
 * The rules, and what they refuse to do:
 *
 *   - An entry is droppable only when EVERY path token it names is covered by
 *     one of this workstream's own NON-PROTECTED declared paths, in either
 *     containment direction on the `/` boundary (`tests/` covers a declared
 *     `tests/test_x.py`; `testsfoo` covers nothing).
 *   - A PROTECTED path (`isProtectedPath`: `.github/`, `.pi/`, `CODEOWNERS`,
 *     `agents.json`) is never a reason to open a fence. A protected DECLARATION
 *     cannot make a token covered, and an entry that NAMES one keeps the entry:
 *     those paths are guarded by their own gate, which halts the cycle.
 *   - An entry that names no path token is KEPT. There is nothing to compare it
 *     against, and a rule that deletes fences it cannot read is worse than a
 *     useless fence.
 *   - Two grammars, each with one predicate, and they are exclusive: a
 *     PATH-shaped entry is judged by the plan-quality gate's own containment rule
 *     (`findFenceContradictions`, which reads `dir/**`, `dir/*` and a
 *     `(new)`-annotated path as the path they are), and PROSE is judged by the
 *     whole-token rule (`pathTokenIn`, which makes `data.txt` never name
 *     `a.txt`). The path arm runs first and an entry it covers is never read as
 *     prose — that is the #1725 rule against two answers for one entry.
 *   - A sentence names the DIRECTORY (`tests/`), not the files beneath it, so a
 *     declared path's own directory is a spelling of that path: the token
 *     `tests/` is covered by a declared `tests/test_x.py`, while prose about
 *     `docs` still cannot name a declared `docsfoo/x.md`.
 *
 * Pure, and it emits no trace: each caller owns its own line and its own record.
 */

import { neutraliseFenceEntry } from "./plan-fence-render.ts";
import { normaliseDeclaredPath, pathTokenIn } from "./work-driver-declared-path.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import { findFenceContradictions } from "./work-driver-plan-paths.ts";

/** What `selfFenceEntryDrop` decided about one entry. */
export type SelfFenceEntryDrop =
  /** The entry may go, with the own declared path that makes it a self-fence. */
  | { drop: true; path: string }
  /** The entry stays: it names nothing, or names something this workstream does
   * not own (a sibling's path, a protected path, an undeclared subtree). */
  | { drop: false };

/** The declared paths, normalised and de-duplicated, in declaration order.
 * Exported so a caller that asks about several entries normalises once (M3). */
export function declaredPaths(ownPaths: readonly string[]): string[] {
  return [...new Set(ownPaths.map((p) => normaliseDeclaredPath(p)).filter((p) => p.length > 0))];
}

/**
 * The path-shaped arm, for a whole fence list at once: every candidate entry the
 * plan-quality gate's own containment predicate says covers one of this
 * workstream's declarations, indexed by entry so a caller looks each one up
 * instead of re-running the predicate per entry (M3 — the fold used to call
 * `findFenceContradictions` once per entry, re-normalising the whole declaration
 * list every time, for one answer per entry).
 *
 * Read as a single synthetic workstream, so containment is judged against THESE
 * declarations alone. A token whose only entry is protected is left out: an
 * entry that names a protected path keeps its fence.
 */
export function contradictionPathsByEntry(
  ownPaths: readonly string[],
  candidates: readonly string[],
): Map<string, string> {
  const own = declaredPaths(ownPaths);
  const found = findFenceContradictions({ self: { paths: own, outOfScope: [...candidates] } });
  const byEntry = new Map<string, string>();
  for (const c of found) {
    if (isProtectedPath(c.path) || isProtectedPath(c.entry)) continue;
    if (!byEntry.has(c.entry)) byEntry.set(c.entry, c.path);
  }
  return byEntry;
}

/** Every path-shaped token a prose entry makes a claim about: a whitespace-
 * delimited word carrying a `/`, or one ending in a file extension, after the
 * surrounding punctuation is stripped. Free words ("the public API surface") are
 * not tokens, so an entry made of nothing but them names nothing at all. */
export function pathTokens(entry: string): string[] {
  const out: string[] = [];
  // The scan runs on the CONTROL-FREE form of the entry. A planner (or a model
  // echoing terminal colour) can break a directory token with a control byte,
  // and an entry whose own path token the scan cannot read must never be DROPPED
  // on the strength of the tokens it did read — that is a fence removed because
  // of a character nobody can see. Reading the neutralised form instead makes a
  // control-character-bearing entry fail CLOSED (it stays), while a fence whose
  // paths are legible is judged on what it really says. The `entry` the record
  // and the note carry is neutralised again at that point, so nothing raw
  // reaches the state file either way.
  const scanned = neutraliseFenceEntry(entry);
  for (const word of scanned.split(/\s+/)) {
    // A trailing `.` or `/` is sentence punctuation, an internal one is part of
    // the name: `src/legacy.` , `src/legacy/` and `src/legacy` are the three
    // spellings of the same fence. A leading `.` is KEPT, because that is how a
    // dot-directory is spelled (`.github/`), and `pathTokenIn` then judges what
    // is left against the sentence as written.
    const token = word
      .replace(/^[,;:([{"'`]+/, "")
      .replace(/[,;:)}\]"'`]+$/, "")
      // A trailing `.` is sentence punctuation only when it ENDS a sentence (the
      // word is the last, or followed by a closing bracket); an internal one is
      // part of the name, so `src/legacy.` names that directory.
      .replace(/(?<=[^\s.])\.(?=\s|$|[)\]}])/, "");
    if (token.length === 0) continue;
    if (token.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(token)) out.push(token);
  }
  return out;
}

/** Is `token` covered by the declaration `p`, in either containment direction on
 * the `/` boundary? `tests/` and `tests` both cover a declared
 * `tests/test_x.py`; `testsfoo` covers nothing. A declaration that is a FILE
 * (`src/a.ts`) covers only itself and what is beneath it, so prose that names a
 * SIBLING's file is never "covered" by a self-declaration. */
function tokenCoveredBy(token: string, p: string): boolean {
  const clean = token.replace(/\/\*+$/, "").replace(/\/+$/, "");
  if (clean.length === 0 || clean === ".") return false;
  return p === clean || p.startsWith(`${clean}/`) || clean.startsWith(`${p}/`);
}

/**
 * The prose arm: does this sentence fence ONLY this workstream's own files?
 *
 * Each path token must (a) appear in the sentence as a WHOLE path token —
 * `pathTokenIn` is what makes `data.txt` not name `a.txt` — and (b) be covered
 * by one of its own non-protected declarations. The first token that fails
 * either test is the finding that holds the whole entry: it is a sibling's path,
 * a protected path, or something nobody declared, and there is no way to remove
 * part of a sentence. A token the whole-token rule cannot see at all (an entry
 * broken by a control byte) also holds the entry, so a fence the driver cannot
 * fully read is never dropped.
 */
function proseSelfFence(entry: string, own: readonly string[]): SelfFenceEntryDrop {
  const tokens = pathTokens(entry);
  if (tokens.length === 0) return { drop: false };
  const scanned = neutraliseFenceEntry(entry);
  let first: string | undefined;
  let named = false;
  for (const token of tokens) {
    // A token the whole-token rule does not see in its own sentence is a token
    // the sentence does not really make (`src/legacy//` matches nothing): it
    // cannot be the reason the entry goes, and it cannot be dismissed either —
    // an unreadable token holds the fence.
    if (!pathTokenIn(scanned, token)) return { drop: false };
    named = true;
    const owner = own.find((p) => tokenCoveredBy(token, p));
    if (owner === undefined) return { drop: false };
    first ??= owner;
  }
  return named && first !== undefined ? { drop: true, path: first } : { drop: false };
}

/**
 * The ONE question both fence-dropping sites ask: may this entry go?
 *
 * `ownPaths` are the workstream's declared paths (raw, or the output of
 * `declaredPaths` — normalising twice is harmless). `contradictionPath` is the
 * path-shaped arm's answer for THIS entry, from one batch call to
 * `contradictionPathsByEntry`; pass `undefined` when the entry is not path-shaped
 * or covers none of the declarations, and the prose arm judges it.
 */
export function selfFenceEntryDrop(
  entry: string,
  ownPaths: readonly string[],
  contradictionPath: string | undefined,
): SelfFenceEntryDrop {
  if (entry.trim().length === 0) return { drop: false };
  if (contradictionPath !== undefined) return { drop: true, path: contradictionPath };
  const own = declaredPaths(ownPaths).filter((p) => !isProtectedPath(p));
  if (own.length === 0) return { drop: false };
  return proseSelfFence(entry, own);
}
