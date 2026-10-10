/**
 * /work driver — inline prompt builders for the early pipeline steps.
 * Pure string-template builders (no `DriverContext`, no state-machine logic)
 * for Steps 1-4: explore, plan, branch, develop, speculative-explore.
 * Split out of work-driver.ts per AGENTS.md §12 module-size hygiene (#171).
 */
import { inlineBranchPrompt } from "./work-driver-prompts-branch.ts";
import { scratchHygieneSection } from "./work-driver-prompts-late.ts";

/**
 * Step 1 explore prompt. PR3 Pattern 1 fetched the body in PARALLEL
 * with the explore dispatch — but the prompt never inlined the body
 * content or pointed at the cached artifact path, so the agent's
 * verdict committed BEFORE the fetch settled and the agent never had
 * the body to read. Empirical false-NEEDS_CLARIFICATION cap-hits on
 * v0.12.12's `/work 563 565` (and prior #561) had verdict reasons
 * literally "Issue body not provided - awaiting driver to deliver
 * issue content".
 *
 * PR13 fixes the race: driver fetches bodies as a BARRIER before this
 * prompt is built, and the bodies are EMBEDDED inline below. The
 * agent reads them directly — no race, no agency-dependence, no
 * "trust the driver to deliver" footgun.
 */
export function inlineExplorePrompt(
  issues: number[],
  scratchDirAbs: string,
  bodies: Array<{ issue: number; body: string; truncated: boolean }> = [],
  /**
   * #397 — which verdict protocol this prompt asks for. Passed in rather than
   * read from `intentResolutionEnabled()` because importing it here would
   * close the cycle prompts-early → intent → plan → prompts-early.
   */
  intentEnabled = true,
): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  // #397 — ONE verdict protocol per dispatch. This prompt used to carry both
  // the legacy `## Verdict` block and the #378 `INTENT-VERDICT:` block, each
  // labelled LOAD-BEARING. A resolver on #337 answered the legacy one, the
  // driver read only the other, found nothing, defaulted to `park` /
  // `underspecified`, and told the operator a fully-resolved issue "does not
  // say enough to build from". Multi-issue stays on the legacy protocol
  // because intent resolution yields ONE spec, not N.
  const useLegacyVerdict = !intentEnabled || issues.length > 1;
  const verdictBlock = !useLegacyVerdict
    ? []
    : issues.length === 1
      ? [
          "  - a verdict (heading: `## Verdict`), one line, EXACTLY one of:",
          "      `VERDICT: NEEDS_WORK`           — issue is open and has real work to do",
          "      `VERDICT: ALREADY_COMPLETE`     — issue is closed, merged, or already satisfied by a prior PR",
          "      `VERDICT: NEEDS_CLARIFICATION`  — issue is ambiguous, contradictory, or missing acceptance criteria",
        ]
      : [
          "  - a per-issue verdict block (heading: `## Verdict`), ONE line per issue with EXACTLY one verdict and an optional reason after `—`:",
          "      ```",
          "      ## Verdict",
          ...issues.map(
            (n) =>
              `      - #${n}: NEEDS_WORK | ALREADY_COMPLETE | NEEDS_CLARIFICATION  — <optional one-line reason>`,
          ),
          "      ```",
          "    The driver parses each line and routes per-issue. NEEDS_WORK issues proceed into plan/branch/develop; ALREADY_COMPLETE / NEEDS_CLARIFICATION are dropped (surfaced in the PR body + handoff). If EVERY issue is dropped, the cycle halts at handoff before any code is written.",
        ];
  const verdictDoctrine = !useLegacyVerdict
    ? ""
    : issues.length === 1
      ? "The `## Verdict` block is LOAD-BEARING. If you conclude the issue is already done (e.g., a prior PR addressed it), say `VERDICT: ALREADY_COMPLETE` even if the issue is still technically open in the tracker — the driver routes on your verdict, not on the issue's status. On ALREADY_COMPLETE or NEEDS_CLARIFICATION the driver halts immediately and hands off to the operator; no plan/branch/develop will run."
      : "The `## Verdict` block is LOAD-BEARING per issue. Mark each issue with the verdict you'd give if it were the only one in scope; the driver merges the active subset and runs ONE bundled PR with `Fixes #N` for each active issue.";
  // PR13 — embed each issue body inline. This is the agent's source of
  // truth for what each issue needs; reading these BEFORE answering the
  // verdict prevents the false NEEDS_CLARIFICATION cap-hit pattern.
  const bodyBlock =
    bodies.length > 0
      ? [
          "",
          "---",
          "## Issue bodies (read these to determine your verdict)",
          "",
          ...bodies.flatMap(({ issue, body, truncated }) => [
            `### Issue #${issue}${truncated ? " (truncated — full body cached on disk; see scratch dir if needed)" : ""}`,
            "",
            "```",
            body,
            "```",
            "",
          ]),
        ].join("\n")
      : "";

  return [
    `/work ${headline} — Step 1 (Reconnaissance). The driver has fetched and embedded each issue body below — read those to determine the verdict; you do NOT need to re-fetch via \`gh issue view\`.`,
    "",
    `Gather context relevant to executing ${issues.length === 1 ? "this issue" : "these issues together"}:`,
    // #394 — the line this replaces could never work: `list --json` returns an
    // OBJECT, so `.[]` yields the array and `.memory_type` errors — and the
    // pipeline still exits 0, so the agent saw empty output and concluded the
    // project had no memory types. The enum is closed and fixed, so state it.
    "  1. memory types are a closed set: `fact`, `preference`, `procedure`, `guard`, `observation` — do not try to discover them,",
    // #394 — `--hybrid --recency 0.3` was a recency SORT, not a search: RRF
    // scores span ~0.048 while the recency term spans r*1.0, so relevance is
    // swamped. Pure semantic at 0.0 is the only mode whose score means anything.
    "  2. `vipune search '<keywords-from-issue-title>' --no-hybrid --recency 0.0 --limit 5` for prior decisions,",
    "     and `vipune search '<same>' --memory-type guard --no-hybrid --recency 0.0 --limit 5` for traps,",
    // #280 C — guard memories about type-invariant removals; the widening scan
    // writes one per (file, symbol) so the explore agent should look for them.
    "  2b. `vipune search 'invariant-removal <basename>' --memory-type guard --no-hybrid --recency 0.0 --limit 3` for guard memories about recent constraint removals (invariant-removal scan),",
    "  3. `mcp__codebase_memory__search_code({query: '<concept>'})` for existing relevant code.",
    "",
    "Return a STRUCTURED summary the work-driver can route on:",
    ...verdictBlock,
    "  - parallel-workstream candidates (heading: `## Workstreams`),",
    "  - relevant prior decisions (heading: `## Prior decisions`),",
    "  - touchpoint files (heading: `## Touchpoints`).",
    "",
    verdictDoctrine,
    useLegacyVerdict ? "" : intentResolutionBlock(issues),
    bodyBlock,
    scratchHygieneSection(scratchDirAbs),
    // #397 — drop the block the gate above suppressed, so removing a protocol
    // does not leave a stray blank line where it used to be.
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * #378 — ask the explore agent to resolve INTENT, not just classify. Runs in
 * the explore role (structurally denied write/edit, #238). An agent holding
 * edit tools rationalises ambiguity away because building is cheaper than asking.
 */
function intentResolutionBlock(issues: number[]): string {
  const one = issues.length === 1;
  return [
    "",
    "---",
    "## Resolve the intent (LOAD-BEARING — the driver routes on this)",
    "",
    `Whatever shape ${one ? "the issue body takes" : "the issue bodies take"} — a full spec, a paragraph, or one line — work out what is actually being asked, then check whether it is TRUE:`,
    "",
    "  1. **Against the code.** Do the named symbols and files exist? Does the described behaviour match what the code actually does? Is this already implemented? Use `mcp__codebase_memory__search_code` / `mcp__codebase_memory__trace_path` and read the files.",
    "  2. **Against the world.** If a third-party API or library behaviour is referenced, does it exist with that shape? Use `ctx7` or web search.",
    "",
    "A contradiction between the issue and the code is the most valuable thing you can find. Report it — do not quietly work around it.",
    "",
    "Then emit these two markers on their own lines, followed by a `## Spec` block:",
    "",
    "```",
    "INTENT-VERDICT: proceed | proceed-with-assumptions | park",
    "PARK-REASON: underspecified | contradicted-by-code | already-implemented | too-large | premise-unsound",
    "```",
    "",
    "  - `proceed` — the intent is clear and grounded.",
    "  - `proceed-with-assumptions` — gaps exist, but each has a defensible default. List every one under Assumptions; they go into the PR body for review.",
    "  - `park` — do NOT guess. Use this when the intent cannot be resolved, is contradicted by the code, is already done, is too large for one cycle, or rests on a premise you could not substantiate. `PARK-REASON` is required for a park.",
    "",
    "**Parking is a good outcome when it is the right one.** Writing code from a guess is how the wrong thing ships confidently. Ask at most 3 clarifying questions, and only where the answer would change what gets built; anything smaller becomes an Assumption.",
    "",
    "```markdown",
    "## Spec",
    "",
    "### Intent",
    "<one sentence: what outcome is actually wanted>",
    "",
    "### Deliverables",
    "- <id>: <what to build> [paths: src/foo.ts, src/bar.ts]",
    "- <id>: <what to do> [no-diff: <evidence: the command, API endpoint, or settings URL>]   ← ONLY for work that produces NO code diff by design (repo settings toggles, an operator decision, a manual verification step, external service configuration)",
    "",
    "### Acceptance criteria",
    "- <testable outcome>",
    "",
    "### Out of scope",
    "- <what NOT to touch>",
    "",
    "### Assumptions",
    "- <assumption> — <why it is the defensible default>",
    "",
    "### Open questions",
    "- <question that did not block>",
    "",
    "### Evidence",
    "- <claim you checked> — <file:line or URL> — confirmed | contradicted | unverifiable",
    "```",
    "",
    "Then a `## Rationale` section: two or three sentences on why you reached that verdict. On a park this is what the operator reads.",
    "",
    "Deliverables are the units of work, NOT the acceptance criteria — one per separable thing to build. If the issue enumerates them, carry them across; if it does not, derive them.",
    "",
    "A deliverable that cannot produce a code diff by design (e.g. a GitHub repo settings toggle, an operator decision, a manual verification step, or external service configuration) gets a `[no-diff: <evidence>]` marker INSTEAD of `[paths: ...]`, where <evidence> is the command, API endpoint, or settings URL that proves it was done. The driver skips the diff check for marked deliverables and surfaces them as operator actions in the PR body — but the marker is honoured ONLY when the evidence string is non-empty, and ONLY when the deliverable declares no code paths (a deliverable with both is malformed and the code paths win). Never use the marker to excuse missing code work, and never write prose like `n/a` into a `[paths: ...]` slot — prose is not a control signal.",
    "",
    "A no-diff deliverable is NOT a workstream candidate — it must not appear in the `## Workstreams` block (it has no paths, so it would fail the empty-paths plan-quality check).",
  ].join("\n");
}

// #171 (split hygiene): inlineBranchPrompt moved to work-driver-prompts-branch.ts
// so this file stays under the 500-line gate — re-exported here unchanged so
// existing imports keep working.
export { inlineBranchPrompt };

/**
 * Step 2 (plan) prompt. PR3: asks for `## Workstreams`; single-workstream
 * issues return one `### default` entry (or zero, which the driver synthesises).
 */
export function inlinePlanPrompt(issues: number[], scratchDirAbs: string): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  return [
    `/work ${headline} — Step 2 (Decomposition).`,
    "",
    `The driver has already cached ${issues.length === 1 ? "the issue body" : "each issue body"} and Step 1's explore report. Read ${issues.length === 1 ? "both" : "all of them"}, then work in this order:`,
    "",
    "  1. ENUMERATE the discrete findings first. Numbered items and checkboxes in the issue body are the default enumeration — one finding per item. Write the list out before you decide anything about workstreams.",
    "  2. Split into workstreams ONLY where the work is genuinely independent: no two workstreams may share a file, and NO workstream may have a compile or runtime dependency on another (a type change and every place that uses it is ONE workstream, not two — the consumer does not compile without the producer's commit). Shared files, shared symbols, or one half that cannot build without the other means ONE workstream. A single-file two-line fix is one workstream; that is fine.",
    "  3. Anything you deliberately are NOT doing goes under an explicit `Deferred:` line with a one-line reason. Silently dropping a finding is worse than deferring it.",
    "",
    "Why this matters: each workstream gets its own worktree and its own developer, and every workstream must pass the project's quality gates ALONE, applied to the base commit — a combined run that passes does not excuse a workstream that fails on its own. Workstreams whose changes depend on each other are the dominant cause of a cycle failing to converge: one plan split a type change from its consumers, 0 of 5 workstreams passed their own gate, and re-running the same split failed identically every time. Decompose only where the halves can each stand alone.",
    "",
    "Return your enumeration and reasoning, then a fenced workstreams block. Format MUST match exactly:",
    "",
    "```markdown",
    "## Workstreams",
    "",
    "### default — <one-line scope label>",
    "- paths: <comma-separated touchpoint files>",
    "- out-of-scope: <comma-separated explicit exclusions — what NOT to touch>",
    "```",
    "",
    "For N>1 workstreams, repeat the `###` subheading per workstream (use short ids like `task-a`, `task-b`). The `out-of-scope` line is LOAD-BEARING — issue #553 polluted PR #556 with off-scope files because nothing told the developer what was OUT. Fence the scope explicitly even when you think it's obvious.",
    "",
    "EVERY workstream MUST declare a non-empty `paths:`. The driver checks the committed diff against that list to prove each workstream's slice actually landed; an empty list silently disables that check for the slice. `paths` means files the developer is EXPECTED TO MODIFY: a file you list in `paths` but never edit (e.g. a shared or legacy test whose contract you keep green without touching it) counts as a missing slice at the consolidation gate and parks the cycle. Shared tests, legacy tests, or anything you deliberately keep green without editing go in `out-of-scope` — that is what the out-of-scope line is for.",
    "",
    "If single-workstream, ALWAYS use `### default` so the driver routes through the same code path uniformly.",
    "",
    "Optional per-workstream lines (N>1 plans that declare workstream ORDERING or integration coverage):",
    "",
    "  - `depends-on: <id>` — the workstream(s) this one builds on. The develop step defers this workstream's worktree until the referenced one commits, and sources it from that worktree's HEAD rather than the cycle's base. The graph must be a DAG: no workstream may depend on itself or on a chain that loops back to it. A reference to an undeclared id (or to a workstream folded away by the ceiling) is a plan-quality rejection.",
    "",
    "Cross-declaration contract for N>1 workstreams: put every sibling workstream's `paths` files in your own `out-of-scope` line (and keep the contract symmetric). The driver's plan-quality gate rejects two workstreams claiming the same file, and the develop scope fence honours the cross-declaration — a `depends-on` workstream is exempted from its sibling's files for exactly that reason. Do not rely on the exemption for paths your workstream genuinely needs to edit; if two workstreams both need to edit a file, that is one workstream, not two.",
    "  - `integration-test: <path>` — the consolidated-tree test that exercises this workstream TOGETHER with the workstream(s) it depends on. REQUIRED (plan-quality rejection otherwise) when two workstreams are interdependent through DIFFERENT files — i.e. one declares `depends-on: <other>` with a disjoint file set, or one's test file exercises the other's file. The line is a DECLARATION only: the develop step does not execute it; it exists so the plan records that integration coverage was required.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

export function inlineDevelopPrompt(
  issues: number[],
  scratchDirAbs: string,
  workstream?: {
    id: string;
    scope: string;
    paths: string[];
    outOfScope: string[];
    /** #679 — optional; presence is informational (sibling injection), not a gate input. */
    dependsOn?: string[];
    /** #679 — optional; plan-quality declaration, never executed by the develop step. */
    integrationTest?: string;
  },
  workstreamId?: string,
  speculativeContextPath?: string,
  /** #422 — prior memory about the in-scope files, already rendered. */
  memoryBrief?: string,
  /**
   * #679 case 1 — the SIBLING workstreams this developer runs in parallel
   * with, for the informational injection only. Gated on N>1 by the CALLER
   * (runDevelop only passes this when `ids.length > 1` and the workstream
   * is not `default`); the N=1 `default` path passes nothing and its prompt
   * is byte-identical to the pre-#679 shape. Informational ONLY: the
   * scope-fanout gate in work-driver-verify-develop.ts still uses the
   * workstream's OWN declared `paths` list — never the sibling paths
   * carried here.
   */
  siblingWorkstreams?: Array<{
    id: string;
    scope: string;
    paths: string[];
  }>,
  /**
   * #751 — the project's verify command, resolved ONCE PER WORKSTREAM by the
   * caller via `verifyCmdFor(ctx.repoRoot)` (the same resolver the
   * develop-verify gate uses) and threaded in here as a plain string so the
   * prompt builder stays a pure function with no filesystem access. The
   * prompt names this exact command so the developer's self-check and the
   * driver's downstream gate can never diverge.
   *
   * Appended as the LAST parameter so the existing positional-argument call
   * sites (the N=1 default path, the #679 sibling-injection tests) keep
   * working unchanged; a mid-list insertion would silently re-shape every
   * existing call.
   */
  verifyCmd?: string,
  /**
   * #1078 — paths to the driver-cached issue body artifact(s); the prompt
   * points at the file(s) instead of re-fetching via gh. A multi-issue cycle
   * caches one file per active issue (primary under the legacy `issue-body`
   * name, the rest as `issue-body-<N>` siblings in the same directory); the
   * caller threads all of them so every named issue's body stays reachable
   * even though re-fetching is forbidden.
   */
  issueBodyArtifactPath?: string[],
): string {
  // PR11 — multi-issue cycles must show the developer the ACTIVE issues
  // (NEEDS_WORK subset after explore), not the primary cycle issue. The
  // pre-PR11 hardcoded `ctx.issue` told developers to fetch + work on
  // `issues[0]` even when activeIssues = [different]; on the v10r
  // incident this is how PR #483 ended up implementing #479's --config
  // work while labelled `fix(#476)`.
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issue(s) #${issues.join(", #")}`;
  const lines = [`/work ${headline} — Step 4 (Implementation).`, ""];
  if (workstream) {
    // Anchor scope explicitly so this developer doesn't drift. The out-of-scope
    // fence addresses the issue #553 scope-contamination pattern.
    //
    // NOT gated on N>1. It was, and since every cycle measured on the dev host
    // was N=1, that meant the fence the plan step re-dispatches to produce —
    // and the vipune memory brief the driver pays ~8s for before every develop
    // dispatch — were computed and thrown away on every real run. Only the
    // "you are one of several parallel developers" framing is genuinely
    // multi-workstream; the scope is not.
    const parallel = Boolean(workstreamId) && workstreamId !== "default";
    lines.push(
      parallel
        ? `**Workstream: \`${workstream.id}\`** — one of multiple developers running in parallel for this ${issues.length === 1 ? "issue" : "set of issues"}.`
        : "**Scope for this dispatch** — stay inside it.",
      `Scope: ${workstream.scope}`,
      workstream.paths.length > 0
        ? `In-scope files: ${workstream.paths.join(", ")}`
        : "In-scope files: derive from the scope description above.",
      // Prior memory sits directly under the file list because it is ABOUT
      // those files; separating them invites the reader to skip it.
      memoryBrief ?? "",
      workstream.outOfScope.length > 0
        ? `**OUT OF SCOPE — do NOT touch**: ${workstream.outOfScope.join(", ")}`
        : "Stay tightly focused on the scope; other workstreams handle the rest.",
      "",
    );
    // #679 case 1 — sibling-injection: informational ONLY. The developer is
    // told the ids + declared scope/paths of the OTHER parallel workstreams
    // so a "duplicate implementation" (the case-1 failure shape: 3 of 4
    // workstreams each independently implemented the ENTIRE feature) is at
    // least VISIBLE to the developer as they work. This must NEVER extend
    // the scope-fanout gate's declared-path list — that gate reads
    // `workstream.paths` from state, not from this prompt text.
    if (siblingWorkstreams && siblingWorkstreams.length > 0) {
      lines.push(
        "**Parallel workstreams (informational — your scope above is unchanged):**",
        ...siblingWorkstreams.map(
          (s) =>
            `  - \`${s.id}\` — ${s.scope} — in-scope files: ${s.paths.join(", ") || "(derive from scope)"}`,
        ),
        "These other developers are working in their OWN worktrees in parallel. Do NOT implement their scope — each workstream's scope is exclusive. This list exists so you know what the SIBLING work is, not so you take it on.",
        "",
      );
    }
  }
  // #1078 — the driver already fetched the issue body in Step 1 and cached
  // it to disk. Point the developer at that file instead of re-fetching.
  // Multi-issue: name every issue's cached file (the caller threads one path
  // per active issue) — the primary is cached in state, the siblings are not,
  // and the "do not re-fetch" line below forbids fetching them back.
  let fetchInstr: string;
  if (issueBodyArtifactPath && issueBodyArtifactPath.length > 0) {
    const cats = issueBodyArtifactPath.map((p) => `\`cat ${p}\``).join(", ");
    fetchInstr =
      issueBodyArtifactPath.length === 1
        ? `Read the issue body (acceptance criteria, DoD) from the driver-cached file: \`cat ${issueBodyArtifactPath[0]}\`. Do NOT re-fetch via \`gh issue view\` — the driver already did that in Step 1.`
        : `Read each active issue body (acceptance criteria, DoD) from the driver-cached files: ${cats}. Do NOT re-fetch via \`gh issue view\` — the driver already did that in Step 1.`;
  } else if (issues.length === 1) {
    fetchInstr = `\`gh issue view ${issues[0]}\` to re-fetch the issue body (acceptance criteria, DoD).`;
  } else {
    fetchInstr = `Re-fetch each active issue body — run \`gh issue view <N>\` for each of: ${issues.map((n) => `#${n}`).join(", ")}.`;
  }
  const verifyLine = verifyCmd
    ? `Before committing, run the project's verify command — \`${verifyCmd}\` — and make it pass in your worktree; this is the exact command the verify gate will run, so the two cannot diverge. Fix formatting or lint output by RUNNING the formatter/linter, never by hand-guessing.`
    : "This project has no discoverable verify command, so there is no project-level check to run before committing — rely on the change being correct and complete.";
  lines.push(
    `  1. ${fetchInstr}`,
    "  2. Implement the change end-to-end. Your worktree is on a detached HEAD at the base commit — that is correct. Commit your work there; the driver moves the commits to the feature branch during Step 6 consolidation.",
    `  3. ${verifyLine}`,
    // #543 F5 — the driver's checkpoint commits the worktree at the natural
    // seams the child made during its run, so a cap kill never leaves only
    // a failure message. Committing at natural seams is what makes those
    // seams exist; the driver only stages what is there.
    // #621 — the develop-verify gate (work-driver-verify-develop.ts) REQUIRES
    // at least one commit ahead of baseSha; uncommitted-only work is rejected.
    // Make the exact commands explicit so smaller models don't drift off the
    // commit step under long-context constraint decay (issue #622 covers the
    // mechanical safety net as defense-in-depth).
    // #1078 — commit subject follows the project's convention, not a fixed
    // <type>(scope): shape (a project's AGENTS.md may set a different style).
    '  4. Commit your work in the worktree at natural seams (a clean build, a passing test suite): run `git add -A` followed by `git commit -m "<concise subject — follow the project\'s commit convention from AGENTS.md, or <type>(scope): description>"`. The verify gate REJECTS uncommitted-only work — no commit ahead of base SHA means the develop step fails. Do NOT push — the driver owns the branch and ops owns the push in Step 6.',
    "  5. End your reply with a `## Touched files` section listing every file you changed and a one-line `## Summary`.",
    "",
    "Discourage drive-by edits; only touch files in scope.",
  );
  if (speculativeContextPath) {
    lines.push(
      "",
      "## Speculative context — read when you reach a decision point",
      "",
      "An explore subagent ran in parallel with this dispatch to surface context Step 1 may have missed (test patterns at the touchpoints, related API surface, similar prior fixes). When it lands it writes to:",
      "",
      `  ${speculativeContextPath}`,
      "",
      "Consult this file when you hit a decision point you're unsure about (test framework conventions, API shape, prior-art patterns). It's CONTEXT, not instructions — your scope is unchanged. Absent or empty file = the parallel explore had nothing new to surface; proceed without it.",
    );
  }
  lines.push(scratchHygieneSection(scratchDirAbs));
  return lines.join("\n");
}

/**
 * Step 4 speculative explore prompt. Opt-in only
 * (`PI_ENSEMBLE_SPECULATIVE_EXPLORE=1`): it runs in `Promise.allSettled`
 * alongside the developer and writes its findings to a scratch file the
 * developer's prompt names, and measured live that file always landed after
 * the developer had already looked for it — see the knob in
 * `work-driver-branch-develop.ts`. Returns a brief one-liner so the dispatch
 * event has a useful summary; the heavy content goes to the scratch file so
 * the dispatch report stays small.
 */
export function inlineSpeculativeExplorePrompt(
  issues: number[],
  workstream:
    | {
        id: string;
        scope: string;
        paths: string[];
        outOfScope: string[];
        /** #679 — optional; presence is informational (sibling injection), not a gate input. */
        dependsOn?: string[];
        /** #679 — optional; plan-quality declaration, never executed by the develop step. */
        integrationTest?: string;
      }
    | undefined,
  contextPath: string,
  scratchDirAbs: string,
): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issue(s) #${issues.join(", #")}`;
  const scopeBlurb = workstream
    ? `Workstream \`${workstream.id}\` scope: ${workstream.scope}. In-scope files: ${workstream.paths.join(", ") || "(derive from scope)"}.`
    : `${headline}.`;
  return [
    `/work ${headline} — Step 4 speculative context.`,
    "",
    "You are running IN PARALLEL with a developer working on the change. Your job is to surface context the developer may benefit from:",
    "  - test patterns at the touchpoints (how does the project structure its tests for this area?)",
    "  - related API surface (what functions/types nearby will the change interact with?)",
    "  - similar prior fixes (vipune / git log for the same module — what did past changes look like?)",
    "  - non-obvious constraints (rate limits, perf budgets, doctrine notes)",
    "",
    scopeBlurb,
    "",
    `Write your findings to: \`${contextPath}\` (overwrite if it exists).`,
    "Keep it under 200 lines — terse, actionable, with file:line references. NOT a tutorial; the developer is competent.",
    "",
    "End your reply with a one-line summary (e.g., `wrote 14 KB of context covering test fixtures + auth flow`). Do NOT include the full content in your reply — it goes to the file.",
    "",
    "Speculative: if there's genuinely nothing useful to surface (the developer already has full context from Step 1), write a one-line `(no additional context worth surfacing)` to the file and return.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}
