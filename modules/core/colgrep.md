# ColGREP

ColGREP is a semantic **code** search tool. Use it to find existing code that implements a concept — concrete things you'd expect to see in source files.

```bash
colgrep "<query>"
```

**Good queries** describe something that exists in code:

- `colgrep "JWT token validation"`
- `colgrep "rate limit middleware"`
- `colgrep "where users are persisted"`
- `colgrep "retry on transient HTTP failures"`
- `colgrep "session cookie handling"`

**Bad queries** are project-level meta-questions that don't describe code:

- ❌ `colgrep "project architecture"`
- ❌ `colgrep "workflow conventions"`
- ❌ `colgrep "testing quality gates"`
- ❌ `colgrep "team norms"`

Those don't return useful results because no source file says "project architecture" inside it. For meta-questions about the project, use `vipune search` (memory) or read documentation files (`README.md`, `CONTRIBUTING.md`).

Run `colgrep --help` for advanced options.
