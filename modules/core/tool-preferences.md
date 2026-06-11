# File Editing

File editing permissions vary by agent.
- If your agent has `edit`/`write` access, use `edit` for existing files and `write` for new files.
- If your agent does NOT have file-edit permissions, do not attempt file modifications — report needed changes to PM.

# Tool Preferences

## Search: prefer codebase-memory-mcp for code; rg for regex on text

When the question is "find code about X", "what calls Y", or "what does my diff break", use the indexed `codebase_memory_*` MCP tools. They run in sub-milliseconds and return structural answers `rg` cannot. The `rg` tool stays useful for regex over text files (configs, docs, log fixtures) and for files outside the index.

Ordering (use the first one that fits):

1. **`codebase_memory_search_code({query: "..."})`** — semantic find across the indexed repo. Default for "where is X implemented?".
2. **`codebase_memory_trace_path({from, to})`** / **`codebase_memory_search_graph({entity})`** — call graph / dataflow. Use when the question is "what calls Y" or "what depends on Z".
3. **`codebase_memory_detect_changes({diff})`** — blast radius. Run before reporting a change complete.
4. **`codebase_memory_get_architecture({path})`** — module map. When you need the structural overview.
5. **`codebase_memory_get_code_snippet({symbol})`** — pull source by symbol name (when a previous query returned the name).
6. **rg tool** — regex over text. Configs, docs, files the index doesn't cover.
7. **read tool** — load a file by known path (after one of the above returned it).

```
✅ codebase_memory_search_code({query: "JWT validation middleware"})
✅ codebase_memory_detect_changes({diff: "<git diff HEAD>"})
✅ rg tool: { pattern: "function.*export", include: "*.ts" }    ← regex on text
❌ bash: rg "pattern" --type ts                                  ← bash rg forbidden
❌ bash: grep -r "pattern" .                                     ← bash grep forbidden
```

**rg tool parameters:**
- `pattern` — regex pattern for content search
- `path` — directory to search (default: project root)
- `include` — file glob filter (e.g., "*.ts", "*.{js,tsx}")
- `files_only` — if true, list files matching pattern instead of content

See `modules/core/codebase-memory-mcp.md` for the full doctrine on which `codebase_memory_*` tool answers which question.

## JSON Parsing

Use `jq` for structured data:
- Parse API responses: `gh api ... | jq '.items[]'`
- Extract fields: `jq -r '.name'`

## File Operations

- **Read files**: Use Read tool, not `cat`/`head`/`tail`
- **Edit files**: Only if your agent has edit/write permission; otherwise report changes to PM

## FORBIDDEN in Bash

- ❌ `grep` — use `codebase_memory_search_code` or rg tool
- ❌ `rg` — use rg tool (the built-in one, not bash)
- ❌ `find` — use rg tool with `files_only: true`
