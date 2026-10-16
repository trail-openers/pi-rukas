# Specialist Agent Surface — Baseline

**Status**: Active baseline for the agent-surface program (#1075, #1076, #1077, #1078).
**Enforcement status**: the three canaries below are **PLANNED — none exists yet**, so every count
in this document is an unenforced assertion today. Section "The three canaries" states each
contract; section "What pins this today" states what actually runs.

## Why this exists

An agent is reliable only while its prompt and its runtime describe the same toolbox. When the
prompt claims a capability the runtime denies, the agent burns a dispatch discovering it: a
lens-fix developer was told to run `bunx tsc --noEmit` and could not — its bash map grants the
subcommand-scoped `bun test*` / `bun run <script>*` / `bun install*` forms (`bun install` and
`bun run build` ARE allowed), and carries no `bunx` or `node` pattern at all, so the bare-binary
form is a promise the runtime will not keep. When the runtime grants more
than the prompt knows about, the drift is invisible: `mcp__codebase_memory__*` and `codemode`
reach a child's roster without ever passing through the role's `permission` map, so nobody reading
`agents.json` can see what the role actually holds. This document is the shared baseline both
sides are measured against — the roster, the bash map, the model, and the working directory each
role actually gets. Keeping that claim from drifting is the job of the canaries below, which do
not exist yet: today the claim is maintained by nobody but this file and the
`mcpCount === 14` assertion in `test-codemode-activation.ts` — and that assertion is a tautology
(see "What pins this today"), so the honest count of mechanical checks pinning this baseline is
**zero**.

## Scope: the shipped surface, not the effective verdict

This baseline pins the **shipped** surface — what `agents.json`, `extension/src/role-tools.ts`,
and the child argv in `spawn-support.ts` put on disk in this repository. It does **not** pin the
verdict a call receives at runtime, and the two are not the same thing.

Verdicts are computed by `resolveToolPermission()` (`extension/src/permission-guard.ts`) from
three overlays, first match wins:

1. `$PWD/.pi/permissions.json` — per-project operator state
2. `~/.pi/agent/permissions.json` — per-host operator state
3. `agents.json` — the shipped map this document describes

Layers 1 and 2 are operator state that lives outside this repository and are **out of scope
here**: an operator can widen or narrow any verdict without touching this repo, and no count in
this document can see it. Inside a subagent the same three layers are consulted by
`resolveToolPermission()` via `permission-subagent-guard.ts`. And in trust mode — the default on
an interactive host and in the sandbox — the `tool_call` handler in `permission-guard.ts` returns
before any lookup at all (the `isInTrustMode` early return), so the whole overlay stack is inert.

Consequence: on the **verdict** side, `--exclude-tools` (`excludeToolsFor()` in
`extension/src/role-tools.ts`) is the only fence an operator overlay cannot override — the overlay
layers never remove a tool from the active set, they only answer "is this call allowed?".

Ahead of those verdict layers sit the **mode-independent guards**, registered before every
trust/sandbox short-circuit, so no overlay and no trust level disables them. There are three, and
the claim "`--exclude-tools` is the only thing running ahead of trust mode" is false:

| Guard | Registered by | Decides | Operator escape hatch |
|---|---|---|---|
| destructive-git | `registerDestructiveGitGuard()` (`extension/src/permission-subagent-guard.ts`) | may anything destroy work the harness has not captured? | `PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT=1` |
| issue-creation | `registerIssueCreationGuard()` (`extension/src/issue-creation-guard.ts`) | may a subagent open a ticket itself instead of reporting to PM? | `PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE=1` |
| merge (#912) | `registerMergeGuard()` (`extension/src/merge-guard.ts`) | may a PR merge without a passing review ledger? | `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1` |

All three run in one block — `registerModeIndependentGuards()`
(`extension/src/subagent-guard-guards.ts`) — called both by `registerSubagentGuard()` (strict /
headless children, before its `PI_ENSEMBLE_SANDBOX_MODE` / `PI_ENSEMBLE_TRUST_MODE` returns) and
by the trust-mode companion `extension/src/child-guards.ts`, so a trust-mode child is guarded too.
What distinguishes `--exclude-tools` from these three is narrower and is the true claim: **each of
the guards has an operator env-var opt-out; `--exclude-tools` has none.** There is no
`PI_ENSEMBLE_ALLOW_EXCLUDED_TOOLS` — `excludeToolsFor()` reads only the checked-in
`ROLE_TOOL_EXCLUDES` map.

## Authoritative sources

Each fact has exactly one deciding location. Everything else in the repo is a projection of it.

| Fact | Decided by | Notes |
|---|---|---|
| Declared tool grants + bash allowlist | `agents.json` → `agent.<role>.permission` | Per-role map. `bash` is **object-valued** (a nested subcommand allowlist consulted only on the bash-with-command path); every other key is a string verdict `allow`/`ask`/`deny`; `task` is object-valued for developer / adversarial-developer / project-manager. A top-level `"*": "ask"` catch-all exists for **project-manager only** — the five child roles declare no `"*"` at `permission` level; their catch-all lives at `permission.bash["*"] = "ask"`, which is a different map. A role absent from a config layer contributes nothing at that layer — `checkConfig()` returns null when `config[role]?.permission` is missing — and a miss on *all* layers yields `ask` from the single terminal default, not per layer. **There is no inheritance from another role's map, and there is no `tools` key anywhere in `agents.json` or in the resolver.** See "How a role's verdict is resolved" below. |
| Structural tool removal | `extension/src/role-tools.ts` — `ROLE_TOOL_EXCLUDES`, `excludeToolsFor()`, `excludeToolListFor()` | The only fence that binds MCP and codemode tools, and the only one an operator overlay cannot widen. |
| Child argv (builtins, MCP, codemode) | `extension/src/spawn-support.ts` — `childArgsBase()`, and the `--exclude-tools` push in `spawnChildArgs()` where `excludeToolsFor(role)` is read | `--mode rpc --no-extensions -e builtin:mcp`, plus `-e builtin:codemode` unless `PI_ENSEMBLE_CHILD_CODEMODE=0`. |
| MCP roster a child actually sees | the installed `codebase-memory-mcp` binary's own tool surface — **outside this repository** | `install.sh`'s `mcpServers.codebase_memory` block (`install.sh:273`) writes only `{command, args: [], exposure: "direct"}` — **no tool list at all** — so nothing in this repo names the roster: it is whatever the installed server exposes, admitted unfiltered because the block sets `exposure: "direct"` with no allowlist key. It is also an **installation-time** fact: the block is written only inside `if [ -n "$CBM_BIN" ]`, so on a host without the binary on `PATH` (or in `~/.local/bin/`) there is no `codebase_memory` entry and no roster. `extension/smoke-tests/test-codemode-activation.ts` — `BASE_ROSTER` — is a **test fixture** that stands in for that surface so the activation paths can be exercised offline; nothing pins it to the server's real tool list, and it must not be cited as the deciding location. |
| Working directory | `extension/src/spawn.ts` — `const cwd = spec.cwd ?? process.cwd()` | Absent `cwd` silently means the Pi process directory, not the worktree. |
| Model | `extension/src/models.ts` — `resolveModel(spec.role, spec.model)` (called from `spawnSpecialistInner()` in `spawn.ts`) | Precedence: spec → config → `PI_ENSEMBLE_MODEL_<ROLE>` → `PI_ENSEMBLE_SUBAGENT_MODEL` → Pi default. `agents.json` holds no model config. |
| Lens / lens-fix tree | `extension/src/work-driver-lens-fix.ts` — `lensWorktree()` | Review and fix must name the SAME tree; `worktrees.default` first, `repoRoot` fallback. |

## Declared surface per role

Counts are read from `agents.json` with `jq`, from `extension/src/role-tools.ts`
(`--exclude-tools`), and the undeclared column names the `mcp__codebase_memory__*` tools no role's
`permission` map mentions — derived from the surface `install.sh`'s written `mcp.json` block lets
through (`exposure: "direct"`, no allowlist), **not** from the `BASE_ROSTER` fixture. MCP and
codemode additions arrive without ever passing through the map — the map is a verdict layer, not a
roster filter (and there is **no `tools` key** in `agents.json` for them to pass through) — so they
are listed separately rather than folded into the declared columns.

**Counting convention** (a future canary is written against these numbers, so the convention is
stated next to them rather than implied): each role's `permission` map is partitioned by verdict,
with the object-valued `bash` sub-map **excluded** from every count below (it is counted separately
in its own column), and a `"*"` key counted only where the role declares it at `permission` level
— which is `project-manager` alone. `allow` / `ask` / `deny` count string-valued keys only;
object-valued non-`bash` keys (`task` for developer, adversarial-developer and project-manager)
are counted in their own `obj` column. So `MCP + allow + ask + deny + obj = Object.keys(permission) − 1`
exactly, with nothing dropped. `Bash patterns` counts every key of `permission.bash`, the `"*"`
catch-all included (the five child roles' `bash["*"] = "ask"` and PM's too); subtract 1 per role
for the excluding convention.

| Role | MCP keys (all `allow`) | non-MCP `allow` | `ask` | `deny` | obj | `"*"` at `permission`? | Bash patterns | `--exclude-tools` |
|---|---|---|---|---|---|---|---|---|
| developer | 7 | 11 | 1 | 2 | 1 | no | 207 | — (none) |
| ops | 3 | 5 | 1 | 11 | 0 | no | 208 | — (none) |
| adversarial-developer | 7 | 4 | 1 | 6 | 1 | no | 75 | `write,edit,multiedit` |
| code-review-specialist | 7 | 7 | 1 | 4 | 0 | no | 78 | `write,edit,multiedit` |
| explore | 7 | 7 | 1 | 4 | 0 | no | 105 | `write,edit,multiedit` |
| project-manager | 8 | 24 | 2 | 6 | 1 | **yes** (`"*": "ask"`) | 114 | — (parent is never gated) |

What the partitioned columns hide, spelled out: the single `ask` on every child role is
`external_directory: ask`, declared identically in all six maps. `deny` is `hashline_read` /
`hashline_edit` on developer; `edit`/`write`/`webfetch` + `list_tasks`/`check_task`/`cancel_task`
on adversarial-developer; `edit`/`write`/`multiedit`/`task` on code-review-specialist and explore;
`edit`/`write`/`multiedit`/`webfetch`/`task` + 6 `parallel-*` on ops; and `write`/`edit`/
`webfetch`/`websearch` + 2 `parallel-*` on project-manager. The `obj` column is `task:
{"*": "deny"}` for developer and adversarial-developer, and PM's `task` map (catch-all deny with
five role grants).

The MCP keys named per role: developer / adversarial-developer / code-review-specialist / explore
all name the same seven (`search_code`, `search_graph`, `trace_path`, `detect_changes`,
`get_code_snippet`, `get_architecture`, `query_graph`); ops names only `search_code`,
`get_code_snippet`, `get_architecture`; project-manager names those seven **plus**
`index_repository` — the one explicit grant of it, at
`agent["project-manager"].permission["mcp__codebase_memory__index_repository"]`. Note that the
per-role undeclared set is NOT this table's business: arrival is unconditional, so the same 14
reach every child regardless of which of them the map names (see the paragraph below the roster).

The 14 names below are the MCP tools whose arrival this baseline tracks. **This list is prose,
not a constant**: nothing pins it to the server's real surface, and canary 3 must derive it from
what the installed server exposes (the `install.sh` block only proves the surface arrives
unfiltered — see the Authoritative-sources row above) rather than restating it.

`search_code`, `trace_path`, `detect_changes`, `get_architecture`, `get_code_snippet`,
`query_graph`, `search_graph`, `index_repository`, `list_projects`, `delete_project`,
`index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr`.

This grouping — 14 names — is **this document's own accounting, not a citation**. `docs/mcp.md`,
`README.md` and `docs/troubleshooting.md` each describe a **seven**-tool direct surface
(`search_code`, `search_graph`, `trace_path`, `detect_changes`, `get_code_snippet`,
`get_architecture`, `query_graph`) plus separately-named admin tools; none of them contains this
14-name list, so this document does not cite them for it. The two are counting different things:
the seven are what those files call *direct*, and the further seven (`index_repository`,
`list_projects`, `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`,
`manage_adr`) are what this baseline adds to the tracked set because they reach the same child
roster by the same unfiltered `exposure: "direct"` path. Correcting those four files to carry the
14-roster is deliberately **out of scope** for this PR (they are cited, never changed).

The `BASE_ROSTER` fixture adds `bash`/`read`/`edit`/`write` to those 14 — the four core tools a
child carries; `--exclude-tools write,edit,multiedit` is what structurally removes two of them
from the three reader roles. `codemode` is not in the fixture: `childArgsBase()` passes
`-e builtin:codemode` and `enableChildCodemode()` **appends** it to the active set on
`session_start` (the activation test asserts `length === BASE_ROSTER.length + 1` with `codemode`
last) — which is also why `agents.json` carries `codemode: allow` for five of the six roles but no
`codemode` key at all for project-manager (`agents.json` has five `codemode` entries, not six).
**What codemode can reach is the surviving active tool set, not the `permission` map.** Pi's
`executeCodemode` builds its `sandboxTools` from `getCodemodeCallableTools(ctx.tools)` — the tools
still in the session registry, i.e. `getActiveTools()` minus `--exclude-tools` — and routes calls
through the same `executeTool` + `tool_call` hooks as a direct call. So `--exclude-tools` DOES bind
`write`/`edit`/`multiedit` behind the codemode path (live canary
`test-codemode-reviewer-rejection.ts`, run on every Pi bump per AGENTS.md §4: its exclusion arm
asserts write/edit/multiedit stay absent from the roster **and** from `sandboxTools`, and its
positive control arm proves the same script's `tools.write` succeeds without the exclusion — so a
revocation of that fence fails the test, not a silent pass). What the role *keeps* is reachable too:
`bash` is active for those children and the same arm fails the test if a reviewer invokes it, which
is an explicit acknowledgement that a reader role holds a real write/egress path (`git remote
set-url`, `git worktree add`, forge verbs) that no `permission` entry gates — in trust mode (the
default) the call never consults the map, so `codemode: allow` records neither a grant nor a limit.
`delete_project` — destructive, and never granted to any role in `agents.json` — is the
undeclared name an earlier note had guessed as `get_file_outline`; the roster refutes that.
**`get_file_outline` is not in the roster.**

For a child, every name its `permission` map omits resolves the same way — there is no per-role
catch-all to fall back to, because five of the six maps declare none — so the difference between
`ops` (which names 3 MCP tools) and `developer` (which names 7) is a difference in the verdict a
strict-mode parent would give, never in which tools sit on the roster. Being absent from the
`permission` map is not the point, and is not the same as being unavailable. **Arrival is unconditional; usability is mode-dependent.** All 14
`mcp__codebase_memory__*` tools reach every child's roster in every permission state, because the
only fence that removes a tool from the roster is `--exclude-tools`
(`extension/src/role-tools.ts` — `excludeToolsFor()`), and that fence currently names only
`write`/`edit`/`multiedit` — no role excludes any MCP tool, so all 14 reach every child that
`spawn.ts` starts. Whether arrival equals usability depends on the guard state:
`permission` is a verdict layer, not a roster filter. Trust mode — the default for interactive host
and sandbox — returns from the `tool_call` handler before any lookup
(`isInTrustMode` early return in `extension/src/permission-guard.ts`), so an arriving MCP tool is
usable; strict mode falls through to `resolveToolPermission()` (reached from
`extension/src/permission-subagent-guard.ts` in a child), where an unmapped name resolves to the
`"ask"` terminal default and escalates to the parent; headless has no human to consent, so the same
`"ask"` is denied.

**How a role's verdict is resolved** (`resolveToolPermission()`): the lookup takes the fixed role
string the child was spawned with and reads `config[role]?.permission`. If that key is absent, the
layer contributes **nothing** (`checkConfig()` returns null) and resolution falls to the next layer.
Within a layer, exact tool-name match wins, then a `prefix*` wildcard (longest pattern first), then
that role's own `"*"` catch-all — **and only `project-manager` declares one**
(`permission["*"] = "ask"`). The five child roles have no `"*"` key at `permission` level at all;
their `"*": "ask"` sits inside the *separate* `permission.bash` sub-map and is consulted only on the
bash-with-command path (`matchBashSubcommand`), never as a tool-level catch-all. So "a role that has
no `"*"` entry yields null from the lookup" is not a hypothetical here — it is the **actual shipped
shape for five of the six roles**: for `explore`, say, a tool name its map does not mention falls
through all three layers to `resolveToolPermission()`'s single terminal `return "ask"` (prompt in
strict, deny in headless). The `"ask"` is produced once, at the end, by that terminal default — it
is not a per-layer verdict, and a Layer-3 miss is not itself an `ask`. **There is no inheritance
from another role's map**: `developer` never picks up a verdict declared for `project-manager`, and
an absent role is not "denied" — it simply falls through.

