# Agent Guidelines for pi-rukas

Auto-loaded by Pi when any agent works inside this repo. Static rules only: conventions and load-bearing constraints. No incident history, no dated measurements, no module registry — git and the PRs keep those, and the jsdoc header of a source file is the authoritative contract for that file.

> ℹ️ **Recursive context.** pi-rukas both *uses* Pi (when you, the agent, run inside it) and *configures* Pi (its product — role prompts and an orchestrator extension). "The agent" means *you*, the reader. "Subagents" / "role prompts" / "specialists" mean pi-rukas's product surface.

**Where else to look.** `docs/configuration.md` is the home of every `PI_ENSEMBLE_*` knob — this file lists none; `pi-rukas-headless --capabilities` prints the machine-readable list. `docs/troubleshooting.md` is symptom → cause → fix. `docs/headless.md` is the headless contract. A rule stated here in one sentence is a mechanism described there in full; never copy a mechanism description into this file, and never cite an issue number here — history belongs to git.

---

## 1. 🚨 Pre-Push Quality Gates (BLOCKING)

CI is for VERIFICATION, not DISCOVERY. All gates pass locally before `git push`. Never push to "see if CI catches anything."

```bash
# 1. Build prompts (repo root) — generates dist/prompts/standard/*.md
bun run build

# 2. Type-check, lint, and smoke-test (extension/)
cd extension && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && bun run check && \
  bash smoke-tests/lib/verify-loop.sh smoke-tests/test-*.ts
```

If any check fails: fix it, re-run, only then push. Do NOT:

- ❌ Use `--no-verify`, `--no-gpg-sign`, or skip hooks
- ❌ Add `// biome-ignore` or `// @ts-ignore` to bypass — fix the code
- ❌ Push and hope CI catches it
- ❌ Run only the smoke test that exercises your change — they're all fast offline

**Live smoke tests are NOT in the pre-push set.** `extension/smoke-tests/test-*-live.ts` spawn real Pi children and cost real tokens. Run them when you change child-process behaviour (`spawn.ts`), bump the Pi pin, or investigate a production-only failure. CI runs the offline tests only.

### Review findings and the review budget

**Six-pass review findings are blocking at HIGH severity and above.** MEDIUM and LOW findings are disclosed and may be deferred.

**The review budget is two rounds: one full review, one fix wave, one scoped re-review.** It covers only what the fix changed and blocks on its carried rows and any new CRITICAL, so any other row is disclosed rather than fixed.

A `CRITICAL` always parks, as does a carried HIGH still open. Otherwise `ISSUES_FOUND` carries on to CI when the adversarial gate approved **and** the residuals were posted; failed disclosure parks, and the wall-clock cap parks regardless: [docs/troubleshooting.md](docs/troubleshooting.md) → "review ledger".

Child guards: every child loads the mode-independent guard companion in every mode, and a missing companion file fails the spawn rather than producing an unguarded child. The write fence keeps a develop or lens-fix child's writes inside its worktree. See the jsdoc of `child-guards.ts`, `write-fence.ts`.

---

## 2. Two change paths (READ FIRST before editing)

pi-rukas has **distinct codebases** that need different handling. Misidentifying the path is the most common source of confusion.

**Path A — Extension TypeScript (`extension/src/*.ts`).** Loaded by Pi at runtime via jiti; no build step for the TS itself. Gates: tsc + biome + offline smoke tests.

**Path B — Modular prompt layer (`modules/`, `manifests/`, `agents-base/`, `agents.json`).** Source-of-truth markdown that builds into per-role system prompts. **You MUST run `bun run build`** from the repo root after editing, to validate the assembled prompt. Artefacts land in `dist/prompts/standard/*.md`, which is **gitignored** — regenerated at install time and by CI. Commit the sources, never `dist/`.

**Slash-command bodies (`pi-prompts/*.md`).** Read at runtime, no build; effective on the next command invocation.

**Path D — Sandbox image (`.devcontainer/`).** Built and published to GHCR by CI after a green push to main; `install.sh` pulls it. Contributors never `docker build` and push by hand. Layer order in the Dockerfile is a cost decision: anything after the repo `COPY` rebuilds per architecture on every merge, so steps that do not read the checkout go above it.

---

## 3. Project structure

### Extension code (`extension/src/`)

