# Code-search Usage Policy for `/audit`

**Status**: Active — supersedes the previous colgrep policy following the codebase-memory-mcp adoption.

## Overview

This policy defines how `/audit` uses the `codebase_memory_*` MCP tools (from `codebase-memory-mcp`) for code-aware audit phases.

The goal is to use the seven read-side tools effectively to:
- Discover representative code examples for standards inference
- Trace patterns and detect drift across the codebase
- Find concrete implementations for audit passes
- Bound the scope of a change-driven audit via diff blast-radius

The key principle: **pick the tool that matches the question, and prefer structural answers (`trace_path`, `search_graph`, `get_architecture`) over text-pattern fishing when the question is structural.**

This policy complements the main [audit specification](audit-spec.md). For the full workflow, phases, and finding schemas, see the spec.

---

## Tool surface

`/audit` uses these seven `codebase_memory_*` tools (all pre-approved on the read-heavy roles):

| Tool | What it answers | When `/audit` uses it |
|---|---|---|
| `codebase_memory_search_code({query})` | Semantic find — code patterns matching a concept | Phase 1: representative examples. Phase 2: convention drift / dead-code seeding. |
| `codebase_memory_trace_path({from, to})` | Call / dataflow paths between two symbols | Phase 2: dead-code confirmation, dependency drift. |
| `codebase_memory_search_graph({entity})` | Walk the call / dependency graph from an entity | Phase 2: architecture drift, blast-radius probes. |
| `codebase_memory_detect_changes({diff})` | Map a diff to affected symbols + downstream impact | Phase 2 (change-driven audits): scope the audit to the diff. |
| `codebase_memory_get_architecture({path})` | Module map of a path / repo | Phase 1: layering inference. Phase 2: architecture drift. |
| `codebase_memory_get_code_snippet({symbol})` | Pull source by symbol name | Anywhere: load a specific symbol once a query returned it. |
| `codebase_memory_query_graph({...})` | Cypher-style structural query | Advanced; rare. Falls back to specific tools when those suffice. |

---

## When to Use Code Search in `/audit`

`/audit` uses these tools in two phases:

### Phase 1: Standards discovery

- Find representative examples of common patterns (`search_code`)
- Infer conventions from code patterns (`search_code` + `get_code_snippet`)
- Discover idiomatic usage styles (`search_code`)
- Establish the module map (`get_architecture`)

### Phase 2: Audit passes

- Trace references to confirm dead code (`trace_path`, `search_graph`)
- Detect drift across the codebase (`search_code` for content drift, `get_architecture` for structural drift)
- Find all instances of a pattern (`search_code`)
- Bound a diff-driven audit (`detect_changes`)

---

## Query Patterns: Good vs Bad

`search_code` works best when your query describes **concrete code** that exists in source files. It returns thin results for meta or vague queries.

### Good queries ✅

Describe something implementations would actually contain:

| Query | Why it works | Domain |
|---|---|---|
| `search_code({query: "error handling"})` | Code has error-handling blocks (try-catch, etc.) | General |
| `search_code({query: "test coverage"})` | Test files contain coverage-related code | Testing |
| `search_code({query: "API endpoint"})` | API code defines endpoints | APIs |
| `search_code({query: "validation"})` | Validation functions validate input | Input handling |
| `search_code({query: "transaction"})` | Database code uses transactions | Databases |
| `search_code({query: "authentication"})` | Auth code has authentication checks | Security |
| `search_code({query: "middleware"})` | Frameworks use middleware patterns | Web |
| `search_code({query: "retry on transient HTTP failures"})` | HTTP clients have retry logic | Networking |
| `search_code({query: "session cookie handling"})` | Auth code handles session cookies | Web auth |
| `search_code({query: "dependency injection"})` | Code patterns inject dependencies | Architecture |
| `search_code({query: "circuit breaker"})` | Failure-handling code uses circuit breakers | Resilience |
| `search_code({query: "cache invalidation"})` | Caching code has invalidation logic | Performance |
| `search_code({query: "database migration"})` | Database code runs migrations | Databases |
| `search_code({query: "user registration"})` | Apps have user registration flows | Auth |
| `search_code({query: "password hashing"})` | Auth code hashes passwords | Security |

### Bad queries ❌

Describe meta-questions that no source file would contain — use `get_architecture` or `vipune search` for these:

