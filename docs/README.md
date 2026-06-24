# pi-ensemble docs

Specifications + policy docs for `/audit` (Epic #31) plus a troubleshooting guide for the sandboxed runtime.

## Operator docs

### [troubleshooting.md](troubleshooting.md)
Symptom → cause → fix entries for the most common `pi-ensemble` sandbox issues: `MCP: 0/N servers`, `gh` 401 inside container, custom LLM endpoints unreachable, custom provider missing from `/ensemble-model`, vipune embedding 404, fd/rg auto-download at boot, session-resume picker failures, named-volume cleanup. Each entry links the PR that addressed it. First stop when something weird happens — usually `./install.sh` fixes it.

## `/audit` Command Documentation

### [audit-spec.md](audit-spec.md)
The master specification for the `/audit` command. This document defines:
- Command contract, syntax, and output format
- Four-phase workflow (standards discovery, audit passes, synthesis, memory write-back)
- `DerivedStandards` model schema
- Finding schema with severity and confidence
- Six audit passes and their roles
- Failure handling and fallback behavior
- v1/v2 boundaries

**Status**: Active — `/audit` ships in pi-ensemble alpha. v2 boundary work tracked separately under Epic #31.

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
| `/work` | Execute an issue from start to merge (compiled state-machine driver) | Follows `/audit` findings when fixing issues |
| `/do` | Free-form orchestration without an issue (PM-driven) | Alternative to `/work` when there's no GitHub issue — e.g., fixing `/review` findings, one-off changes |

## Contact

For questions or feedback on the `/audit` command, see the parent pi-ensemble repository at [github.com/randomm/pi-ensemble](https://github.com/randomm/pi-ensemble).