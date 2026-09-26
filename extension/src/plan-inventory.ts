/**
 * plan-inventory — Phase 1 of the compiled /plan pipeline (mechanical
 * inventory: vipune + forge issue search).
 *
 * Split out of plan-draft.ts along the 500-line hard limit (AGENTS.md §12).
 * The vipune seam (injectable for tests) and the forge-adapter resolution
 * live here with their consumer, `mechanicalInventory`; plan-draft.ts
 * re-exports for existing consumers.
 *
 * #858: the vipune leg is TWO calls — a semantic read (calibrated cosine
 * scores) and a hybrid leg for the agreement bit — filtered through
 * `selectResults` with `requireAgreement` (the documented guard rule:
 * semantic floor AND agreement). The old single unfiltered leg is what let
 * unrelated rows enter the inventory. Any vipune failure on either leg
 * degrades to an empty inventory, never a throw (a memory problem must not
 * cost a cycle whose code work is done).
 */
import { detectForge } from "./forge-detect.ts";
import { type Forge, createForge } from "./forge.ts";
import type { MemoryHit } from "./vipune.ts";
import { type SearchResult, selectResults, vipuneSearch } from "./vipune.ts";

// ---------------------------------------------------------------------------
// vipune seam — injectable for tests (the same DI pattern as setPlanDispatch /
// setPlanForge; production keeps the real vipuneSearch with a 30 s bound).
// ---------------------------------------------------------------------------

type PlanVipuneSearchFn = typeof vipuneSearch;

let _planVipuneSearch: PlanVipuneSearchFn | null = null;

/** Set a vipune-search stub for the next runs (tests). Pass `null` to clear. */
export function setPlanVipuneSearch(fn: PlanVipuneSearchFn | null): void {
  _planVipuneSearch = fn;
}

/**
 * Resolve the forge adapter for the plan-draft inventory step
 * (#612 S4 task-b). `PI_ENSEMBLE_FORGE=none` refuses; unknown detection
 * falls back to raw `gh` (pre-migration behaviour).
 */
async function planDraftForge(repoRoot: string): Promise<Forge | undefined> {
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  try {
    const det = await detectForge(repoRoot, {});
    if (det.forge === "unknown") return undefined;
    return createForge(det, { cwd: repoRoot });
  } catch {
    return undefined;
  }
}

export interface MechanicalInventory {
  memory: MemoryHit[];
  related: { number: number; title: string; state: string }[];
  errors: string[];
}

/**
 * Extract the concrete code identifiers the descriptor names (file names,
 * dotted/qualified symbols). Phase 2's code prior-art leg runs only when
 * the descriptor actually names code — a meta descriptor should not burn a
 * code search.
 */
export function codeIdentifiersIn(descriptor: string): string[] {
  const out = new Set<string>();
  const fileRe = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|rs|go|py|rb|sh|json|ya?ml|toml)\b/g;
  const symbolRe = /\b[a-z][a-zA-Z0-9]*(?:[./][a-zA-Z0-9_]+)+\b/g;
  for (const m of descriptor.matchAll(fileRe)) if (m[0]) out.add(m[0]);
  for (const m of descriptor.matchAll(symbolRe)) if (m[0] && m[0].length >= 6) out.add(m[0]);
  return [...out].slice(0, 5);
}

export async function mechanicalInventory(
  repoRoot: string,
  descriptor: string,
  forgeOverride?: Forge,
): Promise<MechanicalInventory> {
  const keywords = descriptor
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^(the|and|with|from|into|that|this|which|when)\b/i.test(w))
    .slice(0, 4);
  const terms = keywords.length > 0 ? keywords.join(" ") : descriptor.slice(0, 60);
  // #612 S4 task-b — forge adapter (an unresolvable forge yields an empty
  // related list, no error). The two legs share no data — concurrent.
  const searchFn = _planVipuneSearch ?? vipuneSearch;
  const searchOpts = { cwd: repoRoot, timeoutMs: 30_000 };
  const [semRes, hydRes, forgeSide] = await Promise.all([
    searchFn(terms, { ...searchOpts, limit: 5 }),
    searchFn(terms, { ...searchOpts, limit: 5, hybrid: true }),
    (async () => {
      const related: MechanicalInventory["related"] = [];
      const errors: string[] = [];
      const forge = forgeOverride ?? (await planDraftForge(repoRoot));
      if (forge) {
        try {
          const rows = await forge.issueSearch(terms.replace(/'/g, ""));
          for (const r of rows) related.push({ number: r.number, title: r.title, state: r.state });
        } catch (err) {
          errors.push(`forge issueSearch: ${(err as Error).message.split("\n")[0]}`);
        }
      }
      return { related, errors };
    })(),
  ]);
  const memory = pickRelevant(semRes, hydRes);
  return { memory, ...forgeSide };
}

/**
 * #858: the relevance filter for inventory rows — the selectResults guard
 * rule (semantic floor AND hybrid agreement bit). A failing or empty hybrid
 * leg drops every row (the conjunction cannot pass without both legs);
 * `selectResults` never throws, so this cannot either.
 */
function pickRelevant(sem: SearchResult, hyd: SearchResult | undefined): MemoryHit[] {
  const semantic = sem.kind === "hits" ? sem.hits : [];
  const hybrid = hyd && hyd.kind === "hits" ? hyd.hits : undefined;
  return selectResults(semantic, hybrid, { requireAgreement: true });
}
