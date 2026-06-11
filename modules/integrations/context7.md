# Context7

Look up current library docs before writing or reviewing code that touches a third-party API. Training data is often months out of date; context7 has the current shape of the library.

Two-step CLI workflow (uses the `ctx7` binary on `$PATH`):

```bash
# 1. Resolve a library name to a Context7 library ID.
#    Returns a ranked list — the first entry with high reputation is usually right.
ctx7 library <library-name> "<short context to disambiguate>"

# 2. Query that library for docs matching your question.
ctx7 docs <library-id> "<specific question or feature>"
```

Examples:

```bash
ctx7 library react "hooks"
# → /reactjs/react.dev   (or similar)

ctx7 docs /reactjs/react.dev "useEffect cleanup function"
# → markdown with code snippets + source URLs
```

When to use it:

- About to write code that calls a third-party library you haven't touched recently — verify the API.
- Reviewing a PR that uses a library — check the call matches the current signature.
- Tracking down whether a library bumped a deprecation between versions.

Skip it for:

- The project's own code (`codebase_memory_search_code` is faster).
- Standard library / built-in language features.
- Meta-questions about the project (`vipune search`).

Add `--json` to either subcommand if you need machine-parseable output.
