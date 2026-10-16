# Specialist Agent Surface — Baseline

**Status**: Active baseline for the agent-surface program (#1075, #1076, #1077, #1078).

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
against — the roster, the bash map, the model, and the working directory each role actually gets,
plus the three canaries that keep the claim and the runtime from drifting apart again.

## Authoritative sources

Each fact has exactly one deciding location. Everything else in the repo is a projection of it.

| Fact | Decided by | Notes |
|---|---|---|
| Declared tool grants + bash allowlist | `agents.json` → `agent.<role>.permission` | Per-role map; `"*": "ask"` is the default. Read verbatim by the permission overlay; roles not present fall back to the parent's map. |
| Structural tool removal | `extension/src/role-tools.ts` — `ROLE_TOOL_EXCLUDES`, `excludeToolsFor()`, `excludeToolListFor()` | The only fence that binds MCP and codemode tools. |
| Child argv (builtins, MCP, codemode) | `extension/src/spawn-support.ts` — `childArgsBase()` (line 271), `--exclude-tools` push at lines 331-333 | `--mode rpc --no-extensions -e builtin:mcp`, plus `-e builtin:codemode` unless `PI_ENSEMBLE_CHILD_CODEMODE=0`. |
| MCP roster a child actually sees | `extension/smoke-tests/test-codemode-activation.ts` — `BASE_ROSTER` (line 53) | The 18-entry roster a mock `getActiveTools()` returns to both activation paths; 14 of the entries are `mcp__codebase_memory__*`, asserted by the `mcpCount === 14` check. `install.sh` writes `exposure: "direct"` with no tool allowlist (line 273), so the whole server surface arrives — the roster is the server's surface, not a projection of `agents.json`. |
| Working directory | `extension/src/spawn.ts:99` — `spec.cwd ?? process.cwd()` | Absent `cwd` silently means the Pi process directory, not the worktree. |
| Model | `extension/src/models.ts` — `resolveModel(spec.role, spec.model)` (called at `spawn.ts:112`) | Precedence: spec → config → `PI_ENSEMBLE_MODEL_<ROLE>` → `PI_ENSEMBLE_SUBAGENT_MODEL` → Pi default. `agents.json` holds no model config. |
| Lens / lens-fix tree | `extension/src/work-driver-lens-fix.ts` — `lensWorktree()` (lines 198-201) | Review and fix must name the SAME tree; `worktrees.default` first, `repoRoot` fallback. |

## Declared surface per role

Counts below are read from `agents.json` (bash = pattern count in `permission.bash`, allow and
deny together; "MCP in map" = keys starting `mcp__codebase_memory__`, all of them `allow`), from
`extension/src/role-tools.ts` (`--exclude-tools`), and the undeclared column is the `BASE_ROSTER`
set (`test-codemode-activation.ts:53`) minus the keys that role's `permission` map names. MCP and
codemode additions arrive without ever passing through the map's `tools` entries — the map is a
verdict layer, not a roster filter — so they are listed separately rather than folded into the
declared column.

| Role | Declared tool grants | Undeclared MCP / codemode additions (from `BASE_ROSTER`) | `--exclude-tools` | Bash patterns | Declared in |
|---|---|---|---|---|---|
| developer | 22 keys in map — 7 MCP + 11 non-MCP `allow` (`codemode`, `read`/`edit`/`write`/`multiedit`, `rg`/`list`/`skill`/`todowrite`/`question`/`webfetch`) + `external_directory: ask`, `task: {"*": deny}`, 2 hashline denials | 7: `index_repository`, `list_projects`, `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr` | — (none) | 207 | `agents-base/developer.md` + `modules/core/codebase-memory-mcp.md` |
| ops | 20 keys — 3 MCP (`search_code`, `get_code_snippet`, `get_architecture`) + 5 non-MCP `allow` (`codemode`, `read`/`rg`/`list`/`todowrite`), `edit`/`write`/`multiedit`/`webfetch`/`task` deny, 6 `parallel-*` denials | 11: the developer 7 **plus** `search_graph`, `trace_path`, `detect_changes`, `query_graph` — ops' map names only the 3 above | — (none) | 208 | `agents-base/ops.md` |
| adversarial-developer | 19 keys — 7 MCP + 4 non-MCP `allow` (`codemode`, `read`/`rg`/`list`), `edit`/`write`/`webfetch`/3 `*_task` deny, `task: {"*": deny}` | 7: same as developer | `write,edit,multiedit` | 75 | `agents-base/adversarial-developer.md` |
| code-review-specialist | 19 keys — 7 MCP + 7 non-MCP `allow` (`codemode`, `read`/`rg`/`list`/`skill`/`todowrite`/`webfetch`), `edit`/`write`/`multiedit`/`task` deny | 7: same as developer | `write,edit,multiedit` | 78 | `agents-base/code-review-specialist.md` |
| explore | 19 keys — 7 MCP + 7 non-MCP `allow` (`codemode`, `read`/`rg`/`list`/`skill`/`todowrite`/`webfetch`), `edit`/`write`/`multiedit`/`task` deny | 7: same as developer | `write,edit,multiedit` | 105 | `agents-base/explore.md` |
| project-manager | 41 keys — 8 MCP (`index_repository` included — the one explicit grant of it, `agents.json:144`) + 24 non-MCP `allow`, `write`/`edit`/`webfetch`/`websearch` deny | 6: `list_projects`, `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`, `manage_adr` | — (parent is never gated) | 114 | `agents-base/project-manager.md` |

The roster itself is fixed: `BASE_ROSTER` is 18 entries — `bash`, `read`, `edit`, `write` plus
**14** `mcp__codebase_memory__*` tools (`search_code`, `trace_path`, `detect_changes`,
`get_architecture`, `get_code_snippet`, `query_graph`, `search_graph`, `index_repository`,
`list_projects`, `delete_project`, `index_status`, `check_index_coverage`, `compare_graphs`,
`manage_adr`). The roster's `bash`/`read`/`edit`/`write` entries are the four core tools a child
carries; `--exclude-tools write,edit,multiedit` is what structurally removes two of them from the
three reader roles. `codemode` is not in the base roster: `childArgsBase()` passes
`-e builtin:codemode` and `enableChildCodemode()` **appends** it to the active set on
`session_start` (the test asserts `length === BASE_ROSTER.length + 1` with `codemode` last) —
which is also why `agents.json` carries `codemode: allow` for five of the six roles but no
`codemode` key at all for project-manager (`agents.json` has five `codemode` entries, not six).
`delete_project` — destructive, and never granted to any role in `agents.json` — is the
undeclared name my earlier note had guessed as `get_file_outline`; the roster refutes that.
**`get_file_outline` is not in the roster at all.** It appears nowhere in the three authoritative
sources, and is not a tool the index exposes (the seven read-side tools `docs/mcp.md` documents and
the three admin tools it names — `index_repository`, `delete_project`, `manage_adr` — together
account for the 14); it was a guess, and it is removed from this document.

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
(`extension/src/permission-guard.ts:388`), so an arriving MCP tool is usable; strict mode falls
through to `resolveToolPermission` (`extension/src/permission-subagent-guard.ts:170`), whose
Layer-3 miss yields `ask` and escalates to the parent; headless has no human to consent, so the
same `ask` is denied.

Two consequences worth stating plainly: `--exclude-tools` is the *only* structural fence, and the
bash allowlists are where the real capability boundaries sit — three roles have zero build-tool
patterns, so any prompt that tells them to "run the build" is a lie.

## Doctrine single-source rule

**Each doctrine statement exists in exactly one source file. Role prompts may reference a
statement, never restate it.** The assembled prompt is the concatenation of `agents-base/<role>.md`
and the modules listed in `manifests/<role>.manifest`; a sentence written in two of those files
reaches the model twice, and once the copies diverge the model is handed a contradiction about its
own rules. AGENTS.md §11 forbids the duplication; §7 names the adversarial-gate verdict vocabulary
as the defect class this rule exists to prevent.

Two statements are currently duplicated verbatim and are being consolidated:

1. > "Hand-managed work gets the same gates as /work: development managed outside the driver (a
   > hand-dispatched developer, /do, free-form requests) must still pass adversarial_loop AND the
   > full six-pass lens review (dispatch_lens_review), with CRITICAL/HIGH findings fixed, before
   > PR/CI/merge via @ops — a developer's self-report plus CI is NOT a pass."

   Lives in `agents-base/project-manager.md:255` only. Consolidates **there** — it is a PM
   orchestration rule (PM owns `adversarial_loop` and `dispatch_lens_review`), and the developer
   copy belongs in neither `agents-base/developer.md` nor `modules/workflows/quality-gates.md`,
   since the developer is explicitly told elsewhere that the gate is not its responsibility.

