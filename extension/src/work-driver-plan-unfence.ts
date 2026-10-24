/**
 * work-driver-plan-unfence — #1167: a plan must not fence out what the issue
 * itself requires.
 *
 * The bug (measured on /work #1020, 2026-10-13): the planner wrote
 * `extension/src/dispatch.ts` into the single workstream's `out-of-scope:`
 * line, while the issue's own `## Resolved decisions` require `dispatchCore`
 * (which lives in `dispatch.ts`) to take a `DispatchHost`. Develop then
 * parked with `workstream default touched out-of-scope path
 * extension/src/dispatch.ts — declared fence violated (issue-fenced)`, and the
 * correct change had to be finished by hand (PR #1159). Same class as #1137's
 * out-of-scope lists that said "sibling owns all tests" after workstreams had
 * been merged.
 *
 * The fence is not the defect — the develop gate (`work-driver-scope-fanout
 * .ts`) is correct to fail a file no one owns, and this module deliberately
 * does not touch it. The defect is that nothing between the planner's reply
 * and the plan being accepted ever asked whether a fence contradicted the
 * issue. So the fix lives at plan time: read the issue's own decision and
 * acceptance sections, and drop from every fence any path the issue names.
 *
 * What is NOT unfenced (both keep the fence, per the operator resolutions of
 * 2026-10-17 recorded on #1167):
 *
 *   - **Prohibitions.** A section line that says "do not touch X" names X, and
 *     removing that fence would remove a boundary the issue itself asked for.
 *   - **Sibling-owned paths.** When a sibling workstream declares the path in
 *     its `paths`, the fence stays for every OTHER workstream — the #572
 *     cross-declaration contract makes that fence a true-positive collision
 *     warning, not an issue-level contradiction. The owner is never fenced
 *     (this pass removes it from the owner's own list, which is what #776 /
 *     #784's self-fence demotion was a workaround for).
 *
 * The pass runs AFTER the MAX_WORKSTREAMS fold, the port fold and the coupling
 * merge (all three rewrite `outOfScope` — `foldTwo` unions it — so an earlier
 * unfence can be reintroduced) and BEFORE `planQualityReason`, so the quality
 * gate judges the plan the driver will actually develop.
 *
 * The extraction half — which sections are requirements and which tokens name
 * a file or symbol — lives in work-driver-plan-unfence-extract.ts.
 */

import { keepClippedRecords } from "./plan-fence-record.ts";
import { trace, traceWarn } from "./trace.ts";
import { resolveDefiningFile } from "./work-driver-plan-unfence-defines.ts";
import {
  couldNotResolveNote,
  issueNamedTokensWithRejections,
} from "./work-driver-plan-unfence-extract.ts";
import { definingFiles, readAtRef } from "./work-driver-plan-unfence-git.ts";
import { placeUnplacedPath, rankIdentifiers } from "./work-driver-plan-unfence-place.ts";

// The placement/ranking helpers live in work-driver-plan-unfence-place.ts (the
// 500-line gate) and are re-exported here so this module stays the one import
// path callers know, as the other fragments of this module are.
export { placeUnplacedPath } from "./work-driver-plan-unfence-place.ts";
import {
  fenceCoveringBroader,
  fenceEntryMatching,
  isUnfenceablePath,
  keptBroaderFenceNote,
  ownerOf,
  type UnfenceRecord,
  unfencedNote,
  unresolvedIdentifierNote,
} from "./work-driver-plan-unfence-notes.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";

/**
 * One warning per refused issue-named token (#1167 round-3). Only path-shaped
 * rejections are named individually: the identifier half of a split token
 * (`passwd` out of `/etc/passwd`) is ordinary prose to grep for, and reporting
 * every English word would bury the warnings that matter.
 */
function warnRejected(warnings: string[], token: string): void {
  if (!token.includes("/")) return;
  const bare = token.split("/").pop() ?? token;
  if (!/\.[A-Za-z][A-Za-z0-9]*$/.test(bare) && !token.endsWith("/")) return;
  const why = /[*?[\]{}]/.test(token) ? "a glob names no file" : "not a plain repo-relative path";
  const note = `rejected issue-named token ${token}: ${why} — no fence it names is lifted`;
  if (!warnings.includes(note)) warnings.push(note);
}

