# `/audit` Command Documentation

This directory contains the complete documentation and policy specifications for the `/audit` command (part of Epic #31).

## Documents

### [audit-spec.md](audit-spec.md)
The master specification for the `/audit` command. This document defines:
- Command contract, syntax, and output format
- Four-phase workflow (standards discovery, audit passes, synthesis, memory write-back)
- `DerivedStandards` model schema
- Finding schema with severity and confidence
- Six audit passes and their roles
- Failure handling and fallback behavior
- v1/v2 boundaries

**Status**: Draft — Addresses Issue #32

### [audit-vipune-policy.md](audit-vipune-policy.md)
Explicit vipune usage policy for `/audit`. This document defines:
- Pre-audit search strategies
- What to store (critical/high findings, conventions, architecture, aggregated drift)
- What NOT to store (low-confidence findings, every violation, temporary issues)
- Memory type selection (`fact` vs `observation`)
- Duplicate detection and superseding behavior

**Status**: Draft — Addresses Issue #36

### [audit-code-search-policy.md](audit-code-search-policy.md)
Code-search (codebase-memory-mcp) usage policy for `/audit`. This document defines:
- When to use each `codebase_memory_*` tool in each audit phase
- Good vs bad query patterns (concrete code vs meta-questions)
- Phase 1 discovery queries by category
- Phase 2 audit pass queries for each pass (including diff-bounded audits via `detect_changes`)
- Structural sweep (`search_graph` / `trace_path` / `get_architecture`) vs content match (`search_code`)
- Index lifecycle and failure handling

**Status**: Active — supersedes the previous colgrep policy.

## Quick Links

- **Main README** — [../README.md](../README.md)
- **Quickstart guide** — See README.md "When to use which command" section
- **Contributing** — [../CONTRIBUTING.md](../CONTRIBUTING.md)

## Status

These documents are **draft** and define v1 of the `/audit` command. Implementation is tracked under:
- Epic #31: `/audit` command
- Issue #32: Formal `/audit` spec
- Issue #36: Vipune policy for audit
- Issue #37: Colgrep policy for audit

For the latest implementation progress, see the GitHub issues.

## Related Commands

| Command | Purpose | Relationship |
|---|---|---|
| `/audit` | Audit repo/path against its own standards | This command |
| `/review` | Six-pass code review against universal lenses | Complementary: `/review` checks quality lenses, `/audit` checks repo-specific standards |
| `/research` | Multi-source investigation | Precedes `/audit` for understanding unknown topics |
| `/work` | Execute an issue from start to merge | Follows `/audit` findings when fixing issues |

## Contact

For questions or feedback on the `/audit` command, see the parent pi-ensemble repository at [github.com/randomm/pi-ensemble](https://github.com/randomm/pi-ensemble).