Each module's responsibilities are documented in the jsdoc header of its source file — that's the authoritative contract, and it evolves with the code. Read the top of any file you're about to edit; don't rely on a stale registry here.

### Modular prompt layer

| Path | Content |
|---|---|
| `agents-base/<role>.md` | Per-role identity, tool access table, workflow doctrine |
| `modules/<category>/<name>.md` | Composable behaviour modules pulled into multiple roles |
| `manifests/<role>.manifest` | Ordered list of modules to assemble for that role |
| `agents.json` | Per-role tool/permission matrix (built into PM doctrine) |
| `skill/<name>/SKILL.md` | Skills auto-symlinked to `~/.pi/agent/skills/` |
| `pi-prompts/*.md` | Slash-command body (read at runtime, no build) |

**Permission model — trust mode is the default.** The permission guard runs as trust (sandbox, or interactive without the strict opt-in), strict (the opt-in: project → global → `agents.json` verdict resolution, prompts on `ask`), or headless (no UI: as strict, but `ask` hard-denies, since there is no human to consent). Children of a `/work` cycle run as trust, as an interactive cycle's children do — the boundary there is the mode-independent guards and the write fence, not the allowlist. Mechanism: [docs/headless.md](docs/headless.md).

*Why trust mode is the default in an interactive host:* pi-rukas runs as the user's own UID, so no agent-tool-layer gate can meaningfully constrain a misbehaving subagent — same filesystem, network and credential access. Per-call prompts at runtime volumes become theatre. The sandbox is the path for confined execution, and it is transparent to host capabilities by default (docker socket, SSH agent, host env forwarded), so it is the agent's runtime rather than the user's security boundary. Confine with it; don't trust it as a fence.

*Subagents:* the role's system prompt is the actual behavioural guidance; the runtime gate is either off (trust) or a soft fence (strict). Reviewer roles have write/edit/multiedit structurally excluded, which does not make their bash read-only. Installed user extensions are auto-forwarded to children; MCP server-side credentials remain the real capability boundary. Mechanism: the jsdoc of `spawn.ts`, `spawn-support.ts`, `spawn-extension-forward.ts`, `child-guards.ts`.

---

## 4. Pi compatibility (load-bearing)

The extension depends on Pi's CLI flags, JSON event stream shape, and `ExtensionAPI` surface. The dev-dependency pins in `extension/package.json` (`@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`, co-pinned and moved in lockstep) are **deliberate and non-normative**: a CI-reproducibility device, explicitly NOT a supported-version claim. Operators upgrade Pi freely — `pi` is a global install outside this package manager. The single maintained claim is the "Last verified against pi X.Y.Z" line in [docs/pi-compatibility.md](docs/pi-compatibility.md); every other site restates it and never carries an independent literal that can drift (enforced by `extension/smoke-tests/test-pi-version-drift.ts`).

