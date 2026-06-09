---
description: Create a deeply-specified GitHub issue via multi-phase research, type-specialised investigation, and an adversarial gap gate. The issue body IS the spec.
argument-hint: "<bug|feature|epic|chore|spike description>"
---

# Plan: Spec-Driven Issue Creation

**Input**: $ARGUMENTS

If no input was provided, ask the user before proceeding.

---

## What `/plan` Does (and what changed)

`/plan` produces a GitHub issue whose body is the canonical spec for downstream `/work` cycles. Specs that drive working code need more than a one-liner — they need acceptance criteria, anti-rediscovery references, named pitfalls, and explicit Open Questions. This command runs five deterministic phases to get there.

**Differs from `/research`**:
- `/research <topic>` gathers cross-source knowledge into PM's context — no ticket created.
- `/plan <descriptor>` produces a ticket. **It explicitly inventories what PM already knows from prior `/research` invocations or in-session discussion**, then only dispatches investigators for the gaps that remain.

**Core invariants**:
1. **Issue body IS the spec.** No separate `.spec/` files. `/work` reads the issue body as the spec contract.
2. **Existing PM context is first-class input.** Never re-investigate what `/research` or user discussion has already established. Phase 1 inventories first; Phase 2 dispatches only for gaps.
3. **Adversarial gap gate is mandatory.** Before user confirmation, an `@adversarial-developer` pass surfaces what's missing / under-specified / unverifiable. CRITICAL/HIGH gaps trigger one extra research iteration; MEDIUM/LOW become Open Questions.
4. **Drop alternatives in the final draft.** The issue body carries the recommended approach only — not a survey.

---

## Phase 0: Argument & classification setup

Parse `$ARGUMENTS` for the ticket descriptor. Identify the proposed type from the descriptor's language:

| Type | Trigger words | Title prefix |
|------|--------------|--------------|
| Bug | "broken", "fails", "error", "doesn't work" | `Bug: ` |
| Feature | "add", "support", "implement", "introduce" | `feat: ` |
| Epic | "overhaul", "redesign", "multi-issue body of work" | `EPIC: ` |
| Chore | "refactor", "rename", "bump", "tidy" | `chore: ` |
| Spike | "investigate", "research", "explore feasibility" | `research: ` |

This is a working guess only — Phase 1's `classification` field is authoritative.

---

## Phase 1: Context Inventory + Targeted Discovery

### Step 1a — Context inventory (PM-only, no dispatch yet)

Before deciding what to investigate, PM writes out a `contextInventory` of what it ALREADY KNOWS from the current session. This is load-bearing — every dispatch decision flows from this inventory.

Required structure (PM writes this internally before proceeding):

```
contextInventory: {
  fromPriorResearch: [
    "/research <topic> earlier this session covered: <facts and sources PM saw>",
    ...
  ],
  fromUserDiscussion: [
    "User stated: <relevant fact>",
    "User constraint: <requirement>",
    ...
  ],
  fromPriorVipuneLookups: [
    "Already searched vipune for X; found: <result>",
    ...
  ],
  confidenceMap: {
    "classification": "high|medium|low — why",
    "priorContext": "high|medium|low — why",
    "duplicateRisk": "high|medium|low — why",
    "technicalContext": "high|medium|low — why",
    "testSurface": "high|medium|low — why"
  },
  knownUnknowns: [
    "Still need to know: <specific gap>",
    ...
  ]
}
```

If `contextInventory` is empty (cold-start session), proceed to Step 1b for fresh discovery.

If `contextInventory` already covers classification + prior decisions + duplicate risk with high confidence, **skip Step 1b entirely** and proceed to Phase 2 with the inventory as input. Don't pad with "just to be thorough" dispatches.

### Step 1b — Targeted discovery dispatch (conditional)

Only IF `knownUnknowns` is non-trivial AND the inventory doesn't already cover the basics, dispatch ONE `@explore` with a brief that explicitly carries the inventory forward:

