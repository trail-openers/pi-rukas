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
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";
import { UNFENCE_NOTES_CAP } from "./work-driver-plan-unfence-notes.ts";
import type { PlanUnfenceSummary } from "./workflow-state-schema.ts";
import type { Workstream } from "./workflow-state-schema.ts";

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
  // #1862 — the plan-quality gate asks with this FALSE. A fence entry that IS a
  // path and fences the workstream's own file is the defect #1167's one-shot
  // corrective exists to fix: the planner wrote an instruction it cannot obey,
  // and the only thing that tells it so is the gate finding the contradiction.
  // The tool boundary drops a PROSE sentence of the same kind (a sentence is not
  // an instruction the develop gate could honour), but a path-shaped fence is a
  // real fence the develop gate reads, and silently emptying it means the plan
  // reaches develop un-fenced, the developer touches files the planner meant to
  // protect, and the planner is never steered. So the gate must still see it.
  countPathShaped = true,
): Map<string, string> {
  const own = declaredPaths(ownPaths);
  const found = findFenceContradictions({ self: { paths: own, outOfScope: [...candidates] } });
  const byEntry = new Map<string, string>();
  for (const c of found) {
    if (isProtectedPath(c.path) || isProtectedPath(c.entry)) continue;
    if (!countPathShaped && !/\s/.test(c.entry)) continue;
    if (!byEntry.has(c.entry)) byEntry.set(c.entry, c.path);
  }
  return byEntry;
}

/**
 * The path a fence entry covers among `paths`, by the containment rule the plan
 * gate itself uses (`findFenceContradictions`, which reads a `dir/**` / `dir/*`
 * entry as `dir`). Stated in the GATE's terms rather than in the tool boundary's:
 * `contradictory-fence` fires on exactly the entries this answers for, so the
 * view the gate reasons over can hold no entry the gate could not have judged.
 */
function coveredByOwnPath(entry: string, paths: readonly string[]): string | undefined {
  const own = declaredPaths(paths);
  if (own.length === 0) return undefined;
  const found = findFenceContradictions({ self: { paths: own, outOfScope: [entry] } });
  const hit = found.find((c) => c.entry === entry);
  if (hit === undefined) return undefined;
  // The same refusals the boundary's arm makes: a protected path is never a
  // reason to open (or to re-add) a fence.
  if (isProtectedPath(hit.path) || isProtectedPath(hit.entry)) return undefined;
  return hit.path;
}

/**
 * The self-fence entries a FOLD removed, re-added per workstream id.
 *
 * A fold — the ceiling fold or the coupling merge — unions both halves' fences
 * and then drops the entries that fence the merged workstream's own files
 * (`foldSelfFenceDrops`). The plan-quality gate has to see those entries: a fence
 * over a file the plan declares IS the `contradictory-fence` defect the one-shot
 * corrective exists to point out, and a fold has just erased it from the map the
 * gate would otherwise read. `drops` are the fold's own records, so nothing else
 * is ever added, and that restriction is the whole design:
 *
 *   - A sibling's fence or a protected path is not a drop, so it is not re-added.
 *   - The TOOL BOUNDARY's drops are not passed here either — the reader hands
 *     them to `planGateView` with the raw entry (`rawDrops`), because a fence
 *     entry is one instruction and the neutralised form a record holds is a
 *     different string than the one the planner wrote. An entry only ONE of the
 *     two removed is therefore absent from this argument and never put back, so
 *     the gate sees a wider FENCE, never a different plan.
 *
 * Because ids, `paths` and `dependsOn` all come from `merged`, a pair the merge
 * folded away cannot reappear here and cannot manufacture `overlapping-paths` or
 * a dangling `depends-on`. A drop whose id the merge absorbed contributes
 * nothing: it is not in the merged map at all.
 */
export function mergeFoldDropsInto<T extends { paths: string[]; outOfScope?: string[] }>(
  merged: Record<string, T>,
  drops: readonly UnfenceRecord[],
): Record<string, T> {
  return addEntriesByWorkstream(
    merged,
    drops.map((d) => ({ id: d.workstream, entry: d.entry })),
  );
}

/** Re-add `entries` to each named workstream's fence list, keeping the stored
 * entries first and never adding a duplicate. One rule for both re-adding sites
 * (the fold's records and the boundary's raw drops). */
