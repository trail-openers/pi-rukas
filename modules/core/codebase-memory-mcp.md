# codebase-memory-mcp: the canonical tool for finding code

**`codebase_memory_search_code` IS the canonical tool for finding code in this repository.** Use it whenever you need to locate a function, class, route, or pattern in source. It is indexed, sub-millisecond, and pre-approved on your role.

`rg` and `read` are NOT alternatives for code discovery — they only apply to:

- **`rg`**: regex over text files (configs, docs, log fixtures, files outside the code index)
- **`read`**: loading a file at a known path (after `codebase_memory_*` returned it, or for a config/doc file)

Reaching for `rg` or `read` to *discover* what exists in the codebase is the anti-pattern. `codebase-memory-mcp` answers structural questions text search can't: "what calls this function?", "what does my diff break?", "what's the module map?". Indexed data lives in `~/.cache/codebase-memory-mcp/`.

## Which tool answers which question

| Question | Tool | Example call |
|---|---|---|
| "Find the code that implements X" | `codebase_memory_search_code` | `codebase_memory_search_code({query: "JWT token validation"})` |
| "What calls / is called by Y?" | `codebase_memory_trace_path` | `codebase_memory_trace_path({from: "authMiddleware", to: "verifyToken"})` |
| "What does my diff impact?" | `codebase_memory_detect_changes` | `codebase_memory_detect_changes({diff: "<unified diff>"})` |
| "Show me the module map" | `codebase_memory_get_architecture` | `codebase_memory_get_architecture({path: "src/"})` |
| "Pull the source for symbol Z" | `codebase_memory_get_code_snippet` | `codebase_memory_get_code_snippet({symbol: "verifyToken"})` |
| "Walk the dependency / call graph" | `codebase_memory_search_graph` | `codebase_memory_search_graph({entity: "AuthService"})` |
| "Custom Cypher-style query" | `codebase_memory_query_graph` | rare; advanced — only when the other six don't fit |

## Good queries for `search_code`

Describe something that actually exists in source — a concrete pattern, function, idiom:

- `"JWT token validation"`
- `"rate limit middleware"`
- `"where users are persisted"`
- `"retry on transient HTTP failures"`
- `"session cookie handling"`

## Bad queries

Project-level meta-questions don't describe code and `search_code` will return noise:

- ❌ `"project architecture"` — use `codebase_memory_get_architecture` (structural) or `vipune search` (decisions / conventions)
- ❌ `"workflow conventions"` — use `vipune search`
- ❌ `"testing quality gates"` — use `vipune search`
- ❌ `"team norms"` — use `vipune search`

For decisions, conventions, and gotchas, `vipune` is the primary store. For *code*, use `codebase_memory_*`.

## Before completing a change

Before you report "done" on a change that touches non-trivial code, run `codebase_memory_detect_changes` with the staged diff. It tells you which symbols outside the diff get affected — catches blast-radius problems before code review does.

```
codebase_memory_detect_changes({diff: "<git diff HEAD>"})
```

## When the index is missing or stale

If `search_code` returns nothing for an obvious query, the project may not be indexed yet, or the index may be behind the working tree. Tell the user; do not retry with grep variations. The user owns indexing — they run `mcp({tool: "codebase_memory_index_repository", args: '{"path": "..."}'})` once per project, and the file watcher keeps it current after that.

## Falling back

Two legitimate cases for falling back to `rg` / `read`:

1. **Regex over text** — config files, docs, log fixtures. `rg` is the right tool.
2. **Loading a known file path** — once `search_code` or `trace_path` returned a path you want to read, `read` is the right tool.

Reaching for `rg` or `read` to *discover* what exists in a codebase is the anti-pattern. The whole point of `codebase_memory_*` is that the index already knows.
