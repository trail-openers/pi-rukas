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

import { trace } from "./trace.ts";
import { issueNamedTokens, resolveDefiningFile } from "./work-driver-plan-unfence-extract.ts";
import {
  fenceCoveringBroader,
  fenceEntryMatching,
  keptBroaderFenceNote,
  ownerOf,
  unfencedNote,
  unresolvedIdentifierNote,
} from "./work-driver-plan-unfence-notes.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";

/** The argv-form `git grep` / `git show` seam (issue text is data, never shell). */
export type UnfenceExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/** The workstream a fence was removed from, with the reason the operator sees. */
export interface UnfenceRecord {
  workstream: string;
  path: string;
  /** The fence entry as the planner wrote it (annotation included). */
  entry: string;
  note: string;
  /**
   * Set when the pass could not place the path it had just removed and so put
   * the entry BACK — the fence is still there, and `removed` must not claim
   * otherwise. The adversarial review of #1167 caught a warning that read
   * "left fenced" while the entry was already gone: the word was a lie about
   * the plan the develop gate would read.
   */
  restored?: string;
}

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

/** One `git show <ref>:<file>`; argv form, so the path is data, never shell. */
async function readAtRef(
  file: string,
  execFn: UnfenceExecFn,
  repoRoot: string,
  ref: string,
): Promise<string> {
  const { stdout } = await execFn("git", {
    argv: ["show", `${ref}:${file}`],
    cwd: repoRoot,
    timeout: 30_000,
  });
  return stdout;
}

/** One `git grep -l -w` at the base ref; argv form — the name is data, not shell. */
async function definingFiles(
  name: string,
  execFn: UnfenceExecFn,
  repoRoot: string,
  ref: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFn("git", {
      argv: ["grep", "-l", "-w", "-e", name, ref, "--"],
      cwd: repoRoot,
      timeout: 30_000,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    // `git grep` exits 1 with no output when nothing matches; any other
    // failure is an infra error and resolves to the same answer — nothing.
    return [];
  }
}

/** The directory prefix two paths share, counted in whole segments. */
function sharedPrefixDepth(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  let n = 0;
  while (n < as.length - 1 && n < bs.length - 1 && as[n] === bs[n]) n++;
  return n;
}

/**
 * The best workstream for a path no one declared: the one whose declared
 * paths share the longest directory prefix. Ties go to the earliest workstream
 * in plan order (first best wins, never replaced by an equal score); a path
 * sharing no directory prefix with anything returns `undefined` so the caller
 * can decline to place it — with several workstreams, handing a file to an
 * arbitrary one is a scope decision the driver does not get to make.
 */
export function placeUnplacedPath(
  path: string,
  workstreams: Record<string, Workstream>,
): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const id of Object.keys(workstreams)) {
    const ws = workstreams[id];
    if (!ws) continue;
    let score = 0;
    for (const declared of ws.paths.map((p) => normaliseDeclaredPath(p))) {
      score = Math.max(score, sharedPrefixDepth(path, declared));
    }
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Resolve every token the issue named to a repo path (identifiers via `git grep`). */
async function issueNamedPaths(
  body: string,
  opts: { execFn: UnfenceExecFn; repoRoot: string; ref: string },
  warnings: string[],
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const token of issueNamedTokens(body)) {
    if (token.includes("/")) {
      paths.add(token);
      continue;
    }
    const unique = [...new Set(await definingFiles(token, opts.execFn, opts.repoRoot, opts.ref))];
    // A name is a DEFINITION site when exactly one candidate source file
    // carries a line declaring it; test and prose files that merely mention
    // the symbol never own it. Anything else is ambiguous and never unfences.
    const sole = await resolveDefiningFile(token, unique, (file) =>
      readAtRef(file, opts.execFn, opts.repoRoot, opts.ref),
    );
    if (sole === undefined) {
      warnings.push(unresolvedIdentifierNote(token, unique, opts.ref));
      continue;
    }
    paths.add(sole);
  }
  return paths;
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
 * A fence is matched EXACTLY (see `fenceEntryCovering`): an issue naming
 * `config/app.ts` does not lift a `config/` directory fence. When a broader
 * fence covers the path the pass keeps it and records a note, so the plan says
 * why nothing changed.
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

  const paths = await issueNamedPaths(body, opts, warnings);
  const next: Record<string, Workstream> = {};
  for (const id of ids) next[id] = { ...workstreams[id] } as Workstream;

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
      for (const id of ids) {
        const ws = next[id];
        if (!ws) continue;
        if (owner && id !== owner) continue;
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
      const why = `unfenced ${path}: named by the issue, left fenced for placement (no workstream shares a directory)`;
      if (!warnings.includes(why)) warnings.push(why);
    }
  }

  if (removed.length > 0) {
    trace(`work-driver: plan unfence — removed ${removed.length} issue-contradicting fence(s)`);
  }
  return { workstreams: next, notes, warnings, placed, removed };
}