/** The argv-form `git grep` / `git show` seam (issue text is data, never shell). */
export type UnfenceExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/** The verdict of the pass: the repaired plan plus what it did. */
export interface UnfenceResult {
  workstreams: Record<string, Workstream>;
  /** `unfenced <path>: named by the issue` — one per removed fence entry. */
  notes: string[];
  /** `unresolved identifier <name>: <candidates>` — never unfences anything. */
  warnings: string[];
  /** Paths the issue named that no workstream declared, and where each went. */
  placed: Array<{ path: string; workstream: string }>;
  removed: UnfenceRecord[];
}

/**
 * #1167 round-3 — the ceiling on identifier resolutions per pass. Each one
 * costs a `git grep` plus a `git show` per candidate, run serially, and the
 * issue body is unbounded prose: an acceptance-criteria list naming thirty
 * symbols used to be thirty-plus subprocess spawns inside the plan step, with
 * no bound at all. Fifteen covers a real issue's decisions section by a wide
 * margin; past it the pass stops resolving and RECORDS what it skipped, so an
 * operator can see the pass declined rather than concluding nothing was named.
 */
const MAX_IDENTIFIER_RESOLUTIONS = 15;

/**
 * Resolve every token the issue named to a repo path (identifiers via `git grep`).
 *
 * Two bounds the first implementation did not have (#1167 round-3), both of
 * them the same failure shape — unbounded work driven by untrusted prose:
 *
 *   - **No fences, no I/O.** With nothing fenced there is nothing to remove,
 *     so the whole resolution step is skipped before the first subprocess.
 *   - **A cap on what IS resolved** (`MAX_IDENTIFIER_RESOLUTIONS`), spent on
 *     the de-duplicated set of names, with the remainder recorded as a warning
 *     rather than dropped silently.
 *
 * There is no per-name pre-filter, and `rankIdentifiers` says why.
 *
 * Every path — the ones the issue wrote directly and the ones an identifier
 * resolved to — passes `isUnfenceablePath` before it is returned, so an
 * absolute, traversing, glob or metacharacter token from the issue body can
 * neither unfence a fence nor land in a workstream's `paths`.
 */
