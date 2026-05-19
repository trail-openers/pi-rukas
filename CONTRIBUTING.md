# Contributing to pi-ensemble

Thanks for the interest. This is an alpha-status project — the API will change
before 1.0, and the maintainer (one person, hobby cadence) reserves the right
to redirect any contribution toward the project's existing shape.

## Dev setup

```bash
git clone https://github.com/randomm/pi-ensemble.git
cd pi-ensemble
./install.sh
```

The installer runs preflight checks for required CLIs (`pi`, `bun`, `git`,
`gh`, `vipune`, `colgrep`, `oo`, `jq`) — if any are missing you'll get a
named list with install hints. See README → Prerequisites for the full table.

## Build, test, lint

| Command | What it does |
|---|---|
| `bun run build` | Assembles per-role system prompts from `modules/` + `manifests/` + `agents-base/` into `dist/prompts/standard/`. |
| `cd extension && bun install` | Installs extension deps. |
| `cd extension && bunx tsc --noEmit` | Type-check. |
| `cd extension && bun run check` | Biome (lint + format check). |
| `cd extension && bun run format` | Apply biome format fixes. |
| `cd extension && bun run smoke-tests/test-command-flow.ts` | Integration smoke (offline). |
| `cd extension && bun run smoke-tests/test-lens-review.ts` | Unit smoke for review synthesis (offline). |
| `cd extension && bun run smoke-tests/test-models.ts` | Unit smoke for model resolution (offline). |
| `cd extension && bun run smoke-tests/test-runs.ts` | Unit smoke for `/runs` (offline). |
| `cd extension && bun run smoke-tests/test-spawn.ts` | **Live** — spawns a real Pi child, costs a few cents. |
| `cd extension && bun run smoke-tests/test-parallel.ts` | **Live** — three concurrent children. |
| `cd extension && bun run smoke-tests/test-lens-review-live.ts` | **Live** — full six-pass review against a synthetic diff (~$0.02 on Cerebras). |

CI runs the offline tests on every push and PR. Live tests run on the dev
machine only.

## What lives where

| Concern | Path | Rebuild after edit? |
|---|---|---|
| Slash-command bodies | `pi-prompts/*.md` | No — read at runtime |
| Per-role system prompts (source) | `agents-base/*.md`, `modules/**/*.md`, `manifests/*.manifest` | Yes — `bun run build` |
| Per-role permission matrix source | `agents.json` | Yes — `bun run build` |
| Skills | `skill/<name>/SKILL.md` | No — symlinked into `~/.pi/agent/skills/` |
| Extension code | `extension/src/*.ts`, `extension/index.ts` | No — Pi loads via jiti on next launch |
| Built artefacts | `dist/prompts/standard/*.md` | (generated, do not edit) |
| Runtime data | `~/.pi/agent/ensemble-runs/`, `~/.pi/agent/ensemble-models.json` | (runtime state) |

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/). Versioning
and CHANGELOG entries are automated by
[release-please](https://github.com/googleapis/release-please) on the `main`
branch — it reads commit messages and proposes version bumps.

Allowed types:

- `feat:` — new feature → **minor** bump
- `fix:` — bug fix → **patch** bump
- `refactor:` — internal restructure (no observable change) → patch
- `docs:` — documentation only → patch
- `test:` — test additions/changes → patch
- `chore:` — build, deps, tooling → patch
- `ci:` — CI/CD pipeline → patch
- `perf:` — performance work → patch

Append `BREAKING CHANGE: <description>` in the footer (or `!` after type, e.g.
`feat!:`) to trigger a **major** bump.

Useful scopes for this repo (optional but encouraged):

- `feat(work):` — change to the `/work` flow
- `feat(review):` — change to the six-pass review
- `feat(model):` — model resolution / picker
- `fix(spawn):` — spawn / child-process bugs
- `chore(deps):` — dependency bumps
- `docs(readme):` — README only

Examples:

```
feat(review): add per-lens retry on parse failure
fix(spawn): close stdin to prevent hang on macOS
chore(deps): bump @earendil-works/pi-coding-agent to 0.76.0
feat(work)!: replace dispatch_parallel max with PI_ENSEMBLE_MAX_PARALLEL env

BREAKING CHANGE: the hardcoded 10-slot limit is now configurable
                 via env var; default remains 10.
```

## Pi compatibility

pi-ensemble depends on Pi's CLI flags, JSON event stream shape, and
`ExtensionAPI` surface. We pin `@earendil-works/pi-coding-agent` to a tight
range in `extension/devDependencies` so a Pi minor bump is a deliberate
update, not silent drift.

When updating the pin:

1. Read the Pi changelog: `gh api repos/badlogic/pi-mono/releases | jq -r '.[0:5][] | "\(.tag_name): \(.body[0:200])"'`.
2. Bump the pin in `extension/package.json` (e.g. `~0.75.3` → `~0.76.0`).
3. Run the live smoke tests on the new version. Especially watch:
   - `agent_end.messages[].content[]` block types (we depend on `text`, `thinking`, `toolCall`).
   - Tool-call args field (we depend on `arguments`).
   - CLI flags: `-p`, `--mode json`, `--no-extensions`, `--no-session`, `--append-system-prompt`, `--session`, `--skill`, `--extension`, `--model`.
4. Update CHANGELOG.md's "Tested against pi X.Y.Z" line.
5. Open a PR with the bump + smoke-test evidence.

When Pi changes a shape we depend on (this has happened — `tool_use` →
`toolCall`), the offline smoke tests won't catch it. The live ones will, and a
future `test-pi-shape.ts` will codify the assertions. Until then, manual
inspection of a recent transcript is the canonical check.

## Adding to the modular prompt layer

To add behaviour for *every* role: write a module under `modules/<category>/`,
add it to each `manifests/<role>.manifest`, run `bun run build`. Test by
spawning a single specialist and confirming the new doctrine appears in their
output.

To add behaviour for *one* role only: append a module reference to that
role's manifest only.

To add a new skill: drop a directory under `skill/<skill-name>/` with a
`SKILL.md` (frontmatter + body, Claude-Agent-Skills compatible). Re-run
`./install.sh` to symlink it into `~/.pi/agent/skills/`.

## Issue / PR etiquette

- One concern per PR. Small + reviewable beats Big Bang.
- Include the smoke-test output in PR descriptions when changing spawn /
  review / model code.
- Use `gh issue create` or the web UI. No template — just be specific about
  what you saw and what you expected.

## License

By contributing you agree your contributions are licensed under Apache 2.0
(matches the project license).
