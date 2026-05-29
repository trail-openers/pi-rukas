# Agent Guidelines for pi-ensemble

This document is auto-loaded by Pi when any agent works inside this repo. It establishes the rules, conventions, and project-specific constraints all development work follows. Read once; apply throughout.

> ℹ️ **Recursive context.** pi-ensemble both *uses* Pi (when you, the agent, run inside it) and *configures* Pi (its actual purpose — building role prompts and an orchestrator extension). When this file says "the agent", it means *you*, the one reading this. When it says "subagents" / "role prompts" / "specialists", it means pi-ensemble's product surface.

---

## 1. 🚨 Pre-Push Quality Gates (BLOCKING)

CI is for VERIFICATION, not DISCOVERY. All gates pass locally before `git push`. Never push to "see if CI catches anything."

```bash
cd extension && bunx tsc --noEmit && bun run check && \
  for t in test-command-flow test-lens-review test-models test-runs test-progress test-prune test-async-dispatch; do \
    bun run smoke-tests/$t.ts || break; \
  done
```

If any check fails: fix the issue, re-run, only then push. Do NOT:

- ❌ Use `--no-verify`, `--no-gpg-sign`, or skip hooks
- ❌ Add `// biome-ignore` or `// @ts-ignore` to bypass — fix the code
- ❌ Push and hope CI catches it
- ❌ Run only the smoke test that exercises your change — they're all fast offline

### Live smoke tests are NOT in the pre-push set

Files matching `extension/smoke-tests/test-*-live.ts` spawn real Pi children and cost real tokens (a few cents per run on Cerebras GLM-4.7). Run them only when:

- You changed `spawn.ts` (changes to child process behaviour)
- You bumped the Pi version pin in `extension/package.json`
- You're investigating a production-only failure mode

CI runs the offline tests only. Live tests are dev-machine only.

**Six-pass review findings are blocking at MEDIUM severity and above.** The fix loop continues until all MEDIUM, HIGH, and CRITICAL findings are resolved — there is no round cap for these severities. Only LOW findings may be deferred or overridden with user confirmation.

---

## 2. Two change paths (READ FIRST before editing)

pi-ensemble has **two distinct codebases** that need different handling. Misidentifying the path is the #1 source of confusion.

### Path A — Extension TypeScript (`extension/src/*.ts`)

- The orchestrator code that gets loaded by Pi
- Edit → Pi picks up changes on next launch (loaded via jiti at runtime)
- No build step needed for the TS itself
- Required gates: tsc + biome + offline smoke tests

### Path B — Modular prompt layer (`modules/`, `manifests/`, `agents-base/`)

- Source-of-truth markdown that builds into per-role system prompts
- Edit → **MUST run `bun run build`** from repo root before changes take effect
- Built artefacts go to `dist/prompts/standard/*.md`
- `dist/prompts/standard/` is committed (subagents read it directly at spawn time)

### Slash-command bodies (`pi-prompts/*.md`)

- Read at runtime by the extension; no build step
- Changes take effect on next `/work`, `/start`, etc. invocation

**Rule**: if you edit anything under `modules/`, `manifests/`, `agents-base/`, or `agents.json`, you MUST run `bun run build` and commit `dist/prompts/standard/*.md` in the same commit. CI does not rebuild; the committed artefact is the source of truth at runtime.

---

## 3. Project structure

### Extension code (`extension/src/`)

The major modules — know which one to edit for which kind of change:

| File | Owns | Edit when |
|---|---|---|
| `index.ts` | Extension activation, tool/command registration | Adding/removing a top-level command or tool |
| `commands.ts` | Slash-command handlers, PM doctrine injection | Changing slash-command body loading, PM sticky preamble |
| `dispatch.ts` | `dispatch_specialist` and `dispatch_parallel` tools | Single/parallel dispatch semantics |
| `permission-guard.ts` | Top-level session permission enforcement (project + global + `agents.json` layers); bash subcommand allowlist matching; decision cache | Permission prompts, cache shape, allow/deny logic |
| `dispatch-status.ts` | `dispatch_status`, `dispatch_kill` tools | Job-introspection surface |
| `async-jobs.ts` | Job registry, push-callback delivery via `pi.sendUserMessage` | All async-dispatch lifecycle changes |
| `spawn.ts` | Fire-and-forget `pi -p --mode json` child spawn | Single-shot subagent spawn behaviour |
| `adversarial.ts` | Encapsulated 3-round adversarial review-then-fix gate | The mandatory adversarial gate after every developer dispatch |
| `lens-review.ts` | Six-pass code-review orchestrator | Lens dispatch, deduplication, verdict computation |
| `lens-reporter.ts` | Child extension loaded into review specialists | `report_finding` tool registration |
| `model-adapters.ts` | Per-LLM-family text-artifact filtering | Adding support for a new model family with known quirks |
| `models.ts` + `model-config.ts` + `model-picker.ts` | Per-role model resolution, `/ensemble-model` interactive picker | Model resolution priority changes |
| `progress.ts` | Per-child live-progress state for `onUpdate` callbacks | Tool-output stream rendering |
| `roles.ts` + `types.ts` | Role enum + result/dispatch types | New specialist role |
| `runs.ts` | `/runs` slash command + transcript browsing/pruning | Transcript management |
| `worktree.ts` | Git worktree helpers (delegated to ops in practice) | Worktree lifecycle |
| `trace.ts` | Gated stderr trace (set `PI_ENSEMBLE_DEBUG=1`) | Debug instrumentation |