| Query | Why it fails | Better tool |
|---|---|---|
| `search_code({query: "project architecture"})` | No file says "architecture" inside | `get_architecture({path: "."})` |
| `search_code({query: "workflow conventions"})` | Code doesn't describe workflows | `vipune search "workflow conventions"` |
| `search_code({query: "testing quality gates"})` | No file has "quality gates" text | `vipune search` + config inspection |
| `search_code({query: "team norms"})` | Norms are not in code | `vipune search` |
| `search_code({query: "best practices"})` | Code doesn't self-document as "best practice" | `vipune search` |
| `search_code({query: "code quality"})` | No file says "code quality" | `vipune search` |
| `search_code({query: "good code"})` | Subjective; no literal match | Drop the query |
| `search_code({query: "clean code"})` | Subjective; no literal match | Drop the query |
| `search_code({query: "technical debt"})` | Maybe in comments, but poor query | `vipune search "technical debt"` |

---

## Phase 1: Standards Discovery Queries

In the standards discovery phase, use `codebase_memory_search_code` to find representative examples for:
- Function patterns
- Error handling patterns
- Testing patterns
- API patterns
- Data layer patterns
- Validation patterns

For layering inference, use `codebase_memory_get_architecture({path: "."})` once to get the module map, then use `search_code` to inspect representative content within identified modules.

### Query categories and examples

#### Function and class patterns

```
codebase_memory_search_code({query: "function definition"})
codebase_memory_search_code({query: "async function"})
codebase_memory_search_code({query: "class definition"})
codebase_memory_search_code({query: "constructor"})
```

**Goal**: Infer naming conventions (camelCase vs snake_case), structure patterns, async patterns.

#### Error handling patterns

```
codebase_memory_search_code({query: "try catch error handling"})
codebase_memory_search_code({query: "throw new Error"})
codebase_memory_search_code({query: "Result type error"})
codebase_memory_search_code({query: "error logging"})
```

**Goal**: Infer error-handling conventions (do we catch errors? do we log? do we rethrow?).

#### Testing patterns

```
codebase_memory_search_code({query: "test function describe it"})
codebase_memory_search_code({query: "assertion expect"})
codebase_memory_search_code({query: "test setup teardown"})
```

**Goal**: Infer testing framework, assertion style, test organization.

#### API and routing patterns

```
codebase_memory_search_code({query: "HTTP route handler"})
codebase_memory_search_code({query: "API endpoint definition"})
codebase_memory_search_code({query: "middleware"})
```

**Goal**: Infer API framework, routing conventions, middleware usage.

#### Database and data patterns

```
codebase_memory_search_code({query: "database query"})
codebase_memory_search_code({query: "transaction"})
codebase_memory_search_code({query: "ORM model"})
codebase_memory_search_code({query: "database migration"})
```

**Goal**: Infer database technology, ORM usage, query patterns.

#### Validation patterns

```
codebase_memory_search_code({query: "input validation"})
codebase_memory_search_code({query: "schema validation"})
codebase_memory_search_code({query: "type guard"})
```

**Goal**: Infer validation strategy (libraries, custom checks, schema-based).

#### Security patterns

```
codebase_memory_search_code({query: "authentication"})
codebase_memory_search_code({query: "authorization"})
codebase_memory_search_code({query: "password hashing"})
codebase_memory_search_code({query: "JWT token"})
codebase_memory_search_code({query: "OAuth flow"})
```

**Goal**: Infer auth mechanism, encryption patterns, security libraries used.

### Collecting representative examples

For each query, collect 3–5 representative matches. `search_code` returns ranked results — first 5 are usually the most representative.

```
# Example: After finding error handling patterns
codebase_memory_search_code({query: "try catch error handling"})
# Result: 45 ranked matches

# Sample the top few for inference
# - src/auth/login.ts:23-31 (specific error types, logs, rethrows)
# - lib/db/queries.ts:45-52 (wraps errors, no rethrow)
# - api/users/create.ts:78-89 (generic catch, logs, returns error response)

# Infer convention: "Error handling uses try-catch with specific error types, logs errors, and either rethrows or returns error response."
```

Record findings in `DerivedStandards.examples`:
- Path and line numbers
- What the pattern shows
- How consistent it is across matches

For deeper inspection of a single symbol returned by `search_code`, use `codebase_memory_get_code_snippet({symbol: "..."})` to pull the canonical source without dumping the whole file into context.

