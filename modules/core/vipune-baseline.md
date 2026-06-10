# Vipune (Baseline)

> Source-of-truth: `skill/vipune/SKILL.md` in this repo. This module is a role-sized subset for active-but-not-orchestrator use. Load the full skill via `--skill <skills-dir>/vipune` if you need deeper reference.

Vipune is **project-scoped semantic memory**. Search before starting work on any task. Store findings so future sessions have context.

**Use vipune for project meta-questions** ("what's our convention here?", "did we decide on a stack?", "what's the gotcha with X?"). For code-level questions ("where is X implemented?") use ColGREP.

## Memory types (5)

vipune supports five types. Type aggressively — typed memories filter better.

| Type | Use when |
|---|---|
| `fact` (default) | Objective truths about the project |
| `preference` | How the user wants things done |
| `procedure` | Validated step-by-step recipes |
| `guard` | Things to NEVER do |
| `observation` | Notable-but-not-yet-load-bearing context |

```bash
vipune add 'finding' --memory-type fact         # default — durable
vipune add 'finding' --memory-type observation  # ephemeral, in-session
```

## Status: active vs candidate

- `active` (default) — validated, durable knowledge.
- `candidate` — provisional; hidden from default searches until promoted.

Use `--status candidate` when uncertain. Promote later if the fact holds across sessions.

```bash
vipune add 'tentative finding' --memory-type observation --status candidate
```

## Search (always start here)

```bash
vipune search 'topic' --hybrid --recency 0.3 --limit 5
```

Score thresholds: **0.80+ act / 0.70–0.79 cross-check / <0.60 ignore.**

## Freshness verification

Memories are snapshots. **Before acting on a recalled memory, verify against current state** (`ls` for files, `grep` for symbols, `--help` for flags). If stale, supersede or delete:

```bash
vipune add 'corrected statement' --supersedes <old-id> --memory-type fact
```

Never let two contradictory memories coexist.

## Single-quote safety — non-negotiable

```bash
# SAFE
vipune add 'key finding with context'

# DANGEROUS — double quotes execute substitutions
vipune add "key finding $(whoami)"   # ❌
```

## When to write

Write at **task close**, not mid-debug. One atomic fact per `vipune add`. Save:
- Durable findings (architecture, conventions) → `fact`
- User corrections / preferences → `preference`
- Validated workflows → `procedure`
- Discovered pitfalls → `guard`
- In-session observations for PM to recall → `observation`

**Never save secrets** (API tokens, passwords). Hard line — vipune stores plaintext SQLite.

## Pi-ensemble specifics

All session agents (PM, @explore, @developer, etc.) share the **same project-scoped DB**. Use `--memory-type observation` for findings you want PM to retrieve later this session via `vipune search '...' --recency 0.9 --memory-type observation`.

**For the full doctrine** (failure modes, search-recipe scoring tables, deep examples), load the bundled skill via `--skill <skills-dir>/vipune`. Run `vipune --help` for advanced options.