Last verified against `pi` **1.4.0 (2026-11-01)** — the line above in [docs/pi-compatibility.md](docs/pi-compatibility.md) is the single source of truth; this restatement must agree with it (and with the pins' co-pin state) or the drift gate fails.

**What the pin protects:** type-checking only, for every `import type` of the Pi packages (erased at compile time), plus the `@earendil-works/pi-tui` **value** imports (`Text`, `SelectList`, `Container`), which really do resolve to the pinned TUI code at runtime. **What it does not protect:** the runtime `ExtensionAPI` surface. A devDependency cannot fence runtime — `spawnSpecialist` re-invokes the *running* pi binary. Shape changes surface as runtime errors, never type errors, and the offline tests do not exercise child processes: `test-pi-shape-live.ts` is the only detector, and it runs only when someone bumps the pin. Keep the pin current.

### Shapes we depend on

Don't assume these are stable across Pi versions — verify when bumping:

- `agent_end.messages[].content[]` blocks: `text`, `thinking`, `toolCall` (with `id`, `name`, `arguments`)
- `message_end` events with `message.role` and `message.usage` (input, output, cacheRead, cacheWrite)
- `tool_execution_start` events with `toolName` and `args`
- CLI flags: `--mode rpc`, `--no-extensions`, `--append-system-prompt`, `--session`, `--skill`, `--extension`, `--model`, `--no-skills`
- `--mode rpc` stdin commands: `{type:"prompt"|"steer"|"abort"|"follow_up"|"get_state", …}`
- RPC commands: `prompt` (with `streamingBehavior: "steer" | "followUp"`), `steer`, `abort`
- `pi.sendUserMessage(content, { deliverAs: "steer" })` — the behaviour is required, not optional (see `agent-message.ts`)

### Bumping the Pi pin

1. Read the Pi changelog: `gh api repos/badlogic/pi-mono/releases --jq '.[0:5][] | "\(.tag_name): \(.body[0:200])"'`.
2. Bump `pi-coding-agent` and `pi-tui` **together** in `extension/package.json`; the drift gate fails on a one-sided bump.
3. Run the **live** smoke tests — the offline ones cannot see a shape change: `test-pi-shape-live.ts` (event shapes + tool-roster integrity), `test-progress-live.ts`, `test-lens-review-live.ts`, `test-codemode-reviewer-rejection.ts`.
4. Update the "Last verified against" line in [docs/pi-compatibility.md](docs/pi-compatibility.md) **and** the restating line in this section; the drift gate cross-checks both against the pins. The install floor (`MIN_PI_VERSION` in `install-preflight.sh`) is a **minimum** and is never equalised with the verified line. Never edit a released CHANGELOG entry.
5. PR with the bump + smoke-test evidence.

---

## 5. Supply-chain hygiene (4-day embargo)

The extension's npm dependencies are guarded against zero-day supply-chain attacks.

- `extension/bunfig.toml` sets `minimumReleaseAge = 345600` (4 days); bun refuses anything newer. `extension/.npmrc` mirrors it as `min-release-age=4` for the npm fallback path. `extension/package.json` declares the engines floor that makes the npm floor enforceable.
- `extension/bun.lock` is the sole committed lockfile; CI uses `bun install --frozen-lockfile`.
- **Only npm-registry installs** — no `github:` or `git+` URLs (they bypass the embargo).
- Need a fresh release? Add the package to `minimumReleaseAgeExcludes` in `bunfig.toml`. Keep the list short; review it on every Dependabot PR.
- The same discipline applies to **prerequisite CLIs** (Pi, ctx7, parallel-cli): pin versions where instructions allow it, install with `--ignore-scripts`, and wait ≥4 days after a release before raising the recommended version in the README.

---

## 6. Minimalist engineering

**Every line of code, every test and every comment is a liability. It must earn its place, and the burden is on the person adding it.**

- **Prefer deleting to adding.** The smallest change that solves the issue wins. Elegance beats completeness.
- Before creating a module, function, type, file or test, answer: is it required by the issue; can existing code do it (search first); is this the simplest way; would it be maintainable in six months. Any "no" → DO NOT CREATE IT.
- A fix for a review finding may not grow the code more than the defect warrants. "This could theoretically fail" does not by itself justify new harness or test code — ask whether the risk is real, and show what breaks if you do not add it.
- A new gate must be observed failing on a deliberate mutant, in the same change that ships it. A gate never run in a failing state proves nothing and is itself bloat.
- **Reviewers apply the same rule.** A finding whose fix would add more than it protects is said to be so, with that reasoning, rather than filed as a demand.
- ❌ "Nice to have" features not in the issue · premature abstractions that appear once · defensive coding for unlikely scenarios · backwards-compat shims for in-progress refactors (this project is alpha; break things deliberately and document it).
- **Comments state the current WHY, in present tense.** No incident history, no "it used to…", no issue-number narration. Docs follow the same rule: history belongs to git, the PRs and `docs/troubleshooting.md`.

---

## 7. The compiled pipeline and its gates

**PM orchestrates; specialists execute.** When you run inside a parent `pi` session driven by `/work`, `/research`, `/plan`, `/review`, you are the **project manager** — the extension injects a sticky preamble forbidding `edit`, `write` and non-read-only bash. That is doctrine, not a hint: implementation, tests, debugging and file edits go to a `developer`, git/commits/PRs/deployment to `ops`, research and file reading to `explore`.

**`/work`, `/plan` and `/research` are compiled drivers, never hand-rolled pipelines.** The step table, state file, queue, review-cap timer and handoff artifact are the driver's code. A PM (or any agent) that reimplements the pipeline by hand produces a cycle with no state file, no queue, no review gate and no handoff — and nothing in the transcript says so. Start a cycle with the driver's tool; never reconstruct it with dispatches. `/do`, `/audit`, `/review` and `/start` are prose commands PM does orchestrate; they are not the compiled pipeline and must not be imitated as one.

These principles apply to **every** gate in this repository:

1. **A gate checks executed evidence, never a child's claim.** What a subagent *says* it did is narration.
2. **Silence is never a pass.** An absent or unparsable reply must be distinguishable from any parsed value, and the caller decides what absence means. Collapsing "absent" into a default is how a gate begins reporting a confident wrong answer.
3. **Fail in the direction of the blast radius.** The irreversible act (a merge) fails closed: an unreadable answer blocks. A routine absence (no doctrine file, no optional config) gets the shipped default, because that is the normal case.
4. **Doctrine is read at the cycle's base commit, never from the working tree,** so a cycle cannot rewrite the rules it is judged by mid-cycle. Documentation still ships with the PR — this repo's own "docs ship with the PR" rule is what that preserves.
5. **A cap is a stop signal that produces a handoff, never a question.** No "should I continue?" — the artifact *is* the answer, and the turn ends.
6. **Deterministic git/gh work is mechanized in driver code, not narrated to an LLM.** Every worst-class incident in this harness was an LLM improvising an enumerable shell recipe; deleting that failure source beats detecting its failures. A fallback to an LLM path is recovery from mechanized failure, never an opt-out.
7. **Prose is convention; a hook or a test is enforcement.** A rule that must hold gets a deterministic check, not a sentence. When a natural-language document must be consulted, it is consulted through one judged seam whose answer is honoured only against a verified quote — never through hand-rolled regexes over operator prose.

---

## 8. Transcript discipline

Per-child subagent transcripts auto-save to `~/.pi/agent/ensemble-runs/<date>/<runId>-<role>.json`, for **post-hoc inspection by the human user** via `/runs`. The PM (and any agent in a workflow) must NEVER read these files with the `read` tool — that re-imports tens of thousands of tokens of raw events, defeating the bounded-summary invariant the dispatch tools enforce.

Surface transcript paths in your reply verbatim; let the user browse via `/runs`.

---

## 9. Git workflow

This repo lives on GitHub, so `gh` and "PR" are used throughout. A GitLab project gets the same doctrine with `glab` and MR.

### Conventional commits

```
<type>(<scope>): <description>
```

**Never put an issue number in the scope position.** Alphabetic subsystem scopes (`fix(spawn):`) are the prescribed form; a bare type (`fix:`) only where no subsystem applies. Issue linkage goes in the PR body via `Closes #N` / `Fixes #N` — the scope-position number is decorative (no parser reads it) and downstream changelog tooling mangles headers that carry one.

Types: `feat` | `fix` | `refactor` | `docs` | `test` | `chore` | `ci` | `perf` | `feat!` / `fix!` (BREAKING). Scopes for this repo name the subsystem: `feat(work):`, `feat(review):`, `feat(model):`, `fix(spawn):`, `chore(deps):`, `docs(readme):`.

```
feat(review): add per-lens retry on parse failure
fix(spawn): close stdin to prevent hang on macOS
feat(work)!: make the parallel group ceiling configurable
```

Versioning is automated by [release-please](https://github.com/googleapis/release-please). While the project is pre-1.0, `release-please-config.json` sets `bump-minor-pre-major` and `bump-patch-for-minor-pre-major`, so `feat:` bumps PATCH and only `!` / `BREAKING CHANGE:` moves the minor digit.

Release PRs authenticate with a `RELEASE_PAT`, not the default `GITHUB_TOKEN`: a PR authored with `GITHUB_TOKEN` does not trigger `on: pull_request` workflows at all, so a release PR merges with zero CI runs and reports "no checks reported". The PAT needs `Contents: write` and `Pull requests: write`; it does **not** need `workflows` (a release PR touches no workflow file).

### Branch naming

```
feature/issue-{N}-brief-description   # issue-driven work
fix/issue-{N}-...                     # bug fixes
docs/...                              # docs-only (no issue required)
chore/...                             # tooling / config (no issue required)
```

### Branch protection

- ❌ NO direct commits to `main`
- ❌ NO force pushes to `main`
- ✅ All work on feature branches → PR
- ✅ PRs squash-merged; release-please opens release PRs on merge

### Spike branches

Experimental architectural work lives on its own feature branch. Stack spikes on foundational PRs when needed; rebase onto fresh main after the foundation merges.

### Gate files

**Gate files: `AGENTS.md`, `.github/`, `.pi/` and `agents.json`.** These define what verification, review and permission mean for a cycle. `.github/`, `.pi/` and `agents.json` halt a cycle that changes them, and the operator admits the path deliberately for the single run that is genuinely about that file (`/work <issue> --allow-protected <path>`). An `AGENTS.md` edit ships in the PR alongside the behaviour it documents, and grants that cycle nothing: the driver reads doctrine at the cycle's base commit, so the governing copy is the one on `main` and the edit takes effect for later cycles once an operator merges it. **A PR that changes a gate file is merged by the operator** — agents hold merge authority for everything else (see the grant below).

### LLMs are allowed to squash merge PRs/MRs

If all project quality gates have been met (code reviews, CI, linters, type checks etc) LLMs / agents are allowed to squash merge PRs (GitLab: MRs).

There is no retained human merge gate: merging is not a human approval step. Humans are consulted only when a PR is problematic in a way that further research and steering cannot resolve — escalation, not sign-off.

**This grant is load-bearing.** The `/work` driver reads this file at the `merged` step and parks as `awaiting-human-merge` without a grant like the sentence above, so state a rule about merging positively — a negation anywhere in this file reads as a refusal and turns auto-merge off regardless of the grant. Other projects opt in the same way, or per run with `/work <issue> --merge`. Authority is not sufficient — the merge needs executed `gh` evidence (`mergeStateStatus` + `gh pr checks`), and required checks reporting `skipped`/`neutral` count as not passing. See [docs/troubleshooting.md](docs/troubleshooting.md) → "Merge authority".

---

## 10. Issue-driven development

### Before starting

1. A GitHub issue exists for the work
2. The issue clearly describes the requirement
3. Your approach matches the issue scope exactly
4. No scope expansion without updating the issue or filing a new one

### During development

- Keep changes focused on the issue.
- PM surfaces related work via the forge CLI (`gh issue create` / `glab issue create`); specialists report it to PM and PM decides — don't bundle.
- One PR per issue (per concern); small + reviewable beats Big Bang.

### When the issue text drifts

Refinements and corrections go in the **body** (`gh issue edit --body-file`; GitLab: `glab api -X PUT projects/:id/issues/:iid`), not as comments. Comments get buried — they are for progress notes, not design corrections.

---

## 11. Documentation policy

### The 200-PR test

Before adding documentation: *"Will this be true in 200 PRs?"*

- **YES** (enduring principle) → document the principle (WHY)
- **NO** (implementation detail) → skip, or use a code comment (WHAT/HOW)

### What to document

- ✅ Project goals and vision (`README.md`)
- ✅ Contribution guidelines (`CONTRIBUTING.md`, `AGENTS.md`)
- ✅ Core concepts and terminology
- ✅ Non-obvious algorithms (code comments — short, focused)
- ✅ Architectural decisions tied to a load-bearing rationale
- ✅ Operator troubleshooting (`docs/troubleshooting.md`) — symptom → cause → fix entries for failures that recur. Update it on every PR that resolves a class of user-facing failure.

### Forbidden documentation

- ❌ Issue drafts (`issue_*.md`), implementation summaries (`*_IMPLEMENTATION.md`), fix notes (`fix_*.md`), research scratch (`research_*.md`), design documents (`DESIGN.md`), plans (`PLAN.md`, `IMPLEMENTATION_PLAN.md`)
- ❌ `TODO` comments — create issues instead

If it changes frequently or is task-specific, don't document it as a file. Use issues, PR descriptions, or vipune memory.

### Module-level descriptions live in source jsdoc, not in tables

Don't add file-by-file "what does X own" tables to AGENTS.md or CONTRIBUTING.md. Such tables drift with every refactor and become a second source of truth that is perpetually stale. The authoritative module contract is the **jsdoc header of the source file itself**; the answer to "what does `dispatch-deck.ts` do?" is "open the file". This file enforces principles and load-bearing constraints — it is not a module registry, and each statement here lives in exactly one file: a role prompt may point at a rule, it does not restate it.

### Public repository hygiene

This repository and its issues, pull requests, comments and releases are public. Never include the maintainers' private hosts, networks, addresses, private projects, personal paths, or field-run identifiers in files, commit messages, PR or issue text. Summarise field evidence generically; detail lives outside this repository.

The rule is enforced, not just stated: a mode-independent hook refuses a publish, commit message, or push to a public GitHub remote whose text matches the operator's private denylist, and refuses a surface it cannot read rather than assuming it is clean. It never prints the matched term. Mechanism: `public-hygiene-guard.ts`, `public-denylist.ts`; operator-facing form: [docs/troubleshooting.md](docs/troubleshooting.md) → "Public repository hygiene".

---

## 12. Code style

### TypeScript (`extension/`)

- Biome (lint + format) is the single source of truth: `bun run check`
- No `// @ts-ignore`, no `// @ts-expect-error` without an explicit reason in the comment
- Imports sorted automatically by Biome (`bun x biome format --write src/`)
- Avoid `any` — use `unknown` and narrow with type guards. If you must cast, comment WHY.

### File size limits

- **Hard limit**: 500 lines per source file · **ideal**: 300 or fewer · **refactor trigger**: over the cap, or 3+ distinct responsibilities

The gate scans the **whole repository** — every `.ts`, `.sh` and workflow `.yml`, not just `extension/`. Markdown and JSON are excluded deliberately: the limit is about logic a person holds in their head, and `docs/troubleshooting.md` is legitimately long. Excluded directories are named explicitly in the test, because an implicit exclusion is indistinguishable from a gap. Enforcement is `extension/smoke-tests/test-file-size-limit.ts`, in the same offline loop as every other smoke test (§1); it asserts both directions — the repo is clean, and a deliberately oversized fixture is caught — and prints the file closest to the cap. Split large modules along a natural seam (per-step handlers each in their own file behind a shared context module is the house pattern) and keep the comment that explains the seam: a size cap is never met by shortening prose.

### Markdown (`modules/`)

- Modules under `modules/<category>/` are self-contained and composable
- Heading levels: `# Section` top-level, `##` subsections
- One behaviour per module
- Don't reference other modules by path — Pi assembles them, and the assembled order is the manifest's call

### Commit messages

- Conventional commits with an alphabetic subsystem scope (`feat(work):`), or a bare type (`fix:`) where no subsystem applies — issue linkage goes in the PR body via `Closes #N`
- First line ≤ 72 chars; wrap the body at ~72
- "Why" in the body, not just "What" — the diff shows what changed

---

## 13. Common pitfalls

### 🚨 Model-specific placeholder text

Some model families emit literal placeholder text blocks between tool calls. The `model-adapters.ts` registry filters these in `spawn.ts:collapseEvents`. **Never add model-specific filtering in shared paths** — add an entry to `FAMILY_DETECTORS`, which is also where the concrete family evidence for the existing entry lives.

### 🚨 PM trying to code

The sticky preamble injection (`commands.ts:PM_STICKY_PREAMBLE`) is prompt-layer enforcement; structural tool-stripping is tracked separately. If you see the PM reach for `edit` / `write` / arbitrary bash, the preamble didn't land — file a bug.

### 🚨 AGENTS.md re-read habit

Pi auto-loads this file into every agent's context. Doctrine code must NOT instruct agents to re-read AGENTS.md — state the requirement directly, don't reference "as documented in AGENTS.md".

### 🚨 Transcript context bloat

Reading `~/.pi/agent/ensemble-runs/*.json` directly is forbidden for the orchestrating agent. Each transcript is 50k–300k tokens of raw events; the dispatch tool's report is the bounded summary by design.

### 🚨 Pi version shape drift

CLI flags and event shapes change between Pi versions. The dev pins keep CI reproducible; they do not fence runtime, and the offline tests do not exercise child processes. The maintained claim lives in [docs/pi-compatibility.md](docs/pi-compatibility.md) and `test-pi-version-drift.ts` cross-checks the restatements against it (§4).

### 🚨 Branching off stale main

Ops must detect the mainline, verify a clean working tree, and fast-forward via `git pull --ff-only` before branching. Branching off whatever HEAD points at burns time on phantom conflicts.

### 🚨 `dispatch_parallel` with 1 spec

`dispatch_parallel` enforces ≥2 specs at runtime. For a single subagent, use `dispatch_specialist`.

---

## 14. Quick commands reference

The authoritative set is §1. One-offs: `./install.sh` (install), `cd extension && bun run smoke-tests/<test>.ts` (one offline test).

---

*For human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md) for the human-targeted workflow (dev setup, commit conventions, supply-chain notes).*
*For Pi compatibility: see [CONTRIBUTING.md § Pi compatibility](CONTRIBUTING.md#pi-compatibility).*