function addEntriesByWorkstream<T extends { paths: string[]; outOfScope?: string[] }>(
  merged: Record<string, T>,
  entries: readonly { id: string; entry: string }[],
): Record<string, T> {
  const byId = new Map<string, string[]>();
  for (const d of entries) {
    const list = byId.get(d.id);
    if (list) list.push(d.entry);
    else byId.set(d.id, [d.entry]);
  }
  const out: Record<string, T> = {};
  for (const [id, ws] of Object.entries(merged)) {
    const extra = byId.get(id);
    if (!extra || extra.length === 0) {
      out[id] = ws;
      continue;
    }
    const kept = new Set(ws.outOfScope ?? []);
    const add = extra.filter((e) => !kept.has(e));
    out[id] = add.length === 0 ? ws : { ...ws, outOfScope: [...(ws.outOfScope ?? []), ...add] };
  }
  return out;
}

/**
 * The single view the plan-quality gate reasons over (#1862).
 *
 * `stored` is the map the cycle develops — the truth for every reason except the
 * one this exists for. `boundaryRaw` are the raw self-fence entries the tool
 * boundary removed from these very calls (it reports them; nothing re-derives
 * them), and `foldDrops` the entries the FOLD removed from the halves it merged.
 * Each is re-added through its own rule, because they arrive in different
 * forms on purpose: the boundary hands over the planner's own text so the gate
 * and the corrective steer read the entry the planner wrote, while a fold's
 * records hold the neutralised text the state file is allowed to carry, and
 * re-adding that is what lets a fold-opened contradiction be seen at all.
 *
 * Built ONCE by the tail and judged ONCE: `planQualityReason` runs a single time
 * over the result, so a plan cannot be steered on a reading no other site has.
 * A whitespace-free entry that covers none of the workstream's own declarations
 * is not a self-fence under this gate's own containment rule and is left out —
 * a fence the driver never removed is not a contradiction it may invent.
 */
export function planGateView(
  stored: Record<string, Workstream>,
  boundaryRaw: readonly { workstream: string; entry: string }[],
  foldDrops: readonly UnfenceRecord[] = [],
): Record<string, Workstream> {
  const raw = addEntriesByWorkstream(
    mergeFoldDropsInto(stored, foldDrops),
    boundaryRaw.map((d) => ({ id: d.workstream, entry: d.entry })),
  );
  const out: Record<string, Workstream> = {};
  for (const [id, ws] of Object.entries(raw)) {
    const entries = ws.outOfScope;
    if (!entries || entries.length === 0) {
      out[id] = ws;
      continue;
    }
    const kept = entries.filter((e) => /\s/.test(e) || coveredByOwnPath(e, ws.paths) !== undefined);
    out[id] = kept.length === entries.length ? ws : { ...ws, outOfScope: kept };
  }
  return out;
}

/**
 * Fold the drops the TOOL BOUNDARY made into the pass's record. Its own counter
 * (`boundarySelfFences`), not `removed` and not `selfFences`: the issue-named
 * pass, the folds and the boundary are three authorities, and an operator
 * reading a plan where fences went needs to know which of the three opened them
 * — the same reason `docsTests` and `selfFences` are counted apart. The notes
 * join `notes`, each kind held to its own cap so neither list hides the other.
 */
export function withBoundaryDrops(
  summary: PlanUnfenceSummary | undefined,
  drops: readonly UnfenceRecord[],
): PlanUnfenceSummary | undefined {
  if (drops.length === 0) return summary;
  const notes = [
    ...(summary?.notes ?? []),
    ...drops.map((r) => r.note).slice(0, UNFENCE_NOTES_CAP),
  ].slice(0, UNFENCE_NOTES_CAP * 2);
  return {
    ran: true,
    removed: summary?.removed ?? 0,
    kept: summary?.kept ?? 0,
    rolledBack: summary?.rolledBack ?? 0,
    unresolved: summary?.unresolved ?? 0,
    ...(summary?.selfFences === undefined ? {} : { selfFences: summary.selfFences }),
    boundarySelfFences: (summary?.boundarySelfFences ?? 0) + drops.length,
    ...(summary?.issueBodyUnreadable === undefined
      ? {}
      : { issueBodyUnreadable: summary.issueBodyUnreadable }),
    ...(summary?.docsTests === undefined ? {} : { docsTests: summary.docsTests }),
    notes,
  };
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
