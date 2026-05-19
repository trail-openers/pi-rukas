# Document Types Reference

Templates and guidance for technical document types. Each entry covers purpose, audience, a template, and writing tips. Templates are starting points — adapt to the project.

## Table of Contents

1. [README](#1-readme)
2. [Architecture Overview](#2-architecture-overview)
3. [Architecture Decision Record (ADR)](#3-architecture-decision-record-adr)
4. [API Reference](#4-api-reference)
5. [Developer Setup Guide](#5-developer-setup-guide)
6. [Contributing Guide](#6-contributing-guide)
7. [Deployment Guide](#7-deployment-guide)
8. [Runbook](#8-runbook)
9. [Incident Response Plan](#9-incident-response-plan)
10. [Testing Documentation](#10-testing-documentation)
11. [Security Policy & Model](#11-security-policy--model)
12. [Configuration Reference](#12-configuration-reference)
13. [Release Process](#13-release-process)
14. [Changelog & Release Notes](#14-changelog--release-notes)
15. [RFC / Design Proposal](#15-rfc--design-proposal)
16. [Data Model Documentation](#16-data-model-documentation)
17. [Monitoring & Observability Guide](#17-monitoring--observability-guide)
18. [Troubleshooting Guide](#18-troubleshooting-guide)
19. [Glossary](#19-glossary)
20. [Documentation Index](#20-documentation-index)

---

## 1. README

**Purpose:** Orient a newcomer — what is this, why does it exist, how do I start?
**Audience:** Anyone encountering the project for the first time.
**Location:** Repository root as `README.md`.

### Template

```markdown
# Project Name

One-line description of what this project does and for whom.

[badges: build status, version, license — max 3-5]

## What is this?

2-3 paragraphs: what problem this solves, who it's for, what makes it
different. Write for someone who has never heard of this project.

## Quick start

Fastest path from zero to "it works." Copy-paste commands.

    $ install command
    $ run command

What you should see when it works.

## Usage

Key patterns with examples. Cover the 2-3 most common things.

## Documentation

Links to deeper docs — architecture, API reference, deployment guide, etc.

## Contributing

Brief pointer to CONTRIBUTING.md or inline contribution basics.

## License

License name and link.
```

### Tips

- The quick-start must actually work. Test it on a clean environment.
- Don't dump configuration options in the README — link to a config reference.
- For visual projects (UI, CLI with output), include a screenshot or terminal recording.
- Keep the README focused on orientation. Anything more than 300 lines suggests content should move to `docs/`.

---

## 2. Architecture Overview

**Purpose:** Give a reader the mental model of how the system is built.
**Audience:** New team members, senior engineers, anyone making design decisions.
**Location:** `docs/architecture.md` or `docs/architecture/overview.md`.

### Template

```markdown
# System Architecture

Last updated: YYYY-MM

## Overview

1-2 paragraphs: what the system does at a high level and the key
architectural style (monolith, microservices, event-driven, serverless, etc.).

## System diagram

[Mermaid diagram or image showing major components and their interactions]

## Components

### Component Name
- **Responsibility:** What it does and what it doesn't do
- **Technology:** Language, framework, runtime
- **Interfaces:** What it exposes (APIs, events, queues)
- **Dependencies:** What it talks to
- **Data stores:** What it owns

[Repeat for each major component]

## Data flow

How data moves through the system for key operations. Use sequence
diagrams for complex flows.

## Infrastructure

Where components run, how they're deployed, networking topology.
Link to deployment guide for operational details.

## Key design decisions

Summary of significant architectural choices. Link to individual ADRs
for full context.

## Known limitations

Architectural constraints, scaling bottlenecks, technical debt.
```

### Tips

- A system diagram is mandatory. Start with one — text alone can't convey architecture.
- Don't try to show everything in one diagram. Use a high-level overview diagram plus focused diagrams for subsystems.
- Update this document when architecture changes. An outdated architecture doc is actively harmful.
- Include the "why" alongside the "what" — link to ADRs for deeper rationale.

---

## 3. Architecture Decision Record (ADR)

**Purpose:** Capture a significant technical decision with its context, options, and rationale.
**Audience:** Current and future team members who will wonder "why did we do it this way?"
**Location:** `docs/adr/` with sequential numbering (`001-use-postgresql.md`).

### Template

```markdown
# ADR-NNN: [Decision Title]

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXX
**Date:** YYYY-MM-DD
**Deciders:** [who was involved]

## Context

What situation or problem prompted this decision? What forces are at play
— technical constraints, business requirements, team capabilities, timeline?

## Decision

What we decided and what it means concretely for the codebase/system.

## Options considered

### Option A: [Name]
How it would work. Pros. Cons.

### Option B: [Name]
How it would work. Pros. Cons.

[Add more as needed]

## Consequences

What follows from this decision — both positive and negative.
What becomes easier? What becomes harder? What new constraints exist?

## References

Links to relevant docs, discussions, benchmarks, or external resources.
```

### Tips

- Write the Context section for someone who joins the team a year from now. They weren't in the meeting.
- Rejected options are as valuable as the chosen one — they prevent relitigating.
- Keep ADRs immutable. If a decision is reversed, write a new ADR that supersedes the old one.
- ADRs don't need to be long. A clear one-page ADR beats a vague three-page one.

---

## 4. API Reference

**Purpose:** Complete reference for every interface the system exposes.
**Audience:** Developers integrating with or consuming the API.
**Location:** `docs/api/` or generated alongside code (OpenAPI, TypeDoc, RustDoc).

### Template (per endpoint)

```markdown
## Create User

Creates a new user account.

`POST /api/v1/users`

### Authentication

Requires Bearer token with `users:write` scope.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| email | string | Yes | Valid email address |
| name | string | Yes | Display name (2-100 chars) |
| role | string | No | Default: `member`. One of: `member`, `admin` |

```json
{
  "email": "dev@example.com",
  "name": "Jane Smith",
  "role": "member"
}
```

### Response

`201 Created`

```json
{
  "data": {
    "id": "usr_a1b2c3",
    "email": "dev@example.com",
    "name": "Jane Smith",
    "role": "member",
    "created_at": "2025-03-20T10:00:00Z"
  }
}
```

### Errors

| Status | Code | Description |
|--------|------|-------------|
| 400 | `invalid_email` | Email format is invalid |
| 400 | `name_too_short` | Name must be at least 2 characters |
| 409 | `email_exists` | Account with this email already exists |
| 422 | `invalid_role` | Role must be one of: member, admin |
```

### Tips

- Use realistic example data — not `foo`, `bar`, `test`. Realistic examples catch schema issues.
- Document every error the consumer might encounter. Undocumented errors are the #1 API complaint.
- For generated docs (OpenAPI, GraphQL schema), ensure descriptions are written in the source schema — auto-generated docs without descriptions are reference docs with no reference value.
- If the API is versioned, document what changed between versions and how to migrate.

---

## 5. Developer Setup Guide

**Purpose:** Get a new developer from zero to a running development environment.
**Audience:** New team members, contributors, anyone setting up the project locally.
**Location:** `docs/setup.md` or `docs/development/setup.md`.

### Template

```markdown
# Development Setup

Last verified: YYYY-MM against [OS/version]

## Prerequisites

- [Tool] version X.Y+ ([install link])
- [Tool] version X.Y+ ([install link])
- [Service] running locally or accessible at [default URL]

## Clone and install

    $ git clone <repo-url>
    $ cd project-name
    $ <install dependencies command>

## Configuration

Copy the example configuration:

    $ cp .env.example .env

Edit `.env` and set these required values:

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `DATABASE_URL` | PostgreSQL connection string | Local: `postgres://localhost/myapp_dev` |
| `API_KEY` | Third-party API key | [Link to provider dashboard] |

## Database setup

    $ <create database command>
    $ <run migrations command>
    $ <seed data command, if any>

## Run the project

    $ <start command>

You should see: [describe expected output or URL to visit].

## Run tests

    $ <test command>

All tests should pass. If they don't, see Troubleshooting below.

## Troubleshooting

### [Common problem 1]
Symptom: [what the developer sees]
Cause: [why it happens]
Fix: [how to resolve it]

### [Common problem 2]
...
```

### Tips

- Test the guide on a clean machine or in a fresh container. "Works on my machine" guides are worthless.
- List exact version requirements, not "latest." Pin to the major version the team uses.
- The Troubleshooting section is not optional. Capture every setup issue the team has encountered.
- If setup is complex, consider providing a dev container, Docker Compose, Nix flake, or Makefile.

---

## 6. Contributing Guide

**Purpose:** Explain how to contribute — process, expectations, and conventions.
**Audience:** New contributors (team members or open-source contributors).
**Location:** `CONTRIBUTING.md` in repository root.

### Template

```markdown
# Contributing to [Project Name]

## How to contribute

1. Check existing issues or create one describing what you want to change
2. Fork the repo and create a branch from `main`
3. Make your changes
4. Write or update tests
5. Run the full test suite: `<command>`
6. Submit a pull request

## Branch naming

`type/short-description` — e.g., `feature/user-auth`, `fix/null-pointer`,
`docs/api-reference`

## Commit messages

Follow [convention — e.g., Conventional Commits]:
`type(scope): description`

Examples:
- `feat(auth): add OAuth2 login flow`
- `fix(api): handle null response from upstream`
- `docs(setup): update Node.js version requirement`

## Code style

[Linter/formatter] runs automatically. To check locally:

    $ <lint command>
    $ <format command>

## Pull request expectations

- PRs should be focused — one logical change per PR
- Include tests for new functionality
- Update documentation if behavior changes
- PRs are reviewed within [timeframe]

## Code review process

[Describe who reviews, how many approvals needed, what reviewers look for]

## Getting help

[Where to ask questions — Slack channel, GitHub Discussions, email]
```

### Tips

- For open-source projects, include a Code of Conduct reference.
- Keep the process lightweight enough that a first-time contributor isn't intimidated.
- If you have architectural conventions ("we use repository pattern", "no ORM in controllers"), document them here or link to a coding guidelines doc.

---

## 7. Deployment Guide

**Purpose:** Explain how to deploy the system to each environment.
**Audience:** Engineers performing deployments, DevOps, on-call engineers.
**Location:** `docs/deployment.md` or `docs/operations/deployment.md`.

### Template

```markdown
# Deployment Guide

## Architecture overview

Brief description of deployment topology. Link to architecture doc.

## Environments

| Environment | URL | Purpose | Deploy method |
|-------------|-----|---------|---------------|
| Development | localhost:3000 | Local dev | Manual |
| Staging | staging.example.com | Pre-prod validation | Auto on merge to main |
| Production | app.example.com | Live | Manual promotion from staging |

## Prerequisites

- Access to [deployment system/platform]
- [Required credentials or permissions]
- [Required tools installed locally]

## Deployment steps

### Staging (automatic)

Merges to `main` deploy automatically via [CI system]. Monitor at [dashboard URL].

### Production

1. Verify staging is green: [link to staging health check]
2. [Step-by-step deployment commands or UI steps]
3. Verify deployment: [smoke test commands or URLs]
4. Monitor for [duration]: [link to dashboards]

## Rollback

If something goes wrong after deploying:

    $ <rollback command or steps>

Rollback takes approximately [duration] and [describe impact during rollback].

## Database migrations

Migrations run [automatically/manually] during deployment.

If a migration fails:
1. [Recovery steps]
2. [How to check migration status]

## Environment-specific configuration

[What differs between environments and how to manage it]

## Troubleshooting

### Deploy is stuck at [stage]
[Resolution steps]

### Health check failing after deploy
[Resolution steps]
```

### Tips

- Include rollback as a first-class section, not an afterthought. When you need rollback instructions, you need them urgently.
- Document the "happy path" first, then failure scenarios.
- If deployment involves multiple services or coordination (blue-green, canary), document the orchestration.

---

## 8. Runbook

**Purpose:** Step-by-step instructions for handling a specific operational scenario.
**Audience:** On-call engineers, operators — often at 3am under pressure.
**Location:** `docs/runbooks/` with one file per scenario.

### Template

```markdown
# Runbook: [Scenario Name]

**Severity:** P1 / P2 / P3
**Last tested:** YYYY-MM-DD
**Owner:** [team or person]

## Symptoms

What does this look like? What alerts fire? What do users report?
Be specific — paste actual alert text or error messages.

## Impact

What is affected? Users? Internal systems? Data integrity?

## Quick mitigation

The fastest way to reduce impact, even if it's not a permanent fix:

    $ <command to mitigate>

Expected result: [what should change]

## Diagnosis

Step-by-step investigation:

1. Check [specific dashboard or log]: `<command>`
   - If you see [X], go to step 2
   - If you see [Y], this is a different issue — see [other runbook]
2. Check [next thing]: `<command>`
3. ...

## Resolution

Once you've identified the cause:

### Cause A: [Description]
    $ <fix commands>
Verify: [how to confirm it's fixed]

### Cause B: [Description]
    $ <fix commands>
Verify: [how to confirm it's fixed]

## Escalation

If the above doesn't resolve it:
- Escalate to: [team/person]
- How: [Slack channel / PagerDuty / phone]
- What to include: [information they'll need]

## Post-incident

- [ ] Update this runbook if you learned something new
- [ ] File post-mortem if impact exceeded [threshold]
```

### Tips

- Write for someone who is stressed and has never seen this failure before. No assumed context.
- Use exact commands, not "check the logs." Which logs? What command? What are you looking for?
- Test runbooks periodically. An untested runbook is a guess.
- Include the "quick mitigation" section — often you need to stop the bleeding before diagnosing.

---

## 9. Incident Response Plan

**Purpose:** Define how the team responds to production incidents.
**Audience:** All engineers, especially on-call.
**Location:** `docs/operations/incident-response.md`.

### Template

```markdown
# Incident Response

## Severity levels

| Level | Definition | Response time | Examples |
|-------|-----------|---------------|----------|
| P1 | Service down or major data loss | Immediate | Complete outage, data corruption |
| P2 | Degraded service, workaround exists | < 1 hour | Slow responses, partial feature failure |
| P3 | Minor issue, no user impact | Next business day | Internal tool broken, log noise |

## When an incident starts

1. **Acknowledge** the alert in [system]
2. **Assess severity** using the table above
3. **Communicate** in [incident channel] — state what you know and don't know
4. **Mitigate** — consult the relevant [runbook](/docs/runbooks/)
5. **Escalate** if needed — see escalation paths below

## Roles during an incident

- **Incident Commander:** Coordinates response, communicates status
- **Responder:** Investigates and fixes
- **Communicator:** Updates stakeholders (for P1/P2)

## Escalation paths

| System | Primary | Secondary | Contact |
|--------|---------|-----------|---------|
| [Service A] | [Team/person] | [Backup] | [How to reach them] |

## Communication templates

**Initial (internal):** "Investigating [symptom] affecting [scope]. Severity: [Px]. Updates in [channel]."

**Status update:** "[Time elapsed]. Status: [investigating/mitigating/resolved]. Current understanding: [brief]. Next step: [what]."

## After the incident

- [ ] Write post-mortem within [timeframe]
- [ ] Identify action items
- [ ] Update runbooks with anything learned
- [ ] Review in next team sync
```

---

## 10. Testing Documentation

**Purpose:** Explain the testing strategy, how to run tests, and how to write new ones.
**Audience:** All developers working on the project.
**Location:** `docs/testing.md` or section in CONTRIBUTING.md for smaller projects.

### Template

```markdown
# Testing

## Strategy

What levels of testing we use and what each level covers:

- **Unit tests:** [scope, what's mocked, target coverage]
- **Integration tests:** [scope, what external systems are involved]
- **End-to-end tests:** [scope, how they run, environments needed]

## Running tests

    $ <unit test command>
    $ <integration test command>
    $ <e2e test command>
    $ <full suite command>

### Test environment requirements

[What needs to be running — databases, services, etc.]
[How to set up test data — fixtures, factories, seeds]

## Writing tests

### Where to put tests
[Directory structure, naming conventions, co-location rules]

### Patterns we use
[Test structure — Arrange/Act/Assert, Given/When/Then, etc.]
[Mocking conventions — what to mock, what not to mock]
[Factory/fixture patterns for test data]

### Example

```[language]
[A complete, annotated example test following the team's conventions]
```

## Coverage

Current target: [X%] (checked in CI)
View coverage report: `<command>`

## Known issues

[Flaky tests, slow tests, known limitations, things not yet covered]
```

---

## 11. Security Policy & Model

**Purpose:** Document the security posture — vulnerability handling, auth model, data protection.
**Audience:** Security teams, auditors, developers, users reporting vulnerabilities.
**Location:** `SECURITY.md` in repo root (vulnerability policy), `docs/security/` for deeper docs.

### Template — SECURITY.md

```markdown
# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability, please report it responsibly:

**Email:** security@example.com
**PGP key:** [link, if applicable]

Please do NOT open a public GitHub issue for security vulnerabilities.

We will acknowledge your report within [timeframe] and provide a fix
within [timeframe] for critical issues.

## Supported versions

| Version | Supported |
|---------|-----------|
| X.Y | Yes |
| X.Z | Security fixes only |
| < X.0 | No |

## Security practices

- Dependencies scanned [how often] via [tool]
- [Other security practices — SAST, secrets scanning, etc.]
```

### Template — Security Model Doc

```markdown
# Security Model

## Authentication

How users/services authenticate. Mechanisms used (JWT, OAuth2, API keys,
mTLS). Token lifecycle — issuance, expiry, refresh, revocation.

## Authorization

Permission model — RBAC, ABAC, or other. Roles, permissions, how they
map to actions. How authorization is enforced (middleware, policy engine).

## Data protection

- Encryption at rest: [what's encrypted, with what]
- Encryption in transit: [TLS versions, certificate management]
- PII handling: [what PII exists, how it's classified, retention policy]

## Secrets management

Where secrets are stored. How they're rotated. Who has access.

## Audit logging

What's logged, where, retention period. How to query audit logs.

## Compliance

Applicable regulations (GDPR, SOC2, HIPAA, etc.) and how they're addressed.
```

---

## 12. Configuration Reference

**Purpose:** Complete reference for all configuration options.
**Audience:** Developers and operators configuring the system.
**Location:** `docs/configuration.md`. Also provide `.env.example` or `config.example.yml` in repo root.

### Template

```markdown
# Configuration Reference

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | One of: `debug`, `info`, `warn`, `error` |
| `FEATURE_NEW_UI` | No | `false` | Enable new UI (experimental) |

## Configuration file

The system reads `config.yml` from the working directory. All values can
be overridden by environment variables (env vars take precedence).

```yaml
# config.yml — annotated example
server:
  port: 3000          # HTTP port
  host: "0.0.0.0"     # Bind address
  workers: 4          # Number of worker processes

database:
  pool_size: 10       # Connection pool size
  timeout: 5000       # Query timeout in ms
```

## Feature flags

| Flag | Default | Description | Lifecycle |
|------|---------|-------------|-----------|
| `FEATURE_NEW_UI` | off | Redesigned dashboard | Beta, targeting GA in v3.2 |

## Environment differences

| Setting | Development | Staging | Production |
|---------|-------------|---------|------------|
| `LOG_LEVEL` | debug | info | warn |
| `POOL_SIZE` | 2 | 5 | 20 |
```

### Tips

- Include every configuration option. Developers discover missing docs by getting runtime errors.
- Show the default and whether it's required — these are the two things people look for first.
- For feature flags, document their purpose and lifecycle (experimental → beta → GA → deprecated).

---

## 13. Release Process

**Purpose:** Document how releases are created and shipped.
**Audience:** Anyone who performs or approves releases.
**Location:** `docs/release-process.md` or `docs/processes/release.md`.

### Template

```markdown
# Release Process

## Versioning

We use [SemVer / CalVer / other]. Version format: [describe].

## Release cadence

[Schedule — weekly, biweekly, on-demand, etc.]

## Steps to release

1. Ensure `main` is green on CI
2. Update CHANGELOG.md with release notes
3. Bump version: `<command>`
4. Create release PR and get approval
5. Merge and tag: `<command>`
6. [Automated steps — CI publishes, deploys, etc.]
7. Verify release: [smoke tests, monitoring checks]
8. Announce: [where — Slack, email, release page]

## Hotfix process

For critical fixes that can't wait for the next release:

1. Branch from the release tag: `git checkout -b hotfix/description vX.Y.Z`
2. Fix, test, PR against `main` and the release branch
3. Follow normal release steps with a patch version bump

## Who can release

[Roles/people authorized to publish releases]
```

---

## 14. Changelog & Release Notes

**Purpose:** Communicate what changed in each release.
**Audience:** Users, operators, developers upgrading.
**Location:** `CHANGELOG.md` in repository root.

### Template

```markdown
# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- [Feature description with context — what it does, not just what changed]

### Changed
- [Behavior changes that affect users]

### Fixed
- [Bug fixes — describe the bug that was fixed, not just the fix]

### Deprecated
- [Features that will be removed — include timeline and migration path]

### Removed
- [Features removed — link to migration guide if applicable]

### Security
- [Security-related changes — CVE references if applicable]

## [X.Y.Z] — YYYY-MM-DD

[Same structure as above]
```

### Tips

- Write for the reader who needs to decide whether to upgrade and what will break.
- "Fixed null pointer in user service" is developer context. "Fixed a crash that occurred when creating users without an email" is user context. Write the latter.
- For breaking changes, always include a migration path or link to one.

---

## 15. RFC / Design Proposal

**Purpose:** Propose a significant change and invite discussion before implementation.
**Audience:** Team members who need to evaluate and decide on the proposal.
**Location:** `docs/rfcs/` or `docs/proposals/`.

### Template

```markdown
# RFC: [Title]

**Author:** [name]
**Date:** YYYY-MM-DD
**Status:** Draft | In Discussion | Accepted | Rejected | Withdrawn

## Summary

One paragraph: what you're proposing and why.

## Motivation

What problem does this solve? Why now? What happens if we don't do this?

## Detailed design

How it works. Be specific enough that someone could implement from this doc.
Include diagrams, data models, API changes, or whatever makes the design
concrete.

## Drawbacks

Why might we NOT want to do this? Be honest — every approach has costs.

## Alternatives

What other approaches were considered? Why is this one better?

## Unresolved questions

What still needs to be figured out during implementation?

## Implementation plan

Rough phasing — what gets built first, estimated effort, dependencies.
```

---

## 16. Data Model Documentation

**Purpose:** Document entities, relationships, and data flows.
**Audience:** Developers working with the data layer, data engineers, analysts.
**Location:** `docs/data-model.md` or `docs/architecture/data-model.md`.

### Template

```markdown
# Data Model

## Entity relationship diagram

[Mermaid ER diagram]

## Entities

### User
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | uuid | PK | Unique identifier |
| email | varchar(255) | Unique, Not null | Login email |
| name | varchar(100) | Not null | Display name |
| created_at | timestamp | Not null | Account creation time |

**Relationships:**
- Has many Orders
- Belongs to Organization (optional)

**Notes:**
[Soft delete? Audit trail? PII classification? Migration history?]

[Repeat for each entity]

## Key data flows

### [Flow name — e.g., "Order placement"]
[Sequence diagram or prose describing how data moves through entities]

## Conventions

- [Primary key format — UUID, ULID, auto-increment]
- [Timestamp handling — timezone, format]
- [Soft delete vs hard delete policy]
- [Naming conventions — snake_case, plural table names, etc.]
```

---

## 17. Monitoring & Observability Guide

**Purpose:** Document what's monitored, how to read dashboards, and what alerts mean.
**Audience:** On-call engineers, operators, developers investigating issues.
**Location:** `docs/operations/monitoring.md`.

### Template

```markdown
# Monitoring & Observability

## Dashboards

| Dashboard | URL | What it shows |
|-----------|-----|---------------|
| Service Health | [link] | Request rate, error rate, latency |
| Infrastructure | [link] | CPU, memory, disk, network |
| Business Metrics | [link] | Active users, transactions, revenue |

## Key metrics

| Metric | Normal range | Warning | Critical |
|--------|-------------|---------|----------|
| Request latency (p99) | < 200ms | 200-500ms | > 500ms |
| Error rate | < 0.1% | 0.1-1% | > 1% |
| CPU utilization | < 60% | 60-80% | > 80% |

## Alerts

### [Alert Name]
**Fires when:** [condition]
**Means:** [what's actually happening]
**Action:** [what to do — link to runbook]

## Logging

| Service | Log location | How to query |
|---------|-------------|--------------|
| API | [location] | `<query command>` |
| Workers | [location] | `<query command>` |

### Log levels
- `error` — Something failed that shouldn't have. Investigate.
- `warn` — Unexpected but handled. Watch for patterns.
- `info` — Normal operations. Useful for tracing request flows.
- `debug` — Detailed internals. Not enabled in production by default.

## Tracing

[How distributed tracing works, how to find a trace, how to read it]
```

---

## 18. Troubleshooting Guide

**Purpose:** Help users and developers diagnose and fix common problems.
**Audience:** Anyone who encounters a problem.
**Location:** `docs/troubleshooting.md` or as sections within relevant docs.

### Template

```markdown
# Troubleshooting

## [Problem category — e.g., Installation]

### [Symptom — what the user sees]

**Error message:**
```
[Exact error message or output]
```

**Cause:** [Why this happens]

**Solution:**
[Step-by-step fix]

**If that doesn't work:**
[Escalation path or alternative fix]
```

### Tips

- Use the exact error message as the heading or near it — people search by error text.
- Give the fix, not just the explanation. "This happens because of X" without a resolution is frustrating.
- Organize by symptom, not by cause. The reader knows what they see, not why.

---

## 19. Glossary

**Purpose:** Define project-specific terms, acronyms, and domain jargon.
**Audience:** Anyone new to the project or domain.
**Location:** `docs/glossary.md`.

### Template

```markdown
# Glossary

| Term | Definition |
|------|-----------|
| **ADR** | Architecture Decision Record — a document capturing a significant technical decision |
| **Backfill** | Retroactively processing historical data through a new or updated pipeline |
| **Circuit breaker** | A pattern that prevents cascading failures by stopping requests to a failing service |
```

### Tips

- Include domain terms, not just technical ones. If your business domain uses specific language (financial instruments, medical terms, logistics jargon), define them.
- Alphabetical order. Always.
- Link to the glossary from documents where jargon first appears.

---

## 20. Documentation Index

**Purpose:** A map of all documentation — what exists, where it is, who it's for.
**Audience:** Anyone looking for documentation.
**Location:** `docs/README.md` or `docs/index.md`.

### Template

```markdown
# Documentation

## Getting started
- [README](../README.md) — What this project is and how to start
- [Developer Setup](setup.md) — Get your development environment running
- [Contributing](../CONTRIBUTING.md) — How to contribute

## Architecture
- [Architecture Overview](architecture/overview.md) — System design and components
- [Data Model](architecture/data-model.md) — Entities and relationships
- [ADRs](adr/) — Architecture decision records

## API
- [API Reference](api/reference.md) — Complete endpoint documentation
- [Authentication](api/authentication.md) — How to authenticate

## Operations
- [Deployment Guide](operations/deployment.md) — How to deploy
- [Runbooks](runbooks/) — Operational procedures
- [Monitoring](operations/monitoring.md) — Dashboards, alerts, and logging
- [Incident Response](operations/incident-response.md) — How we handle incidents

## Processes
- [Release Process](processes/release.md) — How releases work
- [Security Policy](../SECURITY.md) — Vulnerability reporting

## Reference
- [Configuration](configuration.md) — All config options
- [Glossary](glossary.md) — Terms and definitions
- [Changelog](../CHANGELOG.md) — What changed in each release
```

### Tips

- Keep this up to date. An outdated index is worse than no index — it sends readers to dead links.
- Group by reader need, not by file structure.
- Add a one-line description for each link so readers can decide what to click without opening every page.
