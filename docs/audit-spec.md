# `/audit` Command Specification

**Status**: Draft — Source of truth for #32 (feat(audit): write formal /audit spec)

## Overview

`/audit` is a standards-first repo/path audit command that derives expectations from a project's own documentation, configuration, CI, prior memory, and representative code examples. It reports misalignments across bugs, dead code, style drift, architecture drift, and quality-gate/test gaps.

Unlike `/review` (which checks a PR or code against universal quality lenses) and `/research` (which investigates a topic across sources), `/audit` is repo-specific and standards-deriving. It discovers what the project *intends* to be, then measures reality against that intent.

### Distinction from related commands

| Command | Purpose | Scope | Standard source |
|---|---|---|---|
| `/audit` | Repo/path quality audit | Repo or scoped path | Derived from docs, config, CI, memory, examples |
| `/review` | Six-pass code review | PR, file, dir, or codebase | Universal quality lenses (security, error, types, perf, arch, simplicity) |
| `/research` | Multi-source investigation | Any topic, across web, codebase, memory | N/A (informational, not evaluative) |

### Non-goals for v1

The following are explicitly out of scope for v1:

- **Automatic fixing/remediation** — audit reports findings; implementation requires manual work or a separate `/work` cycle
- **Turning vipune into a bug tracker** — store only durable high-value results; not every violation
- **New role types** — use existing `explore`, `adversarial-developer`, `code-review-specialist` roles
- **Hard-coded universal rules** — standards are repo-specific, derived from actual project artifacts
- **Persistent audit caching** — v1 runs are fresh each time; caching adds complexity and may be added in v2 if needed

---

## Command Contract

### Syntax

```
/audit [<path> | "full"]
```

- **No arguments**: Audit the entire repo
- **`<path>`**: Audit a specific directory or file (e.g., `src/auth/`, `utils.ts`)
- **`"full"`**: Explicit full-repo audit (future: may trigger deeper analysis than default)

### Example invocations

```bash
/audit                    # Full repo audit
/audit src/               # Audit src/ directory
/audit lib/auth.ts        # Audit single file
/audit "full"             # Explicit full audit (same behavior as no args in v1)
```

### Output format

The audit returns a structured report with:

1. **Executive summary** — severity-weighted finding counts, overall health score
2. **Standards discovered** — what sources were consulted and what was inferred
3. **Findings** — grouped by severity, each with structured metadata
4. **Recommendations** — prioritized actions
5. **Transcripts** — per-phase transcript paths for inspection

---

## Workflow Phases

`/audit` executes in four phases:

1. **Standards discovery** — derive what the project intends
2. **Audit passes** — run targeted checks against reality
3. **Synthesis** — collate findings, infer patterns, compute verdict
4. **Memory write-back** — store durable results to vipune for future audits

Each phase logs its run to a separate transcript for post-hoc inspection.

## Phase 1: Standards Discovery

### Objective

Build a `DerivedStandards` model that captures the project's intended behavior, patterns, and quality gates. The model is evidence-backed — every inferred standard cites its source.

### Data sources (in priority order)

| Source | What it provides | How to access |
|---|---|---|
| **Documentation** | `README.md`, `CONTRIBUTING.md`, `docs/`, inline docs | Read and parse |
| **Configuration** | Build configs, linter rules, CI/CD | Read and parse |
| **CI/CD pipelines** | Test expectations, check gates | Read workflow files, job definitions |
| **Memory** | Prior decisions, architecture notes, conventions | `vipune search` before starting |
| **Representative examples** | Idiomatic patterns, style conventions | `codebase_memory_search_code` queries for concrete implementations |
| **Test files** | Testing patterns, coverage expectations | Read `test/`, `__tests__/`, `*test.*` files |

### DerivedStandards schema

