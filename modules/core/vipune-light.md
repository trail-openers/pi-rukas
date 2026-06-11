# Vipune (Light Usage)

> Source-of-truth: `skill/vipune/SKILL.md` in this repo. This module is the minimal subset for roles that mostly read memory and write sparingly.

Vipune is **project-scoped semantic memory**. Your role uses it primarily for recall; write only genuinely durable findings.

## Search first (always)

```bash
vipune search 'topic' --hybrid --recency 0.3 --limit 5
```

Score thresholds: **0.80+ act / 0.70–0.79 cross-check / <0.60 ignore.**

For project meta-questions (conventions, decisions, gotchas) → vipune. For code-level questions (where is X implemented?) → `codebase_memory_search_code` (see `modules/core/codebase-memory-mcp.md`).

## Memory types — by name

- `fact` (default) — objective project truths
- `preference` — how the user wants things done
- `procedure` — validated step-by-step recipes
- `guard` — things to NEVER do
- `observation` — ephemeral, in-session

Use `--memory-type` when writing. Default to `--status candidate` when uncertain — promotes only after a second confirmation.

## When to write (sparingly)

Save only at task close, after a conclusion holds. One atomic fact per `vipune add`:

```bash
vipune add 'durable finding' --memory-type fact
vipune add 'in-session finding' --memory-type observation
vipune add 'tentative finding' --memory-type observation --status candidate
```

**Never save secrets.** Hard line — vipune stores plaintext SQLite.

## Single-quote safety

```bash
vipune add 'finding'    # SAFE
vipune add "finding $(whoami)"   # ❌ DANGEROUS — shell expansion
```

## Freshness check before acting

Memories are snapshots. Verify against current state (`ls`, `grep`, `--help`) before using as the basis for action. If stale, `--supersedes <old-id>` or `vipune delete <id>`.

For the full doctrine load the bundled skill via `--skill <skills-dir>/vipune`. Run `vipune --help` for options.