### Modular prompt layer

| Path | Content |
|---|---|
| `agents-base/<role>.md` | Per-role identity, tool access table, workflow doctrine |
| `modules/<category>/<name>.md` | Composable behaviour modules pulled into multiple roles |
| `manifests/<role>.manifest` | Ordered list of modules to assemble for that role |
| `agents.json` | Per-role tool/permission matrix (built into PM doctrine) |
| `skill/<name>/SKILL.md` | Skills auto-symlinked to `~/.pi/agent/skills/` |
| `pi-prompts/*.md` | Slash-command body (read at runtime, no build) |

**Permission model — top-level vs subagents.**

*Top-level session* (the parent `pi` you launch): pi-ensemble's `permission-guard.ts` is the active enforcer. It intercepts every tool call, resolves a verdict via three layers (`.pi/permissions.json` project config → `~/.pi/agent/permissions.json` global config → `agents.json`), prompts the user for `ask`, and caches "Allow always" / "Deny always" decisions in `.pi/decisions.json`. `pi-permissions` (if installed) adds a separate interactive layer on top of this.

*Subagents* (developer, ops, explore, code-review-specialist, adversarial-developer): spawned with `--no-extensions`, so **pi-ensemble's own extension is NOT loaded** inside subagent processes. There is no runtime enforcement from pi-ensemble for subagent tool calls — the role's system prompt (assembled from `agents.json` `agent.<role>.permission`) tells the role what it may use, but a misbehaving subagent isn't blocked at the tool layer. Hard confinement requires Pi's own built-in checks or sandboxing.

*Extension auto-forward to subagents*: `discoverInstalledExtensions` in `extension/src/spawn.ts` scans `~/.pi/agent/extensions/` (or `$PI_AGENT_DIR/extensions`) and re-injects every installed extension into the subagent via `--extension <real-path>`, except pi-ensemble itself (matched by `package.json.name === "@randomm/pi-ensemble"` to prevent recursive spawn). This means `pi-claude-auth` (Anthropic Claude Code identity headers) and MCP bridges like `pi-mcp-adapter` reach subagents automatically once installed in the canonical location — no env-var wiring needed.