```typescript
interface DerivedStandards {
  documentation: {
    filesRead: string[];
    architectureDecisions: ArchitectureDecision[];
    conventions: Convention[];
    qualityGates: QualityGate[];
  };
  configuration: {
    buildSystem?: string;
    linter?: { name: string; rules: Record<string, unknown> };
    formatter?: { name: string; config: Record<string, unknown> };
    testRunner?: string;
    ciProvider?: string;
  };
  ciCD: {
    provider: "github" | "gitlab" | "azure" | "circleci" | "jenkins" | "other";
    workflows: Workflow[];
    qualityChecks: QualityCheck[];
  };
  memory: {
    priorFindings: PersistentFinding[];
    architectureNotes: ArchitectureNote[];
    conventions: ConventionNote[];
  };
  examples: {
    modules: ExampleModule[];
    patterns: PatternExample[];
  };
  testing: {
    frameworks: string[];
    coverageThreshold?: number;
    pattern: TestPattern;
  };
  evidence: EvidenceSource[];
}

interface ArchitectureDecision {
  topic: string;
  decision: string;
  rationale: string;
  source: string; // e.g., "README.md: Architecture section"
  confidence: "high" | "medium" | "low";
}

interface Convention {
  category: "naming" | "structure" | "patterns" | "apis" | "other";
  description: string;
  examples: string[];
  source: string;
  confidence: "high" | "medium" | "low";
}

interface QualityGate {
  gate: string;
  threshold: string;
  enforcement: "strict" | "warn" | "info";
  source: string;
}

interface EvidenceSource {
  type: "doc" | "config" | "ci" | "memory" | "code" | "test";
  path: string;
  extraction: string;
  confidence: "high" | "medium" | "low";
}
```

### Discovery methods per source

#### Documentation

Read these files in order:
1. `README.md` — architecture decisions, patterns, goals
2. `CONTRIBUTING.md` — workflow conventions, quality gates
3. `docs/**/*.md` — detailed docs if present
4. `**/README.md` in subdirectories — module-level docs

Extract using regex patterns and structured parsing:

```typescript
// Pattern examples for extraction
const architectureSectionPattern = /\n#+\s*(?:Architecture|Design|Overview)\s*\n([\s\S]+?)(?=\n#+|$)/i;
const conventionsSectionPattern = /\n#+\s*(?:Conventions|Style|Guidelines)\s*\n([\s\S]+?)(?=\n#+|$)/i;
const qualityGatePattern = /(must|required|enforced)/i;
```

For each extraction, record:
- The extracted text
- Source file and line range
- Confidence score (high = explicit, medium = inferred, low = ambiguous)

#### Configuration

Parse and read:

| File type | Examples | What it tells you |
|---|---|---|
| Build | `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml` | Language, deps, scripts |
| Lint | `.eslintrc`, `ruff.toml`, `.clippy.toml`, `biome.json` | Style rules, forbidden patterns |
| Format | `.prettierrc`, `biome.json`, `rustfmt.toml` | Code style expectations |
| Test | `jest.config.js`, `pytest.ini`, `Cargo.toml \[test\]` | Test framework, coverage settings |

#### CI/CD workflows

Parse workflow files:

| Provider | File locations | Key extraction targets |
|---|---|---|
| GitHub | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | Required checks, test commands, coverage thresholds |
| GitLab | `.gitlab-ci.yml` | Stages, jobs, test commands |
| Azure | `.azure-pipelines.yml` | Stages, jobs, test commands |
| CircleCI | `.circleci/config.yml` | Jobs, executors, test commands |
| Jenkins | `Jenkinsfile` | Stages, steps, test commands |

Extract:

```yaml
# Example: GitHub workflow parsing
on:
  push:
    branches:
      - main  # Gate: main is protected
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test  # Test command
      - run: npm run lint  # Lint gate
      - uses: codecov/...  # Coverage expected
```

#### Memory from vipune

Before discovery, search vipune for prior context:

