# Ruby Greenfield — AGENTS.md (fixture)

A hand-authored AGENTS.md for a Gemfile-only repository (no package.json, no
Cargo.toml, no go.mod, no pyproject.toml). This fixture exists to assert that
`detectFacts(root).manifest === undefined` — the pre-pass dispatch trigger
fires for this repo shape.

The file carries the full marker-wrapped managed-section shape a brownfield
`update` would produce after a B1/B2 agent pre-pass: the three fact sections
plus the code-style section plus the decision-ledger.

<!-- pi-rukas:agents-md:begin quality-gates v1 -->
Run these before pushing. All must pass locally:

- **bundle test** — `bundle exec rspec`
- **bundle rubocop** — `bundle exec rubocop`
<!-- pi-rukas:agents-md:end quality-gates -->

<!-- pi-rukas:agents-md:begin commands v1 -->
| kind | command |
| --- | --- |
| test | `bundle exec rspec` |
| lint | `bundle exec rubocop` |
| build | `bundle exec rake build` |
<!-- pi-rukas:agents-md:end commands -->

<!-- pi-rukas:agents-md:begin environment v1 -->
- Manifest: `Gemfile`
- Package manager: `ruby`
- Language: `ruby`
- CI workflows: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`
<!-- pi-rukas:agents-md:end environment -->

<!-- pi-rukas:agents-md:begin code-style v1 -->
- Follow RuboCop defaults; no custom RuboCop config
- Frozen string literals: `# frozen_string_literal: true` required in all files
- No `require` in method bodies — top-level `require` only
- RSpec: one describe block per class, `let` for shared fixtures
- Rake tasks: `Rake::Task` with `prereq` chains, never raw `sh`
<!-- pi-rukas:agents-md:end code-style -->

<!-- pi-rukas:agents-md:begin decision-ledger v1 -->
| key | value | provenance |
| --- | --- | --- |
| quality-gates | bundle test, rubocop | [detected:agent,2026-01-01] |
| commands | bundle exec rspec, rubocop, rake build | [detected:agent,2026-01-01] |
| environment | Gemfile, ruby | [detected:agent,2026-01-01] |
<!-- pi-rukas:agents-md:end decision-ledger -->

## Project notes (operator-authored)

This is a small internal Ruby service. The manifest is `Gemfile`; there is no
package.json, no Cargo.toml, no go.mod, no pyproject.toml — so
`detectFacts(root).manifest` is `undefined` and the pre-pass dispatch trigger
fires (the agent must supply the facts).

The CI workflows are `ci.yml` and `publish.yml` (raw filenames; the
`.github/workflows/` prefix is applied by the renderer, not stored here).
