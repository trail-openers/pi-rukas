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
reach a child's roster without passing the `tools` gate, so nobody reading `agents.json` can see
what the role actually holds. This document is the shared baseline both sides are measured
against — the roster, the bash map, the model, and the working directory each role actually gets.
Keeping that claim from drifting is the job of the canaries below, which do not exist yet: today
the claim is maintained by nobody but this file and the `mcpCount === 14` assertion in
`test-codemode-activation.ts`.

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

Consequence: **`--exclude-tools` (`excludeToolsFor()` in `extension/src/role-tools.ts`) is the only
fence in the surface that an operator overlay cannot override.** Everything else on the verdict
side is overridable by state this document does not see; the only other guard that runs ahead of
trust mode is `registerDestructiveGitGuard()` (see below).

## Authoritative sources

Each fact has exactly one deciding location. Everything else in the repo is a projection of it.

| Fact | Decided by | Notes |
|---|---|---|
| Declared tool grants + bash allowlist | `agents.json` → `agent.<role>.permission` | Per-role map; `"*": "ask"` is the catch-all each role declares for itself. A role absent from a config layer contributes nothing at that layer — `checkConfig()` returns null when `config[role]?.permission` is missing, and a Layer-3 miss yields `ask`. **There is no inheritance from another role's map.** See "How a role's verdict is resolved" below. |
| Structural tool removal | `extension/src/role-tools.ts` — `ROLE_TOOL_EXCLUDES`, `excludeToolsFor()`, `excludeToolListFor()` | The only fence that binds MCP and codemode tools, and the only one an operator overlay cannot widen. |
| Child argv (builtins, MCP, codemode) | `extension/src/spawn-support.ts` — `childArgsBase()`, and the `--exclude-tools` push in `spawnChildArgs()` where `excludeToolsFor(role)` is read | `--mode rpc --no-extensions -e builtin:mcp`, plus `-e builtin:codemode` unless `PI_ENSEMBLE_CHILD_CODEMODE=0`. |
| MCP roster a child actually sees | `install.sh` — the `mcpServers.codebase_memory` block it writes to `~/.pi/agent/mcp.json` | Written with `exposure: "direct"` and **no tool allowlist**, so the whole server surface arrives: the roster is whatever the installed server exposes, not a projection of `agents.json` and not a list anyone maintains in this repo. `extension/smoke-tests/test-codemode-activation.ts` — `BASE_ROSTER` — is a **test fixture** that stands in for that surface so the activation paths can be exercised offline; nothing pins it to the server's real tool list, and it must not be cited as the deciding location. |
| Working directory | `extension/src/spawn.ts` — `const cwd = spec.cwd ?? process.cwd()` | Absent `cwd` silently means the Pi process directory, not the worktree. |
| Model | `extension/src/models.ts` — `resolveModel(spec.role, spec.model)` (called from `spawnSpecialistInner()` in `spawn.ts`) | Precedence: spec → config → `PI_ENSEMBLE_MODEL_<ROLE>` → `PI_ENSEMBLE_SUBAGENT_MODEL` → Pi default. `agents.json` holds no model config. |
| Lens / lens-fix tree | `extension/src/work-driver-lens-fix.ts` — `lensWorktree()` | Review and fix must name the SAME tree; `worktrees.default` first, `repoRoot` fallback. |

## Declared surface per role

Counts below are read from `agents.json` (bash = pattern count in `permission.bash`, allow and
deny together; "MCP in map" = keys starting `mcp__codebase_memory__`, all of them `allow`), from
`extension/src/role-tools.ts` (`--exclude-tools`), and the undeclared column names the
`mcp__codebase_memory__*` tools that no role's `permission` map mentions — derived from the set
`install.sh`'s written `mcp.json` block lets through, **not** from the `BASE_ROSTER` fixture. MCP
and codemode additions arrive without ever passing through the map's `tools` entries — the map is a
verdict layer, not a roster filter — so they are listed separately rather than folded into the
declared column.