async function issueNamedPaths(
  body: string,
  opts: { execFn: UnfenceExecFn; repoRoot: string; ref: string },
  fences: Set<string>,
  warnings: string[],
): Promise<Set<string>> {
  const paths = new Set<string>();
  const identifiers: string[] = [];
  const extracted = issueNamedTokensWithRejections(body);
  for (const token of extracted.tokens) {
    if (isUnfenceablePath(token)) {
      if (token.includes("/")) {
        paths.add(token);
        continue;
      }
      identifiers.push(token);
      continue;
    }
    // A token the extractor let through and this check did not — the two
    // grammars are not identical, so this is the belt to that brace, and it is
    // reported for the same reason.
    warnRejected(warnings, token);
  }
  // #1167 round-3 — the extractor's own refusals. An issue whose paths were all
  // absolute, traversing or shell-laden used to extract NOTHING and look
  // exactly like an issue that named no path, so a plan full of untouched
  // fences read as a clean one. Saying what was refused is what separates the
  // two.
  for (const token of extracted.rejected) warnRejected(warnings, token);
  // Bound #2: an identifier only earns a grep when some fence entry's basename
  // or extension-less stem relates to it. This is NOT the claim "the file that
  // defines the symbol is named like the symbol" — it does not have to be, and
  // `dispatchCore` in `dispatch.ts` is the counter-example. It is the claim
  // "the fence an unfence could remove is named like a file", which is checkable
  // from the plan alone: a resolved identifier can only ever equal some fence
  // entry (nothing else is removed), so its file's basename has to relate to
  // that entry, and a symbol whose name relates to no fence basename cannot
  // resolve to a file any fence names.
  //
  // The match tolerates `-`/`_` and optional word separators, because the
  // repo's two conventions differ: the fence `dispatch-core.ts` and the symbol
  // `dispatchCore` are the same name written two ways. Without that, real
  // fences silently stop unfencing — the wrong direction of failure.
  //
  // The cap then applies to what SURVIVES the filter, never before it. The
  // first attempt at this bounded the raw token list, and a real issue body
  // (76 identifiers, ordinary English in front) used the whole budget on
  // `No`, `module`, `holds`, `an` — so `dispatchCore`, the one symbol whose
  // fence #1020 actually parked on, was never resolved and the replay regressed.
  //
  // A name that fails the filter is also never reported as "unresolved":
  // nothing was consulted for it, so that warning would describe work the pass
  // correctly declined, and ordinary English in an acceptance list would bury
  // the one warning that matters — a symbol whose fence the plan really carries.
  //
  // DEDUPLICATED before the budget is spent: the extractor hands back the
  // token list in issue order, and a criteria list that names one symbol three
  // times used to burn three of fifteen slots on it, pushing the names behind
  // it out of the pass while the cap warned about a count nobody recognised.
  const relevant = rankIdentifiers(identifiers, fences);
  const resolved = relevant.slice(0, MAX_IDENTIFIER_RESOLUTIONS);
  if (relevant.length > resolved.length) {
    const skipped = relevant.slice(MAX_IDENTIFIER_RESOLUTIONS);
    warnings.push(
      `identifier cap: ${skipped.length} of ${relevant.length} fence-matching names not resolved (max ${MAX_IDENTIFIER_RESOLUTIONS}): ${skipped
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  for (const token of resolved) {
    let unique: string[];
    try {
      unique = [...new Set(await definingFiles(token, opts.execFn, opts.repoRoot, opts.ref))];
    } catch (err) {
      // #1167 round-3 — a git failure is NOT "this symbol is defined nowhere".
      // It used to resolve to the same empty list either way, so a corrupt
      // repository or a bad ref read as a clean plan. Here it fails CLOSED (no
      // unfence from this name) and says which of the two it was, and the pass
      // carries on with the next name rather than throwing the plan step away
      // over a grep.
      const why = (err as Error)?.message ?? String(err);
      warnings.push(
        `git grep failed for ${token}: not resolved (a git failure is not a no-match) — ${why.slice(0, 120)}`,
      );
      continue;
    }
    // A name is a DEFINITION site when exactly one candidate source file
    // carries a line declaring it; test and prose files that merely mention
    // the symbol never own it. Anything else is ambiguous and never unfences.
    let sole: string | undefined;
    try {
      sole = await resolveDefiningFile(
        token,
        unique,
        (file) => readAtRef(file, opts.execFn, opts.repoRoot, opts.ref),
        // #1167 round-4 — no bare catch down in the resolver: a `git show`
        // that FAILED is reported here as "could not resolve", never swallowed
        // into the same empty answer as "no file defines this". Both keep the
        // fence; only one of them is a fact about the repository.
        (name, why) => warnings.push(couldNotResolveNote(name, why)),
      );
    } catch (err) {
      warnings.push(
        `git show failed while resolving ${token}: left fenced — ${(err as Error)?.message?.slice(0, 120) ?? String(err)}`,
      );
      continue;
    }
    if (sole === undefined) {
      warnings.push(unresolvedIdentifierNote(token, unique, opts.ref));
      continue;
    }
    if (!isUnfenceablePath(sole)) {
      warnings.push(`rejected resolved path ${sole} for ${token}: not a plain repo-relative path`);
      continue;
    }
    paths.add(sole);
  }
  return paths;
}

/** Every fence entry across the plan, as written by the planner.
 *
 * The set is what the pass needs twice over: as the short-circuit condition
 * (no entries → nothing to remove → no I/O) and as the name filter below.
 */
function allFenceEntries(workstreams: Record<string, Workstream>): Set<string> {
  const out = new Set<string>();
  for (const id of Object.keys(workstreams)) {
    for (const entry of workstreams[id]?.outOfScope ?? []) {
      // #1167 round-3 — trimmed, never stripped of a trailing `/`. A directory
      // fence means its separator (`docs/` is "that tree"), and the one place
      // these entries are consulted turns on it: `fenceCoveringBroader` tells a
      // broader directory fence from an ordinary one by it, and losing it is
      // how a pass that DECLINED to open a fence became indistinguishable from
      // one that saw none. Whitespace around a planner's entry is noise; the
      // separator is the entry's meaning.
      if (entry.trim().length > 0) out.add(entry.trim());
    }
  }
  return out;
}

/**
 * Remove every fence the issue itself contradicts, and place any removed path
 * that no workstream declares.
 *
 * `defaultToSingle` is the N=1 shape: with one workstream a path the issue
 * names belongs to that workstream even when no declared path shares a
 * directory with it. With N>1 placement needs a real shared prefix — a path
 * sharing no directory with any workstream stays fenced rather than being
 * handed to an arbitrary developer, which is how a removed fence would become
 * a scope fanout. "Stays fenced" is carried out literally: the removal for
 * that path is rolled back (see `UnfenceRecord.restored`) rather than
 * reported and left un-done.
 *
 * A fence is matched EXACTLY (`fenceEntryMatching` compares the normalised
 * entry to the path and removes only an entry that equals it): an issue naming
 * `config/app.ts` does not lift a `config/` directory fence. When such a
 * broader fence covers the path, `fenceCoveringBroader` finds it, the pass
 * keeps it and records a note, so the plan says why nothing changed.
 */
export async function unfenceIssueNamedPaths(
  workstreams: Record<string, Workstream>,
  body: string,
  opts: { execFn: UnfenceExecFn; repoRoot: string; ref: string; defaultToSingle?: boolean },
): Promise<UnfenceResult> {
  const ids = Object.keys(workstreams);
  const notes: string[] = [];
  const warnings: string[] = [];
  const placed: Array<{ path: string; workstream: string }> = [];
  const removed: UnfenceRecord[] = [];
  if (ids.length === 0) return { workstreams, notes, warnings, placed, removed };

  // #1167 round-3 — the short-circuit lives BEFORE the copy as well as before
  // the I/O: a plan with nothing fenced has no fence to remove, so the pass
  // hands back the caller's own map rather than a clone of it it never edited.
  const fences = allFenceEntries(workstreams);
  if (fences.size === 0) return { workstreams, notes, warnings, placed, removed };

  // #1167 round-3 — a SHALLOW copy mutates the caller: `{ ...ws }` shares the
  // very `paths` / `outOfScope` arrays the caller's plan holds, and every edit
  // below reassigns one of them — so the pass wrote through into its input.
  // The arrays are cloned here so the input map is never touched, and
  // `dependsOn` / `introduces` / `consumes` cannot leak the same way if a
  // later edit begins to write them.
  const next: Record<string, Workstream> = {};
  for (const id of ids) {
    const ws = workstreams[id];
    if (!ws) continue;
    next[id] = {
      ...ws,
      paths: [...ws.paths],
      outOfScope: [...ws.outOfScope],
      ...(ws.dependsOn ? { dependsOn: [...ws.dependsOn] } : {}),
      ...(ws.introduces ? { introduces: [...ws.introduces] } : {}),
      ...(ws.consumes ? { consumes: [...ws.consumes] } : {}),
    } as Workstream;
  }

  const paths = await issueNamedPaths(body, opts, fences, warnings);

  // #1167 round-3 — the fence side of the same check. An issue writing
  // `/etc/passwd` yields no usable token at all (the extractor splits it into
  // prose), and a glob is dropped before the token list is built — so neither
  // can be reported from the extraction side. But the PLAN may still carry
  // either as a fence entry (`dispatch-deck*.ts`, `agents-base/**` are this
  // repo's own shapes), and the develop gate and the consolidation checks
  // compare fence entries as raw strings. A fence whose shape the driver cannot
  // verify, or which names no file at all, is said out loud here — on the one
  // pass that reads every fence — instead of failing silently at develop.
  for (const entry of fences) {
    const glob = /[*?[\]{}]/.test(entry);
    if (isUnfenceablePath(entry)) continue;
    const why = glob
      ? "a glob names no specific file, so no unfence can reach it"
      : "not a plain repo-relative path — the scope gate cannot verify it";
    const note = `fence entry ${entry}: ${why}`;
    if (!warnings.includes(note)) warnings.push(note);
  }

  for (const path of paths) {
    const owner = ownerOf(next, path);
    const removals: UnfenceRecord[] = [];
    for (const id of ids) {
      const ws = next[id];
      if (!ws) continue;
      // A path owned by a sibling stays fenced for every non-owner.
      if (owner && id !== owner) continue;
      const hit = fenceEntryMatching(ws.outOfScope, path);
      if (hit === undefined) continue;
      ws.outOfScope = ws.outOfScope.filter((entry) => entry !== hit);
      removals.push({
        workstream: id,
        path,
        entry: hit,
        note: unfencedNote(path),
      });
    }
    if (removals.length === 0) {
      // Nothing was removed — but a BROADER directory fence may be covering
      // this very path. It stays (the issue named a file, not the tree), and
      // the plan records that rather than leaving the operator to wonder
      // whether the pass ran at all.
      //
      // #1167 round-3 — the ownership filter is deliberately NOT applied here,
      // unlike the removal loop above. A removal from a non-owner would be a
      // scope grant, so ownership gates it; a NOTE grants nothing, and the
      // #572 cross-declaration contract means the directory fence over an
      // issue-named file is normally on a SIBLING. Applying the filter here
      // meant the "we saw a wider fence and declined to open it" note almost
      // never fired, and a pass that declined read as a pass that saw nothing.
      //
      // A note is evidence about what the pass SAW, so unlike a removal it
      // never has to be taken back: when every removal for this path is later
      // rolled back (see `UnfenceRecord.restored`), the `unfenced …` notes go
      // with the removal and this one stays, because the broader fence really
      // is still there.
      for (const id of ids) {
        const ws = next[id];
        if (!ws) continue;
        const broader = fenceCoveringBroader(ws.outOfScope, path);
        if (broader === undefined) continue;
        const note = keptBroaderFenceNote(path, broader);
        if (!notes.includes(note)) notes.push(note);
      }
      continue;
    }
    for (const rec of removals) removed.push(rec);
    const note = unfencedNote(path);
    if (!notes.includes(note)) notes.push(note);
    // Placement only when NO workstream declared the path — adding a path an
    // owner already declared to a second workstream would manufacture the very
    // overlap `findPathCollisions` rejects.
    if (owner !== undefined) continue;
    const target =
      placeUnplacedPath(path, next) ??
      (ids.length === 1 && opts.defaultToSingle ? ids[0] : undefined);
    const ws = target ? next[target] : undefined;
    if (target && ws && !ws.paths.some((p) => normaliseDeclaredPath(p) === path)) {
      ws.paths = [...ws.paths, path];
      placed.push({ path, workstream: target });
      notes.push(`${note} — placed in workstream ${target}`);
      continue;
    }
    if (target) continue; // already declared — nothing to place, nothing to undo
    // No workstream can own the path, so the fence is NOT lifted: an unfence
    // without an owner is a file no developer may touch, and a plan note that
    // says "left fenced" while the entry is gone is a note about a plan that
    // does not exist. Roll the removal back and say what was done.
    for (const rec of removals) {
      const target2 = next[rec.workstream];
      if (!target2 || target2.outOfScope.includes(rec.entry)) continue;
      target2.outOfScope = [...target2.outOfScope, rec.entry];
      rec.restored = rec.entry;
    }
    const kept = removals.filter((rec) => rec.restored !== undefined);
    if (kept.length > 0) {
      // #1167 round-3 / round-4 — the rollback has to take its own notes back
      // with it. The `unfenced …` note was pushed above on the assumption the
      // removal stuck; leaving it in place alongside a fence that is back makes
      // the plan say two opposite things about the same file, and the operator
      // reading notes cannot tell which is the plan the develop gate sees. The
      // `unfenced <path>: named by the issue` line is the same claim in a second
      // field — round-3 removed the long form and left that one, so a fully
      // rolled-back path still read "unfenced" beside a warning that said it was
      // left fenced. Both go when nothing was removed.
      const dropped = unfencedNote(path);
      for (let i = notes.length - 1; i >= 0; i--) {
        if (notes[i] === dropped) notes.splice(i, 1);
      }
      const why = `unfenced ${path}: named by the issue, left fenced for placement (no workstream shares a directory)`;
      if (!warnings.includes(why)) warnings.push(why);
    }
  }

  // #1744 — a clip record is keyed by its ENTRY TEXT, so this pass needs no
  // re-keying at all: keep the records whose entry still exists and every drop
  // record, and a removed entry takes its own record with it. A restored entry
  // (the no-owner rollback put it back) still names itself, so its marker
  // survives. Carrying a record for an entry that is gone would hang the
  // "…[clipped]" marker on nothing.
  for (const id of ids) {
    const ws = next[id];
    if (!ws?.outOfScopeClipped) continue;
    const kept = keepClippedRecords(ws.outOfScope, ws.outOfScopeClipped);
    // The key is REMOVED when nothing is left, never set to `undefined`: a
    // present-but-empty field is a second shape for "nothing was bounded", and a
    // reader (or a state file that round-trips) has to learn which one means what.
    const { outOfScopeClipped: _dropped, ...rest } = ws;
    next[id] = kept.length > 0 ? { ...rest, outOfScopeClipped: kept } : rest;
  }

  if (removed.length > 0) {
    trace(`work-driver: plan unfence — removed ${removed.length} issue-contradicting fence(s)`);
  }
  if (warnings.length > 0) {
    traceWarn(
      `work-driver: plan unfence — ${warnings.length} warning(s): ${warnings
        .slice(0, 3)
        .join(" | ")}`,
    );
  }
  return { workstreams: next, notes, warnings, placed, removed };
}

// `unfenceSummary` — the operator's persisted record of this pass — lives with
// the note builders it counts in work-driver-plan-unfence-notes.ts (the §12
// cap, and it reads those exact strings). Re-exported so the plan step keeps
// one import path for the pass and its record.
export { unfenceSummary } from "./work-driver-plan-unfence-notes.ts";
export type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";