---

## Phase 2: Audit Pass Queries

In audit passes, use the structural tools for:
- Tracing references (dead code detection) — prefer `trace_path` / `search_graph` over text grep
- Finding drift across the codebase — `search_code` for content; `get_architecture` for structural
- Locating all instances of a pattern — `search_code`
- Bounding a change-driven audit — `detect_changes`

### Pass 4: Dead code detection

Trace references to find unused code. Prefer the structural tools — they understand symbol identity, not just text match:

```
# For a specific function, walk the call graph
codebase_memory_search_graph({entity: "functionName"})
# Returns the inbound edges (callers). If empty, candidate dead code.

# For a path between two symbols (e.g. "is anything reachable from foo to bar")
codebase_memory_trace_path({from: "entryPoint", to: "functionName"})

# Fall back to text find if the symbol is dynamically referenced
codebase_memory_search_code({query: "functionName"})
```

**Strategy**:
1. Start with a module or function.
2. Use `search_graph` to find inbound references.
3. If zero references, mark as potentially dead code.
4. Confirm via `get_code_snippet` + manual inspection (may be referenced dynamically — string-keyed dispatch, reflection, etc.).

### Pass 2: Style drift detection

Find patterns and check for consistency. `search_code` is the right tool here — drift is about content shape:

```
codebase_memory_search_code({query: "async function naming"})
codebase_memory_search_code({query: "error handling block"})
codebase_memory_search_code({query: "class definition"})
```

**Strategy**:
1. Query for a pattern.
2. Inspect 5–10 matches for consistency (use `get_code_snippet` for any that need expansion).
3. If deviation > 20%, flag as drift.

**Example**:
```
# Check async function naming
codebase_memory_search_code({query: "async function definition"})
# Top 40 matches:
# - 28: "async fetchUserData(...)"
# - 8: "async getUser(...)"
# - 4: "async loadUser(...)"

# Conclusion: Drift! Inconsistent naming. Store as finding.
```

### Pass 5: Architecture drift

Trace dependencies and layer violations. The structural tools shine here:

```
# Get the module map first
codebase_memory_get_architecture({path: "."})

# Walk the graph from a layer entry
codebase_memory_search_graph({entity: "uiLayer"})

# Probe a specific cross-layer dependency
codebase_memory_trace_path({from: "ui/UserPage", to: "data/UserRepository"})
```

**Strategy**:
1. Know the intended layering (from architecture docs, `get_architecture`, or inference).
2. Use `trace_path` or `search_graph` to find cross-layer dependencies.
3. Flag violations against the documented / inferred layering.

### Pass 6 (optional): Change-driven scope

If the audit is bounded by a diff (e.g. "audit only what this PR touched"):

```
codebase_memory_detect_changes({diff: "<git diff base..HEAD>"})
# Returns affected symbols + downstream impact. Use the result to constrain
# the subsequent passes to only the symbols actually touched / impacted.
```

---

## Indexing and Setup

### Index lifecycle

`codebase-memory-mcp` is an MCP server with a persistent SQLite knowledge graph at `~/.cache/codebase-memory-mcp/`. The index is per-project; the file watcher keeps it current automatically once initialized.

```
# One-time index of a project (PM owns this; allow-listed for PM)
mcp({tool: "codebase_memory_index_repository", args: '{"path": "/path/to/repo"}'})

# Check status (allow-listed via mcp proxy)
mcp({tool: "codebase_memory_index_status", args: '{"path": "/path/to/repo"}'})
```

### Automatic preflight

`/audit` should preflight the index:

1. If `get_architecture({path: "."})` returns nothing, the project is unindexed.
2. Prompt the user (via the `mcp` proxy `ask` verdict) to run `index_repository`.
3. If indexing fails, log warning and continue without `codebase_memory_*` tools.
4. Mark standards discovery as "code-memory unavailable".

### Indexing expectations

- Average repo: indexing in milliseconds to seconds.
- Linux-kernel-sized repos: ~3 minutes.
- Incremental updates are automatic via the file watcher.
- The first query after a major change may include a brief sync delay; subsequent queries are sub-millisecond.

### Handling failures

If the server is unreachable or queries fail:

