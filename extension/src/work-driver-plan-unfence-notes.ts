/**
 * work-driver-plan-unfence-notes — #1167: the two notes the plan-time unfence
 * writes, and the one question it asks of the plan.
 *
 * Split out of work-driver-plan-unfence.ts for the AGENTS.md §12 line cap.
 * These are the strings an operator reads in a handoff, so the wording lives
 * in one place and the tests assert against it rather than a paraphrase:
 *
 *   - `unfenced <path>: named by the issue` — the fence is gone and the issue
 *     is the authority that removed it (the operator's wording from #1167).
 *   - `kept fence <entry>: the issue named <path>, not the whole directory` —
 *     the issue named one file, a BROADER directory fence covers it, and the
 *     fence STAYS (see `fenceCoveringBroader` for why exactness is the rule).
 *   - `unresolved identifier <name>: <candidates>` — the pass could not say
 *     which file a symbol lives in, so it unfenced NOTHING and said why.
 *     Silence here would be indistinguishable from "the issue named nothing",
 *     which is how an extraction bug reads as a clean plan.
 *
 * `ownerOf` is the ownership question the two carve-outs turn on: a path a
 * sibling declares keeps its fence for every non-owner (#572), and a path
 * nobody declares is the only one that can be placed.
 */

import { isPlainRepoRelativePath } from "./work-driver-plan-paths.ts";
import type { UnfenceResult } from "./work-driver-plan-unfence.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { PlanUnfenceSummary, Workstream } from "./workflow-state-schema.ts";

/**
 * #1167 round-3 — an issue-named token is only allowed to move a fence once it
 * has the SHAPE the driver can verify. `normaliseDeclaredPath` alone strips a
 * planner annotation and returns whatever is left, so an absolute
 * (`/etc/passwd`), traversing (`../secret.ts`) or glob (`src/*.ts`) token from
 * an issue body would enter `ws.paths` unchecked — a path the develop scope
 * gate and the consolidation checks compare as raw strings, and which
 * #1005's `invalid-path` reason exists to reject when the PLANNER writes it.
 * The issue body is untrusted prose, so the same bar applies here. The check
 * runs on the token AS WRITTEN: an entry carrying an annotation ("src/x.ts
 * (new)") is the planner's shape, not the issue's, and is not what this pass
 * places.
 */
export function isUnfenceablePath(token: string): boolean {
  if (token.length === 0 || token !== token.trim()) return false;
  return isPlainRepoRelativePath(token) && !/[*?[\]{}]/.test(token);
}

/**
 * The fence entry in `entries` that EXACTLY equals `path` (normalised), or
 * `undefined`.
 *
 * #1167 round-4 — exactness IS the rule, and it is why there is no second
 * "covering" variant of this function beside `fenceCoveringBroader`: an issue
 * naming `config/app.ts` says nothing about the tree around it, so it must not
 * lift a `config/` fence. A broader fence that covers the path is left to
 * `fenceCoveringBroader`, which keeps it and lets the caller note that.
 */
export function fenceEntryMatching(entries: string[], path: string): string | undefined {
  return entries.find((entry) => normaliseDeclaredPath(entry) === path);
}

/** The note the operator sees when a fence the issue contradicts is removed. */
export function unfencedNote(path: string): string {
  return `unfenced ${path}: named by the issue`;
}
/** The note the operator sees when a symbol could not be resolved to one file. */
export function unresolvedIdentifierNote(name: string, candidates: string[], ref: string): string {
  return candidates.length === 0
    ? `unresolved identifier ${name}: no defining file at ${ref}`
    : `unresolved identifier ${name}: ${candidates.slice(0, 5).join(", ")}`;
}

/**
 * The workstream that declares `path`, or `undefined` when none does. Matching
 * is normalised and containment-aware in both directions (`src/foo` owns
 * `src/foo/bar.ts`, and a fence naming `src/foo` covers `src/foo/bar.ts`), so
 * an annotated or directory-shaped entry cannot dodge the ownership question.
 */
