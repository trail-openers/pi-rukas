# Colgrep Usage Policy for `/audit`

**Status**: Draft — Addresses #37 (feat(audit): define colgrep policy)

## Overview

This policy defines how `/audit` uses colgrep — semantic code search tool for pi-ensemble.

The goal is to use colgrep effectively to:
- Discover representative code examples for standards inference
- Trace patterns and detect drift across the codebase
- Find concrete implementations for audit passes

The key principle: **Use colgrep for concrete code patterns, not vague semantic fishing.**

This policy complements the main [audit specification](docs/audit-spec.md). For the full workflow, phases, and finding schemas, see the spec.

---

## When to Use Colgrep in `/audit`

`/audit` uses colgrep in two phases:

### Phase 1: Standards discovery

- Find representative examples of common patterns
- Infer conventions from code patterns
- Discover idiomatic usage styles

### Phase 2: Audit passes

- Trace references (e.g., "is this function used anywhere?")
- Detect drift across the codebase
- Find all instances of a pattern

---

## Query Patterns: Good vs Bad

Colgrep works best when your query describes **concrete code** that exists in source files. It fails when your query is meta or vague.

### Good queries ✅

Describe something implementations would actually contain:

| Query | Why it works | Domain |
|---|---|---|
| `colgrep "error handling"` | Code has error-handling blocks (try-catch, etc.) | General |
| `colgrep "test coverage"` | Test files contain coverage-related code | Testing |
| `colgrep "API endpoint"` | API code defines endpoints | APIs |
| `colgrep "validation"` | Validation functions validate input | Input handling |
| `colgrep "transaction"` | Database code uses transactions | Databases |
| `colgrep "authentication"` | Auth code has authentication checks | Security |
| `colgrep "middleware"` | Frameworks use middleware patterns | Web |
| `colgrep "retry on transient HTTP failures"` | HTTP clients have retry logic | Networking |
| `colgrep "session cookie handling"` | Auth code handles session cookies | Web auth |
| `colgrep "dependency injection"` | Code patterns inject dependencies | Architecture |
| `colgrep "circuit breaker"` | Failure-handling code uses circuit breakers | Resilience |
| `colgrep "cache invalidation"` | Caching code has invalidation logic | Performance |
| `colgrep "database migration"` | Database code runs migrations | Databases |
| `colgrep "user registration"` | Apps have user registration flows | Auth |
| `colgrep "password hashing"` | Auth code hashes passwords | Security |

### Bad queries ❌

Describe meta-questions that no source file would contain:

| Query | Why it fails |
|---|---|
| `colgrep "project architecture"` | No file says "architecture" inside |
| `colgrep "workflow conventions"` | Code doesn't describe workflows |
| `colgrep "testing quality gates"` | No file has "quality gates" text |
| `colgrep "team norms"` | Norms are not in code |
| `colgrep "best practices"` | Code doesn't self-document as "best practice" |
| `colgrep "code quality"` | No file says "code quality" |
| `colgrep "good code"` | Subjective; no literal match |
| `colgrep "clean code"` | Subjective; no literal match |
| `colgrep "technical debt"` | Maybe in comments, but poor query |

---

## Phase 1: Standards Discovery Queries

In the standards discovery phase, use colgrep to find representative examples for:
- Function patterns
- Error handling patterns
- Testing patterns
- API patterns
- Data layer patterns
- Validation patterns

### Query categories and examples

#### Function and class patterns

```bash
# Find function definitions to infer naming conventions
colgrep "function"
colgrep "def "
colgrep "const.*=.*=>"
colgrep "async function"

# Find class definitions
colgrep "class "           # Python, TypeScript, Java
colgrep "def __init__"     # Python
```

**Goal**: Infer naming conventions (camelCase vs snake_case), structure patterns, async patterns.

#### Error handling patterns

```bash
# Find error handling constructs
colgrep "try catch"
colgrep "try {"
colgrep "except"           # Python
colgrep "throw new Error"  # JavaScript/TypeScript
colgrep "error handling"   # Comments/docs mentioning it
```