1. **Log the failure clearly**: "codebase-memory-mcp unavailable: <error>"
2. **Continue without it**: Discovery from docs/config/CI/vipune only.
3. **Warn in report**: "Standards inference limited to docs/config/CI (codebase-memory-mcp unavailable)"
4. **Encourage user**: "Check the MCP server at `~/.config/mcp/mcp.json`."

Do NOT fail the entire audit due to a code-search server outage.

---

## Breadth vs Depth: structural sweep vs content match

The new tool surface separates breadth from depth more cleanly than the old flat search:

### Structural sweep — `get_architecture`, `search_graph`, `trace_path`

Use when you need the shape of the codebase or the relationships between symbols:

```
# Module map for the whole repo
codebase_memory_get_architecture({path: "."})

# Walk the graph from one entity
codebase_memory_search_graph({entity: "AuthService"})

# Find the path between two symbols
codebase_memory_trace_path({from: "loginHandler", to: "verifyToken"})
```

**Use when**:
- You want a survey of what exists
- You're checking architecture / layering
- You're tracing references for dead-code confirmation
- Prioritizing breadth over depth

### Content match — `search_code`

Use when you need to see actual code examples and infer patterns:

```
codebase_memory_search_code({query: "error handling"})
codebase_memory_search_code({query: "validation logic"})
```

**Use when**:
- You need actual code, not just file locations
- Understanding patterns, not just structure
- Inference or drift detection requires content detail

### Single-symbol load — `get_code_snippet`

Use after one of the above returned a specific symbol you want to read in full:

```
codebase_memory_get_code_snippet({symbol: "AuthService.verifyToken"})
```

---

## Performance and Efficiency

Queries are sub-millisecond, but `/audit` may run dozens. Optimize by:

1. **Avoid duplicate queries** — Don't ask the same question twice. Cache results in the discovery report.
2. **Prefer structural over content when possible** — `search_graph` returns much less context than `search_code` for "find references" questions.
3. **Batch related queries in parallel** — `/audit` already dispatches specialists in parallel; let each one own its slice.
4. **Use `detect_changes` to bound scope** — for change-driven audits, this dramatically reduces the search space.

### Query budget guidance

- Standards discovery: ~10–20 `search_code` calls + 1 `get_architecture`.
- Each audit pass: ~5–15 queries (mix of structural + content).
- Total per audit: typically 50–100 tool calls. The index handles this in milliseconds.

---

## Prompt Embedding

The `/audit` command prompt (`pi-prompts/audit.md`) embeds this policy by reference. Key sections to keep in the prompt:

### Standards discovery section

Add query guidance:

```markdown
### Finding representative examples

Use `codebase_memory_search_code` to find concrete code patterns. These examples help infer conventions and standards.

**Query pattern**: `codebase_memory_search_code({query: "<concrete code description>"})`

**Good queries** (describe what exists in code):
- `codebase_memory_search_code({query: "error handling"})`
- `codebase_memory_search_code({query: "API endpoint"})`
- `codebase_memory_search_code({query: "validation"})`
- `codebase_memory_search_code({query: "authentication"})`
- `codebase_memory_search_code({query: "transaction"})`

**Bad queries** (meta-questions that no code contains — use `get_architecture` or vipune):
- ❌ `codebase_memory_search_code({query: "project architecture"})`
- ❌ `codebase_memory_search_code({query: "workflow conventions"})`
- ❌ `codebase_memory_search_code({query: "best practices"})`

For each query, collect 3–5 representative matches. Record:
- Path and line numbers
- What the pattern shows
- How consistent it is across matches

**If the project is unindexed**, ask the user to run `mcp({tool: "codebase_memory_index_repository", args: '{"path": "."}'})`. If indexing fails, continue without `codebase_memory_*` and note the limitation in your report.
```

### Audit pass sections

Add guidance for each pass that uses code search:

```markdown
#### Pass 4: Dead code detection

Use the structural tools first:
- `codebase_memory_search_graph({entity: "<symbol>"})` — find callers / inbound edges
- `codebase_memory_trace_path({from: "<entry>", to: "<symbol>"})` — confirm reachability

If `search_graph` returns no inbound edges, code may be dead. Confirm via `get_code_snippet` + manual inspection (dynamic dispatch can hide references from the static graph).

#### Pass 2: Style drift detection

Use `search_code` to find patterns and check consistency:
- `codebase_memory_search_code({query: "async function"})`
- `codebase_memory_search_code({query: "error handling block"})`

Inspect 5–10 matches. If deviation > 20%, flag as drift.
```

