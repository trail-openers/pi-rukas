# Vipune (Heavy Usage Pattern)

> Source-of-truth: `skill/vipune/SKILL.md` in this repo (bundled, symlinked to `~/.pi/agent/skills/vipune` at install). This module is a role-sized subset for orchestrator-heavy use; load the full skill via `--skill <skills-dir>/vipune` when you need the deep reference.

Vipune is **project-scoped semantic memory** — cross-session knowledge that prevents re-paving ground already walked. Search aggressively, store continuously, type aggressively.

**`vipune` is a bash binary, not a tool.** Invoke it via bash (`vipune search "..."`, `vipune add "..."`, `vipune list`). There is no Pi tool, MCP server, or extension named `vipune` — a structured tool call like `<tool_use name="vipune">` will fail. Every example below is shell.

**Use vipune for project meta-questions** (conventions, decisions, gotchas, architectural rationale, who-is-working-on-what). For code-level "where is X implemented?" questions use `codebase_memory_search_code` — they're orthogonal tools (see `modules/core/codebase-memory-mcp.md`).

## Memory types (5)

vipune supports five types; **default `fact` only when nothing more specific fits**:

| Type | Use when |
|---|---|
| `fact` | Objective truths about the project / codebase / environment (e.g. "project uses OpenTofu, not Terraform") |
| `preference` | How the user wants things done (e.g. "user prefers concise responses, no trailing summaries") |
| `procedure` | Validated step-by-step recipes (e.g. "to deploy: source .env, then ./scripts/deploy.sh stage") |
| `guard` | Things the agent MUST NOT do (e.g. "never use --no-verify on commits") |
| `observation` | Notable-but-not-yet-load-bearing context (e.g. "endpoint hangs ~30s on cold start") |

```bash
vipune add 'durable finding'              --memory-type fact         # default
vipune add 'user wants X'                 --memory-type preference
vipune add 'to do X: step1; step2'        --memory-type procedure
vipune add 'never do X because Y'         --memory-type guard
vipune add 'observed but unconfirmed'     --memory-type observation
```

## Status: active vs candidate

vipune has no built-in TTL. Use `--status`:

- `active` (default) — surfaces in default searches; validated, durable knowledge.
- `candidate` — hidden from default searches; provisional. Promote to active once the fact survives a second confirmation.

```bash
vipune add 'tentative observation' --memory-type observation --status candidate
# NOTE: you cannot promote. `vipune update` is denied to every role — it can
# replace a memory's content in place with no lineage and no undo. Leave the
# row a candidate; promotion is an operator action.
```

Default to `candidate` for anything you're not certain will outlast this session.

## Search (always start here)

```bash
vipune search 'topic' --no-hybrid --recency 0.0 --limit 5 --no-touch --json
```

Search recipes — what works:
- **Single technical term** (`'Caddyfile'`) — top score 0.81
- **`[component] [action]`** (`'vllm extra_args'`) — top score 0.80
- **`--hybrid`** for 1–3-word queries and proper nouns
- **`--recency 0.7+`** for "what changed recently"
- **`--memory-type <type>`** for narrow recall

**Score thresholds — semantic mode only** (`--no-hybrid --recency 0.0`). Hybrid scores are RRF reciprocals ceilinged near 0.077; never compare them to these bands, and never apply a band to a recency-blended score: 0.80+ act / 0.70–0.79 cross-check top 2–3 / <0.60 ignore.

**Usage pattern**:
- Search vipune at **session start** for project context
- Search **before delegating work** to check prior decisions
- Search **before major decisions** to verify alignment
- Search **on surprise** when reality contradicts expectations
- Store **after each task completes** for cross-session continuity

## Freshness verification — REQUIRED before acting

Every memory is a snapshot. Code moves, files rename, decisions reverse. **Before acting on a recalled memory, verify against current state.**

| Memory claims | Verification step |
|---|---|
| File at `path/foo.sh` | `ls path/foo.sh` |
| Function/symbol exists | `grep -r "name" .` |
| Flag is supported | Check `--help` |
| Version pinned at X | Read the lockfile |

