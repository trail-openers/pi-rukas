/**
 * work-driver-plan-unfence-place — #1167: the two judgements the unfence pass
 * makes about the PLAN (as opposed to the issue text or the repo).
 *
 * Split out of work-driver-plan-unfence.ts for the AGENTS.md §12 line cap.
 *
 *   - `rankIdentifiers` decides who gets the bounded grep budget when the issue
 *     named more symbols than the cap allows. It ORDERS, never filters, and the
 *     docstring says why filtering a symbol by its name is not sound.
 *   - `placeUnplacedPath` decides which workstream owns a path the issue named
 *     and nobody declared. Longest shared directory prefix wins; no shared
 *     prefix at all returns `undefined` so the caller can decline — with
 *     several workstreams, handing a file to an arbitrary one is a scope
 *     decision the driver does not get to make.
 *
 * Both are pure functions of (issue text already extracted) + (the plan), with
 * no I/O, which is what makes them testable without a repo or a git stub.
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";

/**
 * The cap's budget is spent on the names most likely to name a fence, in this
 * order: exact basename/stem match first, then the two containment directions,
 * then everything else — each group in issue order.
 *
 * #1167 round-3 — there is deliberately NO *filter* here, and the reason is
 * worth keeping in the file because it is the obvious-looking optimisation that
 * must not come back. A symbol resolves to the file that DECLARES it, and no
 * string comparison between a symbol's name and a fence's basename says which
 * file that is:
 *
 *   - `dispatchCore` is declared in `dispatch.ts` — a fence whose stem is a
 *     PREFIX of the name, so an equality test drops it (#1020's own case);
 *   - `parseReport` may be declared in `reportConsumer.ts` — no shared prefix
 *     or suffix at all;
 *   - `mysterySymbol` may be declared nowhere, which is the fact the grep
 *     exists to establish and which the `unresolved identifier` note reports.
 *
 * Dropping such a name does not make the answer "no" — it makes the answer "we
 * did not ask", indistinguishable from "the issue named no fence", which is the
 * exact failure this module exists to remove. So nothing is dropped.
 *
 * ORDERING, by contrast, is safe and is what makes the cap usable. On the
 * #1020 fixture the body names 76 identifiers before the cap, and with no
 * ordering the fifteen spent were `No` / `module` / `holds` / `an` — ordinary
 * English, and the fence that parked that cycle stayed put. Ranking cannot
 * produce a false negative: every name is still resolved while the budget
 * lasts, and past the cap the name is reported as skipped. Rank only decides
 * who is refused when there is not enough budget for everyone, and a name that
 * looks nothing like any fence is the honest first candidate for that.
 */
export function rankIdentifiers(identifiers: string[], fences: Set<string>): string[] {
  const unique = [...new Set(identifiers)];
  const fenceKeys: string[] = [];
  for (const entry of fences) {
    const base = entry.split("/").pop() ?? entry;
    // A directory fence (`docs/`) has no basename; its last non-empty segment
    // is the name an identifier could relate to.
    const named = base.length > 0 ? base : (entry.replace(/\/+$/, "").split("/").pop() ?? entry);
    for (const key of [named, named.replace(/\.[^.]+$/, "")]) {
      const k = nameSkeleton(key);
      if (k.length > 0 && !fenceKeys.includes(k)) fenceKeys.push(k);
    }
  }
  const score = (name: string): number => {
    const t = nameSkeleton(name);
    let best = 3;
    for (const k of fenceKeys) {
      if (k === t) return 0;
      if (t.startsWith(k) || k.startsWith(t)) best = Math.min(best, 1);
      else best = Math.min(best, 2);
    }
    return best;
  };
  // Array#sort is stable, so issue order survives inside each rank.
  return unique.sort((a, b) => score(a) - score(b));
}

/** Lowercase letters and digits only — the spelling-insensitive form of a name. */
function nameSkeleton(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
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