---

## Examples

### Example 1: Inferring error-handling conventions

```
# Query for error handling
codebase_memory_search_code({query: "try catch error handling"})

# Results (top 3 sampled):
# - src/auth/login.ts:23-31: try { ... } catch (AuthError e) { logger.error(...); throw e; }
# - lib/db/queries.ts:45-52: try { ... } catch (e) { return { error: e.message }; }
# - api/users/create.ts:78-89: try { ... } catch (e) { logger.error(...); return res.status(500).json(...); }

# Inference: "Error handling uses try-catch with specific error types, logs errors, and either rethrows or returns error response."

# Store as convention:
vipune add '[audit] Convention: Error handling uses try-catch with specific error types, logs errors, and either rethrows or returns error response. Examples: src/auth/login.ts:23, lib/db/queries.ts:45, api/users/create.ts:78. Evidence: 15/16 error handlers follow this pattern.'
```

### Example 2: Detecting style drift

```
# Query for async function definitions
codebase_memory_search_code({query: "async function definition"})

# Top 40 results:
# - 28: "async fetchUserData(...)"
# - 8: "async getUser(...)"
# - 4: "async loadUser(...)"

# Analysis: No clear convention. 70% use "fetch" prefix, but drift exists.
# Finding: "Style drift: Inconsistent async function naming. 70% use 'fetch' prefix (e.g., fetchUserData), 20% use 'get' prefix, 10% use 'load' prefix."

# Store as finding or drift:
vipune add '[audit] Recurring drift: Inconsistent async function naming. 70% use "fetch" prefix, 20% use "get", 10% use "load". Examples: src/**/*.ts. Severity: low.'
```

### Example 3: Dead-code confirmation via structural query

```
# Suspected dead function: legacyParseConfig
codebase_memory_search_graph({entity: "legacyParseConfig"})
# Result: { inbound: [], outbound: [...] }
# Empty inbound → candidate dead code.

# Confirm via text find (catches dynamic references the static graph misses):
codebase_memory_search_code({query: "legacyParseConfig"})
# Result: 1 match in tests/legacy-config.test.ts — a unit test that still imports it.

# Finding: legacyParseConfig is referenced only by a test that itself appears dead. Recommend removing both.
```

### Example 4: Change-driven audit

```
# Bound the audit to a specific PR's diff
codebase_memory_detect_changes({diff: "<git diff main..HEAD>"})
# Result: { affected: ["authMiddleware", "verifyToken", "loginHandler"], impacted: ["...19 downstream symbols..."] }

# Constrain Phase 2 passes to those symbols:
# - Pass 2 (style drift) queries scoped to files containing the affected symbols
# - Pass 4 (dead code) ignored — change-driven audits don't speculate beyond the diff
# - Pass 5 (architecture) checks whether the impacted symbols cross layer boundaries they didn't before
```

### Example 5: Bad query (avoid this)

```
# ❌ Bad: Too meta, no code literally says this
codebase_memory_search_code({query: "testing quality gates"})

# Result: Few or irrelevant matches

# Correct approach:
# ✅ For the structural question, use get_architecture
codebase_memory_get_architecture({path: "."})

# ✅ For the conventional question, ask vipune
vipune search "testing quality gates" --memory-type fact

# ✅ For concrete test patterns, search_code with a code-shaped query
codebase_memory_search_code({query: "test fixture setup"})
```

---

## Implementation Checklist

- [x] Policy documented in `docs/audit-code-search-policy.md`
- [x] Standards discovery queries embedded in `/audit` command prompt
- [x] Audit pass queries embedded in `/audit` command prompt
- [x] Good vs bad query examples in prompt
- [x] Structural sweep vs content match guidance in prompt
- [x] Error handling for code-memory unavailability
- [ ] Empirical: run `/audit` end-to-end on a small subject and confirm it cites a snippet retrieved via `codebase_memory_*` — verified during PR review.

---

## References

- Epic #31: `/audit` command
- Issue #32: Formal `/audit` spec
- Issue #36: Vipune policy for audit
- `docs/audit-spec.md` — Full `/audit` specification
- `modules/core/codebase-memory-mcp.md` — Baseline code-search doctrine (not audit-specific)
- `~/.config/mcp/mcp.json` — User-global MCP server config (where codebase-memory-mcp is registered)