Two consequences worth stating plainly: on the structural side `--exclude-tools` is the *only*
fence (the three mode-independent guards above gate *actions*, not tool rosters), and the
bash allowlists are where the real capability boundaries sit. **`code-review-specialist` and
`explore` have zero build-tool patterns** — any prompt that tells either of them to "run the
build" is a lie. `adversarial-developer` is not zero, but it holds only read-only analysis
patterns — all seven of these are verified present in
`agent["adversarial-developer"].permission.bash` (`cargo check*`, `cargo clippy*`,
`npx tsc --noEmit*`, `ruff check*`, `go vet*`, `golangci-lint*`, `shellcheck*`) and no test runner
or build command at all — `jq` over that sub-map finds not one `pytest*`, `jest*`, `bun test*`,
`cargo test*`, `npm test*`, `go test*` or `*build*` pattern in it. So the conclusion
applies to all three: **never tell one of these roles to "run the build" or "run the tests"
without naming a form its map actually grants** — for adversarial that means one of the analysis
commands above, and for the other two it means the dispatch is asking for something nobody can
run, which is `GATE NOT RUNNABLE` territory. Note that `npx tsc --noEmit*` makes adversarial the
one role able to type-check directly — a role without that grant (developer, for instance) has to
go through a granted wrapper such as `bun run typecheck`.

