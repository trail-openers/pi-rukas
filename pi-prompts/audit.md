---
description: Audit a repo or scoped path against its own documented standards — bugs, drift, dead code, architecture problems, test gaps
argument-hint: "[<path> | <path>=<scope> ...]"
---

# Audit: Standards-Based Quality Inspection

**Scope**: $ARGUMENTS (default: entire repo)

If no path provided, audit the entire repo.

You may specify paths and scopes: e.g., `src/` for src directory only, `src/ lib/` for multiple paths. Additional flags for future use (e.g., `--mode=security`).

---

## What `/audit` Does

**Differ from `/review`**:
- `/review` is on-demand, PR-scoped, six-pass code review (you ask, it reviews)
- `/audit` is repo-scoped, standards-first, derives expectations from docs/config/examples before judging

**The audit workflow**:
1. **Standards Discovery** — Read docs, configs, CI, vipune memory, and representative code examples to derive what the repo INTENDS to follow.
2. **Audit Passes** — Parallel specialists inspect against derived standards (bugs, drift, dead code, architecture, test gaps).
3. **Synthesis** — Merge findings, deduplicate, report with severity/confidence/evidence/provenance.

**Findings include**:
- Category (bug | drift | dead-code | architecture | test-gap | quality-gate | heuristic)
- Severity (critical | high | medium | low)
- Confidence (high | medium | low)
- Source standard (documented | enforced | inferred | heuristic)
- Discovery mode and limitations when discovery degrades
- Observed deviation
- Evidence (file:line or pattern)
- Suggested next action

---

## Core Invariants

1. **Standards-first** — Never judge code before establishing what the repo actually intends.
2. **Evidence-driven** — Every finding must point to concrete evidence (file:line, config, CI rule, memory entry).
3. **Conservative synthesis** — High-severity findings are conservative; preference low false positives over catching everything.
4. **Async reporting compatible** — Use the same async/job patterns as `/work` and `/review`.
5. **No giant rubric** — Rules come from the repo itself (docs, configs, examples), not hard-coded assumptions.

---

## Vipune Memory Policy

See [../docs/audit-vipune-policy.md](../docs/audit-vipune-policy.md) for the canonical policy.

- Search vipune before auditing with scope-derived terms from `$ARGUMENTS` and focused subsystem names.
- Keep storage limited to durable results: CRITICAL/HIGH findings, conventions, architecture decisions, quality gates, and recurring drift.
- Do not use vipune as a bug tracker; follow the canonical doc for duplicate detection, superseding, and candidate handling.

## ColGREP Usage Policy

See [../docs/audit-colgrep-policy.md](../docs/audit-colgrep-policy.md) for the canonical policy.

- Use colgrep for concrete code patterns during standards discovery and audit passes.
- Prefer files-only for breadth checks and content inspection for concrete matches.
- If colgrep is unavailable or fails, continue standards discovery with docs/config/CI/vipune evidence only, and carry a limitation note into synthesis/final report.
- Keep query examples and fallback guidance in the canonical doc.

## Phase 0: Argument Normalization

Parse `$ARGUMENTS` into paths and flags:
- No args → entire repo (`.`)
- `path1 path2` → multiple paths (space-separated)
- `path1=scope1 path2=scope2` → optional scope annotation (for future use)

Extract `cwd` from the extension context (default: current working directory).

---

## Phase 1: Standards Discovery (MANDATORY FIRST PHASE)

Run a single `explore` specialist to derive the standards model. Use `dispatch_specialist` with role `explore`:

```
dispatch_specialist({
  role: "explore",
  prompt: "STANDARDS DISCOVERY TASK

Your job: derive what this repo INTENDS to follow by inspecting:

1. DOCUMENTED STANDARDS — Read docs if present:
   - CONTRIBUTING.md, CODE_OF_CONDUCT.md, README.md sections on development
   - docs/ or documentation/ directories
   - Any style guides, coding standards, or ADRs (Architecture Decision Records)

2. ENFORCED STANDARDS — Read config if present:
   - .eslintrc, .biomerc, .prettierrc, pyproject.toml, Cargo.toml, go.mod
   - lint-staged, husky, pre-commit hooks
   - CI config: .github/workflows/*.yml, .gitlab-ci.yml, .travis.yml, Jenkinsfile

3. DURABLE FINDINGS — Query vipune memory:
   - List memory types: vipune list --json | jq -r '.[] | .memory_type' | sort -u
   - Search for standards/decisions: vipune search '<keyword>' --memory-type fact --limit 5
   - Keywords: 'standard', 'convention', 'style', 'quality gate', 'lint', 'test'

4. REPRESENTATIVE EXAMPLES — Use colgrep ONLY for concrete pattern gathering:
   - colgrep 'error handling pattern' → find how errors are typically handled
   - colgrep 'test pattern' → find typical test structure
   - colgrep 'async function' → find async patterns if the codebase uses them

If colgrep is unavailable or errors, do not abort discovery: continue using docs/config/CI/vipune evidence only, record a limitation note, and proceed as long as you still have enough evidence to build a usable standards model.
Do NOT use colgrep for meta-questions like 'project architecture' — that returns useless matches.

OUTPUT FORMAT (return this EXACT structure as your final assistant text):

{
  \"standards\": {
    \"documented\": [
      { \"source\": \"path_to_doc\", \"summary\": \"what it says\", \"evidence\": \"excerpt:line\" }
    ],
    \"enforced\": [
      { \"source\": \"config_file\", \"rule\": \"what it enforces\", \"tool\": \"linter/formatter/CI\" }
    ],
    \"inferred\": [
      { \"source\": \"file:line or pattern\", \"convention\": \"what the examples show\", \"confidence\": \"high|medium|low\" }
    ],
    \"heuristic\": [
      { \"assumption\": \"what we cautiously assume\", \"basis\": \"why\" }
    ]
  },
  \"quality_gates\": [
    { \"gate\": \"description\", \"source\": \"where it's defined\" }
  ],
  \"architecture_patterns\": [
    { \"pattern\": \"name\", \"evidence\": \"file:line\" }
  ],
  \"conflicts\": [
    { \"description\": \"what conflicts\", \"signals\": [\"source1\", \"source2\"] }
  ]
}

If a category has no findings, return it as an empty array. Conflicts are important — signal them explicitly, do NOT silently resolve.",
  cwd: <extracted_from_args_or_repo_root>
})
```

Wait for the `[ensemble:async]` report. The discovery output becomes the `standardsModel` for audit passes.

**If total discovery fails**: Surface the error and halt. Cannot audit without any usable standards model.

---

## Phase 2: Audit Passes (PARALLEL specialist dispatch)

Once you have the `standardsModel`, dispatch 3 specialists in parallel using `dispatch_parallel`:

```
specs:
  - role: explore
    prompt: \"AUDIT PASS: CONVENTION DRIFT & DEAD CODE

Use this standards model to find:
- Convention drift (code that doesn't match documented/inferred standards)
- Dead code (unused functions, commented-out blocks, TODOs over 6 months old)
- Hygiene issues (inconsistent formatting, missing docs where documented standard requires)

Search via colgrep for concrete patterns. Every finding must have:

{
  \"category\": \"drift|dead-code|hygiene\",
  \"severity\": \"high|medium|low\",
  \"confidence\": \"high|medium|low\",
  \"standard_source\": \"documented|enforced|inferred\",
  \"standard_description\": \"what the standard says\",
  \"observed_deviation\": \"what the code actually does\",
  \"evidence\": \"file:line or pattern\",
  \"suggested_action\": \"what to do\"
}

Be conservative: HIGH severity requires STRONG evidence. Prefer false negatives over false positives.\" & the standardsModel (inline)."

  - role: adversarial-developer
    prompt: \"AUDIT PASS: BUGS & RISKY ASSUMPTIONS

Use this standards model to find:
- Likely bugs (null/undefined checks missing, off-by-one, resource leaks)
- Risky assumptions (implicit dependencies, fragile ordering, missing error paths)
- Anti-patterns per the repo's own standards

Search via colgrep for concrete patterns. Every finding must have:

{
  \"category\": \"bug|risky-assumption|anti-pattern\",
  \"severity\": \"critical|high|medium|low\",
  \"confidence\": \"high|medium|low\",
  \"standard_source\": \"documented|enforced|inferred|heuristic\",
  \"standard_description\": \"what safety principle or pattern applies\",
  \"observed_deviation\": \"what the code actually does\",
  \"evidence\": \"file:line or pattern\",
  \"suggested_action\": \"what to do\"
}

Be conservative: CRITICAL severity requires EXTREMELY strong evidence. If you're only moderately confident, downgrade to HIGH or MEDIUM.\" & the standardsModel (inline)."

  - role: code-review-specialist
    prompt: \"AUDIT PASS: ARCHITECTURE DRIFT & TEST GAPS

Use this standards model to find:
- Architecture drift (coupling violations, missing layers, circular deps)
- Test gaps (missing coverage per quality gate, untested critical paths)
- Quality-gate violations (lint rules ignored, type errors suppressed)

Search via colgrep for concrete patterns. Every finding must have:

{
  \"category\": \"architecture-drift|test-gap|quality-gate\",
  \"severity\": \"high|medium|low\",
  \"confidence\": \"high|medium|low\",
  \"standard_source\": \"documented|enforced|inferred\",
  \"standard_description\": \"what architectural principle or gate applies\",
  \"observed_deviation\": \"what the code actually does\",
  \"evidence\": \"file:line or pattern\",
  \"suggested_action\": \"what to do\"
}

Be conservative: HIGH severity requires clear architectural principles violated.\" & the standardsModel (inline)."
```

