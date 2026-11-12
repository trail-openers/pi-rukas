/**
 * /work driver — the Step 1 explore prompt's INTENT-resolution block (#378).
 *
 * Split from work-driver-prompts-early.ts for the AGENTS.md §12 500-line cap;
 * that file is the prompt builder and this is one of the blocks it composes, so
 * the prose that changes most lives where it can grow (the same seam as
 * work-driver-prompts-plan.ts and work-driver-prompts-develop-commit.ts).
 */
/**
 * #378 — ask the explore agent to resolve INTENT, not just classify. Runs in
 * the explore role (structurally denied write/edit, #238). An agent holding
 * edit tools rationalises ambiguity away because building is cheaper than asking.
 */
export function intentResolutionBlock(issues: number[]): string {
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
    // #1351 — the driver checks this commit is on origin/<mainline>; one that is not overturns the park.
    "  - `already-implemented` means the MAINLINE has the work. Add `IMPLEMENTED-AT: <sha>` naming the commit on `origin/<mainline>` that did it (`git log origin/<mainline> -- <path>`). Work that exists only on an open PR or an unmerged branch is NOT already implemented: say so under Evidence and do not park on it; the driver detects open PRs for the issue itself.",
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
    "`contradicted` means the ISSUE is wrong about the code or the world. A stale vipune row is not that: supersede it, and if you list it, give `memory` as its source so it is not read as a finding against the issue.",
    "",
    "Then a `## Rationale` section: two or three sentences on why you reached that verdict. On a park this is what the operator reads.",
    "",
    "Deliverables are the units of work, NOT the acceptance criteria — one per separable thing to build. If the issue enumerates them, carry them across; if it does not, derive them.",
    "",
    "A deliverable that cannot produce a code diff by design (e.g. a GitHub repo settings toggle, an operator decision, a manual verification step, or external service configuration) gets a `[no-diff: <evidence>]` marker INSTEAD of `[paths: ...]`, where <evidence> is the command, API endpoint, or settings URL that proves it was done. The driver skips the diff check for marked deliverables and surfaces them as operator actions in the PR body — but the marker is honoured ONLY when the evidence string is non-empty, and ONLY when the deliverable declares no code paths (a deliverable with both is malformed and the code paths win). Never use the marker to excuse missing code work, and never write prose like `n/a` into a `[paths: ...]` slot — prose is not a control signal.",
    "",
    "A no-diff deliverable is NOT a workstream candidate — it must not appear in the `## Workstreams` block (it has no paths, so it would fail the empty-paths plan-quality check).",
    "",
    // #1155 — the planner is the only author of a `[paths:]` slot, so the
    // grammar the gates read has to be stated where it is written. The #1137
    // cycle parked because a planner wrote "X or new work-driver-<name>.ts"
    // and every downstream reader treated it as one literal filename.
    "A `[paths: ...]` slot holds **paths the diff can be checked against**, comma-separated. The driver matches each one per path segment against the end-of-develop diff, and it reads three forms: a **file** (`src/foo.ts`), a **directory** (`src/foo` — covers everything beneath it), and a **template** (`src/work-driver-<name>.ts` or `src/work-driver-*.ts` — matches ANY file in that directory whose name fits, so it is the right form when the file's name is genuinely not yet decided). Separating two paths with ` or ` or `|` declares ALTERNATIVES: the deliverable counts as delivered when ANY of them lands. So `[paths: extension/src/verify.ts or new work-driver-<name>.ts]` is legitimate, and the developer may satisfy either half. What is NOT legitimate is prose in the slot — a slot that parses to no file, directory or template at all is reported as an **unmeasurable** warning in the PR body and the gate cannot check that deliverable at all.",
  ].join("\n");
}
