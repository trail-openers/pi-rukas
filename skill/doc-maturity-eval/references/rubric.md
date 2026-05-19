# Documentation Maturity Rubric

Detailed scoring criteria for each evaluation dimension. Each dimension is scored 0–4. Use the level descriptors to determine the most appropriate score — if a project falls between two levels, use your judgment and note why in the evaluation.

## Table of Contents

1. [Project Identity & Orientation](#1-project-identity--orientation)
2. [Architecture & Design](#2-architecture--design)
3. [API & Interface Documentation](#3-api--interface-documentation)
4. [Developer Onboarding & Guides](#4-developer-onboarding--guides)
5. [Operational Documentation](#5-operational-documentation)
6. [Testing Documentation](#6-testing-documentation)
7. [Security Documentation](#7-security-documentation)
8. [Configuration & Environment](#8-configuration--environment)
9. [Process & Governance](#9-process--governance)
10. [Maintenance & Sustainability](#10-maintenance--sustainability)
11. [Cross-cutting Quality](#11-cross-cutting-quality)

---

## 1. Project Identity & Orientation

What someone sees in the first 60 seconds of encountering the project. This dimension answers: "What is this, why should I care, and how do I start?"

### What to look for

- README.md (or equivalent)
- Project description / elevator pitch
- Quick-start or getting-started guide
- Badge/status indicators (build status, version, license)
- Screenshots or demo links for visual projects
- Link to live instance or demo environment
- "Who is this for?" section

### Scoring

**0 — Absent:** No README or project description exists. A newcomer has no idea what this project does.

**1 — Ad-hoc:** A README exists but it's a skeleton (auto-generated boilerplate, just the project name, or a few sentences that don't explain what the project actually does). No quick-start. A newcomer would have to read source code to understand the project.

**2 — Basic:** README clearly explains what the project is and what problem it solves. There's some form of getting-started instructions, but they may be incomplete or assume too much context. A newcomer can understand the project's purpose but might struggle to get it running.

**3 — Solid:** README is comprehensive — clear purpose, target audience, quick-start that actually works, prerequisites listed, basic usage examples. A competent developer can go from zero to running in under 15 minutes. License and status are visible.

**4 — Exemplary:** README is a landing page for the project. Clear value proposition, quick-start with copy-paste examples, links to deeper docs, screenshots/diagrams where helpful, contribution pointers, badges for build/coverage/version. The project makes a strong first impression and respects the reader's time.

---

## 2. Architecture & Design

How well the system's design is documented — its components, their relationships, the decisions behind them, and how data flows through the system.

### What to look for

- Architecture overview / system design document
- Component diagrams (C4 model, boxes-and-arrows, UML)
- Architecture Decision Records (ADRs)
- Data flow diagrams
- Data model / entity relationship documentation
- Sequence diagrams for key workflows
- Technology choice rationale
- Domain model / bounded context documentation (for DDD projects)
- Integration points with external systems

### Scoring

**0 — Absent:** No architecture documentation. System design exists only in people's heads (or has been lost entirely).

**1 — Ad-hoc:** Some architectural notes exist — maybe a diagram in a slide deck, a whiteboard photo, or scattered comments. Nothing systematic, probably outdated. You'd need to talk to someone to understand how the system works.

**2 — Basic:** An architecture overview exists describing the main components and how they interact. Might be a single document or diagram. Gives a newcomer the mental model, but lacks detail on decisions, trade-offs, or edge cases. Probably not kept fully up to date.

**3 — Solid:** Well-structured architecture documentation covering system components, their responsibilities, key interactions, and technology choices. ADRs or equivalent capture significant decisions and their rationale. Diagrams are present and reasonably current. A senior engineer joining the team can understand the system in a day.

**4 — Exemplary:** Comprehensive architecture documentation with multiple views (logical, deployment, data flow). ADRs cover not just what was decided but alternatives considered and trade-offs accepted. Diagrams are maintained alongside code (e.g., generated or version-controlled). Domain model is well-documented. Documentation evolves with the system — there's a culture of updating architecture docs when the architecture changes.

---

## 3. API & Interface Documentation

How well the project's interfaces are documented — whether that's REST APIs, GraphQL schemas, library APIs, CLI interfaces, event schemas, or IPC contracts.

### What to look for

- API reference documentation (endpoints, methods, parameters, responses)
- OpenAPI/Swagger specs, GraphQL schema docs, or equivalent
- Request/response examples with realistic data
- Error codes and error response documentation
- Authentication/authorization documentation for APIs
- Rate limiting and usage policies
- SDK/client library documentation
- Versioning and deprecation information
- Webhook/event documentation
- CLI help text and man pages
- Library API docs (generated or hand-written)

### Scoring

**0 — Absent:** No API documentation. Users must read source code to understand how to interact with the system.

**1 — Ad-hoc:** Some API docs exist but they're incomplete — maybe a few endpoints documented, or a Swagger spec that's out of sync with the actual API. Error handling is undocumented. No examples.

**2 — Basic:** Most API endpoints/methods are documented with parameters and response formats. Some examples exist. But coverage has gaps — newer endpoints might be missing, edge cases are undocumented, error responses are incomplete.

**3 — Solid:** Comprehensive API documentation covering all public interfaces. Every endpoint has parameters, response formats, at least one example, and error documentation. Authentication is explained. The docs are generally kept up to date. A developer can integrate with the API using only the docs.

**4 — Exemplary:** API docs include runnable examples, comprehensive error catalogs, edge case documentation, versioning information, migration guides between versions, and rate limiting details. Generated docs (Swagger/OpenAPI, TypeDoc, RustDoc) are integrated into the workflow so they can't drift from implementation. Interactive API explorers or playground available.

---

## 4. Developer Onboarding & Guides

How effectively the documentation helps new developers become productive — from setting up their environment to making their first contribution.

### What to look for

- Development environment setup guide
- Prerequisites and dependency installation
- IDE/editor configuration recommendations
- Contributing guidelines (CONTRIBUTING.md)
- Code style guide or linting configuration docs
- Branching strategy documentation
- PR/MR process and expectations
- How to run the project locally
- Tutorial or walkthrough for common development tasks
- Troubleshooting guide for setup issues
- Glossary of project-specific terms

### Scoring

**0 — Absent:** No onboarding documentation. New developers rely entirely on asking teammates or reverse-engineering the setup.

**1 — Ad-hoc:** Some setup notes exist — maybe a few lines in the README about required tools, or an outdated wiki page. A new developer will hit multiple undocumented steps and need to ask for help to get running.

**2 — Basic:** A setup guide covers the main steps to get the project running locally. Contributing guidelines exist in some form. But there are gaps — some prerequisites are assumed, platform-specific issues aren't covered, or the guide hasn't been validated recently.

**3 — Solid:** Comprehensive setup guide that works on supported platforms. Contributing guidelines are clear about process, expectations, and code standards. A new developer can get from zero to a passing test suite by following the docs, with minimal help needed. Common pitfalls are documented.

**4 — Exemplary:** Onboarding is a first-class concern. Setup is either automated (dev containers, Nix flakes, Makefiles) or meticulously documented with troubleshooting for common issues. Contributing guide covers not just process but architectural conventions and "how we do things here." Glossary exists for domain terms. Tutorials walk through common development tasks. New developers consistently report smooth onboarding.

---

## 5. Operational Documentation

How well the documentation supports running the system in production — deploying, monitoring, responding to incidents, and maintaining reliability.

### What to look for

- Deployment guide (how to deploy, where, prerequisites)
- Infrastructure documentation (what's provisioned, how it's managed)
- Runbooks for common operational tasks
- Incident response procedures
- Monitoring and alerting documentation (what's monitored, where to look, what thresholds mean)
- Logging documentation (what's logged, log levels, how to query)
- Backup and restore procedures
- Scaling documentation (horizontal, vertical, auto-scaling configuration)
- Disaster recovery plan
- On-call guide and escalation procedures
- SLA/SLO definitions
- Post-mortem / post-incident review templates and archives

### Scoring

**0 — Absent:** No operational documentation. Deployment and incident response knowledge exists only in specific people's heads. The bus factor for production operations is 1.

**1 — Ad-hoc:** Some operational notes exist — maybe a deploy script with comments, a Slack thread bookmarked with "how to restart the thing", or a half-finished wiki page. Not reliable enough to follow during an actual incident.

**2 — Basic:** Deployment process is documented and reproducible. Basic monitoring is documented (where to look, what dashboards exist). But runbooks are missing or incomplete, incident response is informal, and there's no disaster recovery plan.

**3 — Solid:** Comprehensive operational docs covering deployment, monitoring, common operational procedures, and incident response. Runbooks exist for known failure modes. On-call engineers can handle common issues using the docs. Monitoring and alerting are documented well enough to understand what's normal and what's not.

**4 — Exemplary:** Operational excellence in documentation. Runbooks are tested and maintained. Incident response is well-defined with clear escalation paths. Post-mortems are archived and their action items tracked. SLOs are defined and documented. Disaster recovery is documented and periodically tested. Documentation is part of the incident response process — every post-mortem checks if runbooks need updating.

### Applicability note

This dimension is most relevant for deployed services and platforms. For libraries, CLI tools, and other non-deployed software, score as N/A or evaluate only the applicable aspects (e.g., release process, distribution documentation).

---

## 6. Testing Documentation

How well the project's testing strategy, practices, and expectations are documented.

### What to look for

- Testing strategy document (what's tested, how, at what level)
- How to run tests (unit, integration, e2e)
- Test environment setup requirements
- Coverage expectations and current metrics
- Test data management approach
- Mocking/stubbing conventions
- Performance/load testing documentation
- Test naming conventions
- CI/CD test pipeline documentation
- How to write new tests (patterns, examples)
- Known test limitations or flaky tests

### Scoring

**0 — Absent:** No testing documentation. It's unclear whether tests exist, how to run them, or what they cover.

**1 — Ad-hoc:** Tests exist in the codebase but how to run them is undocumented or only in a CI config. No testing strategy. A new developer would need to figure out the test setup by reading CI configs and test files.

**2 — Basic:** How to run tests is documented (commands, prerequisites). Test structure is somewhat apparent from directory layout. But there's no documented testing strategy, coverage expectations, or guidance on writing new tests.

**3 — Solid:** Testing strategy is documented — what levels of testing are used, what coverage is expected, how test environments work. How to run all test types is clearly documented. Conventions for writing tests are established. A new developer knows where to put tests and what patterns to follow.

**4 — Exemplary:** Comprehensive testing documentation covering strategy, execution, conventions, and continuous improvement. Test data management is documented. Performance testing approach is defined. Flaky test policy exists. Testing docs are integrated into contributing guidelines so writing tests is part of the development workflow, not an afterthought.

---

## 7. Security Documentation

How well security considerations, practices, and requirements are documented.

### What to look for

- Security model overview (authentication, authorization architecture)
- Auth/authz documentation (how it works, roles, permissions)
- Vulnerability disclosure policy (SECURITY.md)
- Dependency security scanning documentation
- Secrets management approach
- Data classification and handling policies
- GDPR/compliance documentation (if applicable)
- Security review process
- Penetration testing records (existence of, not content)
- Network security / firewall / access control docs
- Encryption approach (at rest, in transit)
- Audit logging documentation
- Third-party security certifications or compliance

### Scoring

**0 — Absent:** No security documentation. Auth model, secrets management, and vulnerability handling are undocumented.

**1 — Ad-hoc:** Some security-related information exists but it's scattered — maybe auth is partially described in API docs, or there's a note about secrets in the README. No security policy, no vulnerability disclosure process.

**2 — Basic:** Authentication and authorization are documented at a functional level (how to authenticate, what roles exist). SECURITY.md or equivalent exists with a vulnerability reporting contact. Secrets management approach is documented. But the security model isn't comprehensively described, and compliance considerations are absent.

**3 — Solid:** Security model is well-documented — auth architecture, permission model, data handling practices. Vulnerability disclosure policy is clear. Secrets management is documented and follows best practices. Dependency scanning is in place and documented. Compliance requirements (if any) are identified and documented.

**4 — Exemplary:** Security documentation is comprehensive and maintained. Threat model exists. Security review process is defined. Audit logging is documented. Compliance requirements are tracked with evidence. Security is integrated into the development workflow documentation (secure coding guidelines, security review checklist). Regular security documentation reviews happen.

### Applicability note

The depth of security documentation should match the project's risk profile. A personal blog engine doesn't need a threat model, but it should still have a SECURITY.md. A financial services platform needs everything.

---

## 8. Configuration & Environment

How well the project's configuration options, environment variables, feature flags, and environment-specific behaviors are documented.

### What to look for

- Environment variable documentation (complete list, descriptions, defaults, required vs. optional)
- Configuration file documentation (format, options, examples)
- Feature flag documentation
- Environment-specific configuration (dev, staging, production differences)
- Secrets/credentials configuration (without exposing actual secrets)
- Third-party service configuration (API keys, endpoints)
- Example configuration files (.env.example, config.example.yml)
- Infrastructure-as-code documentation (if applicable)
- Configuration validation and error messages

### Scoring

**0 — Absent:** No configuration documentation. Which env vars are needed, what config options exist, and how environments differ is undocumented. Developers discover required configuration by encountering runtime errors.

**1 — Ad-hoc:** Some configuration is documented — maybe a partial .env.example or some env vars mentioned in the README. But coverage is incomplete, descriptions are missing, and it's unclear which configurations are required vs. optional.

**2 — Basic:** An .env.example or similar exists covering the main configuration. Required vs. optional is generally clear. But descriptions are terse, defaults aren't always documented, and environment-specific differences aren't covered.

**3 — Solid:** Comprehensive configuration documentation — all env vars and config options listed with descriptions, types, defaults, and whether they're required. Example configs are complete and maintained. Environment differences are documented. A developer can configure the project for their needs without guessing.

**4 — Exemplary:** Configuration is self-documenting (validation with clear error messages, typed config with documentation, JSON schema for config files). Complete documentation covers every option with use cases. Feature flags are documented with their purpose and lifecycle. Configuration changes are part of the change management process.

---

## 9. Process & Governance

How well the project documents its development processes, decision-making, and workflows.

### What to look for

- Release process documentation
- Code review guidelines and expectations
- RFC or proposal process for significant changes
- Decision-making process documentation
- Branch strategy and git workflow
- Issue/ticket management conventions
- Communication channels and their purposes
- Meeting cadence and documentation
- Roadmap or prioritization documentation
- Stakeholder communication process
- On-call rotation process
- Change management / change approval process
- License and intellectual property documentation

### Scoring

**0 — Absent:** No process documentation. How releases happen, how decisions are made, and how changes flow through the system is entirely tribal knowledge.

**1 — Ad-hoc:** Some processes are informally documented — maybe a note in the wiki about the release process, or a git branch naming convention in the README. But most processes are undocumented or documented only by example (look at how the last PR was done).

**2 — Basic:** Key processes are documented — release process, basic code review expectations, branching strategy. But governance is light — no RFC process, decision-making is informal, and processes may not be consistently followed.

**3 — Solid:** Well-documented processes covering the full development lifecycle. Release process is clear and repeatable. Code review guidelines set expectations. There's a process for proposing significant changes (RFC, design doc, ADR). Roles and responsibilities are defined. Processes are generally followed.

**4 — Exemplary:** Governance is mature and well-documented. Processes are living documents that evolve with the team. Decision-making is transparent with documented rationale. RFCs or equivalent capture significant proposals with discussion. Change management is proportional to risk. Documentation of processes is itself subject to review and improvement.

---

## 10. Maintenance & Sustainability

How well the project documents its approach to long-term maintenance — versioning, changes over time, dependency management, and evolution.

### What to look for

- CHANGELOG or release notes
- Versioning policy (SemVer, CalVer, or other)
- Deprecation policy and timeline
- Dependency management approach
- Dependency update policy and automation
- Migration guides between major versions
- End-of-life / support lifecycle documentation
- Technical debt tracking
- Documentation maintenance process
- Contribution sustainability (bus factor awareness, knowledge sharing)

### Scoring

**0 — Absent:** No maintenance documentation. No changelog, no versioning policy, no deprecation guidance. Users have no way to understand how the project evolves over time.

**1 — Ad-hoc:** Some maintenance artifacts exist — maybe git tags serve as a de facto changelog, or there's an informal understanding of versioning. But nothing is systematic or reliable enough for users to depend on.

**2 — Basic:** A changelog exists (even if it's auto-generated from commits). Versioning follows a recognizable scheme. Basic dependency management is in place. But deprecation is handled ad-hoc, migration guides are rare, and there's no documented sustainability plan.

**3 — Solid:** Meaningful changelog with human-readable release notes. Clear versioning policy. Deprecation process is documented with timelines. Dependency management is documented and reasonably automated. Migration guides exist for breaking changes. The project gives users confidence in its continuity.

**4 — Exemplary:** Maintenance is a first-class concern. Comprehensive release notes explain not just what changed but why and how to adapt. Deprecation is graceful with clear timelines and migration paths. Dependency updates are automated and documented. Technical debt is tracked and prioritized. The project's sustainability model is transparent.

---

## 11. Cross-cutting Quality

This dimension evaluates the quality characteristics that apply across all documentation, not the content of any single dimension.

### Sub-dimensions

#### Consistency

- Consistent formatting and structure across documents
- Consistent terminology (same concept always uses the same term)
- Consistent voice and tone
- Consistent level of detail

#### Findability / Discoverability

- Documentation is organized logically
- Navigation structure exists (table of contents, index, sidebar)
- Search capability (for docs sites)
- Cross-referencing between related docs
- Documentation is where you'd expect to find it
- A clear entry point exists (README links to everything else)

#### Freshness / Accuracy

- Documentation reflects current state of the system
- Dates on documents (last updated, or version)
- Evidence of maintenance (recent commits to docs, recent updates)
- No obviously outdated information (references to removed features, old URLs)
- Code examples actually work

#### Writing Quality

- Clear, concise prose
- Appropriate level of detail for the audience
- Good use of examples
- Proper use of formatting (headers, code blocks, lists) to aid scanning
- Correct grammar and spelling (not critical, but reflects care)
- Diagrams and visuals where they add clarity

#### Accessibility & Inclusivity

- Documentation available in relevant languages (if applicable)
- Readable formatting (not walls of text)
- Alt text on images (for docs sites)
- No unnecessary jargon or unexplained acronyms
- Considers different skill levels in the audience

### Scoring

**0 — Absent:** Quality is not a consideration. Documentation (if it exists) is a jumble of styles, formats, and levels of detail. Finding information requires already knowing where it is.

**1 — Ad-hoc:** Some structure exists but it's inconsistent. Documentation quality varies widely between sections or authors. Finding information requires hunting. Some docs are clearly outdated but it's not obvious which ones.

**2 — Basic:** Documentation follows a generally consistent structure. Organization is logical if not always intuitive. Most information is findable if you know what you're looking for. Some outdated content exists but critical docs are mostly current.

**3 — Solid:** Documentation is consistent in style, format, and terminology. Information is organized logically and discoverable. Docs are generally up to date. Writing quality is good — clear, concise, well-structured. Cross-references help readers navigate between topics.

**4 — Exemplary:** Documentation is a pleasure to use. Consistent style and quality throughout. Excellent organization with intuitive navigation. Search works well (if applicable). Freshness is maintained through process (docs-as-code, CI checks, review requirements). Writing is clear and considerate of the reader. The documentation reflects pride in craft.

---

## Weighting Guidance

When calculating an overall score, weight dimensions by their importance to the project type. Here's guidance — adjust based on specific context:

### Library / SDK / Package

| Dimension | Weight |
|-----------|--------|
| Project Identity & Orientation | High |
| Architecture & Design | Medium |
| API & Interface Documentation | Critical |
| Developer Onboarding & Guides | High |
| Operational Documentation | Low / N/A |
| Testing Documentation | Medium |
| Security Documentation | Medium |
| Configuration & Environment | Medium |
| Process & Governance | Low-Medium |
| Maintenance & Sustainability | High |
| Cross-cutting Quality | High |

### API Service / Microservice

| Dimension | Weight |
|-----------|--------|
| Project Identity & Orientation | Medium |
| Architecture & Design | High |
| API & Interface Documentation | Critical |
| Developer Onboarding & Guides | High |
| Operational Documentation | Critical |
| Testing Documentation | High |
| Security Documentation | High |
| Configuration & Environment | High |
| Process & Governance | Medium |
| Maintenance & Sustainability | Medium |
| Cross-cutting Quality | Medium |

### Platform / Monolith

| Dimension | Weight |
|-----------|--------|
| Project Identity & Orientation | Medium |
| Architecture & Design | Critical |
| API & Interface Documentation | High |
| Developer Onboarding & Guides | Critical |
| Operational Documentation | Critical |
| Testing Documentation | High |
| Security Documentation | High |
| Configuration & Environment | High |
| Process & Governance | High |
| Maintenance & Sustainability | High |
| Cross-cutting Quality | High |

### Data Pipeline / ML System

| Dimension | Weight |
|-----------|--------|
| Project Identity & Orientation | Medium |
| Architecture & Design | Critical |
| API & Interface Documentation | Medium |
| Developer Onboarding & Guides | High |
| Operational Documentation | High |
| Testing Documentation | High |
| Security Documentation | High |
| Configuration & Environment | Critical |
| Process & Governance | Medium |
| Maintenance & Sustainability | High |
| Cross-cutting Quality | Medium |

### CLI Tool

| Dimension | Weight |
|-----------|--------|
| Project Identity & Orientation | Critical |
| Architecture & Design | Low |
| API & Interface Documentation | Critical (CLI reference) |
| Developer Onboarding & Guides | High |
| Operational Documentation | Low / N/A |
| Testing Documentation | Medium |
| Security Documentation | Low-Medium |
| Configuration & Environment | High |
| Process & Governance | Low |
| Maintenance & Sustainability | High |
| Cross-cutting Quality | High |

---

## Calibration Notes

To maintain scoring consistency:

- **Score what exists, not intentions.** A planned documentation site that isn't written yet is a 0, not a 2.
- **Score against the project's own needs.** A startup MVP with a clear README and good API docs might be a 3 overall, even if it lacks governance docs — because governance docs aren't critical for its current stage.
- **Be specific about evidence.** Every score should reference specific documentation artifacts (or their absence) that justify the score.
- **Half-points are OK** if a dimension clearly falls between two levels. Score 2.5 if you must, but explain why.
- **The overall score is not a simple average.** It's a weighted assessment that reflects the project's specific needs. A library scoring 4 on API docs but 0 on runbooks should score higher overall than one scoring 2 on both.