If verification fails: **supersede or delete the stale memory immediately**. Don't ignore it — the next session hits the same trap.

```bash
vipune add 'corrected statement' --supersedes <old-id> --memory-type fact
# (`vipune delete` is denied to every role — superseding is the correction.)
```

## Conflict handling — supersede, don't duplicate

vipune flags conflicts at 0.85 similarity. Three responses:
1. **New is correct, old is wrong** → `--supersedes <old-id>` (atomic replacement). **Default.**
2. **Both true, different angles** → `--force` (rare — only when both genuinely coexist).
3. **Old is fine** → don't add.

Never let two contradictory memories coexist — that's memory rot.

## Pi-ensemble specifics

**Multi-agent shared DB.** During /work or /research, the PM and every dispatched subagent (@explore, @developer, @ops, @code-review-specialist, @adversarial-developer) share the **same project-scoped vipune DB**. Observations stored by a subagent are immediately retrievable by PM and vice versa.

Use this:
- When dispatching, tell subagents: *"Store your key findings as `--memory-type observation` for session context."*
- To retrieve mid-session: `vipune search '...' --recency 0.9 --memory-type observation`
- Cross-session knowledge (decisions, conventions, gotchas) → `fact`/`procedure`/`guard` with `--status active`.

**Session autosave (opt-in).** When `PI_ENSEMBLE_AUTOSAVE=1` is set, pi-ensemble writes a deterministic session-summary memory to vipune at `session_shutdown`. Complements, doesn't replace, your explicit `vipune add` calls during the session.

## Single-quote safety — non-negotiable

Double quotes execute shell substitutions. **Always use single quotes for `vipune add`.**

```bash
# SAFE — single quotes prevent shell expansion
vipune add 'key finding with context'

# DANGEROUS — double quotes may execute commands
vipune add "key finding $(whoami)"   # ❌ never do this
```

## Periodic consolidation

Every ~10–15 sessions on a project, run a reflection pass:

```bash
vipune list --limit 50 --json | jq .
```

Look for: duplicates (supersede older), stale facts (delete/supersede), drift across multiple `observation`-typed entries on the same theme (consolidate into one `fact`/`procedure`), candidates that survived ≥5 sessions (promote), candidates untouched for months (delete).

## Quick reference

```bash
vipune search '<term>' --no-hybrid --recency 0.0 --limit 5 --no-touch --json
vipune add '<distilled fact>' --memory-type <type> [--status candidate] [--supersedes <id>]
vipune list --limit 50
# `vipune update` and `vipune delete` are DENIED to every role. To correct a
# memory, write a new one with `--supersedes <id>`, which preserves the original.
```

**One atomic fact per `vipune add` call.** For the full doctrine (deep search recipes, failure-mode catalogue, all examples), load the bundled skill via `--skill <skills-dir>/vipune` (pi-ensemble installs it to `~/.pi/agent/skills/vipune`).

## Writing a memory others can actually find

One claim per row, **leading with the file basename**, under ~300 characters:

```
work-driver-lens.ts: reviewRound is incremented here and never reset
```

Three reasons, all measured:

- **Lead with the basename** because that is the token a later search is built from. A row that
  says "the review loop" and a query that says `work-driver-lens.ts` share nothing for BM25 to
  match, so only the semantic leg fires and the row scores on the dead `1/(25+r)` ladder.
- **One claim per row** because a retrieved memory is injected into somebody's prompt and has to be
  checkable on its own. A row carrying four claims is right about some and stale about others, and
  the reader cannot tell which.
- **Short** because of injection cost, *not* findability — long rows retrieve perfectly well (the
  most-retrieved row in this project is 1598 characters). But a brief carries several hits, and the
  corpus median is 742 characters, so unbounded rows crowd out the actual task.

Do **not** shorten by dropping the operative clause. If a memory needs the rule stated last after
its evidence, write two rows instead of truncating one.