**Goal**: Infer error-handling conventions (do we catch errors? do we log? do we rethrow?).

#### Testing patterns

```bash
# Find test code
colgrep "test"             # Matches test functions, test files
colgrep "describe"         # Jest/Jasmine/Mocha style
colgrep "it("              # Jasmine/Mocha
colgrep "assert"           # Assertion libraries
colgrep "expect"           # Jest/Chai
colgrep "pytest"           # Python
colgrep "@test"            # Java, TypeScript annotations
```

**Goal**: Infer testing framework, assertion style, test organization.

#### API and routing patterns

```bash
# Find API endpoints
colgrep "endpoint"
colgrep "router"           # Express, Fastify, etc.
colgrep "GET /"            # Route definitions
colgrep "POST /"
colgrep "app.use"          # Express middleware
colgrep "@GetMapping"      # Spring Boot
colgrep "@PostMapping"
```

**Goal**: Infer API framework, routing conventions, middleware usage.

#### Database and data patterns

```bash
# Find database operations
colgrep "query"
colgrep "SELECT"           # SQL
colgrep "INSERT"
colgrep "UPDATE"
colgrep "transaction"
colgrep "connection"
colgrep "db."
colgrep "ORM"              # ORM usage comments
```

**Goal**: Infer database technology, ORM usage, query patterns.

#### Validation patterns

```bash
# Find validation logic
colgrep "validation"
colgrep "validate"
colgrep "isValid"
colgrep "check"
colgrep "schema"           # Schema validation
colgrep "Zod"              # Specific library mentions
colgrep "Joi"
colgrep "yup"
```

**Goal**: Infer validation strategy (libraries, custom checks, schema-based).

#### Security patterns

```bash
# Find security-related code
colgrep "authentication"
colgrep "authorization"
colgrep "encrypt"
colgrep "hash"
colgrep "salt"
colgrep "JWT"
colgrep "OAuth"
colgrep "middleware"       # Auth middleware
```

**Goal**: Infer auth mechanism, encryption patterns, security libraries used.

### Collecting representative examples

For each query, collect 3-5 representative matches:

```bash
# Example: After finding error handling patterns
colgrep "try catch"
# Result: 45 matches

# Sample a few for inference
# - src/auth/login.ts:23-31 (specific error types, logs, rethrows)
# - lib/db/queries.ts:45-52 (wraps errors, no rethrow)
# - api/users/create.ts:78-89 (generic catch, logs, returns error response)

# Infer convention: "Error handling uses try-catch with specific error types, logs errors, and either rethrows or returns error response."
```

Record findings in `DerivedStandards.examples`:
- Path and line numbers
- What the pattern shows
- How consistent it is across matches

---

## Phase 2: Audit Pass Queries

In audit passes, use colgrep for:
- Tracing references (dead code detection)
- Finding drift across the codebase
- Locating all instances of a pattern

### Pass 4: Dead code detection

Trace references to find unused code:

```bash
# For a specific function, find where it's called
colgrep "functionName"           # Find calls or references

# Or use the full signature if ambiguous
colgrep "functionName("

# For modules, find imports
colgrep "from './module'"        # ES6 imports
colgrep "require('./module')"    # CommonJS
colgrep "import.*module"         # Various import styles

# For variables, find usage
colgrep "variableName"           # Find references
```

**Strategy**:
1. Start with a module or function
2. Use colgrep to find references
3. If zero references, mark as potentially dead code
4. Confirm via code inspection (maybe referenced dynamically)

### Pass 2: Style drift detection

Find patterns and check for consistency:

```bash
# Find all async function definitions
colgrep "async function"
colgrep "const.*=.*async.*=>"

# Find all error handling blocks
colgrep "try {"

# Find all class definitions
colgrep "class "

# Find all database imports
colgrep "from.*db"
colgrep "require.*db"
```

**Strategy**:
1. Query for a pattern
2. Inspect 5-10 matches for consistency
3. If deviation > 20%, flag as drift

