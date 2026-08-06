/**
 * Deterministic multi-issue grouping for `/work N M P ...`. Split out of
 * work-driver.ts (#171) to stay under the module-size guideline (AGENTS.md
 * §12) — this is a pure function (issue bodies in, groups out), and
 * `commands.ts` imports it directly to run the grouping analysis ahead of
 * dispatching cycles.
 */

/**
 * PR16 — Deterministic multi-issue grouping.
 *
 * For /work N M P with K > 1 activeIssues, partition them into groups
 * that will each become one worktree + one PR. The compiled driver's
 * PR10 shortcut bundled ALL K issues into ONE PR; that empirically
 * failed 3× (vipune `memory-row`). PR15 retreated to one-PR-per-issue.
 * PR16 restores the old PM-driven /work's smarts (analyze → group
 * related issues → parallelize independent ones) but codified as pure
 * code so it's deterministic and testable.
 *
 * Rules, applied first-match-wins per issue-pair, union-find into
 * groups:
 *
 *   R1 — Explicit link markers: regex on issue bodies for
 *        "depends-on: #N", "companion-to: #N", "blocks #N",
 *        "blocked-by: #N". Directed edge; both directions merge.
 *   R2 — Path-overlap ≥ 50% (Jaccard): parse file paths from body
 *        fenced code + bullet lists; ≥ 0.5 overlap → same group.
 *   R3 — Explicit SPLIT marker (anchored at line start):
 *        "Split: true", "Split: yes", "Split: separate", or
 *        "This work must ship separately" → force the containing
 *        issue into its own singleton group even if R1/R2 would have
 *        merged it. (#312 — bare word "independent" removed due to
 *        high false-positive rate in prose).
 *   R4 — Subsystem tag prefix in title: [frontend], [docs], etc.
 *        Same-prefix issues group together, absent R3.
 *   R5 — Default: separate groups.
 *
 * Guardrails after grouping:
 *
 *   - Cap group size at MAX_ISSUES_PER_GROUP (3) — bigger groups
 *     approach the adversarial convergence wall (vipune `memory-row`
 *     empirical ceiling: > 3 issues in one bundle collapsed 3×).
 *     Excess splits into per-issue singletons.
 *   - K > MAX_PARALLEL_GROUPS (2) triggers "sequential" fanout mode
 *     for the remainder (matches worktree cherry-pick ceiling from
 *     vipune `memory-row`).
 *
 * Output shape matches `parseWorkstreams`: `Record<groupId, {id, scope,
 * paths, outOfScope, issues}>`. Each entry becomes one workstream
 * downstream — the rest of the driver iterates
 * `Object.keys(workstreams)` unchanged.
 */
export const MAX_ISSUES_PER_GROUP = 3;
export const MAX_PARALLEL_GROUPS_DEFAULT = 2;

/**
 * The concurrency the queue will actually use. Exported so callers that must
 * size themselves against it — notably the speculative-explore default in the
 * develop step — read the same number the pool does, rather than re-deriving
 * the env parse and drifting.
 */
export function resolvedParallelGroups(): number {
  const env = Number(process.env.PI_ENSEMBLE_PARALLEL_GROUPS);
  return Number.isFinite(env) && env > 0 ? env : MAX_PARALLEL_GROUPS_DEFAULT;
}

export interface GroupingResult {
  groups: Record<
    string,
    {
      id: string;
      scope: string;
      paths: string[];
      outOfScope: string[];
      issues: number[];
    }
  >;
  fanout: { mode: "parallel" | "sequential"; concurrencyCap: number };
  /** Human-readable notes on which rules fired; surfaced in a plumb-report. */
  notes: string[];
}