## What pins this today

**Zero mechanical checks pin this baseline.** There is one assertion that *looks* like one, and it
is a tautology: `extension/smoke-tests/test-codemode-activation.ts` computes
`mcpCount = (call ?? []).filter(t => t.startsWith("mcp__codebase_memory__")).length` **from
`BASE_ROSTER` itself** and compares it to the literal `14`. The same literal both builds the
fixture and grades it, so the assertion cannot fail while the fixture exists — it pins the fixture
to a number, not the roster to the server. In this document's own vocabulary: it asserts a
constant against itself, which is exactly the "a gate never observed to fail is worthless" shape
the canaries below exist to retire.

Nothing else in `extension/smoke-tests/` reads `agents.json`'s surface, compares a role prompt's
claims to the runtime roster, or resolves a role's model. Until the canaries below land, a prompt
that contradicts `agents.json` passes CI.

## Doctrine single-source rule

**Each doctrine statement exists in exactly one source file. Role prompts may reference a
statement, never restate it.** The assembled prompt is the concatenation of `agents-base/<role>.md`
and the modules listed in `manifests/<role>.manifest`; a sentence written in two of those files
reaches the model twice, and once the copies diverge the model is handed a contradiction about its
own rules. AGENTS.md §11 forbids the duplication; §7 names the adversarial-gate verdict vocabulary
as the defect class this rule exists to prevent.