| Role | Declared tool grants | Undeclared MCP / codemode additions | `--exclude-tools` | Bash patterns | Declared in |
|---|---|---|---|---|---|
| developer | 22 keys in map — 7 MCP + 11 non-MCP `allow` (`codemode`, `read`/`edit`/`write`/`multiedit`, `rg`/`list`/`skill`/`todowrite`/`question`/`webfetch`) + `external_directory: ask`, `task: {"*": deny}`, 2 hashline denials | 7: `index_repository`, `list_projects`, `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr` | — (none) | 207 | `agents-base/developer.md` + `modules/core/codebase-memory-mcp.md` |
| ops | 20 keys — 3 MCP (`search_code`, `get_code_snippet`, `get_architecture`) + 5 non-MCP `allow` (`codemode`, `read`/`rg`/`list`/`todowrite`), `edit`/`write`/`multiedit`/`webfetch`/`task` deny, 6 `parallel-*` denials | 11: the developer 7 **plus** `search_graph`, `trace_path`, `detect_changes`, `query_graph` — ops' map names only the 3 above | — (none) | 208 | `agents-base/ops.md` |
| adversarial-developer | 19 keys — 7 MCP + 4 non-MCP `allow` (`codemode`, `read`/`rg`/`list`), `edit`/`write`/`webfetch`/3 `*_task` deny, `task: {"*": deny}` | 7: same as developer | `write,edit,multiedit` | 75 | `agents-base/adversarial-developer.md` |
| code-review-specialist | 19 keys — 7 MCP + 7 non-MCP `allow` (`codemode`, `read`/`rg`/`list`/`skill`/`todowrite`/`webfetch`), `edit`/`write`/`multiedit`/`task` deny | 7: same as developer | `write,edit,multiedit` | 78 | `agents-base/code-review-specialist.md` |
| explore | 19 keys — 7 MCP + 7 non-MCP `allow` (`codemode`, `read`/`rg`/`list`/`skill`/`todowrite`/`webfetch`), `edit`/`write`/`multiedit`/`task` deny | 7: same as developer | `write,edit,multiedit` | 105 | `agents-base/explore.md` |
| project-manager | 41 keys — 8 MCP (`index_repository` included — the one explicit grant of it, `agent["project-manager"].permission["mcp__codebase_memory__index_repository"]`) + 24 non-MCP `allow`, `write`/`edit`/`webfetch`/`websearch` deny | 6: `list_projects`, `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr` | — (parent is never gated) | 114 | `agents-base/project-manager.md` |

The 14 names below are the MCP tools whose arrival this baseline tracks. **This list is prose,
not a constant**: nothing pins it to the server's real surface, and canary 3 must derive it from
the `mcpServers.codebase_memory` block `install.sh` writes (i.e. from what the installed server
exposes) rather than restating it.

`search_code`, `trace_path`, `detect_changes`, `get_architecture`, `get_code_snippet`,
`query_graph`, `search_graph`, `index_repository`, `list_projects`, `delete_project`,
`index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr`.

`docs/mcp.md` groups the first seven as the read-side tools and names the last three
(`index_repository`, `delete_project`, `manage_adr`) as the admin tools.

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

The leaked set is the same for every child role except ops, which loses four more read-side tools
its map never names. Being absent from the `permission` map is not the point, and is not the same
as being unavailable. **Arrival is unconditional; usability is mode-dependent.** All 14
`mcp__codebase_memory__*` tools reach every child's roster in every permission state, because the
only fence that removes a tool from the roster is `--exclude-tools`
(`extension/src/role-tools.ts` — `excludeToolsFor()`), and that fence currently names only
`write`/`edit`/`multiedit` — no role excludes any MCP tool, so all 14 reach every child that
`spawn.ts` starts. Whether arrival equals usability depends on the guard state:
`permission` is a verdict layer, not a roster filter. Trust mode — the default for interactive host
and sandbox — returns from the `tool_call` handler before any lookup
(`isInTrustMode` early return in `extension/src/permission-guard.ts`), so an arriving MCP tool is
usable; strict mode falls through to `resolveToolPermission()` (reached from
`extension/src/permission-subagent-guard.ts` in a child), whose Layer-3 miss yields `ask` and
escalates to the parent; headless has no human to consent, so the same `ask` is denied.

