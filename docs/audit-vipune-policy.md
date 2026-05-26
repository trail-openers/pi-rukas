# Vipune Usage Policy for `/audit`

**Status**: Draft — Addresses #36 (feat(audit): define vipune policy)

## Overview

This policy defines how `/audit` uses vipune — cross-session memory for pi-ensemble. The goal is to support future audits with prior context without turning vipune into a noisy bug tracker.

## Core Principle

**Use vipune deliberately, sparsely, and for durable results only.**

Vipune should help `/audit`:
- Discover prior findings and decisions before starting
- Store high-value, cross-session results after auditing
- Build institutional memory over time

Vipune should NOT:
- Store every single violation
- Act as a bug tracker with issue-style entries
- Spam memory with low-confidence or low-severity findings

---

## Pre-Audit: Search Strategy

Before running audit passes, search vipune for relevant context. Use targeted keyword searches, not semantic queries.

### Search queries

```bash
# Prior audit findings
vipune search "audit" --limit 10

# Architecture decisions (explicitly labeled)
vipune search "architecture" --limit 10

# Conventions and style notes
vipune search "convention" --limit 5
vipune search "style" --limit 5
vipune search "pattern" --limit 5

# Known bugs or blockers
vipune search "bug" --limit 5
vipune search "fix" --limit 5
vipune search "workaround" --limit 5

# Quality gate notes
vipune search "quality gate" --limit 5
vipune search "coverage" --limit 5
```

### Search guidelines

1. **Targeted keywords only** — Use short phrases, not full sentences
   - ✅ `vipune search "convention"` — Good
   - ❌ `vipune search "what are our conventions for naming"` — Bad (too long)

2. **Limit results** — Use `--limit` to avoid context bloat
   - Default: 5-10 results per query
   - More only if you have a specific reason

3. **Parse and prioritize** — Results are ranked by relevance. Prioritize:
   - Recent findings (`--recency 0.9` for last ~1-2 weeks)
   - High-confidence results (memory type `fact` > `observation`)
   - Evidence-backed entries (those with source/path information)

4. **Avoid duplicate searches** — Don't search the same keyword twice in one audit

### Memory types

When reading prior results, understand the type:

- **`fact` (default)** — Durable, persists forever. Architecture decisions, conventions, critical findings.
- **`observation`** — Ephemeral, decays in ~1-2 weeks. Session notes, working context. Less reliable for cross-session reuse.

Prioritize `fact` results. Use `observation` only for recent, high-confidence leads.

---

## Post-Audit: Storage Strategy

After auding, store only durable, high-value results. This section defines exactly what to store, what NOT to store, and the storage format.

## What to Store

Store findings and inferences that have **long-term value** and **cross-session relevance**.

### 1. Critical and high-severity findings

Store these as `fact` (default). These are blocking issues that future audits should track.

**Format**:
```bash
vipune add '[audit] CRITICAL: <concise title>. <description>. Path: <path>:<lines>. Evidence: <evidence>. Standard: <standard>. First seen: <date>.'
```

**Examples**:
```bash
# Critical auth bypass
vipune add '[audit] CRITICAL: Auth middleware bypass in admin endpoints. middleware/auth.ts:45 returns null on header parsing, allowing unauthenticated access. Evidence: direct code inspection. Standard: authentication must never skip. First seen: 2026-05-26.'

# High: Missing input validation
vipune add '[audit] HIGH: Missing input validation on user registration. api/users.ts:23 creates user without validating email format or password strength. Evidence: code inspection. Standard: all user inputs must be validated. First seen: 2026-05-26.'
```