Two statements are consolidated as follows:

1. > "Hand-managed work gets the same gates as /work: development managed outside the driver (a
   > hand-dispatched developer, /do, free-form requests) must still pass adversarial_loop AND the
   > full six-pass lens review (dispatch_lens_review), with CRITICAL/HIGH findings fixed, before
   > PR/CI/merge via @ops — a developer's self-report plus CI is NOT a pass."

   Lives in `agents-base/project-manager.md` (the prose paragraph that closes the "Gate Details"
   table — the table itself lists the six workflow gates; this sentence is the load-bearing copy
   that extends them to hand-managed work) only. It is a PM orchestration rule — PM owns
   `adversarial_loop` and `dispatch_lens_review` — and the
   developer copy belongs in neither `agents-base/developer.md` nor
   `modules/workflows/quality-gates.md`, since the developer is explicitly told elsewhere that the
   gate is not its responsibility.

2. The merge-policy statement — "If all project quality gates have been met (code reviews, CI,
   linters, type checks etc) LLMs / agents are allowed to squash merge PRs (GitLab: MRs)."

   Lives in `AGENTS.md` §9 ("LLMs are allowed to squash merge PRs/MRs") only, and stays there.
   The `/work` driver reads that section at the cycle's `baseSha` as the merge grant, so a copy in
   a role prompt is both a drift risk and a second, non-load-bearing authority for an irreversible
   action. Role prompts refer to the project's `AGENTS.md`; they do not paraphrase it.