export function ownerOf(workstreams: Record<string, Workstream>, path: string): string | undefined {
  for (const id of Object.keys(workstreams)) {
    for (const p of workstreams[id]?.paths ?? []) {
      const n = normaliseDeclaredPath(p);
      if (n === path || n.startsWith(`${path}/`) || path.startsWith(`${n}/`)) return id;
    }
  }
  return undefined;
}

/**
 * A fence entry in `entries` that is a BROADER directory containing `path`
 * (`config/` or `config/**` covers `config/app.ts`). Kept, never removed — but it is the
 * reason a pass that removed nothing can still report a note, and an operator
 * reading a plan that says nothing happened cannot tell "the issue named no
 * fence" apart from "the pass found a fence it declined to open".
 */
export function fenceCoveringBroader(entries: string[], path: string): string | undefined {
  return entries.find((entry) => {
    // #1167 round-3 / round-4 — the entry is compared AS WRITTEN except for the
    // two spellings of "directory", which mean the same thing and are both
    // stripped here: `extension/src/` and `extension/src/**` are one fence
    // written two ways, and the round-3 fix for the trailing separator left the
    // glob form matching nothing.
    //
    // #1707 moved the glob half of that strip OUT of `normaliseDeclaredPath`
    // (it now strips only paired markup, so a wildcard survives — the plan-to-
    // spec gate depends on that) and INTO this line: `/**` is a fence's way of
    // spelling "this directory", not a pattern the fence matches, so the rule
    // is this caller's and lives where the two spellings are described.
    // `normaliseDeclaredPath` still handles the trailing `/` and a planner
    // annotation, and the directory judgement no longer reads the separator,
    // because the comparison below requires a `/` boundary anyway:
    // `extension/src` only ever covers a path *inside* `extension/src/`, never
    // a sibling named `extension/srcfoo`.
    if (entry === path) return false;
    const dir = normaliseDeclaredPath(entry).replace(/\/\*\*$/, "");
    if (dir.length === 0) return false;
    return path.startsWith(`${dir}/`);
  });
}

/**
 * The note the operator sees when the issue names a path that a BROADER
 * directory fence covers. The fence stays — the issue named one file, not the
 * tree around it — and this is what says so out loud instead of silently.
 */
export function keptBroaderFenceNote(path: string, entry: string): string {
  return `kept fence ${entry}: the issue named ${path}, not the whole directory`;
}

/**
 * #1167 round-3 — the one-line record the plan step persists on
 * `pipelineState.planQuality` so the operator can see the pass ran, what it
 * did, and what it declined to do.
 *
 * Before this, notes and warnings went only to `trace()` — a stream the
 * operator does not read during a cycle, so "the unfence found nothing" and
 * "the unfence could not read the issue / hit its cap / failed at git" looked
 * identical from the state file. `kept` is the count of broader-directory
 * fences the pass deliberately did not open. `undefined` fields are absent
 * rather than zero so a clean pass writes `{ran: true, removed: 0, kept: 0}`
 * and nothing else.
 *
 * It lives beside the note builders because it READS them: `kept` and
 * `unresolved` are counts of these exact strings, and a wording change in one
 * place and not the other silently counts zero.
 */
export function unfenceSummary(
  result: UnfenceResult,
  issueBodyUnreadable = false,
): PlanUnfenceSummary {
  const kept = result.notes.filter((n) => n.startsWith("kept fence ")).length;
  const rolledBack = result.removed.filter((r) => r.restored !== undefined).length;
  const unresolved = result.warnings.filter((w) => w.startsWith("unresolved identifier")).length;
  return {
    ran: true,
    removed: result.removed.length - rolledBack,
    kept,
    rolledBack,
    unresolved,
    ...(issueBodyUnreadable ? { issueBodyUnreadable: true } : {}),
    ...(result.notes.length > 0 ? { notes: result.notes.slice(0, 10) } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings.slice(0, 10) } : {}),
  };
}
