# File Editing

File editing permissions vary by agent.
- If your agent has `edit`/`write` access, use `edit` for existing files and `write` for new files.
- If your agent does NOT have file-edit permissions, do not attempt file modifications — report needed changes to PM.

# Tool Preferences

## Search: Use the rg Tool

Use the built-in **rg tool** for all search operations. Do NOT use bash grep/rg commands.

```
✅ rg tool: { pattern: "function.*export", include: "*.ts" }
❌ bash: rg "pattern" --type ts
❌ bash: grep -r "pattern" .
```

**rg tool parameters:**
- `pattern` — regex pattern for content search
- `path` — directory to search (default: project root)
- `include` — file glob filter (e.g., "*.ts", "*.{js,tsx}")
- `files_only` — if true, list files matching pattern instead of content

## JSON Parsing

Use `jq` for structured data:
- Parse API responses: `gh api ... | jq '.items[]'`
- Extract fields: `jq -r '.name'`

## File Operations

- **Read files**: Use Read tool, not `cat`/`head`/`tail`
- **Edit files**: Only if your agent has edit/write permission; otherwise report changes to PM

## FORBIDDEN in Bash

- ❌ `grep` — use colgrep or rg tool
- ❌ `rg` — use rg tool
- ❌ `find` — use rg tool with `files_only: true`