```bash
# Search for architecture decisions
vipune search "architecture" --limit 10

# Search for prior audit findings
vipune search "audit" --limit 10

# Search for conventions
vipune search "convention" "style" "pattern" --limit 5 each

# Search for known bugs or blockers
vipune search "bug" "fix" "workaround" --limit 10
```

**Important**: Use targeted keyword searches, not the whole user query. Vipune prefers short phrases. See [docs/audit-vipune-policy.md](docs/audit-vipune-policy.md) for the complete vipune usage policy.

#### Representative examples via codebase-memory-mcp

Use `codebase_memory_search_code` to find concrete implementation examples. Query code directly. See [docs/audit-code-search-policy.md](audit-code-search-policy.md) for the complete code-search usage policy, including query patterns and examples.

```
# Examples of high-signal queries
codebase_memory_search_code({query: "error handling"})
codebase_memory_search_code({query: "test coverage"})
codebase_memory_search_code({query: "API endpoint"})
codebase_memory_search_code({query: "validation"})
codebase_memory_search_code({query: "transaction"})
```

For each query, collect:
- 3-5 representative matches
- Path and line numbers
- Pattern observation (what's typical)

**Avoid low-signal queries** (see [audit-code-search-policy.md](audit-code-search-policy.md#query-patterns-good-vs-bad) for more examples):
- ❌ `codebase_memory_search_code({query: "project architecture"})` — too meta; use `get_architecture` instead
- ❌ `codebase_memory_search_code({query: "best practices"})` — no code says this; use `vipune search`
- ❌ `codebase_memory_search_code({query: "good code"})` — subjective; drop the query

Use `codebase_memory_get_architecture({path: "..."})` when you need a structural map without inspecting content. Use `codebase_memory_search_graph({entity: "..."})` to walk dependencies.

#### Test files

Read test files to understand testing patterns:

```bash
# Find test files
find . -name "*test.*" -o -name "test_*.py" -o -name "*.test.*" -o -name "*_spec.rb"

# Sample a few to infer patterns
```

Extract:
- Test framework used
- Assertion style
- Mocking/stubbing patterns
- Coverage expectations

### Discovery output

The discovery phase produces:

1. **`DerivedStandards` object** — structured representation of what's expected
2. **`EvidenceSource[]`** array — every standard cites its source
3. **Discovery transcript** — full discovery process for inspection

If a source yields nothing (e.g., no docs), record that as a gap rather than failing.

---

## Phase 2: Audit Passes

### Objective

Run targeted checks against the codebase, comparing observed reality to the `DerivedStandards` model. Each pass produces findings with structured metadata.

### Finding schema

```typescript
interface Finding {
  id: string; // Unique identifier per audit run
  title: string; // Short description
  description: string; // Detailed explanation

  // Classification
  class: FindingClass;
  severity: Severity;
  confidence: Confidence;

  // Evidence
  path: string;
  lineRange: [number, number] | null;
  evidence: string;
  standardRef: string; // Which standard this violates

  // Context
  sourceStandard: string;
  observed: string;
  expected: string;

  // Metadata
  phase: "discovery" | "audit";
  detectedBy: "explore" | "adversarial-developer" | "code-review-specialist";
}

type FindingClass =
  | "documented_violation"  // Explicitly violates documented rule
  | "inferred_drift"        // Contradicts inferred convention
  | "likely_bug"            // Code pattern suggests bug
  | "dead_code"             // Unused/unreferenced
  | "architecture_drift"    // Contradicts architecture decisions
  | "quality_gate_gap"      // Missing or failing quality gate
  | "heuristic_concern"     // Low-confidence signal worth flagging;

type Severity = "critical" | "high" | "medium" | "low";
type Confidence = "high" | "medium" | "low";

interface PersistentFinding {
  id: string;
  title: string;
  class: FindingClass;
  severity: Severity;
  firstSeen: string; // ISO timestamp
  lastSeen: string; // ISO timestamp
  occurrences: number;
  supersededBy?: string; // If a newer finding replaces this
}
```

### Audit passes

Each pass is executed by a specialist agent via `dispatch_specialist` or `dispatch_parallel`. Passes can run in parallel where independent.

#### Pass 1: Documentation alignment (`explore`)

Check that reality matches documented commitments:

- Architecture violations (does code match stated architecture?)
- Convention violations (does code follow stated conventions?)
- Missing documentation (critical undocumented paths)

**Dispatch spec**:
```typescript
{
  role: "explore",
  prompt: "Audit documentation alignment. Use these standards: <DerivedStandardsJSON>. Check that the actual codebase matches what's documented. Return findings as Finding objects."
}
```

#### Pass 2: Style drift detection (`adversarial-developer`)

Compare actual patterns to inferred style conventions:

- Naming inconsistencies
- Structural violations
- Pattern deviations from examples

**Dispatch spec**:
```typescript
{
  role: "adversarial-developer",
  prompt: "Audit style drift. Use these inferred conventions: <conventionsJSON>. Check actual code for deviations from typical patterns. Return findings as Finding objects."
}
```

#### Pass 3: Quality gate audit (`code-review-specialist`)

Check that quality gates (from CI/CD configs) are actually enforced and effective:

- Are tests running and passing?
- Is linting configured and enforced?
- Is coverage measured?
- Are required checks passing?

**Dispatch spec**:
```typescript
{
  role: "code-review-specialist",
  prompt: "Audit quality gates. Use these quality gates: <qualityGatesJSON>. Check CI logs, test results, and local verification state. Return findings as Finding objects."
}
```

#### Pass 4: Dead code detection (`explore`)

Find unused, unreferenced, or unreachable code:

- Unimported modules
- Unused functions
- Unreachable code paths
- Deprecated code still in use

**Dispatch spec**:
```typescript
{
  role: "explore",
  prompt: "Audit for dead code. Find unused modules, unreferenced functions, unreachable code paths, and deprecated artifacts. Use codebase_memory_search_graph / trace_path to trace references; fall back to search_code for dynamically-referenced symbols. Return findings as Finding objects."
}
```

#### Pass 5: Architecture drift (`adversarial-developer`)

Check architectural invariants:

- Dependency violations
- Layer violations (e.g., data layer calling UI layer)
- Circular dependencies
- Broken abstraction boundaries

**Dispatch spec**:
```typescript
{
  role: "adversarial-developer",
  prompt: "Audit architecture drift. Check for dependency violations, layer crossings, circular dependencies, and broken abstractions. Use codebase_memory_get_architecture for the module map and codebase_memory_search_graph / trace_path to confirm cross-layer references. Return findings as Finding objects."
}
```

#### Pass 6: Likely bugs (`code-review-specialist`)

Identify code patterns that suggest bugs:

- Unhandled error paths
- Missing null checks
- Resource leaks
- Race conditions
- Incorrect API usage

**Dispatch spec**:
```typescript
{
  role: "code-review-specialist",
  prompt: "Audit for likely bugs. Look for unhandled errors, missing null checks, resource leaks, race conditions, and incorrect API usage. Return findings as Finding objects."
}
```

### Pass execution

Run passes in parallel by specialist type:

1. **Batch 1** (parallel):
   - Pass 1: Documentation alignment (`explore`)
   - Pass 4: Dead code (`explore`)

2. **Batch 2** (parallel):
   - Pass 2: Style drift (`adversarial-developer`)
   - Pass 5: Architecture drift (`adversarial-developer`)

3. **Batch 3** (parallel):
   - Pass 3: Quality gates (`code-review-specialist`)
   - Pass 6: Likely bugs (`code-review-specialist`)

Each batch uses `dispatch_parallel`. Batches depend only on the `DerivedStandards` model (discovered in Phase 1), so all can run in parallel.

### Findings collection

Each pass returns `Finding[]` objects. The orchestrator:

1. Dedupes findings by `(path, lineRange, title)`
2. Merges duplicates with confidence boost (multiple passes agree)
3. Assigns final severities (critical from any pass, or consensus-based)
4. Cites each finding to its source standard

---

## Phase 3: Synthesis

### Objective

Collate all findings, compute overall verdict, produce prioritized recommendations.

### Synthesis report structure

```typescript
interface AuditReport {
  summary: {
    totalFindings: number;
    bySeverity: Record<Severity, number>;
    byClass: Record<FindingClass, number>;
    byConfidence: Record<Confidence, number>;
    overallVerdict: AuditVerdict;
    healthScore: number; // 0-100
  };

  standards: {
    overview: string;
    sources: EvidenceSource[];
    gaps: string[]; // What couldn't be discovered
  };

  findings: {
    critical: Finding[];
    high: Finding[];
    medium: Finding[];
    low: Finding[];
  };

  recommendations: Recommendation[];
  transcripts: TranscriptRef[];
}

type AuditVerdict = "HEALTHY" | "CONCERNS_FOUND" | "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";

interface Recommendation {
  priority: "p0" | "p1" | "p2" | "p3";
  title: string;
  description: string;
  actions: string[];
  relatedFindings: string[]; // Finding IDs
  estimatedEffort: "hours" | "days" | "weeks";
}

interface TranscriptRef {
  phase: "discovery" | "audit";
  role: string;
  transcriptPath: string;
}
```

### Verdict computation

| Verdict | Criteria |
|---|---|
| `HEALTHY` | No critical/high findings; <5 medium findings |
| `CONCERNS_FOUND` | No critical findings; 1-5 high findings; <10 medium findings |
| `ISSUES_FOUND` | No critical findings; >5 high findings OR >10 medium findings |
| `CRITICAL_ISSUES_FOUND` | Any critical findings |

### Health score

```typescript
function computeHealthScore(findings: Finding[]): number {
  let score = 100;

  for (const f of findings) {
    switch (f.severity) {
      case "critical":
        score -= 25 * (f.confidence === "high" ? 1 : 0.5);
        break;
      case "high":
        score -= 10 * (f.confidence === "high" ? 1 : 0.7);
        break;
      case "medium":
        score -= 3 * (f.confidence === "high" ? 1 : 0.5);
        break;
      case "low":
        score -= 1 * (f.confidence === "high" ? 1 : 0.3);
        break;
    }
  }

  return Math.max(0, score);
}
```

### Recommendations

Generate recommendations by grouping related findings:

1. **P0 (blocking)** — Fix before proceeding (critical findings)
2. **P1 (urgent)** — Address this sprint (high findings)
3. **P2 (important)** — Address this quarter (medium findings)
4. **P3 (nice to have)** — Address when convenient (low findings)

Each recommendation:
- Summarizes the issue
- Lists concrete actions
- Cites related findings
- Estimates effort

---

## Phase 4: Memory Write-back

### Objective

Store durable results to vipune so future audits benefit from prior context. Follow the explicit vipune policy (see `docs/audit-vipune-policy.md`).

### What to store

Store only high-value, durable results:

1. **Critical/high findings** — Store as `fact` with full metadata
2. **Inferred conventions** — Store as `fact` with evidence
3. **Architecture decisions** — Store as `fact` with source
4. **Aggregated recurring drift** — Store as `fact` when same pattern appears multiple times

### What NOT to store

- Low-severity or low-confidence findings
- Every individual violation of a recurring pattern
- Temporary issues (e.g., failing test in a PR)
- Heuristic concerns without evidence

### Storage format

```bash
# Critical/high finding
vipune add '[audit] CRITICAL: <title>. <description>. Path: <path>:<lines>. Evidence: <evidence>. Standard: <standard>.'

# Inferred convention
vipune add '[audit] Convention: <description>. Examples: <examples>. Evidence: <evidence>.'

# Architecture decision
vipune add '[audit] Architecture: <topic> - <decision>. Rationale: <rationale>. Source: <source>.'

# Aggregated drift
vipune add '[audit] Recurring drift: <pattern>. Seen <N> times in <locations>.'
```

---

## Failure Handling

### When discovery fails

If **no documentation exists**:
- Record as a gap: `standards.gaps.push("No documentation found")`
- Infer standards from examples and config only
- Adjust confidence to `medium` or `low` appropriately
- Note in report: "Standards inferred from code patterns only (no docs)"

If **conflicting sources exist**:
- Prioritize: docs > config > examples > heuristics
- Record conflicts in `standards.gaps`
- Choose higher-confidence source, note conflict
- Flag as heuristic concern with `confidence: "low"`

### When a specialist pass fails

If a specialist pass times out or errors:
- Mark that pass as `status: "failed"`
- Note in report: `"Pass X failed: <reason>"`
- Continue with other passes (partial audit is better than none)
- Encourage user to retry or inspect transcript

### When vipune / codebase-memory-mcp fail

If vipune search fails:
- Proceed without memory context
- Note in report: `"Memory inaccessible: <reason>"`

If the project is unindexed (codebase_memory_get_architecture returns nothing):
- Prompt the user via the `mcp` proxy to run `codebase_memory_index_repository({repo_path: "."})`
- If indexing fails, note in report and skip example / structural discovery
- Warn user in report: `"codebase-memory-mcp unavailable; standards inference limited to docs/config/CI"`

---

## v1/v2 Boundaries

### v1 (this spec)

- Full four-phase workflow
- Standards discovery from docs/config/CI/memory/examples
- Six audit passes (documentation, style, quality gates, dead code, architecture, bugs)
- Vipune write-back for durable results
- Single-run execution (no caching)
- Synthesis report with verdict and recommendations

### Future v2 possibilities (NOT in scope)

- **Persistent audit cache** — store results, compare diffs across runs
- **Trend analysis** — track health score over time
- **Auto-fix integration** — suggest or apply remediation
- **Subscription/continuous mode** — run on every commit
- **Custom audit rules** — user-defined audit queries
- **Integration with project management** — auto-file issues for findings

---

## Transcript Structure

Each phase logs to a separate transcript:

```
~/.pi/agent/ensemble-runs/
  <date>/
    <runId>-pm-md-audit-discovery.json      # Phase 1
    <runId>-pm-md-audit-pass-1.json         # Phase 2, Pass 1
    <runId>-pm-md-audit-pass-2.json         # Phase 2, Pass 2
    ...
    <runId>-pm-md-audit-synthesis.json      # Phase 3
    <runId>-pm-md-audit-writeback.json      # Phase 4
```

Users browse these via `/runs`. The orchestrator only reads the dispatch-tool reports, never the raw transcripts.

---

## Implementation Notes

### Required code changes (minimal)

This spec defines the behavior. Implementation requires:

1. **Slash command registration** — Add `/audit` to `SLASH_COMMANDS` in `extension/src/commands.ts`
2. **Command body** — Create `pi-prompts/audit.md` with this spec embedded
3. **Optional: Dispatch helpers** — If needed, add `dispatch_audit` tool wrapping the multi-stage workflow

The spec itself is documentation. Code changes should be minimal and focused on wiring.

### Testing

Add smoke coverage in `extension/smoke-tests/`:

- `test-audit-flow.ts` — Offline test: verify command registered, phases dispatchable
- Future: `test-audit-live.ts` — Live test: run against synthetic repo, verify output parsing

---

## References

- Epic #31: `/audit` command
- Issue #32: This spec
- Issue #36: Vipune policy for audit
- Issue #37: Code-search policy for audit (originally colgrep; superseded by codebase-memory-mcp)
- `docs/audit-vipune-policy.md` — Explicit vipune usage policy
- `docs/audit-code-search-policy.md` — Explicit code-search (codebase-memory-mcp) usage policy
- README.md — For command positioning vs `/review` and `/research`