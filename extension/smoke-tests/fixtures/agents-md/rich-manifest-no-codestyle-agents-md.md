# Rich Manifest, No Code Style — AGENTS.md (fixture)

A hand-authored AGENTS.md for a bun + package.json repository with a
populated environment section but NO Code Style managed section. This fixture
exists to assert the "rich-manifest + code-style absent" dispatch path: the
trigger fires (code-style section is absent), but the dispatch is scoped to
code-style ONLY — the child's `AgentFacts.commands`/`manifest`/`language`
fields are IGNORED for the 3 fact sections; only `codeStyleBullets` is passed
through to `agentOverride`.

The fixture carries the three fact sections (with `[auto,...]` ledger rows —
the rich-manifest shape) and the decision-ledger, but NO code-style section.

<!-- pi-rukas:agents-md:begin quality-gates v1 -->
Run these before pushing. All must pass locally:

- **bun test** — `bun run test`
- **bun lint** — `bun run lint`
- **bun build** — `bun run build`
<!-- pi-rukas:agents-md:end quality-gates -->

<!-- pi-rukas:agents-md:begin commands v1 -->
| kind | command |
| --- | --- |
| test | `bun run test` |
| lint | `bun run lint` |
| build | `bun run build` |
| typecheck | `bunx tsc --noEmit` |
<!-- pi-rukas:agents-md:end commands -->

<!-- pi-rukas:agents-md:begin environment v1 -->
- Manifest: `package.json`
- Package manager: `bun`
- Language: `typescript`
- CI workflows: `.github/workflows/ci.yml`
<!-- pi-rukas:agents-md:end environment -->

<!-- pi-rukas:agents-md:begin decision-ledger v1 -->
| key | value | provenance |
| --- | --- | --- |
| quality-gates | bun test, lint, build | [auto:2026-01-01] |
| commands | bun test, lint, build, typecheck | [auto:2026-01-01] |
| environment | package.json, bun, typescript | [auto:2026-01-01] |
<!-- pi-rukas:agents-md:end decision-ledger -->

## Project notes (operator-authored)

This is a bun + TypeScript project. The manifest is `package.json` with a
`bun.lock` lockfile — `detectFacts(root).manifest` is `"package.json"` (rich
manifest), so the pre-pass dispatch is scoped to code-style ONLY. The child's
`AgentFacts.commands`/`manifest`/`language` fields are ignored for the 3 fact
sections; only `codeStyleBullets` is passed through to `agentOverride`.

The `[auto,...]` ledger rows for the 3 fact sections must NEVER be converted
to `[detected:agent,...]` by a code-style-only dispatch.
