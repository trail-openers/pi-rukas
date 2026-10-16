---
name: vipune
description: >
  pi-rukas's bundled vipune memory doctrine — full reference for using the
  vipune CLI as a project-scoped semantic memory store. Encodes the 5-type
  memory taxonomy (fact, preference, procedure, guard, observation), the
  active/candidate status split as the long-term/short-term mechanism,
  freshness verification before acting on recalled memories, conflict
  handling via --supersedes, periodic consolidation reflexes, the hard
  prohibition on storing secrets, and pi-rukas-specific framing
  (multi-agent shared DB, session autosave). Use this skill whenever
  starting a project task; before delegating work; before making
  architectural decisions; after task completion; when the user mentions
  "remember"/"recall"/"vipune"; when surprised by codebase reality vs
  recalled memory; or when encountering a known-feeling pitfall.
  Project-scoped, semantic-search-driven; designed to make every session
  smarter than the last without context bloat or memory rot.
---

# Vipune memory skill (pi-rukas bundled)

> **Source-of-truth note.** This is pi-rukas's project-bundled vipune doctrine. It was originally adapted from a personal Claude Code skill, but the bundled version is the canonical reference for pi-rukas going forward. The role-sized derivative modules at `modules/core/vipune-{light,baseline,heavy}.md` are proper subsets of this skill — when they diverge, the skill is right and the modules need a resync. See the procedure-type memory `"sync pi-rukas vipune modules"` for the workflow.

Vipune is a CLI semantic memory store with project scoping, hybrid search, and typed memories — the authoritative persistent memory layer for every pi-rukas session.

Codebases evolve, conventions accumulate, the user corrects the agent on things, and constraints get discovered together. None of that should be re-learned session by session. Vipune is the durable layer that prevents repeating mistakes and re-paving ground already walked.

> **The mandate**: search vipune at the start of every task, save vipune memories at task boundaries. This is not optional. It is the protocol.

## Why vipune over file-based notes

- **Semantic search** finds memories by meaning, not exact keywords
- **Project scoping** is automatic via git remote — no cross-contamination between codebases
- **Typed memories** route by purpose (fact / preference / procedure / guard / observation)
- **Conflict detection** at 0.85 similarity flags duplicate memories before write
- **Supersede** atomically replaces outdated memories — no orphaned contradictions
- **Status field** (active/candidate) gives a long-term/short-term split
- **Recency-weighted search** gives implicit decay without losing data
- **Single binary, local SQLite** — no API calls, no external service, no network dep
- **All session agents share the project DB** — observations stored by `@explore` or `@developer` during a /work cycle are immediately retrievable by PM and other subagents in the same session.

## The protocol — two bookends and a watchpoint

### 1. Session open / new task — SEARCH FIRST

Before reading code, before running anything, before forming a plan:

```bash
vipune search "<topic the user mentioned>" --no-hybrid --recency 0.0 --limit 5 --no-touch --json
```

Read the returned memories. They tell you:

- The project's conventions (what tools, what style, what to NOT do)
- Past user corrections (don't repeat past mistakes)
- Validated workflows (recipes that already work)
- Known pitfalls and dead-ends
- In-progress context that crossed a session boundary

Run **2–3 targeted searches** with different angles before starting non-trivial work. Single-term queries score highest (0.81+); compound `[domain] [component] [action]` queries also work well. See "Search recipes" below.

### 2. Mid-task — SEARCH ON SURPRISE

If the codebase contradicts a recalled memory, or you encounter unexpected behavior, search again:

```bash
vipune search "<symptom> <component>" --hybrid --limit 5
```

The memory may explain the surprise (known gotcha), or you need to update/supersede a stale memory.

### 3. Task close / session end — SAVE WHAT'S WORTH KEEPING

At the natural end of a unit of work, distill the findings into typed memories:

```bash
# A new project convention discovered
vipune add 'Build runs via "just dev" not "npm run dev" (Justfile is canonical)' \
  --memory-type procedure

# A user correction — high importance
vipune add 'Operator wants secrets via .env, never in terraform.tfvars' \
  --memory-type preference

# A discovered pitfall — guard against repeating
vipune add 'vllm_extra_args containing JSON must escape inner quotes inside the HCL string' \
  --memory-type guard

# An observation that may or may not be load-bearing — hold provisionally
vipune add 'Caddy LE state lives at /mnt/models/caddy_data, survives tofu destroy' \
  --memory-type observation --status candidate
```

**Never save mid-debug.** Only after a conclusion is reached. Mid-debug hypotheses are exactly the kind of false-positive context that becomes "memory rot."

## Memory types — when to use which

Vipune ships with 5 types. Each routes by purpose:

| Type | What it captures | Examples |
|---|---|---|
| `fact` (default) | Objective truths about the project, codebase, or environment | "Project uses OpenTofu, not Terraform" / "H100 SXM5 has 80 GB VRAM" / "Floating IP is 94.237.15.199" |
| `preference` | How the user wants things done | "User prefers concise responses with no trailing summaries" / "Always confirm before tofu apply" |
| `procedure` | Validated step-by-step recipes | "To stop the H100: source .env, then UPCLOUD_SERVER_ID=... ./scripts/upcloud-lifecycle.sh stop" |
| `guard` | Things the agent MUST NOT do | "Never use --no-verify on commits" / "Never put secrets in tfvars committed to git" |
| `observation` | Notable but not yet load-bearing context | "Network throughput between H100 and HF Hub is ~120 MB/s typical" |

Default to `fact` only when nothing more specific fits. **Be aggressive about typing** — typed memories filter better, decay better, and survive consolidation passes.

## Active vs candidate — the long-term / short-term mechanism

Vipune has no built-in TTL. Use `--status` instead:

| Status | Behavior | Use for |
|---|---|---|
| `active` (default) | Surfaces in default searches | Validated, durable knowledge |
| `candidate` | Hidden unless `--include-candidates` is passed | Provisional observations, hypotheses, things that may not outlast this session |

```bash
# Provisional — won't show in default searches until an operator promotes it
vipune add 'tofu apply takes ~5 min when only user_data changed' \
  --memory-type observation --status candidate

# Leave the row a candidate. Promotion is an operator action — report the
# id. Correct a memory by writing a new one with `--supersedes <id>`.
```

**An operator promotes a candidate only after the fact survives a second confirmation.** Report the row's id for promotion; do not run it yourself. Otherwise, let candidates sit — they're inert until explicitly queried. This is the short-term tier.

The `/work` driver writes its own candidates (lens findings, invariant removals), always typed `observation` so the operator's `prune` command can age out the unpromoted ones — it never demotes a `guard`. The developer brief reads active rows only, so a driver candidate reaches no compiled brief until an operator promotes it (an explicit `--include-candidates` sweep still sees it); `/audit` lists the candidates with their ids for that decision.

## Freshness verification — REQUIRED before acting

Every memory is a snapshot of when it was written. Code moves, files rename, decisions reverse. **Before acting on a retrieved memory, verify it against current state.** This is the single biggest gap in most agentic memory implementations.

| Memory claims | Verification step |
|---|---|
| A file exists at `path/foo.sh` | `ls path/foo.sh` |
| A function/symbol exists | `grep -r "function_name" .` |
| A flag is supported | Check `--help` or the upstream version's source |
| A version is pinned at X | Read the lockfile / image tag / pin |
| A user preference is current | If context suggests it may have changed, ask |

If verification fails: **supersede the stale memory immediately.** Don't just ignore it — the next session will hit the same trap.

```bash
# Memory was wrong — supersede atomically
vipune add 'New corrected statement' --supersedes <old-id> --memory-type fact

# Superseding is the correction — it preserves the original row. Removal is not
# yours to do: see "Memory-write boundary" below.
```

## Contradiction handling — supersede, don't duplicate

When you save a memory similar to an existing one (≥ 0.85 similarity), vipune flags a conflict. Three responses:

1. **The new is correct, the old is wrong** → `vipune add "..." --supersedes <old-id>` (atomic replacement)
2. **Both are true but address different angles** → `vipune add "..." --force` (intentional coexistence — rare)
3. **The old is fine, no new memory needed** → don't add

Default to **option 1** if the facts contradict. Never let two contradictory memories coexist — that's the leading cause of "memory rot" where agents confidently cite stale info while also citing the correction.

## Search recipes — what actually works

From vipune's own query-guide scoring data:

| Pattern | Example | Top score |
|---|---|---|
| Single technical term | `vipune search "Caddyfile"` | 0.81 |
| `[Domain] [Component]` | `vipune search "vllm extra_args"` | 0.80 |
| `[Feature] [Implementation]` | `vipune search "floating IP attach"` | 0.79 |
| `[Component] [Action] [Concept]` | `vipune search "torch.compile cache invalidation"` | 0.78–0.81 |
| `[Problem] [Technical Context]` | `vipune search "vllm startup mamba cache"` | 0.80 |
| Natural-language question | `vipune search "how do we stop the H100"` | ~0.70 (still useful) |

Hybrid mode helps short / proper-noun queries:

```bash
vipune search "MTP" --hybrid          # 1–3 word query → hybrid wins
vipune search "ConfigClass" --hybrid  # exact identifier
```

Recency-weighted for "what changed recently":

```bash
vipune search "deployment" --recency 0.7 --limit 10
```

Type-filtered for narrow recall:

```bash
vipune search "do not" --memory-type guard       # only guards
vipune search "stop" --memory-type procedure     # only validated recipes
```

Score thresholds:

These bands apply to **semantic mode only** (`--no-hybrid --recency 0.0`). A hybrid score is an RRF reciprocal — a perfect match reads 0.0769 — and a recency-blended score is not a similarity at all; neither can be read against this table.

- **0.80+** — Use the result directly
- **0.70–0.79** — Cross-check top 2–3
- **0.60–0.69** — Refine the query
- **< 0.60** — Probably nothing relevant; don't act on it

## What to ALWAYS save vs NEVER save

**ALWAYS** (long-term, `active`):

- Project conventions (build tool, package manager, lint config, CI pipeline)
- User preferences and corrections (style, format, tone, depth)
- Architectural decisions and the *reason* behind them
- Validated workflows (the exact commands that work)
- Known pitfalls + their workarounds
- Non-obvious constraints (compliance, performance, security)

**NEVER** (defeats the purpose, causes bloat or actual harm):

- **Secrets of any kind** — API tokens, passwords, SSH private keys, .env contents. Vipune stores in plaintext SQLite. **This is a hard line.** If you discover a secret in memory, **tell the operator immediately and say which memory id** so they can remove it, and treat the credential as compromised — it must be rotated. You cannot remove it yourself: removal is an operator action.
- Raw conversation turns
- One-off file paths likely to move
- Intermediate debugging hypotheses
- Ephemeral stack traces
- Anything reconstructible cheaply from `git log` or current code state

**CONDITIONAL** (use `--status candidate`, report for promotion only if it survives):

- Tentative explanations for observed behavior
- Performance numbers (they drift)
- "I think this is how X works" claims
- Process state mid-task

## Pi-ensemble specifics

**Multi-agent shared DB.** During a /work or /research cycle, the PM and every dispatched subagent (@explore, @developer, @ops, @code-review-specialist, @adversarial-developer) share the same project-scoped vipune DB. Observations stored by a subagent are immediately retrievable by PM and vice versa. Use this:

- When dispatching a subagent, tell it: *"Store key findings as `--memory-type observation` for session context."*
- When recalling subagent context, search: *`vipune search "..." --recency 0.9 --memory-type observation`*.
- Cross-session knowledge (architectural decisions, conventions, gotchas) → `--memory-type fact`/`procedure`/`guard` with `--status active`.

**Session autosave.** When `PI_ENSEMBLE_AUTOSAVE=1` is set, pi-rukas writes a deterministic session-summary memory to vipune at `session_shutdown` (dispatch counts, outcomes, elapsed, cwd). This is opt-in and best-effort — it complements but does NOT replace explicit `vipune add` calls during the session for specific decisions and findings.

**Single-quote safety — non-negotiable.** Use single quotes for `vipune add`. Double quotes execute shell substitutions and are a real RCE risk inside agent workflows:

```bash
# SAFE — single quotes prevent shell expansion
vipune add 'key finding with context and implications'

# DANGEROUS — double quotes may execute commands
vipune add "key finding $(whoami)"   # ❌ never do this
```

## Periodic consolidation — the reflection pass

Every ~10–15 sessions on a project, run:

```bash
vipune list --limit 50 --include-candidates --json | jq .
```

Look for:

- **Duplicates** (≥ 2 memories saying nearly the same thing) → supersede the older ones
- **Stale facts** (still `active` but contradicted by current code) → supersede
- **Drift** (multiple `observation`-type memories on the same theme) → consolidate into one `fact` or `procedure`, then supersede the originals
- **Candidates** that have survived 5+ sessions → report for promotion
- **Candidates** never (or barely) retrieved and old → report for pruning

The report itself is **free prose in your final reply to the operator** — PM includes it in its reply to them. There is no parser; what matters is that each row is one line with the id verbatim, and the two words name the action wanted:

```text
candidate <id> promote
candidate <id> prune
```

Report only rows you did not write in this session. Where the age and retrieval evidence comes from: `vipune list --include-candidates --json` — each row carries `retrieval_count`, `last_retrieved_at`, `created_at`, `memory_type`, `status` and `importance`. That listing is the evidence for both calls. Pass the flag: without the flag `list` shows active rows only, so the candidates you are asked to report are not in the listing. The `/audit` memory panel (`extension/src/memory-panel.ts` / `memory-stats.ts`) is the aggregate view (rows by status/type, total/max retrievals, never-retrieved count, candidate ids + types) — it has no per-row age column.

Report a candidate for pruning when it matches what the operator's `prune` command keys on: `status = 'candidate' AND retrieval_count < N AND age(created_at) > T` — candidate, never (or barely) retrieved, and old. `prune` is an operator command, and it **hard-excludes** `guard`-type rows and rows with `importance` high/critical — never propose pruning one of those, since the operator's own tool would refuse it.

When a memory is obsolete and there is **nothing to correct it to**, do not add a row: report its id for pruning (`candidate <id> prune`) — or, if it is `active`, report it for operator removal.

This is the reflection pattern from the agentic memory literature (Park et al. 2023, A-MEM 2025, MemoryBank). It prevents the bloat-driven degradation that hits unbounded memory stores around 50+ sessions.

## Failure modes to avoid

Real failure patterns documented in agentic memory systems — don't repeat them:

1. **Stale-fact citation** — Quoting a memory that no longer matches reality. *Mitigation*: freshness verification before acting (above).
2. **Contradiction accumulation** — Two memories that disagree, both surfacing in search. *Mitigation*: `--supersedes`, never `--force` unless they truly address different angles.
3. **Context bloat** — So many memories surface that the context window saturates and reasoning quality drops. *Mitigation*: report untouched rows for operator pruning, use candidate status, keep `--limit` tight.
4. **Ephemeral leakage** — Persisting raw conversation-context as memory. *Mitigation*: only save *distilled* conclusions, never raw turns.
5. **Premature commit** — Saving a hypothesis mid-debug. *Mitigation*: save only at task close, after the conclusion holds.
6. **Secret leakage** — A single token or password committed to memory is a breach. *Mitigation*: the explicit NEVER list above + report the memory id to the operator immediately + rotate the credential if found.

## Memory-write boundary

This is the full statement of the rule, and it lives here — every other mention
in this skill and in the role modules is the one-line operative rule.

**Never run `vipune update`, `delete`, `prune` or `promote`.** Those are operator
actions. Correct a memory by writing a new one with
`vipune add '<new content>' --supersedes <old-id> --memory-type <type>`, which
preserves the original row, so the change is auditable and reversible. Retire one
by reporting its id (see Periodic consolidation).

What is actually enforced, per mode — the doctrine is stricter than any single
gate, so behave as if the whole rule is live:

| Verb | Enforcement |
|---|---|
| `update` with `-t`/`--text` | Refused by code — `isDestructiveMemoryWrite` in `extension/src/bash-pattern-wildcard.ts`, reached from `matchBashSubcommand`. Enforced in strict/headless mode and on the PM's mode-independent bash guard. |
| `delete`, `prune`, `promote`, and `update` with any other flag | **No code refusal in trust mode** (the default on an interactive host and in the sandbox). Doctrine is the only gate there. |
| All four verbs | Granted to no role in `agents.json`. In trust mode that grant is doctrine, not a runtime gate. |

`update --text` replaces content in place — same id, no lineage, no undo — so
anything that cited that memory would silently point at new text. That is why it
is the one verb with a code refusal ahead of the allowlist.

## Quick reference

```bash
# SEARCH (start every task here)
vipune search '<technical term or compound>' --no-hybrid --recency 0.0 --limit 5 --no-touch --json

# SAVE (at task boundaries only)
vipune add '<distilled fact/preference/procedure/guard/observation>' \
  --memory-type <type> [--status candidate] [--supersedes <old-id>]

# LIST (for the consolidation pass)
vipune list --limit 50 --include-candidates

# SUPERSEDE (when a memory drifts) — the ONLY correction available to you.
# `--supersedes` preserves the original row, so the change is auditable and
# reversible. `--memory-type` is mandatory: vipune will not tell you the old
# row's type, and guessing wrong silently retypes it out of every typed read.
vipune add '<new content>' --supersedes <old-id> --memory-type <type>

# NOT AVAILABLE: never run `vipune update`, `delete`, `prune` or `promote` —
# operator actions. Correct with `add --supersedes <id>`. See
# "Memory-write boundary" above for what each mode actually enforces.

# VALIDATE (check before adding long content)
vipune validate '<text>'           # exits 3 if over 512-token embedding limit

# JSON OUTPUT (for scripting / consolidation passes)
vipune list --json | jq .
vipune search '<q>' --json | jq '.results[]'
```

## Project scoping

vipune auto-detects the project from the git remote. Override only when intentionally cross-cutting:

```bash
vipune search '<q>' -p some-other-project   # search outside the current project
```

Default behavior is correct ~99% of the time — don't override unless you know why.

## When to NOT use vipune

This skill is opinionated, but there are legitimate non-vipune paths:

- **One-shot session info** that won't outlast the conversation → keep in context, don't persist
- **Code-level documentation** that belongs in comments / docstrings / READMEs → put it there, not in vipune
- **User-cross-project preferences** that belong in user-wide memory → those go to the user's home-directory memory store; vipune is project-scoped
- **Anything sensitive** → no memory tool; use a real secrets manager (1Password, op, vault)

vipune is for **project-scoped, persistent, semantic-recall-worthy** knowledge. Use it for that. Don't use it as a notes file.

## Pre-flight checklist (start of any project task)

- [ ] `vipune search '<task topic>' --no-hybrid --recency 0.0` — what do we already know?
- [ ] Read top 3–5 results; verify any I plan to act on against current state
- [ ] If contradictions surface: `--supersedes` the wrong one before continuing
- [ ] Note candidate observations mentally; save after task closes

## Closing checklist (end of any task)

- [ ] What did we learn that wasn't in vipune already?
- [ ] What did the user correct me on?
- [ ] What workflow worked that's worth recording?
- [ ] What gotcha did we hit that the next session should avoid?
- [ ] Save each as `vipune add ... --memory-type <type>`, with `--status candidate` if uncertain
- [ ] One atomic fact per `vipune add` call. Don't dump whole reports — distil first.

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