```
dispatch_specialist({
  role: "explore",
  prompt: "DISCOVERY TASK for /plan

PM has already established (DO NOT re-investigate these):
<paste contextInventory.fromPriorResearch + fromUserDiscussion + fromPriorVipuneLookups verbatim>

Investigate ONLY these specific gaps:
<list from contextInventory.knownUnknowns>

Specifically:
1. PRIOR DECISIONS — Search vipune for prior decisions relevant to <gap topic>:
   vipune search '<keyword>' --memory-type fact --limit 5
   Keywords should be conceptual fragments from the descriptor, NOT the full sentence.

2. DUPLICATE / RELATED ISSUES — Check for overlap:
   gh issue list --search '<keyword>' --state all --limit 10
   Return titles + numbers + state for any near-duplicates or related issues.

3. CODE PRIOR ART — Use colgrep for concrete patterns ONLY when the descriptor names a code feature:
   colgrep '<pattern>' → find existing implementations to avoid duplication

   Skip colgrep for meta/project-level questions; it returns noise there.

OUTPUT FORMAT (return this EXACT structure as your final assistant text):

{
  \"discoveryFindings\": {
    \"priorDecisions\": [
      { \"source\": \"vipune\", \"fact\": \"<verbatim>\", \"relevance\": \"<why this matters\" }
    ],
    \"relatedIssues\": [
      { \"number\": N, \"title\": \"<title>\", \"state\": \"open|closed\", \"overlap\": \"<how it relates>\" }
    ],
    \"duplicateRisk\": {
      \"level\": \"high|medium|low|none\",
      \"rationale\": \"<concrete evidence>\"
    },
    \"codePriorArt\": [
      { \"path\": \"file:line\", \"summary\": \"<what exists>\" }
    ],
    \"limitations\": [
      \"<any tool/search that failed or returned nothing useful>\"
    ]
  }
}
```

Wait for the `[ensemble:async]` report.

### Step 1c — Brief synthesis (PM-only)

Merge `contextInventory` + (optional) `discoveryFindings` into a single Phase 1 brief:

- `classification`: bug / feature / epic / chore / spike (with confidence + rationale)
- `priorContext`: per-item with source attribution — `[fromPriorResearch | fromUserDiscussion | fromPriorVipuneLookups | dispatched]`
- `relatedIssues`: from Step 1b or in-session knowledge
- `duplicateRisk`: high / medium / low + rationale
- `clarifyingQuestions`: only questions neither existing context NOR Step 1b could answer

**Halt and surface to user** if `duplicateRisk: "high"` — don't create a duplicate ticket.

Ask clarifying questions before proceeding to Phase 2.

---

## Phase 2: Multi-Angle Investigation (parallel, type-specialised, gap-driven)

Based on Phase 1's `classification`, select the maximal dispatch set from the table below. Then TRIM the set by checking the `contextInventory` — for each angle, ask "does PM already know this with high confidence?" If yes, SKIP that dispatch and note it in the synthesis.

### Maximal dispatch sets per type

| Type | Specialists (maximal — trim by inventory) |
|------|-------------------------------------------|
| **Bug** | `@explore` reproduction-surface · `@explore` affected-code · `@explore` test-surface |
| **Feature** | `@explore` prior-art · `@explore` interfaces-and-contracts · `@explore` test-surface · `@adversarial-developer` risk-surface |
| **Epic** | `@explore` decomposition-surface · `@explore` dependencies · `@explore` success-criteria |
| **Chore** | `@explore` scope-validation · `@explore` affected-files |
| **Spike** | `@explore` external-context · `@explore` scoping |

### Dispatch contract (every spec uses this pattern)

Every dispatched specialist's prompt MUST open with:

```
PM has already established (DO NOT re-investigate):
<relevant slices of contextInventory + Phase 1 brief>

Your job: investigate THIS angle (<angle name>) for a ticket of type <type>.
Specifically address these gaps in PM's knowledge:
<2–4 specific unknowns this angle resolves>
```

This gap-briefing is non-negotiable — it's what makes the dispatch cheap and the findings deep.

### Per-angle sub-prompts

**`reproduction-surface` (Bug)**:
```
Determine concrete steps to reproduce. Find:
- Logs / error messages relevant to this bug (use colgrep + git log)
- Environment specifics (Node version, OS, dependencies) that matter
- Flakiness factors (timing, ordering, state)
- Existing related test cases that should have caught this

OUTPUT: { findings: [...], evidence: [...], confidence, gaps, references }
```

**`affected-code` (Bug)**:
```
Identify files, functions, call sites affected. For each, capture:
- Exact path:line
- Function/component name
- Why this code is in-scope for the bug

OUTPUT: { affected: [{path, line, reason}], references, gaps }
```

**`test-surface` (Bug | Feature)**:
```
Catalogue existing tests near the work area:
- File paths + key test names that should be extended or are missing
- Golden-fixture candidates (small input + expected output pairs)
- Coverage gaps the work should close

OUTPUT: { existingTests: [...], goldenFixtureCandidates: [...], coverageGaps: [...] }
```

