/**
 * /work driver — inline prompt builders for the early pipeline steps.
 *
 * Pure string-template builders (no `DriverContext`, no state-machine
 * logic) for Steps 1-4: explore, plan, branch, develop, and the Step 4
 * speculative-explore side-dispatch. Split out of work-driver.ts per
 * AGENTS.md §12 module-size hygiene (issue #171) — these are called
 * directly by the corresponding `run<Step>` handlers in work-driver.ts.
 */
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
    "  3. `codebase_memory_search_code({query: '<concept>'})` for existing relevant code.",
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
 * #378 — ask the explore agent to resolve INTENT, not just classify.
 *
 * The single `VERDICT:` token assumed the issue already said what to build.
 * Specs are often hand-written, terse, or wrong, so the resolver has to work
 * out what is being asked, check whether that is TRUE against the code and the
 * world, and then decide — including deciding not to build.
 *
 * This runs in the explore role, which is structurally denied write/edit/
 * multiedit (#238). That matters: an agent holding edit tools rationalises
 * ambiguity away because building is cheaper than asking.
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
    "  1. **Against the code.** Do the named symbols and files exist? Does the described behaviour match what the code actually does? Is this already implemented? Use `codebase_memory_search_code` / `trace_path` and read the files.",
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
  ].join("\n");
}

/**
 * Step 2 (plan) prompt. PR3: explicitly asks for `## Workstreams` —
 * matches the parser in `parseWorkstreams`. Single-workstream issues
 * return one `### default` entry (or zero, which the driver synthesises).
 * Cribbed from `pi-prompts/plan.md` Phase 2's type-conditional
 * decomposition philosophy.
 */
export function inlinePlanPrompt(issues: number[], scratchDirAbs: string): string {
  const headline = issues.length === 1 ? `issue #${issues[0]}` : `issues #${issues.join(", #")}`;
  return [
    `/work ${headline} — Step 2 (Decomposition).`,
    "",
    `The driver has already cached ${issues.length === 1 ? "the issue body" : "each issue body"} and Step 1's explore report. Read ${issues.length === 1 ? "both" : "all of them"}, then work in this order:`,
    "",
    "  1. ENUMERATE the discrete findings first. Numbered items and checkboxes in the issue body are the default enumeration — one finding per item. Write the list out before you decide anything about workstreams.",
    "  2. Map EACH finding to its OWN workstream. Two findings share a workstream only when they require edits to THE SAME FILES. Disjoint file sets is the only independence criterion — conceptual relatedness, sharing a subsystem, or 'they're both small' are NOT reasons to merge them.",
    "  3. Bias toward MORE workstreams. A single-file two-line fix is one workstream; that is fine. Aim for roughly ≤150 lines of diff per workstream.",
    "  4. Anything you deliberately are NOT doing goes under an explicit `Deferred:` line with a one-line reason. Silently dropping a finding is worse than deferring it.",
    "",
    "Why this matters: an under-decomposed plan is the dominant cause of a cycle failing to converge. One plan collapsed six enumerated findings into a single workstream; the developer then sprawled across 11 files, looped 17 failed builds, and burned 10.5M tokens before dying. Each workstream gets its own worktree and its own developer, so decomposition is what keeps each diff reviewable and each fix loop convergent.",
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
    "EVERY workstream MUST declare a non-empty `paths:`. The driver checks the committed diff against that list to prove each workstream's slice actually landed; an empty list silently disables that check for the slice.",
    "",
    "If single-workstream, ALWAYS use `### default` so the driver routes through the same code path uniformly.",
    scratchHygieneSection(scratchDirAbs),
  ].join("\n");
}

export function inlineBranchPrompt(
  issues: number[],
  workstreamIds: string[],
  scratchDirAbs: string,
): string {
  const multi = workstreamIds.length > 1;
  const multiIssue = issues.length > 1;
  const primary = issues[0] ?? 0;
  const headline = multiIssue ? `issues #${issues.join(", #")}` : `issue #${primary}`;
  const branchHint = multiIssue
    ? `feature/issues-${issues.join("-")}-<brief-description>`
    : `feature/issue-${primary}-<brief-description>`;
  const worktreePrefix = multiIssue
    ? `.worktrees/issues-${issues.join("-")}`
    : `.worktrees/issue-${primary}`;
  const lines = [
    `/work ${headline} — Step 3 (Setup). Create the feature branch under the safety preconditions below.`,
    "",
    "  1. Identify the mainline branch (default `main`; detect via `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`).",
    "  2. Verify clean working tree (`git status --porcelain` must be empty). If dirty, ABORT and surface the failure verbatim — do NOT branch off uncommitted work.",
    "  3. Fetch + fast-forward mainline (`git fetch origin && git checkout <mainline> && git pull --ff-only origin <mainline>`). If --ff-only fails, ABORT.",
    `  4. Create branch \`${branchHint}\` from the fresh mainline tip.`,
    "  5. End your reply with a single line `branch: <branch-name>` so the driver can capture it.",
  ];
  if (multi) {
    lines.push(
      "",
      `  6. **Multi-workstream cycle** — Step 2 decomposed the active issue${multiIssue ? "s" : ""} into ${workstreamIds.length} workstreams (${workstreamIds.join(", ")}). Create one git worktree per workstream off the feature branch:`,
      "",
      ...workstreamIds.map(
        (id) =>
          `       git worktree add ${worktreePrefix}-${id} ${branchHint.replace("<brief-description>", "<brief>")}`,
      ),
      "",
      "  7. End your reply with an additional fenced `## Worktrees` block mapping each workstream id to its absolute path:",
      "",
      "       ```markdown",
      "       ## Worktrees",
      "",
      ...workstreamIds.map((id) => `       - ${id}: <absolute-path-to-worktree>`),
      "       ```",
      "",
      "       Use `git rev-parse --show-toplevel` from inside each worktree to get the absolute path. The driver parses this block to wire up Step 4's per-workstream developer dispatches.",
    );
  } else {
    lines.push(
      "",
      "Single-workstream cycle — do NOT create worktrees. The driver records the repo root as the `default` workstream's path automatically.",
    );
  }
  lines.push(scratchHygieneSection(scratchDirAbs));
  return lines.join("\n");
}

export function inlineDevelopPrompt(
  issues: number[],
  scratchDirAbs: string,
  workstream?: { id: string; scope: string; paths: string[]; outOfScope: string[] },
  workstreamId?: string,
  speculativeContextPath?: string,
  /** #422 — prior memory about the in-scope files, already rendered. */
  memoryBrief?: string,
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
  }
  const fetchInstr =
    issues.length === 1
      ? `\`gh issue view ${issues[0]}\` to re-fetch the issue body (acceptance criteria, DoD).`
      : `Re-fetch each active issue body — run \`gh issue view <N>\` for each of: ${issues.map((n) => `#${n}`).join(", ")}.`;
  lines.push(
    `  1. ${fetchInstr}`,
    "  2. Implement the change end-to-end in the current branch. Run local quality gates (typecheck, lint, tests as the project defines them).",
    // #543 F5 — the driver's checkpoint commits the worktree at the natural
    // seams the child made during its run, so a cap kill never leaves only
    // a failure message. Committing at natural seams is what makes those
    // seams exist; the driver only stages what is there.
    "  3. Commit your work in the worktree at natural seams (a clean build, a passing test suite). Do NOT push — the driver owns the branch and ops owns the push in Step 6.",
    "  4. End your reply with a `## Touched files` section listing every file you changed and a one-line `## Summary`.",
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
  workstream: { id: string; scope: string; paths: string[]; outOfScope: string[] } | undefined,
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