**Example**:
```bash
# Check async function naming
colgrep "async function"
# Results: 40 matches
# - 28: "async fetchUserData(...)"
# - 8: "async getUser(...)"
# - 4: "async loadUser(...)"

# Conclusion: Drift! Inconsistent naming. Store as finding.
```

### Pass 5: Architecture drift

Trace dependencies and layer violations:

```bash
# Find imports from a specific layer
colgrep "from './services'"      # Service layer imports
colgrep "from './data'"          # Data layer imports
colgrep "from './ui'"            # UI layer imports

# Find cross-layer dependencies
# If architecture says: UI → Services → Data
# Then "UI → Data" is a violation

# Trace: Does UI layer import from data layer?
colgrep "from.*data.*ui"         # Look for data imports in UI files
```

**Strategy**:
1. Know the intended layering (from architecture docs or inference)
2. Query for cross-layer imports
3. Flag violations

---

## Indexing and Setup

### Colgrep initialization

Colgrep requires per-project indexing. Before running `/audit`:

```bash
# Check if colgrep is initialized
colgrep status

# If not initialized, initialize
colgrep init
```

### Automatic initialization

`/audit` should automatically initialize colgrep if needed:

1. Start with a trial query: `colgrep "import"`
2. If it fails with "not initialized", run `colgrep init`
3. If init fails, log warning and continue without colgrep
4. Mark standards discovery as "colgrep unavailable"

### Indexing expectations

- Colgrep indexes the entire codebase on `init`
- Indexing takes time on large codebases (minutes)
- Once indexed, queries are near-instant
- Incremental updates may be needed after major changes

### Handling failures

If colgrep init or queries fail:

1. **Log the failure clearly**: "Colgrep unavailable: <error>"
2. **Continue without colgrep**: Discovery from docs/config/CI/only
3. **Warn in report**: "Standards inference limited to docs/config/CI (colgrep unavailable)"
4. **Encourage user**: "Run `colgrep init` manually if indexing issues persist"

Do NOT fail the entire audit due to colgrep unavailability.

---

## Breadth vs Depth: `files-only` vs content inspection

Colgrep offers modes to balance breadth vs depth.

### `files-only` mode

Find files matching a pattern without inspecting content deeply:

```bash
# Find all test files
colgrep "test" --files-only

# Find all API route files
colgrep "router" --files-only
```

**Use when**:
- You want a survey of what files exist
- You don't need detailed content inspection
- Prioritizing breadth over depth

**Examples**:
- "List all test files to sample"
- "Find all files that mention logging to audit"
- "Survey which modules have authentication code"

### Content inspection (default)

Inspect actual code content to extract examples:

```bash
# Find error handling patterns and extract examples
colgrep "try catch"

# Find API endpoints and inspect them
colgrep "endpoint"
```

**Use when**:
- You need to see actual code examples
- Understanding patterns, not just file locations
- Inference or drift detection requires detail

**Examples**:
- "Infer error-handling conventions from code"
- "Check API naming consistency across endpoints"
- "Trace import references for dead code detection"

---

## Performance and Efficiency

Colgrep is fast, but `/audit` may run dozens of queries. Optimize by:

1. **Avoid duplicate queries** — Don't query the same pattern twice
2. **Use `--limit` cautiously** — Colgrep ranks results; first 10 are usually enough
3. **Batch related queries** — Run queries in parallel if independent
4. **Cache results in memory** — Store `DerivedStandards.examples` for reuse

### Query limits

```bash
# Default: let colgrep return ranked results (no additional flag)
colgrep "error handling"

# If you want fewer results (to avoid context bloat):
# Note: Check colgrep documentation for limit flags
# (colgrep's exact CLI varies by version)
```

---

## Prompt Embedding

Embed this policy in `/audit` command prompt (pi-prompts/audit.md):

### Standards discovery section

Add query guidance:

```markdown
### Finding representative examples with colgrep

Use colgrep to find concrete code patterns. These examples help infer conventions and standards.

**Query pattern**: `colgrep "<concrete code description>"`

**Good queries** (describe what exists in code):
- `colgrep "error handling"`
- `colgrep "API endpoint"`
- `colgrep "validation"`
- `colgrep "authentication"`
- `colgrep "transaction"`

**Bad queries** (meta-questions that no code contains):
- ❌ `colgrep "project architecture"`
- ❌ `colgrep "workflow conventions"`
- ❌ `colgrep "best practices"`

For each query, collect 3-5 representative matches. Record:
- Path and line numbers
- What the pattern shows
- How consistent it is across matches

**If colgrep is uninitialized**, run `colgrep init`. If that fails, continue without colgrep and note the limitation in your report.
```

### Audit pass sections

Add guidance for each pass that uses colgrep:

```markdown
#### Pass 4: Dead code detection

Use colgrep to trace references:
- `colgrep "functionName"` — find function calls/references
- `colgrep "from './module'"` — find module imports

If zero references found, code may be dead. Confirm via inspection.

#### Pass 2: Style drift detection

Use colgrep to find patterns and check consistency:
- `colgrep "async function"` — find all async functions
- `colgrep "try {"` — find all error-handling blocks

Inspects 5-10 matches. If deviation > 20%, flag as drift.
```

---

## Examples

### Example 1: Inferring error-handling conventions

```bash
# Query for error handling
colgrep "try catch"

# Results (sampled):
# - src/auth/login.ts:23-31: try { ... } catch (AuthError e) { logger.error(...); throw e; }
# - lib/db/queries.ts:45-52: try { ... } catch (e) { return { error: e.message }; }
# - api/users/create.ts:78-89: try { ... } catch (e) { logger.error(...); return res.status(500).json(...); }

# Inference: "Error handling uses try-catch with specific error types, logs errors, and either rethrows or returns error response."

# Store as convention:
vipune add '[audit] Convention: Error handling uses try-catch with specific error types, logs errors, and either rethrows or returns error response. Examples: src/auth/login.ts:23, lib/db/queries.ts:45, api/users/create.ts:78. Evidence: 15/16 error handlers follow this pattern.'
```

### Example 2: Detecting style drift

```bash
# Query for async function definitions
colgrep "async function"

# Results:
# - 28: "async fetchUserData(...)"
# - 8: "async getUser(...)"
# - 4: "async loadUser(...)"

# Analysis: No clear convention. 70% use "fetch" prefix, but drift exists.
# Finding: "Style drift: Inconsistent async function naming. 70% use 'fetch' prefix (e.g., fetchUserData), 20% use 'get' prefix, 10% use 'load' prefix."

# Store as finding or drift:
vipune add '[audit] Recurring drift: Inconsistent async function naming. 70% use "fetch" prefix, 20% use "get", 10% use "load". Examples: src/**/*.ts. Severity: low.'
```

### Example 3: Bad query (avoid this)

```bash
# ❌ Bad: Too meta, no code literally says this
colgrep "testing quality gates"

# Result: No matches or irrelevant matches

# Correct approach:
# ✅ Query for concrete test patterns
colgrep "test"
colgrep "describe"         # For test frameworks
colgrep "pytest"

# Then infer quality gates from test files and CI configs
```

---

## Implementation Checklist (for #37)

- [ ] Policy documented in `docs/audit-colgrep-policy.md`
- [ ] Standards discovery queries embedded in `/audit` command prompt
- [ ] Audit pass queries embedded in `/audit` command prompt
- [ ] Good vs bad query examples in prompt
- [ ] `files-only` vs content inspection guidance in prompt
- [ ] Error handling for colgrep unavailability
- [ ] Type-check/lint/tests pass (if any minor code tweaks needed)

---

## References

- Epic #31: `/audit` command
- Issue #37: This policy
- Issue #32: Formal `/audit` spec
- Issue #36: Vipune policy for audit
- `docs/audit-spec.md` — Full `/audit` specification
- `modules/core/colgrep.md` — Baseline colgrep usage (not audit-specific)