**Storage criteria**:
- `severity` is `critical` or `high`
- `confidence` is `high` or `medium`
- The issue is durable (won't be fixed in 5 minutes)
- Has a clear path and evidence

### 2. Inferred conventions

Store conventions discovered from code examples and patterns. These help future audits detect drift.

**Format**:
```bash
vipune add '[audit] Convention: <description>. Category: <category>. Examples: <path1:line1>, <path2:line2>. Evidence: <evidence summary>.'
```

**Examples**:
```bash
# Naming convention
vipune add '[audit] Convention: TypeScript files use camelCase for functions, PascalCase for classes. Category: naming. Examples: src/utils/helpers.ts:12 (camelCase), src/models/User.ts:5 (PascalCase). Evidence: analysis of 50 function definitions and 30 class definitions.'

# Error handling pattern
vipune add '[audit] Convention: Database queries use try-catch with specific error types. Category: error-handling. Examples: lib/db/queries.ts:45, lib/db/queries.ts:78, api/routes/auth.ts:23. Evidence: 15/16 database operations follow this pattern.'
```

**Storage criteria**:
- Pattern is consistent across 3+ examples
- Pattern is not language default or trivial (e.g., "functions have names" is not worth storing)
- Evidence includes specific paths and lines

### 3. Architecture decisions

Explicit architecture decisions derived from docs or inferred from patterns.

**Format**:
```bash
vipune add '[audit] Architecture: <topic> - <decision>. Rationale: <rationale>. Source: <source>.'
```

**Examples**:
```bash
# From docs
vipune add '[audit] Architecture: Use PostgreSQL as primary data store. Rationale: transaction support and complex query needs. Source: README.md: Architecture section.'

# Inferred from patterns
vipune add '[audit] Architecture: API layer does not call data layer directly; uses service layer. Rationale: separation of concerns observed. Evidence: service layer mediates all data access. Source: inferred from code patterns (api/ → services/ → data/).'
```

**Storage criteria**:
- Decision is structural or cross-cutting
- Has rationale or evidence
- Not a one-off implementation detail

### 4. Quality gate configurations

Documented or inferred quality gates (test coverage, linting rules, etc.).

**Format**:
```bash
vipune add '[audit] Quality gate: <gate>. Threshold: <threshold>. Enforcement: <strict|warn|info>. Source: <source>.'
```

**Examples**:
```bash
vipune add '[audit] Quality gate: 80% test coverage required for merge. Threshold: coverage >= 80%. Enforcement: strict. Source: .github/workflows/ci.yml:45, CONTRIBUTING.md:12.'

vipune add '[audit] Quality gate: TypeScript strict mode with noImplicitAny. Threshold: tsc must pass. Enforcement: strict. Source: tsconfig.json, CONTRIBUTING.md:15.'
```

**Storage criteria**:
- Gate is enforced or documented
- Threshold is specific and measurable
- Source is clearly cited

### 5. Aggregated recurring drift

When the same pattern violation appears multiple times, store the aggregate instead of each violation.

**Format**:
```bash
vipune add '[audit] Recurring drift: <pattern>. Seen <N> times in: <locations>. Severity: <medium|low>. Evidence: <summary>.'
```

**Examples**:
```bash
# Recurring style drift
vipune add '[audit] Recurring drift: Inconsistent async function naming (some use "asyncGetOthers", some use "fetchOthers"). Seen 8 times in: src/api/*.ts, src/services/*.ts. Severity: low. Evidence: naming convention pattern analysis: 68% use "fetch" prefix, 32% use "async" prefix.'

# Recurring missing error handling
vipune add '[audit] Recurring drift: Missing error handling on database queries. Seen 5 times in: lib/db/users.ts:45, lib/db/posts.ts:23, lib/db/comments.ts:67. Severity: medium. Evidence: 5 functions call db.query() without try-catch; 15 others have try-catch.'
```

**Storage criteria**:
- Same pattern appears 3+ times
- Individual violations are medium or low severity
- Aggregate is more valuable than individual entries

---

## What NOT to Store

These things should NOT be stored to vipune:

### 1. Low-severity or low-confidence findings

- ❌ Low-confidence (`confidence: "low"`) findings of any severity
- ❌ Low-severity (`severity: "low"`) findings with low confidence
- ❌ Individual heuristic concerns without evidence

**Rationale**: These are noise. They don't help future audits; they create context bloat.

### 2. Every individual violation of a recurring pattern

- ❌ Store 5 entries for "missing error handling" when all 5 are the same pattern
- ✅ Store ONE aggregate entry describing the 5 violations

**Rationale**: Aggregates are more useful. Future audits want to know "X appears frequently," not see every single instance.

### 3. Temporary issues

- ❌ Failing tests in a PR (temporary until PR lands)
- ❌ Warnings that go away on the next commit
- ❌ Issues specific to a merge conflict or rebasing

**Rationale**: Vipune is for durable, cross-session context, not transient state.

### 4. Duplicates or superseded findings

- ❌ Store a finding you already stored previously
- ❌ Store both old and new versions of the same finding

**Rationale**: Duplicate entries waste context. Future audits see redundant information.

### 5. Trivial or language-default observations

- ❌ "This project uses function syntax"
- ❌ "Import statements use ES6 syntax"
- ❌ "Tests use Jest's expect() function"

**Rationale**: These are obvious and don't help future audits.

---

## Memory Type Selection

Use the appropriate memory type based on durability and relevance.

### `fact` (default, high durability)

Use for:
- Critical/high findings
- Conventions
- Architecture decisions
- Quality gates

These persist forever. They're the core of institutional memory.

### `observation` (ephemeral, ~1-2 weeks decay)

Use for:
- Low- or medium-severity findings when you're unsure of their durability
- Session notes about patterns you're investigating
- Working hypotheses to be verified or debunked

These decay over time. All session agents share the same DB. Use for "I'm seeing X, let's see if it persists" — if it does, upgrade to `fact`.

### Default: `fact`

If unsure, default to `fact`. Only use `observation` when you have a specific reason (e.g., "I'm not sure this pattern is real yet").

---

## Duplicate Detection and Superseding

When storing findings, check for duplicates before writing.

### Duplicate detection

Before storing a finding, search for similar entries:

```bash
# Check for duplicates by title/topic
vipune search "[audit] CRITICAL: <title keywords>" --limit 5
vipune search "[audit] HIGH: <title keywords>" --limit 5
vipune search "[audit] Convention: <topic>" --limit 5
vipune search "[audit] Architecture: <topic>" --limit 5
vipune search "[audit] Recurring drift: <pattern>" --limit 5
```

If an identical or very similar entry exists:

1. Compare the new finding's metadata:
   - Same severity?
   - Same or similar path/lines?
   - Same evidence?

2. If it's the same finding (same issue at same location):
   - **Do NOT create a duplicate entry**
   - Update the existing entry by re-adding with new `last seen` date (if vipune supports updates)
   - OR: Create a new entry that references the old one: "See also: <prior entry ID>"

3. If it's the same pattern in a new location:
   - Aggregate if you have 3+ instances now (see "Aggregated recurring drift" section)
   - Or skip if it's just a second instance (not enough for aggregation yet)

### Superseding (if supported by vipune)

If a previous finding is now fixed:

1. Search for the finding by title/location
2. If found, mark as superseded or add a new entry:
   ```bash
   vipune add '[audit] RESOLVED: <title>. Previously: <date>. Resolution: <how it was fixed>.'
   ```
3. Future audits skip superseded entries

**Note**: Vipune's exact superseding semantics depend on the vipune tool implementation. Check `vipune --help` for current support.

---

## User-Facing Documentation

This policy complements the main [audit specification](docs/audit-spec.md). For the full workflow, phases, and finding schemas, see the spec.

## User-Facing Documentation

In README.md and `/audit` command docs, explain the memory behavior:

### README.md

Add to the Command comparison table:

| Command | Memory behavior |
|---|---|
| `/audit` | Sparse, durable stores only: critical/high findings, conventions, architecture decisions, aggregated drift. Not a bug tracker. |
| `/research` | Saves all research results as `fact` or `observation` depending on durability. |
| `/work` | No direct memory writes (subagents may store as part of their work). |
| `/review` | Does not write to memory (findings are session-scoped). |

### `/audit` command docs

Add a "Memory and persistence" section:

#### Memory and persistence

`/audit` uses vipune to build cross-session awareness:

- **Before auditing**: Searches for prior findings, conventions, and architecture decisions
- **After auditing**: Stores only durable, high-value results:
  - Critical/high findings
  - Conventions inferred from examples
  - Architecture decisions
  - Quality gate configurations
  - Aggregated recurring drift (3+ instances)

`/audit` does NOT store:
- Low-severity or low-confidence findings
- Every individual violation of a recurring pattern
- Temporary issues (e.g., failing tests in a PR)
- Trivial observations

This keeps memory useful and not noisy. Future audits benefit from prior context without drowning in duplicates.

---

## Examples

### Example 1: Storing a critical finding

```bash
# Finding from audit
vipune add '[audit] CRITICAL: SQL injection in user search. api/users.ts:67 interpolates user input into query without sanitization. Path: api/users.ts:67. Evidence: direct code inspection. Standard: all user input must be parameterized. First seen: 2026-05-26.'
```

### Example 2: Storing a convention

```bash
# Convention inferred from patterns
vipune add '[audit] Convention: API routes use Express middleware pattern with async handlers. Category: api-pattern. Examples: api/routes/users.ts:12, api/routes/posts.ts:23, api/routes/comments.ts:45. Evidence: 15/16 route handlers follow async middleware pattern.'
```

### Example 3: Storing aggregated drift

```bash
# Aggregate of 5 similar violations
vipune add '[audit] Recurring drift: Missing error handling on file operations. Seen 5 times in: src/utils/file.ts:23, src/utils/file.ts:45, src/loaders/config.ts:67, src/loaders/data.ts:89, src/parsers/input.ts:123. Severity: medium. Evidence: 5 functions call fs.readFile() without try-catch; 10 others have try-catch.'
```

### Example 4: Example of what NOT to store (skip this)

Don't store this:

```bash
# ❌ Don't store: trivial observation, low confidence
vipune add '[audit] Some functions use const and some use let. Examples: unknown. Evidence: maybe? Confidence: low.'
```

Instead, verify the pattern first:

```bash
# ✅ After verification, store the aggregate pattern
vipune add '[audit] Convention: Use const by default, let only for reassignment. Category: variable-declaration. Examples: src/**/*.ts (const in 127 places, let in 12 places). Evidence: analysis shows 91% const usage; let used only for loop counters and accumulators.'
```

---

## Implementation Checklist (for #36)

- [ ] Policy documented in `docs/audit-vipune-policy.md`
- [ ] Pre-audit search queries embedded in `/audit` command prompt
- [ ] Post-audit storage guidelines embedded in `/audit` command prompt
- [ ] Examples of good and bad storage decisions in prompt
- [ ] README.md updated with memory behavior table
- [ ] `/audit` command docs updated with "Memory and persistence" section
- [ ] Type-check/lint/tests pass (if any minor code tweaks needed)

---

## References

- Epic #31: `/audit` command
- Issue #36: This policy
- Issue #32: Formal `/audit` spec
- Issue #37: Colgrep policy for audit
- `docs/audit-spec.md` — Full `/audit` specification
- `modules/core/vipune-baseline.md` — Baseline vipune usage (not audit-specific)