**How a role's verdict is resolved** (`resolveToolPermission()`, per layer): the lookup takes the
fixed role string the child was spawned with and reads `config[role]?.permission`. If that key is
absent, the layer contributes **nothing** (`checkConfig()` returns null) and resolution falls to
the next layer. Within a layer, exact tool-name match wins, then a `prefix*` wildcard (longest
pattern first), then that role's own `"*"` catch-all — which every role in `agents.json` declares
(`"*": "ask"` for project-manager; the child roles declare it through their bash/tool defaults).
A role that has no `"*"` entry yields null from the lookup. A miss on all three layers yields
`"ask"` (prompt in strict, deny in headless). **There is no inheritance from another role's map**:
`developer` never picks up a verdict declared for `project-manager`, and an absent role is not
"denied" — it simply falls through.

Two consequences worth stating plainly: `--exclude-tools` is the *only* structural fence, and the
bash allowlists are where the real capability boundaries sit. **`code-review-specialist` and
`explore` have zero build-tool patterns** — any prompt that tells either of them to "run the
build" is a lie. `adversarial-developer` is not zero, but it holds only read-only analysis
patterns (`cargo check*`, `cargo clippy*`, `npx tsc --noEmit*`, `ruff check*`, `go vet*`,
`golangci-lint*`, `shellcheck*`) and no test runner or build command at all. So the conclusion
applies to all three: **never tell one of these roles to "run the build" or "run the tests"
without naming a form its map actually grants** — for adversarial that means one of the analysis
commands above, and for the other two it means the dispatch is asking for something nobody can
run, which is `GATE NOT RUNNABLE` territory. Note that `npx tsc --noEmit*` makes adversarial the
one role able to type-check directly — a role without that grant (developer, for instance) has to
go through a granted wrapper such as `bun run typecheck`.

## What pins this today

There is exactly one mechanical check, and it lives inside an unrelated test:

- `extension/smoke-tests/test-codemode-activation.ts` — the `mcpCount === 14` assertion. If the
  fixture's MCP count drifts, that assertion's own failure message names it.

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

   Lives in `agents-base/project-manager.md` (the Gate Details table, under "Gate Details") only.
   It is a PM orchestration rule — PM owns `adversarial_loop` and `dispatch_lens_review` — and the
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
can check it.

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
empty `permission` map; and the `mcp__codebase_memory__*` set is **derived at runtime from the
`mcpServers.codebase_memory` block `install.sh` writes** (the `exposure: "direct"`, no-allowlist
shape that admits the whole server surface) — not copied from `BASE_ROSTER`, which is a test
fixture for the activation paths and has no relationship to the server's real tool list. The test
asserts the undeclared set — the names that reach children without a `tools` entry, plus `codemode`
— stays undeclared.

**Prevents:** silent surface widening. A new MCP server joining the child roster, or a role key
renamed to something `spawn.ts` never matches, fails this gate instead of quietly enlarging what a
role can call. This is also where the non-mirroring decision below is enforced.

## Explicit non-goals

- **No `agents.json` mirror of the MCP grants.** Arrival bypasses the `permission` map — the map
  cannot remove what it never admitted — so adding the tools the roster
  carries and no role map names (the six no-role-anywhere tools above: `list_projects`,
  `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr`) buys no
  enforcement and creates a fifth place to keep the roster current.
  Declare them in the role prompt, pin them with canary 3. `permission` stays as it is today.
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