2. The merge-policy statement — "If all project quality gates have been met (code reviews, CI,
   linters, type checks etc) LLMs / agents are allowed to squash merge PRs (GitLab: MRs)."

   Lives in `AGENTS.md` §9 ("LLMs are allowed to squash merge PRs/MRs") only, and stays there.
   The `/work` driver reads that section at the cycle's `baseSha` as the merge grant, so a copy in
   a role prompt is both a drift risk and a second, non-load-bearing authority for an irreversible
   action. Role prompts refer to the project's `AGENTS.md`; they do not paraphrase it.

## The three canaries

**Status: PLANNED — none of the three exist yet.** `extension/smoke-tests/` contains none of the
files below, so every count named in this document is currently an *unenforced assertion* — correct
today, silently rotting tomorrow. The contracts are written here first so the tests have a spec to
be written against; treat them as the intended offline pre-push / CI loop (AGENTS.md §1), not as
gates that run today. They follow the shape of `test-pm-tool-permissions.ts`: read the checked-in
configuration, assert a stated premise first so a changed premise fails loudly rather than silently,
and name the exact offending entries in the failure message. Where a contract below names a number
in this document, the test derives it from `agents.json` at runtime rather than restating it.

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
empty `permission` map; and the undeclared structural additions — the `mcp__codebase_memory__*` set
that reaches children without a `tools` entry, plus `codemode` — are an explicitly-declared
constant in the test.

**Prevents:** silent surface widening. A new MCP server joining the child roster, or a role key
renamed to something `spawn.ts` never matches, fails this gate instead of quietly enlarging what a
role can call. This is also where the non-mirroring decision below is enforced: the test asserts
that the undeclared set *stays* undeclared, so a future mirror in `agents.json` is caught too.

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