export function groupIssues(
  activeIssues: number[],
  bodiesByIssue: Record<number, string>,
): GroupingResult {
  const notes: string[] = [];
  if (activeIssues.length === 0) {
    return { groups: {}, fanout: { mode: "parallel", concurrencyCap: 1 }, notes };
  }
  if (activeIssues.length === 1) {
    // Single-issue path: return one "default" group. Callers usually
    // shouldn't reach groupIssues for K=1, but return sanely if they do.
    const n = activeIssues[0] ?? 0;
    return {
      groups: {
        default: { id: "default", scope: `issue #${n}`, paths: [], outOfScope: [], issues: [n] },
      },
      fanout: { mode: "parallel", concurrencyCap: 1 },
      notes,
    };
  }

  // R3 — Detect SPLIT markers up-front. Issues marked SPLIT become
  // singleton groups regardless of other rules.
  //
  // Explicit structured marker anchored at line start (#312).
  // "independent" as a bare word is removed — it's a common English
  // word that appears in prose ("provider-independent", "independent
  // investigation") and causes false-positive splits.
  const splitRe = /^(?:Split\s*:\s*(?:true|yes|separate)|This work must ship separately)/im;
  const splitIssues = new Map<number, string>();
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    const m = splitRe.exec(body);
    if (m) {
      splitIssues.set(n, m[0].trim());
    }
  }
  if (splitIssues.size > 0) {
    const splitList = [...splitIssues.entries()].map(([n, text]) => `#${n} ("${text}")`).join(", ");
    notes.push(`R3 split: ${splitList}`);
  }

  // Union-find over activeIssues.
  const parent = new Map<number, number>();
  for (const n of activeIssues) parent.set(n, n);
  function find(n: number): number {
    let p = parent.get(n) ?? n;
    while (p !== parent.get(p)) {
      const next = parent.get(p) ?? p;
      const gp = parent.get(next) ?? next;
      parent.set(p, gp);
      p = parent.get(p) ?? p;
    }
    return p;
  }
  function union(a: number, b: number): void {
    if (splitIssues.has(a) || splitIssues.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // R1 — Explicit link markers: depends-on / companion-to / blocks /
  // blocked-by. Directed edge → union both ends.
  const linkRe =
    /\b(?:depends[-\s]?on|companion[-\s]?(?:to|of)|blocks?|blocked[-\s]?by)\s*:?\s*#?(\d+)/gi;
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
    while ((m = linkRe.exec(body))) {
      const other = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(other) && parent.has(other) && other !== n) {
        union(n, other);
        notes.push(`R1 link: #${n} ↔ #${other}`);
      }
    }
    linkRe.lastIndex = 0;
  }

  // R2 — Path overlap. Extract path-shaped tokens from each body,
  // compute Jaccard on pairs, union if ≥ 0.5.
  const pathRe =
    /(?<![a-z0-9/])([a-z0-9._-]+\/[a-z0-9._/-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|toml|yaml|yml|sh|css|scss|html))\b/gi;
  const pathsByIssue = new Map<number, Set<string>>();
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    const s = new Set<string>();
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
    while ((m = pathRe.exec(body))) {
      const p = m[1];
      if (p) s.add(p.toLowerCase());
    }
    pathRe.lastIndex = 0;
    pathsByIssue.set(n, s);
  }
  for (let i = 0; i < activeIssues.length; i++) {
    for (let j = i + 1; j < activeIssues.length; j++) {
      const a = activeIssues[i];
      const b = activeIssues[j];
      if (a === undefined || b === undefined) continue;
      const pa = pathsByIssue.get(a);
      const pb = pathsByIssue.get(b);
      if (!pa || !pb || pa.size === 0 || pb.size === 0) continue;
      const inter = [...pa].filter((p) => pb.has(p)).length;
      const union_ = pa.size + pb.size - inter;
      const jaccard = union_ === 0 ? 0 : inter / union_;
      if (jaccard >= 0.5) {
        union(a, b);
        notes.push(`R2 path-overlap: #${a} ↔ #${b} (jaccard=${jaccard.toFixed(2)})`);
      }
    }
  }

  // R4 — Subsystem tag prefix in title. Title is expected on the first
  // non-empty line of the body (gh issue view format). Match `[tag]` at
  // the start.
  const tagByIssue = new Map<number, string>();
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    const m = firstLine.match(/^(?:title:\s*)?\[([a-z0-9_-]+)\]\s/i);
    if (m?.[1]) tagByIssue.set(n, m[1].toLowerCase());
  }
  for (let i = 0; i < activeIssues.length; i++) {
    for (let j = i + 1; j < activeIssues.length; j++) {
      const a = activeIssues[i];
      const b = activeIssues[j];
      if (a === undefined || b === undefined) continue;
      const ta = tagByIssue.get(a);
      const tb = tagByIssue.get(b);
      if (ta && tb && ta === tb) {
        union(a, b);
        notes.push(`R4 subsystem: #${a} ↔ #${b} (tag=[${ta}])`);
      }
    }
  }

  // Collect union-find components.
  const components = new Map<number, number[]>();
  for (const n of activeIssues) {
    const r = find(n);
    if (!components.has(r)) components.set(r, []);
    components.get(r)?.push(n);
  }
  // Deterministic order: sort components by their smallest issue number,
  // then sort issues within each component.
  const componentArr = [...components.values()]
    .map((c) => [...c].sort((a, b) => a - b))
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));

  // Guardrail: cap group size at MAX_ISSUES_PER_GROUP. Splitting into
  // consecutive chunks keeps related issues nearby.
  const capped: number[][] = [];
  for (const c of componentArr) {
    if (c.length <= MAX_ISSUES_PER_GROUP) {
      capped.push(c);
    } else {
      notes.push(
        `guardrail split: component (${c.map((n) => `#${n}`).join(", ")}) exceeds ${MAX_ISSUES_PER_GROUP} — splitting into singletons`,
      );
      for (const n of c) capped.push([n]);
    }
  }

  // Assign group ids: group-a, group-b, ... (K > 26 falls back to
  // group-N; realistically we'll never hit that).
  const groupIdOf = (i: number): string =>
    i < 26 ? `group-${String.fromCharCode(97 + i)}` : `group-${i}`;

  const groups: GroupingResult["groups"] = {};
  for (let i = 0; i < capped.length; i++) {
    const issues = capped[i];
    if (!issues) continue;
    const id = groupIdOf(i);
    // Union of all issues' extracted path sets forms the group's `paths`.
    const pathUnion = new Set<string>();
    for (const n of issues) {
      for (const p of pathsByIssue.get(n) ?? []) pathUnion.add(p);
    }
    // Scope: enumerate issues; developer prompt fills in the details.
    const scope =
      issues.length === 1
        ? `issue #${issues[0]}`
        : `issues ${issues.map((n) => `#${n}`).join(", ")}`;
    groups[id] = {
      id,
      scope,
      paths: [...pathUnion].sort(),
      outOfScope: [],
      issues,
    };
  }

  // Fanout mode: parallel up to MAX_PARALLEL_GROUPS_DEFAULT; sequential
  // if K exceeds it (excess groups still get their own worktree, just
  // run in batches).
  const parallelCap =
    Number(process.env.PI_ENSEMBLE_PARALLEL_GROUPS) > 0
      ? Number(process.env.PI_ENSEMBLE_PARALLEL_GROUPS)
      : MAX_PARALLEL_GROUPS_DEFAULT;
  const K = Object.keys(groups).length;
  const fanout: GroupingResult["fanout"] =
    K <= parallelCap
      ? { mode: "parallel", concurrencyCap: Math.min(K, parallelCap) }
      : { mode: "sequential", concurrencyCap: parallelCap };
  if (K > parallelCap) {
    notes.push(
      `concurrency cap: K=${K} > cap=${parallelCap} → sequential mode (excess groups run in batches of ${parallelCap})`,
    );
  }

  return { groups, fanout, notes };
}