All three pass reports arrive in a single `[ensemble:async]` batch report.

**If a pass fails**: Surface the specific failure but continue with the others. Final synthesis must degrade gracefully.

---

## Phase 3: Synthesis & Reporting

After all pass reports arrive, merge findings into a single report:

1. **Parse findings** from each pass (they're in JSON format).
2. **Deduplicate** by `(category, evidence, standard_description)`.
3. **Group by severity** — critical, high, medium, low.
4. **For each finding**, ensure all fields are present:
   - Category
   - Severity
   - Confidence
   - Standard source (documented | enforced | inferred | heuristic)
   - Standard description
   - Observed deviation
   - Evidence (file:line or pattern)
   - Suggested action

5. **Produce final report**:

```
# Audit Report

**Scope**: <paths audited>
**Standards derived from**: <summary of discovery sources>
**Conflicts surfaced**: <N conflicts (list briefly)>

## Critical (<N> CRITICAL)
- [CRITICAL] <standard source> — <category>
  <standard description>
  Deviation: <observed deviation>
  Evidence: <evidence>
  Confidence: <confidence>
  Action: <suggested action>

## High (<N> HIGH)
[Same format as above]

## Medium (<N> MEDIUM)
[Same format as above]

## Low (<N> LOW)
[Same format as above]

## Summary
- Critical: <N>
- High: <N>
- Medium: <N>
- Low: <N>
- Passes completed: <N>/3

## Next Steps
[Top-priority actions from findings]

## Transcript Access
- Standards discovery: /runs <runId>
- Explore pass: /runs <runId> | /runs <runId2> | ...
- Adversarial pass: /runs <runId>
- Architecture pass: /runs <runId>
```

**If no findings**: Report "No issues found — code conforms to derived standards."

**If discovery failed**: Report "Standards discovery failed: <error>. Cannot audit without standards."

**If all passes failed**: Report "All audit passes failed. See /runs for partial transcripts."

---

## Phase 4: Transcript Access Guidance

Audit transcripts are auto-saved to `~/.pi/agent/ensemble-runs/` under the same rules as `/work` and `/review`. Surface the run IDs in the final report so users can inspect via `/runs`.

DO NOT read transcript files yourself — that bloats context and defeats the bounded-summary invariant of async dispatch.

---

## Standards Discovery Output Shape

See [../docs/audit-contract-examples.md](../docs/audit-contract-examples.md) for full examples.

Required keys:
- `discovery_mode`
- `limitations`
- `standards`
- `quality_gates`
- `architecture_patterns`
- `conflicts`

`standards` contains these arrays:
- `documented[]` → `source`, `summary`, `evidence`
- `enforced[]` → `source`, `rule`, `tool`
- `inferred[]` → `source`, `convention`, `confidence`
- `heuristic[]` → `assumption`, `basis`

`quality_gates[]` entries use `gate` + `source`; `architecture_patterns[]` use `pattern` + `evidence`; `conflicts[]` use `description` + `signals`.

## Merged Audit Report Shape

See [../docs/audit-contract-examples.md](../docs/audit-contract-examples.md) for full examples.

Required keys:
- `discovery_mode`
- `limitations`
- `summary`
- `findings`

`summary` contains `critical`, `high`, `medium`, `low`, and `passes_completed`.
`findings[]` entries use `category`, `severity`, `confidence`, `standard_source`, `standard_description`, `observed_deviation`, `evidence`, and `suggested_action`.

## Partial-Failure Graceful Degradation Shape

See [../docs/audit-contract-examples.md](../docs/audit-contract-examples.md) for full examples.

Required keys:
- `discovery_mode`
- `limitations`
- `summary`
- `pass_failures`
- `findings`

`summary` contains `critical`, `high`, `medium`, `low`, `passes_completed`, and `total_passes`.
`pass_failures[]` entries use `pass` + `error`.
`findings[]` use the same fields as the merged report.

## Principles

- Standards-first, never judge before discovery.
- Evidence-driven, every finding must point to concrete evidence.
- Conservative synthesis, prefer low false positives.
- Async reporting, same patterns as /work and /review.
- No giant rubric, rules come from the repo.