For extensions outside the canonical install location (dev-mode, monorepo paths), `PI_ENSEMBLE_USER_EXTENSION` is still honoured as an additional forwarded extension. To disable auto-forward entirely (restoring the pre-#88 "subagents inherit nothing" behaviour), set `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1`. MCP server-side credentials remain the real capability boundary regardless.

---

## 4. Pi compatibility (load-bearing)

The extension depends on Pi's CLI flags, JSON event stream shape, and `ExtensionAPI` surface. The pin in `extension/package.json` (`@earendil-works/pi-coding-agent: ~0.75.3`) is **deliberate**, not a default.

### Shapes we depend on

Don't assume these are stable across Pi versions — verify when bumping:

- `agent_end.messages[].content[]` blocks: `text`, `thinking`, `toolCall` (with `id`, `name`, `arguments`)
- `message_end` events with `message.role` and `message.usage` (input, output, cacheRead, cacheWrite)
- `tool_execution_start` events with `toolName` and `args`
- CLI flags: `-p`, `--mode json`, `--mode rpc`, `--no-extensions`, `--no-session`, `--append-system-prompt`, `--session`, `--skill`, `--extension`, `--model`, `--no-skills`
- RPC commands: `prompt` (with `streamingBehavior: "steer" | "followUp"`), `steer`, `abort`
- `pi.sendUserMessage(content, { deliverAs: "steer" })` — load-bearing for async push-callback

### Bumping the Pi pin

1. Read the Pi changelog: `gh api repos/badlogic/pi-mono/releases | jq -r '.[0:5][] | "\(.tag_name): \(.body[0:200])"'`.
2. Bump in `extension/package.json` (e.g. `~0.75.3` → `~0.76.0`).
3. Run **live** smoke tests on the new version (offline tests won't catch shape changes).
4. Update `CHANGELOG.md`'s "Tested against pi X.Y.Z" line.
5. PR with the bump + smoke-test evidence.

When Pi changes a shape we depend on (this has happened: `tool_use` → `toolCall`), the offline smoke tests won't catch it. Manual inspection of a recent transcript is the canonical check until a future `test-pi-shape.ts` exists.

---

## 5. Supply-chain hygiene (4-day embargo)

The extension's npm dependencies are guarded against zero-day supply-chain attacks (compromised maintainer publishes a malicious version, caught and yanked within hours).

- `extension/bunfig.toml` sets `minimumReleaseAge = 345600` (4 days). Bun refuses anything published more recently. Requires bun ≥ 1.2.20.
- `extension/.npmrc` mirrors this with `min-release-age=4` for npm / pnpm / yarn users. Requires npm ≥ 11.10.0.
- `extension/package.json` declares the engines floor.
- `extension/bun.lock` is committed; CI uses `bun install --frozen-lockfile`.
- **Only npm-registry installs** — no `github:` or `git+` URLs (they bypass the embargo).

Need a fresh release? Add the package name to `minimumReleaseAgeExcludes` in `bunfig.toml`. Keep the list short; review on every Dependabot PR.

This discipline applies to **prerequisite CLIs** too (Pi, ctx7, parallel-cli, etc.):

- Pin to specific versions in install instructions where possible
- Use `npm install -g --ignore-scripts` (disables postinstall hooks)
- Wait ≥4 days after a new release before bumping the recommended version in README

---

## 6. Minimalist engineering

**CORE PRINCIPLE: Every line of code is a liability.** Question every addition.

### Pre-creation checklist

Before adding a new module, function, type, or feature:

- [ ] Is it required by the GitHub issue?
- [ ] Can existing code solve it (search with `colgrep` first)?
- [ ] Is this the simplest solution?
- [ ] Does it add essential capability or just convenience?
- [ ] Will it be maintainable in 6 months?

If you cannot justify the necessity, DO NOT CREATE IT.

### Forbidden patterns

- ❌ "Nice to have" features not in the issue
- ❌ Premature abstractions / utility functions that appear once
- ❌ Defensive coding for unlikely scenarios
- ❌ Over-engineered solutions to simple problems
- ❌ Backwards-compat shims for in-progress refactors (this project is alpha; break things deliberately and document)

---

## 7. The PM-self-coding failure mode (project-specific gotcha)

When you (the agent) run inside the parent `pi` session triggered by a workflow slash command (`/work`, `/research`, `/plan`, `/review`), you are the **project manager (PM)**. The extension injects a sticky preamble on every PM turn telling you:

> *You MUST NOT use edit, write, or non-vipune/git-read-only bash for implementation work. Dispatch to specialists instead.*

This is real doctrine, not a hint. The PM exists to orchestrate; specialists exist to execute. Specifically:

- **Implementation / tests / debugging / file edits** → `dispatch_specialist` with role `developer`, then `adversarial_loop` to gate the resulting diff
- **Git operations / commits / PRs / branch creation / deployment** → `dispatch_specialist` with role `ops`
- **Research / vipune searches / web / file reading** → `dispatch_specialist` with role `explore`

PM can use `read`, `vipune`, `gh issue view`, and read-only `git status/diff/log/branch`. PM CANNOT use `edit`, `write`, or arbitrary bash.

This rule does NOT apply when an agent works on pi-ensemble itself (this repo's TypeScript). Then the agent IS a developer. The PM rule applies when running inside a `/work` cycle.

---

## 8. Transcript discipline

Per-child subagent transcripts auto-save to `~/.pi/agent/ensemble-runs/<date>/<runId>-<role>.json`. These are for **post-hoc inspection by the human user** via `/runs`. The PM (and any agent in a workflow) must NEVER read these files via the `read` tool — that re-imports thousands of tokens of raw events, defeating the bounded-summary invariant the dispatch tools enforce.

Surface transcript paths in your reply verbatim; let the user browse via `/runs`.

---

## 9. Git workflow

### Conventional commits with issue numbers

```
<type>(#<issue>|<scope>): <description>
```

Types: `feat` (MINOR) | `fix` (PATCH) | `refactor` | `docs` | `test` | `chore` | `ci` | `perf` | `feat!` (BREAKING → MAJOR).

Scope conventions for this repo:

- `feat(work):` change to `/work` flow
- `feat(review):` change to six-pass review
- `feat(model):` model resolution
- `fix(spawn):` spawn / child-process bugs
- `chore(deps):` dependency bumps
- `docs(readme):` README only

Examples:

```
feat(review): add per-lens retry on parse failure
fix(spawn): close stdin to prevent hang on macOS
feat(work)!: replace dispatch_parallel max with PI_ENSEMBLE_MAX_PARALLEL env

BREAKING CHANGE: hardcoded 10-slot limit is now configurable via env var.
```

Versioning is automated by [release-please](https://github.com/googleapis/release-please). Conventional commit messages drive `CHANGELOG.md` entries and the version bump in the release PR.

### Branch naming

```
feature/issue-{N}-brief-description   # for issue-driven work
fix/issue-{N}-...                     # bug fixes
docs/...                              # docs-only changes (no issue required)
chore/...                             # tooling / config (no issue required)
```

### Branch protection

- ❌ NO direct commits to `main`
- ❌ NO force pushes to `main`
- ✅ All work on feature branches → PR
- ✅ PRs squash-merged; release-please opens release PRs on merge

### Spike branches

Experimental architectural work lives on a feature branch and does NOT merge to main without explicit human approval. Stack spikes on top of foundational PRs if needed; rebase onto fresh main after the foundation merges.

### LLMs are allowed to squash merge PRs

If all project quality gates have been met (code reviews, CI, linters, type checks etc) LLMs / agents are allowed to squash merge PRs.

---

## 10. Issue-driven development

### Before starting

1. GitHub issue exists for the work
2. Issue clearly describes the requirement
3. Your approach matches issue scope exactly
4. No scope expansion without updating the issue or filing a new one

### During development

- Keep changes focused on the issue
- If you discover related work, surface it via `gh issue create` — don't bundle
- One PR per issue (per concern); small + reviewable beats Big Bang

### When the issue text drifts

Refinements/corrections to a research issue go in the **body** via `gh issue edit --body-file`, not as comments. Comments get buried. Comments are for progress notes, not design corrections.

---

## 11. Documentation policy

### The 200-PR test

Before adding documentation: *"Will this be true in 200 PRs?"*

- **YES** (principle that endures) → Document the principle (WHY)
- **NO** (implementation detail) → Skip, or use code comments (WHAT/HOW)

### What to document

- ✅ Project goals and vision (`README.md`)
- ✅ Contribution guidelines (`CONTRIBUTING.md`, `AGENTS.md`)
- ✅ Core concepts and terminology
- ✅ Non-obvious algorithms (code comments — short, focused)
- ✅ Architectural decisions tied to a load-bearing rationale

### Forbidden documentation

- ❌ Issue drafts (`issue_*.md`)
- ❌ Implementation summaries (`*_IMPLEMENTATION.md`)
- ❌ Fix notes (`fix_*.md`)
- ❌ Research scratch (`research_*.md`)
- ❌ Design documents (`DESIGN.md`)
- ❌ Plans (`PLAN.md`, `IMPLEMENTATION_PLAN.md`)
- ❌ `TODO` comments — create GitHub issues instead

If it changes frequently or is task-specific, don't document it as a file. Use GitHub issues / PR descriptions / vipune memory.

---

## 12. Code style

### TypeScript (extension/)

- Biome (lint + format) is the single source of truth: `bun run check`
- No `// @ts-ignore`, no `// @ts-expect-error` without an explicit reason in the comment
- Imports sorted automatically by Biome (`bunx biome format --write src/`)
- Avoid `any` — use `unknown` and narrow with type guards. If you must cast, comment WHY.
- One concern per module; modules under `extension/src/` should stay readable in one screen where possible

### Markdown (prompts/)

- Modules under `modules/<category>/` should be self-contained and composable
- Use heading levels consistently: `# Section` for top-level, `##` for subsections
- Keep modules focused (one behaviour per module)
- Don't reference other modules by path — Pi assembles them, but the assembled order is the manifest's call

### Commit messages

- Conventional commits with issue scope (`feat(#123):`)
- First line ≤ 72 chars; wrap body at ~72
- "Why" in the body, not just "What" (the diff shows what changed)

---

## 13. Common pitfalls

### 🚨 "None" placeholder text from GLM family

GLM-4.x / 5.x emits literal `{type: "text", text: "None"}` blocks between tool calls. The `model-adapters.ts` registry filters these in `spawn.ts:collapseEvents`. **Do NOT add inline GLM-specific filtering in shared paths.** If a new family has quirks, add an entry to `FAMILY_DETECTORS` in `model-adapters.ts`.

### 🚨 PM trying to code

The sticky preamble injection (`commands.ts:PM_STICKY_PREAMBLE`) is prompt-layer enforcement. Mechanism-layer enforcement (strip edit/write tools via `setActiveTools`) is tracked in [#26](https://github.com/randomm/pi-ensemble/issues/26). If you see the PM reach for `edit` / `write` / `bash` (beyond vipune/git-read-only), the sticky preamble didn't land — file a bug.

### 🚨 AGENTS.md re-read habit

Pi auto-loads this file into every agent's context. Doctrine code (PM, /work, etc.) should NOT instruct agents to re-read AGENTS.md — that wastes a tool call and tokens. State requirements from AGENTS.md directly; don't reference "as documented in AGENTS.md".

### 🚨 Transcript context bloat

Reading `~/.pi/agent/ensemble-runs/*.json` directly is forbidden for the orchestrating agent (PM). Each transcript is 50k-300k tokens of raw events. Use the dispatch-tool report's final assistant text instead — it's the bounded summary by design.

### 🚨 Pi version shape drift

CLI flags and event shapes change between Pi minor versions. The pin in `extension/package.json` (`~0.75.3`) protects us, but bumping requires live tests + manual transcript inspection. The offline smoke tests don't exercise child-process behaviour; they won't catch a Pi shape regression.

### 🚨 Branching off stale main

`/work` step 3 explicitly requires ops to: detect mainline, verify clean working tree, fast-forward via `git pull --ff-only`. Skipping this and branching off whatever HEAD points at burns time on phantom conflicts.

### 🚨 `dispatch_parallel` with 1 spec

`dispatch_parallel` enforces ≥2 specs at runtime. For single-subagent work, use `dispatch_specialist`. Tool descriptions make the cardinality explicit.

---

## 14. Quick commands reference

| Task | Command |
|---|---|
| Install (after clone) | `./install.sh` |
| Build role prompts | `bun run build` |
| Type-check extension | `cd extension && bunx tsc --noEmit` |
| Lint + format check | `cd extension && bun run check` |
| Apply format | `cd extension && bunx biome format --write src/` |
| All offline smoke tests | (see § 1 pre-push) |
| Single offline smoke test | `cd extension && bun run smoke-tests/<test>.ts` |
| Live spawn test (real tokens) | `cd extension && bun run smoke-tests/test-spawn.ts` |
| Live lens review (real tokens) | `cd extension && bun run smoke-tests/test-lens-review-live.ts` |
| View Pi compat surface | `grep -r 'pi.sendUserMessage\|toolCall\|message_end' extension/src/` |
| Check current model lineup before referencing | WebSearch for "current frontier LLMs <year>" — training data is stale |

---

## Summary — pi-ensemble at a Glance

1. **Quality gates BLOCKING** — tsc + biome + 8 offline smoke tests pass locally before push
2. **Two change paths** — extension code (no build) vs modular prompt layer (`bun run build` required, commit `dist/`)
3. **Pi compatibility is load-bearing** — pin is deliberate; bumps require live tests
4. **4-day npm embargo** — applies to `extension/` deps via bunfig; recommend pinning for prerequisite CLIs too
5. **PM never codes** — orchestrate via dispatch tools; the sticky preamble enforces this
6. **Conventional commits + issue-driven** — `feat(#123): …`, branch `feature/issue-N-…`
7. **Spike branches stay off main** — explicit human approval required for experimental merges
8. **LLMs never merge** — humans gate the merge button
9. **200-PR test for docs** — endures or doesn't get written
10. **Transcript discipline** — orchestrator reads dispatch-tool summaries, never raw transcript files

**Golden rule**: Question every addition. Simplest solution wins. When in doubt, the doctrine in this file is authoritative — including for me.

---

*For human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md) for human-targeted workflow (dev setup, commit conventions in more detail, supply-chain notes).*
*For Pi compatibility: see [CONTRIBUTING.md § Pi compatibility](CONTRIBUTING.md#pi-compatibility).*