**`prior-art` (Feature)**:
```
Look for similar features already implemented OR similar patterns in adjacent codebases / docs.
- Specifically check if /research findings (per PM's brief) already cover this — DO NOT re-fetch.
- For genuinely new gaps, search vipune + colgrep for patterns to follow.

OUTPUT: { priorArt: [{source, summary, reuseOpportunity}], conventions: [...], gaps }
```

**`interfaces-and-contracts` (Feature)**:
```
Map the type contracts, data shapes, and API boundaries the feature touches:
- Function signatures it must implement OR conform to
- Data structures passed in/out
- External API contracts (HTTP, file format, CLI shape)

Include typed references where possible: `path/file.ts:NN — exported interface X`

OUTPUT: { contracts: [...], dataShapes: [...], references }
```

**`risk-surface` (Feature)**:
```
ADVERSARIAL angle. What could go wrong?
- Edge cases / boundary conditions
- Failure modes (network, disk, concurrency)
- Security implications
- Backwards-compatibility risks
- Performance worst-cases

For each, classify likelihood (high/medium/low) and impact.

OUTPUT: { risks: [{description, likelihood, impact, mitigation}], gaps }
```

**`decomposition-surface` (Epic)**:
```
Break the epic into natural sub-issues. For each:
- Title proposal
- Brief scope
- Dependencies on other sub-issues
- Suggested ordering

OUTPUT: { subIssues: [{title, scope, deps, order}], notes }
```

**`dependencies` (Epic)**:
```
Identify cross-cutting dependencies: other epics, infra, external services, team coordination needs.

OUTPUT: { dependencies: [{type, name, impact}], notes }
```

**`success-criteria` (Epic)**:
```
How do we know the epic is done? Outcome metrics, user-visible behaviour, technical milestones.

OUTPUT: { criteria: [{type, description, measurement}], notes }
```

**`scope-validation` (Chore)**:
```
Is this actually a chore vs a feature/bug in disguise? What's the smallest viable change?
What scope-creep risks exist? Flag any that should be split into separate tickets.

OUTPUT: { isChore: bool, smallestViableChange: "...", scopeCreepRisks: [...] }
```

**`affected-files` (Chore)**:
```
List files the chore will touch. For each: path + change type (rename/refactor/delete/config-bump).

OUTPUT: { affected: [{path, changeType, notes}] }
```

**`external-context` (Spike)**:
```
Gather external context: docs, RFCs, papers, third-party tools relevant to the question.
Use web search if Pi/extension has access. Always cite sources.

OUTPUT: { sources: [{url, title, summary}], summary: "..." }
```

**`scoping` (Spike)**:
```
What's the time-box, the expected deliverable (a decision, prototype, write-up — NOT shipped code),
and the success criteria for the spike?

OUTPUT: { timebox: "...", deliverable: "...", successCriteria: "..." }
```

### Dispatch invocation

Use `dispatch_parallel` for sets with 2+ specs. Single specs use `dispatch_specialist`. If you SKIP an angle (covered by inventory), note this in the synthesis: `"prior /research covered prior-art, skipping dispatch"`.

**Zero dispatches in Phase 2 is valid** when the inventory is rich enough. Proceed to Phase 3.

---

## Phase 3: Draft Synthesis

PM synthesises Phase 1 + Phase 2 + `contextInventory` into a structured issue body. Required sections, in order:

```markdown
## Context & motivation

<2-4 sentences: why this work, what's the trigger, who benefits>

## Acceptance criteria

- [ ] <testable outcome 1, with example input/expected output if possible>
- [ ] <testable outcome 2>
- ...

## Technical context

<affected files / interfaces / data shapes — pulled from interfaces-and-contracts / affected-code>

## References

<For each — `path/to/file.ts:NNN — what to reuse here`. This is the anti-rediscovery primitive.>
- `path/to/example.ts:42` — existing pattern for X; follow the same shape
- `docs/RFC-NN.md` — prior decision on Y
- ...

## Test surface

- Existing tests to extend: `test/foo.test.ts:N`
- Golden fixture candidate: <small input + expected output pair>
- Coverage gaps to close: <area>

## Edge cases & pitfalls

<For Feature, pulled from risk-surface. For Bug, pulled from reproduction-surface — what makes the repro flaky / non-deterministic.>

## Open Questions

- **<question>** — Decision owner: <name or role>; status: pending
- ...

## Out of scope

- <related work NOT covered by this ticket>
- → #<issue-N> for <separated concern>
- ...
```

