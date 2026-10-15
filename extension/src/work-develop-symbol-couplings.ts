/**
 * work-develop-symbol-couplings — #1323: which failed workstream needs which
 * sibling. Pairs a consumer (its per-worktree verify failure names a missing
 * symbol or module) with a producer (a sibling that declares it, by its
 * `introduces` or in its own diff). The scans are in
 * work-develop-symbol-scan.ts; the merge that acts on a pair is in
 * work-develop-symbol-merge.ts.
 */

import {
  addedFilesInDiff,
  addedSymbolsInDiff,
  missingModulesIn,
  missingSymbolsIn,
  sameModule,
} from "./work-develop-symbol-scan.ts";
import { symbolKey } from "./work-driver-plan-contract.ts";

/** One coupling: `consumer`'s failure names `symbols`, which `producer` adds. */
export interface SymbolCoupling {
  consumer: string;
  producer: string;
  symbols: string[];
}

/**
 * The workstream a per-worktree failure string belongs to. The gate writes
 * `… failed in <cwd>: <output>` (work-driver-verify-verify-cmd.ts); the
 * longest matching worktree path wins, so `/wt/ws-1` never claims a failure
 * from `/wt/ws-10`.
 */
function failureOwner(failure: string, worktrees: Record<string, string>): string | undefined {
  let best: { id: string; len: number } | undefined;
  for (const [id, cwd] of Object.entries(worktrees)) {
    const at = failure.indexOf(` in ${cwd}`);
    if (at < 0) continue;
    const after = failure.charAt(at + 4 + cwd.length);
    if (after !== "" && after !== ":" && after !== " " && after !== "\n") continue;
    if (!best || cwd.length > best.len) best = { id, len: cwd.length };
  }
  return best?.id;
}

interface Missing {
  symbols: Set<string>;
  modules: Set<string>;
}

interface Adds {
  symbols: Set<string>;
  files: string[];
}

/**
 * #1323 — the consumer → producer couplings in a failed develop gate. Pure
 * apart from `diffOf` (called at most once per workstream). A symbol or
 * module the consumer itself adds is not missing because of a sibling, so
 * it never couples. The result is disjoint: once a workstream is in a
 * coupling it is not paired again this round.
 */
export async function findSymbolCouplings(
  failures: string[],
  worktrees: Record<string, string>,
  introducesOf: (id: string) => string[] | undefined,
  diffOf: (id: string) => Promise<string>,
): Promise<SymbolCoupling[]> {
  const missingBy = new Map<string, Missing>();
  for (const f of failures) {
    const id = failureOwner(f, worktrees);
    if (id === undefined) continue;
    const symbols = missingSymbolsIn(f);
    const modules = missingModulesIn(f);
    if (symbols.length === 0 && modules.length === 0) continue;
    const m = missingBy.get(id) ?? { symbols: new Set<string>(), modules: new Set<string>() };
    for (const s of symbols) m.symbols.add(s);
    for (const s of modules) m.modules.add(s);
    missingBy.set(id, m);
  }
  if (missingBy.size === 0) return [];
  const addsCache = new Map<string, Adds>();
  const addsOf = async (id: string): Promise<Adds> => {
    const cached = addsCache.get(id);
    if (cached) return cached;
    let adds: Adds = { symbols: new Set(), files: [] };
    try {
      const diff = await diffOf(id);
      adds = { symbols: new Set(addedSymbolsInDiff(diff)), files: addedFilesInDiff(diff) };
    } catch {
      // An unreadable diff is no evidence: this workstream just never matches.
    }
    addsCache.set(id, adds);
    return adds;
  };
  const used = new Set<string>();
  const out: SymbolCoupling[] = [];
  for (const [consumer, missing] of missingBy) {
    if (used.has(consumer)) continue;
    const own = await addsOf(consumer);
    const ownDeclared = new Set(
      (introducesOf(consumer) ?? []).map(symbolKey).filter((k): k is string => !!k),
    );
    const symbols = [...missing.symbols].filter((s) => !own.symbols.has(s) && !ownDeclared.has(s));
    const modules = [...missing.modules].filter((m) => !own.files.some((f) => sameModule(f, m)));
    if (symbols.length === 0 && modules.length === 0) continue;
    for (const producer of Object.keys(worktrees)) {
      if (producer === consumer || used.has(producer)) continue;
      const declared = new Set(
        (introducesOf(producer) ?? []).map(symbolKey).filter((k): k is string => !!k),
      );
      const adds = await addsOf(producer);
      const hits = [
        ...symbols.filter((s) => declared.has(s) || adds.symbols.has(s)),
        ...modules.filter((m) => adds.files.some((f) => sameModule(f, m))),
      ];
      if (hits.length === 0) continue;
      out.push({ consumer, producer, symbols: [...new Set(hits)] });
      used.add(consumer);
      used.add(producer);
      break;
    }
  }
  return out;
}
