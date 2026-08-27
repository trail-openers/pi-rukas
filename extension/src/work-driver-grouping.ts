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
 *        Same-prefix issues group together, absent R3. A bracket tag
 *        is explicit human curation and unions on its own; a
 *        conventional-commit scope (`fix(spawn): …`) is boilerplate in
 *        this repository, so a bare scope match no longer unions — it
 *        unions only when corroborated by an R1 link marker between
 *        the pair, R2 path overlap ≥ 0.5, or the tag appearing in
 *        bracket form rather than as a scope. (#501)
 *   R5 — Default: separate groups.
 *
 * Guardrails after grouping:
 *
 *   - Cap group size at MAX_ISSUES_PER_GROUP (3) — bigger groups
 *     approach the adversarial convergence wall (vipune `memory-row`
 *     empirical ceiling: > 3 issues in one bundle collapsed 3×).
 *     Excess splits into per-issue singletons.
 *   - K > MAX_PARALLEL_GROUPS_DEFAULT (3) triggers "sequential" fanout
 *     mode for the remainder (matches worktree cherry-pick ceiling from
 *     vipune `memory-row`).
 *
 * Output shape matches `parseWorkstreams`: `Record<groupId, {id, scope,
 * paths, outOfScope, issues}>`. Each entry becomes one workstream
 * downstream — the rest of the driver iterates
 * `Object.keys(workstreams)` unchanged.
 */
export const MAX_ISSUES_PER_GROUP = 3;
// Three concurrent groups by default. This REVERSES the v0.12.41 default-1
// decision (operator decision 2026-08-26). The original measurement (69
// terminal cycles, every autonomous merge ran alone, concurrent cycles ~2.4x
// slower per role) was sound at the time but predates two structural changes:
//   - #544 shipped capability-preserving dispatch caps (loop detector, typed
//     kill causes) — the unbounded slow-dispatch behaviour that let concurrent
//     cycles degrade each other is structurally different now.
//   - Every workstream develops in its own detached worktree under .worktrees/
//     and patches are applied under a single integration lock (in-process
//     promise chain + O_EXCL lockfile), eliminating the shared repo-root
//     contention that destroyed 2 of 4 lantern cycles at commit-pr.
// The sequential default (1) was judged too conservative: a 6-group queue ran
// entirely sequential under cap=1 (session 2026-08-26). `PI_ENSEMBLE_PARALLEL_GROUPS`
// still overrides in either direction; `PI_ENSEMBLE_PARALLEL_WORK=0` hard-forces 1.
export const MAX_PARALLEL_GROUPS_DEFAULT = 3;

/**
 * The concurrency the queue will actually use. Exported so anything that must
 * size itself against it reads the same number the pool does rather than
 * re-deriving the env parse and drifting.
 */
export function resolvedParallelGroups(): number {
  if (process.env.PI_ENSEMBLE_PARALLEL_WORK === "0") return 1;
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
  // Structural corroboration record for R4: which pairs R1/R2 actually unioned.
  // #501 — tracking these as note strings would couple R4's union DECISION to
  // the human-readable note format of two other rules; a cosmetic rename in
  // R1's note would silently disable R4's corroboration detection.
  const pairKey = (a: number, b: number) => `${Math.min(a, b)}|${Math.max(a, b)}`;
  const r1Pairs = new Set<string>();
  const r2Pairs = new Set<string>();
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
  // #376 — the second alternative was `This work must ship separately`, which
  // no issue in this repo has ever contained. The phrasing actually written is
  // "This work must ship as its own separate PR, independent of any other open
  // issue." Matching the real sentence (with `as its own separate PR` optional
  // so both survive) is what makes R3 fire at all. Still anchored: the bare
  // word "independent" was removed pre-#312 as a false-positive magnet, and
  // that stays removed.
  const splitRe =
    /^(?:Split\s*:\s*(?:true|yes|separate)|This work must ship (?:as its own separate PR|separately))/im;
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
  /**
   * Union two issues, returning whether the merge actually happened.
   *
   * #376 — callers used to push a `notes` line unconditionally, so the
   * decision log claimed unions that a split marker had silently blocked:
   * running the real backlog reported `R4 subsystem: #287 ↔ #368` when #287
   * carries a split marker and was never merged with anything. Notes the
   * operator cannot trust are worse than no notes, since they are the only
   * explanation of why grouping decided what it decided.
   */
  function union(a: number, b: number): boolean {
    if (splitIssues.has(a) || splitIssues.has(b)) return false;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
    return true;
  }
  /**
   * #501 — did this pair end up in one component, by any rule? Used for
   * corroboration notes: R4 may find its pair already merged by R1/R2 and
   * still be the rule whose corroboration licensed a *bare-scope* match,
   * which the operator needs to see even though `union` itself is a no-op.
   */
  function alreadyGrouped(a: number, b: number): boolean {
    if (splitIssues.has(a) || splitIssues.has(b)) return false;
    return find(a) === find(b);
  }

  // R1 — Explicit link markers: depends-on / companion-to / blocks /
  // blocked-by. Directed edge → union both ends.
  // #408 — `closes` / `fixes` / `resolves` / `part of` / `related to` were
  // missing, and GitHub's own closing keywords are how issues reference each
  // other in practice: lantern #657 said "closes #650" and R1 saw nothing, so
  // two issues that were literally the same work were grouped apart.
  const linkRe =
    /\b(?:depends[-\s]?on|companion[-\s]?(?:to|of)|blocks?|blocked[-\s]?by|close[sd]?|fix(?:e[sd])?|resolve[sd]?|supersedes?|part[-\s]of|relate[sd]?[-\s]to|duplicate[-\s]of)\s*:?\s*#(\d+)/gi;
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
    while ((m = linkRe.exec(body))) {
      const other = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(other) && parent.has(other) && other !== n && union(n, other)) {
        notes.push(`R1 link: #${n} ↔ #${other}`);
        r1Pairs.add(pairKey(n, other));
      }
    }
    linkRe.lastIndex = 0;
  }

  // R2 — Path overlap. Extract path-shaped tokens from each body,
  // compute Jaccard on pairs, union if ≥ 0.5.
  // #408 — `container` was absent, so the one file lantern #650 and #657
  // genuinely shared contributed nothing to their Jaccard score. Extended
  // with the infra/config shapes issues actually cite.
  const EXT =
    "ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cpp|hpp|md|mdx|json|jsonc|toml|yaml|yml|sh|bash|zsh|sql|css|scss|html|container|service|dockerfile|env|ini|cfg|conf|lock|tf|gradle|nix";
  const pathRe = new RegExp(`(?<![a-z0-9/])([a-z0-9._-]+/[a-z0-9._/-]+\\.(?:${EXT}))\\b`, "gi");
  // #376 — issues reference bare module names with line anchors far more often
  // than directory-qualified paths: `work-driver.ts:1274`, `commands.ts:262`.
  // Requiring a directory component extracted ZERO paths from 5 of 7 real
  // issues, so R2 never fired and `groups[id].paths` propagated empty. The
  // trailing `:NNN` is required here precisely so prose mentions of a file
  // name do not count — an anchored reference is deliberate, a prose mention
  // is not.
  const bareRe = new RegExp(`(?<![a-z0-9._/-])([a-z0-9._-]+\\.(?:${EXT})):\\d+`, "gi");
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
    // Bare `module.ts:NNN` — normalised to the basename so it can overlap with
    // a directory-qualified mention of the same file in a sibling issue.
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
    while ((m = bareRe.exec(body))) {
      const p = m[1];
      if (p) s.add(p.toLowerCase());
    }
    bareRe.lastIndex = 0;
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
      if (jaccard >= 0.5 && union(a, b)) {
        notes.push(`R2 path-overlap: #${a} ↔ #${b} (jaccard=${jaccard.toFixed(2)})`);
        r2Pairs.add(pairKey(a, b));
      }
    }
  }

  // R4 — Subsystem tag prefix in title. Title is expected on the first
  // non-empty line of the body (gh issue view format). Match `[tag]` at
  // the start.
  // #376 — `[tag]` at the head of a title is structurally impossible for a
  // /plan-authored issue, which mandates `feat: ` / `fix: ` / `EPIC: `
  // prefixes. But the subsystem is already there, as the conventional-commit
  // scope: `fix(work-driver): …`. Read that too rather than asking anyone to
  // change how titles are written.
  // #501 — a bracket tag is explicit human curation and unions on its own.
  // A conventional-commit scope match is boilerplate in this repository —
  // `work-driver` is the modal scope among /work-eligible issues, so a bare
  // scope match confirms boilerplate rather than discovering structure. A
  // scope match now unions only when corroborated by an R1 link marker
  // between the pair or R2 path overlap ≥ 0.5; an uncorroborated scope match
  // is declined and noted rather than silently joined.
  // #501 — accumulated so the O(N²) per-pair "declined" notes collapse into
  // one summary per tag in the plumb report; the loop body pushes pairs,
  // not notes.
  const r4Declined = new Map<string, string[]>();
  const tagByIssue = new Map<number, { tag: string; bracket: boolean }>();
  for (const n of activeIssues) {
    const body = bodiesByIssue[n] ?? "";
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    const bracket = firstLine.match(/^(?:title:\s*)?\[([a-z0-9_-]+)\]\s/i);
    const scope = firstLine.match(
      /^(?:title:\s*)?(?:feat|fix|chore|docs|test|refactor|perf|ci|build|style)!?\(([a-z0-9_.-]+)\)!?\s*:/i,
    );
    const tag = bracket?.[1] ?? scope?.[1];
    if (tag) tagByIssue.set(n, { tag: tag.toLowerCase(), bracket: bracket !== null });
  }
  for (let i = 0; i < activeIssues.length; i++) {
    for (let j = i + 1; j < activeIssues.length; j++) {
      const a = activeIssues[i];
      const b = activeIssues[j];
      if (a === undefined || b === undefined) continue;
      const ea = tagByIssue.get(a);
      const eb = tagByIssue.get(b);
      if (!ea || !eb || ea.tag !== eb.tag) continue;
      const corroborations: string[] = [];
      if (ea.bracket && eb.bracket) corroborations.push("bracket tag");
      if (r1Pairs.has(pairKey(a, b))) corroborations.push("R1 link");
      if (r2Pairs.has(pairKey(a, b))) corroborations.push("R2 path-overlap");
      if (corroborations.length === 0) {
        r4Declined.set(ea.tag, [...(r4Declined.get(ea.tag) ?? []), `#${a} ↔ #${b}`]);
        continue;
      }
      // Record the corroboration whenever the pair ends up in one component —
      // including when a corroborating rule (R1/R2) already merged them and
      // union() is a no-op. The note still documents that the scope match
      // would NOT have unioned on its own.
      if (union(a, b) || alreadyGrouped(a, b)) {
        notes.push(
          `R4 subsystem: #${a} ↔ #${b} (tag=[${ea.tag}]) corroborated: ${corroborations.join(", ")}`,
        );
      } else {
        // Split-blocked: union() refused and alreadyGrouped() is false by
        // construction for split issues, so the pair was evaluated, corroborated,
        // and declined — noted explicitly so the log is complete rather than
        // silently skipping the case.
        notes.push(`R4 skipped: #${a} ↔ #${b} (tag=[${ea.tag}]) — corroborated but split-blocked`);
      }
    }
  }
  // One summary note per tag instead of O(N²) per-pair notes: for the modal
  // scope, N bare-scope issues would otherwise dominate the plumb report with
  // N² notes that all say the same thing.
  for (const [tag, pairs] of r4Declined) {
    notes.push(
      `R4 declined: ${pairs.length} pair${pairs.length === 1 ? "" : "s"} (tag=[${tag}]) — uncorroborated scope match: ${pairs.join(", ")}`,
    );
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