## The three canaries

**Status: PLANNED — none of the three exist yet.** `extension/smoke-tests/` contains none of the
files below (and no `test-role-models.ts` at all), so every count named in this document is
currently an *unenforced assertion* — correct
today, silently rotting tomorrow. The contracts are written here first so the tests have a spec to
be written against; treat them as the intended offline pre-push / CI loop (AGENTS.md §1), not as
gates that run today. They follow the shape of `test-pm-tool-permissions.ts`: read the checked-in
configuration, assert a stated premise first so a changed premise fails loudly rather than silently,
and name the exact offending entries in the failure message. Where a contract below names a number
in this document, the test derives it from `agents.json` at runtime rather than restating it — and
the same rule binds **this document**: the counts in §Declared surface per role are prose, not
enforced, so a count that no test derives is a liability this section exists to retire. Each canary
must also assert against the code that decides its fact (a `src/` export, or `install.sh`'s written
`mcp.json` block), never against a constant copied from another test file — otherwise the assertion
is a tautology and "stays undeclared" proves nothing.

### Canary 1 — `test-role-surface.ts`

**Contract:** every role's *effective* roster — declared `permission` grants, plus the undeclared
MCP/codemode additions, minus `excludeToolListFor(role)` — equals the roster its role prompt
declares.

**Prevents:** the #1076 class — a developer dispatched to run a gate binary its allowlist has no
pattern for (`bunx tsc --noEmit`), or told a tool is unavailable when it is present. A prompt
that says "run the project's type check" is a contract with the runtime, and this is the test that
can check it. It is also the natural home for the two conventions this document states by hand: the
`bash`-sub-map / `"*"` counting rule under §Declared surface per role, and the per-role verdict
shape (PM's `permission["*"]` versus the five children's `permission.bash["*"]`) — both derived
from `agents.json` at runtime, so a change to either fails a test rather than quietly invalidating
a table.