For Bug, replace "Acceptance criteria" with "Expected behaviour" + "Definition of Done" (a tighter shape).
For Epic, add "Sub-issues" section listing the decomposition with `[ ] #N — title` checkboxes (numbers filled in after sub-issue creation).
For Spike, replace "Acceptance criteria" with "Expected deliverable (NOT code — a decision or proof of concept)" + "Timebox".

The draft is held internally — don't show to user yet. Phase 4 runs against it first.

---

## Phase 4: Adversarial Gap Gate (MANDATORY)

Dispatch one `@adversarial-developer` with the draft body + a summary of Phase 2 findings. The gate asks: what's missing, under-specified, ambiguous, or unverifiable?

```
dispatch_specialist({
  role: "adversarial-developer",
  prompt: "GAP DETECTION: review this draft spec and find what's missing.

DRAFT SPEC:
<paste Phase 3 draft verbatim>

PHASE 2 FINDINGS SUMMARY:
<one-line summary per Phase 2 dispatch>

For each gap you find, classify it:
- CRITICAL: the ticket cannot proceed without this resolved
- HIGH: ticket can proceed but the implementer will be confused or wrong
- MEDIUM: nice-to-have clarification, doesn't block implementation
- LOW: cosmetic / future improvement

For each gap, propose ONE of:
(a) A specific additional research dispatch needed (role + prompt sketch)
(b) A sharper acceptance criterion to add
(c) A question for Open Questions (with decision owner suggestion)

OUTPUT FORMAT:
{
  \"gaps\": [
    {
      \"severity\": \"CRITICAL|HIGH|MEDIUM|LOW\",
      \"description\": \"what's missing\",
      \"suggestedFix\": \"a|b|c\",
      \"detail\": \"specific dispatch / criterion / question\"
    }
  ],
  \"overallVerdict\": \"READY|NEEDS_ITERATION\"
}
"
})
```

### Applying gap findings

- **CRITICAL or HIGH** → dispatch the suggested research (single `@explore` or `@adversarial-developer` as appropriate), iterate the draft, re-run Phase 4. **Cap at 2 iterations** to prevent doom loops; if iteration 2 still surfaces CRITICAL/HIGH, escalate to user with the gap list and let them decide.
- **MEDIUM** → add as an Open Question with the suggested decision owner. Iterate once if PM judges it cheap (a single focused dispatch can resolve).
- **LOW** → add to Open Questions as-is.

If verdict is READY (zero CRITICAL/HIGH gaps), proceed to Phase 5.

---

## Phase 5: Confirm & Create

Show the user:

1. The final structured issue body
2. A brief summary of "gaps surfaced in Phase 4 → how each was addressed" (e.g. "HIGH gap on missing fixture → dispatched additional test-surface explore → updated section 5")
3. The Phase 1 brief's `priorContext` source attribution (so the user can see what came from prior /research vs fresh dispatch)

Wait for explicit confirmation. On confirmation:

```bash
gh issue create --title "..." --label "..." --body "<final structured body>"
```

For epics: create the parent epic first, then offer to create child issues (each child runs through `/plan` recursively if the user wants the same depth of spec — or a shorter flow if the user wants to defer details).

### Store learnings

After issue creation, PM stores key learnings in vipune so future `/plan` runs can leverage them:

- Discovered conventions worth re-using: `vipune add '<convention summary>' --memory-type fact`
- Prior decisions cited heavily: confirm they're already in vipune; add if missing
- New gotchas / pitfalls surfaced: `vipune add '<gotcha>' --memory-type observation`

One atomic fact per `vipune add`. Don't dump the entire ticket body into vipune — that defeats the purpose.

---

## Principles

- **Context before drafting.** Phase 1 inventory + targeted discovery always run first.
- **Leverage existing PM context — don't redo work.** If the user paid for `/research` earlier, that context is authoritative. Dispatch only for gaps.
- **Type-specialised dispatch.** Bug needs reproduction; Feature needs interfaces + risk; Epic needs decomposition.
- **Adversarial gap gate is mandatory.** No ticket reaches the user without `@adversarial-developer` pressure-testing the draft.
- **Issue body IS the spec.** Sections are the contract that `/work` reads.
- **Drop alternatives in the final draft.** Recommend one approach, not survey three.
- **Store learnings in vipune.** Future plans benefit from what this plan discovered.