### Canary 2 — `test-role-models.ts`

**Contract:** every role in `agents.json` resolves through `resolveModel(role)` to a non-empty
`model` string, and each resolution still returns a non-empty model under a
`PI_ENSEMBLE_MODEL_<ROLE>` override and under `PI_ENSEMBLE_SUBAGENT_MODEL`.

**Prevents:** the silent-empty-model class. `resolveModel` bottoms out at source `"default"`, where
`model` is `undefined` and the child falls back to whatever Pi has configured — which is correct
behaviour but invisible in a dispatch report, so a typo'd config key reads as a working role.

### Canary 3 — `test-agents-json-schema.ts`

**Contract:** `agents.json` parses and validates against a declared schema; every key in `agent` is
a known role; every key in a role's `permission.bash` is a known subcommand shape; no role has an
empty `permission` map. The roster itself is **not assertable in-repo** — `install.sh:273` writes
`{command, args: [], exposure: "direct"}` with **no tool list**, so the names are decided by the
installed `codebase-memory-mcp` binary outside this repository. What IS decidable in-repo, and what
the test asserts instead, is the two properties that make the surface unfiltered: that the written
`mcpServers.codebase_memory` block has `exposure === "direct"` and that it carries **no allowlist
key** (no `tools` / `allowedTools` / `includeTools` member). The test then asserts the *undeclared*
set stays undeclared — that no `mcp__codebase_memory__*` name and no `codemode` entry is added to a
role's `permission` map on the strength of the roster having arrived — and that the block is still
written only under `if [ -n "$CBM_BIN" ]`, i.e. that nobody has quietly turned an installation-time
fact into a claimed constant. Nothing is copied from `BASE_ROSTER`, which is a test fixture for the
activation paths and has no relationship to the server's real tool list.

**Prevents:** silent surface widening. A new MCP server joining the child roster, or a role key
renamed to something `spawn.ts` never matches, fails this gate instead of quietly enlarging what a
role can call. This is also where the non-mirroring decision below is enforced.

## Explicit non-goals

- **No `agents.json` mirror of the MCP grants.** Arrival bypasses the `permission` map — the map
  cannot remove what it never admitted — so adding the tools the roster
  carries and no role map names (the six no-role-anywhere tools above: `list_projects`,
  `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr`) buys no
  enforcement and creates a fifth place to keep the roster current.
  The one role prompt that names them at all is `agents-base/developer.md`, which names six of
  them in a prohibition ("never call `delete_project`, `index_repository`, `index_status`,
  `list_projects`, `compare_graphs`, or `manage_adr`"); the other five roles carry no such line.
  Extending that to the remaining five role prompts is #1421/#1422 follow-up work, not a claim
  this baseline can make today. Pin them with canary 3. `permission` stays as it is today.
- **No new `PI_ENSEMBLE_*` knobs** unless an existing one is demonstrably broken. Each knob is a
  second path that has to be tested and cannot be deleted without breaking someone who set it.
- **No per-role tool filtering in `spawn.ts`.** Filtering belongs in `role-tools.ts`, which is the
  single exclude-map both `spawn-support.ts` and the canaries read. Adding a second filter in the
  spawn path means canary 1 verifies one of them.

## Working-tree discipline for subagents

`discardsUncommittedWork()` (`extension/src/bash-command-parser.ts`) is the runtime fence, wired
through `registerDestructiveGitGuard()` (`extension/src/permission-subagent-guard.ts`), which runs
**ahead of** the trust-mode early return — so unlike every verdict above, an operator overlay
cannot widen it (escape hatch: `PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT=1`).

**Blocked by that guard:** `git reset --hard` / `--merge` / `--keep`, `git checkout --` / `-f` /
`--force` / `.`, `git restore <path>` (anything other than `--staged` alone), and `git clean` with
`-f` / `--force`. Quoted segments are stripped before the scan, so a command that merely mentions
one inside a message is not blocked.

**Not blocked — the guard deliberately leaves these alone:** bare `git stash` (recoverable via
`git stash list`), bare `git reset` (index only), and `git restore --staged` (unstages, loses
nothing). Nobody stops you, **but don't run them in a driver-assigned worktree anyway**: the
driver integrates from that tree — `integrate()` cherry-picks *committed* work and, on the patch
fallback, builds its patch from `git diff --cached`, so unstaging or shelving your work changes
what lands on the branch. Prefer `git status` / `git diff` to inspect, `git revert` to undo a
commit, and if the tree looks wrong, report it rather than repairing it.

**Known contradiction, recorded not fixed:** the destructive-git guard's own refusal text
(`extension/src/permission-subagent-guard.ts`, the `discardsUncommittedWork` branch) recommends
"move work aside with `git stash push`" — which is precisely the shape this section warns against
in a driver-assigned worktree. The two are not actually in conflict (the guard's advice is aimed at
a refused `git reset --hard`, where stashing is strictly better than destroying; this section is
aimed at the driver's integration path) but an agent that reads both gets two recommendations for
one situation. Changing that refusal string is out of scope here — it lives under `extension/src/`
and is asserted verbatim elsewhere — so it is noted as a #1421/#1422 follow-up rather than fixed.

## Follow-ups recorded (structural items deliberately not taken this round)

- **Lift `withEnv` / `withEnvAsync` into `extension/smoke-tests/lib/`.** Deferred: it touches the
  other caps suites in the same change, and the duplication is two copies of a 15-line helper whose
  behaviour both files already pin.
- **Widen the timing margins in `test-dispatch-caps-timing.ts`.** Deferred: the 500 ms poll against
  400/600 ms grace windows passes reproducibly today, and widening them trades a fast suite for a
  slow one without removing the race — the vacuity guard added in the H1 block is the fix that
  matters, because it makes a non-firing cap visible instead of merely passing.
- **`let session` definite-assignment in the H2 / spawn#6 blocks.** Deferred: TypeScript accepts the
  current shape, and `strictNullChecks` would want a refactor of both blocks for no behavioural gain.
