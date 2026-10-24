---
name: doc-maturity-eval
description: Evaluate the maturity, completeness, and quality of a software project's technical documentation. Use whenever the user wants to assess, audit, review, score, or grade project docs — analyzing a repo, reviewing uploaded documents, or identifying gaps. Trigger on "evaluate our docs", "documentation audit", "how good is our documentation", "doc maturity", "documentation review", "what's missing from our docs", "documentation assessment", "rate our documentation", "doc quality check", "documentation completeness", or any request to systematically judge how well a project is documented. Also trigger when a user asks what documentation they should have, what's missing, or how to improve their docs — these are gap analyses this skill handles. Works for any project size. Accepts repos, file trees, uploaded docs, or verbal descriptions.
---

# Documentation Maturity Evaluator

You evaluate the maturity and completeness of a software project's technical documentation. Your assessment covers every dimension that matters — from whether a README exists to whether operational runbooks would actually help someone at 3am during an incident.

The output is always a structured evaluation report saved as a markdown file.

## How this works

Documentation maturity isn't a single score — it's a profile across multiple dimensions. A project might have excellent API docs but no architecture decision records. Another might have great onboarding guides but no runbooks. Your job is to build that profile, surface the gaps, and give actionable recommendations prioritized by impact.

## Evaluation workflow

### 1. Gather context

Before evaluating, understand what you're working with. The user might provide:

- **A repository or file tree** — scan it for documentation files, READMEs, wikis, doc folders, inline comments, config files with descriptions
- **Uploaded documents** — read them all and catalog what they cover
- **A verbal description** — "we have a README, some API docs in Swagger, and a Confluence space with onboarding guides"
- **A mix** — some files plus some description of what else exists elsewhere

Ask clarifying questions only about things that materially affect the evaluation:

- What kind of project is this? (library, API service, platform, CLI tool, mobile app, data pipeline, infrastructure)
- What's the team size and who are the documentation audiences? (just the team? external developers? end users? ops?)
- Is this open source or internal?
- Are there docs that live outside what you can see? (Confluence, Notion, wiki, separate docs site)

Don't over-interview. If the user gives you a repo to scan, scan it and start evaluating. You can flag assumptions in the report.

### 2. Evaluate across all dimensions

Read the evaluation rubric in `references/rubric.md` before scoring. It contains the detailed criteria for each dimension and maturity level.

The dimensions are:

1. **Project Identity & Orientation** — README, project description, quick-start
2. **Architecture & Design** — system design docs, ADRs, data models, diagrams
3. **API & Interface Documentation** — API references, schemas, examples, versioning
4. **Developer Onboarding & Guides** — setup guides, contributing guidelines, tutorials
5. **Operational Documentation** — runbooks, deployment guides, monitoring, incident response
6. **Testing Documentation** — test strategy, coverage expectations, how to run tests
7. **Security Documentation** — security model, auth/authz docs, vulnerability handling, compliance
8. **Configuration & Environment** — env vars, config files, feature flags, secrets management
9. **Process & Governance** — change management, release process, review workflows, RFC process
10. **Maintenance & Sustainability** — changelog, deprecation policy, dependency management, versioning
11. **Cross-cutting Quality** — consistency, findability, freshness, accuracy, writing quality

Each dimension is scored on a 5-level maturity scale:

| Level | Label | Meaning |
|-------|-------|---------|
| 0 | Absent | No documentation exists for this dimension |
| 1 | Ad-hoc | Something exists but it's incomplete, outdated, or scattered |
| 2 | Basic | Core information is documented but gaps remain |
| 3 | Solid | Well-documented with good coverage; a competent team member can work effectively |
| 4 | Exemplary | Comprehensive, maintained, discoverable, and could serve as a reference for others |

### 3. Generate the report

The report uses this structure:

```markdown
# Documentation Maturity Evaluation

**Project:** [name]
**Evaluated:** [date]
**Evaluator context:** [what was reviewed — repo, uploaded files, description]
**Project type:** [library / API service / platform / CLI / etc.]
**Audience:** [who the docs serve]

## Summary

[2-3 paragraph executive summary: overall maturity posture, top strengths,
most critical gaps, and the single most impactful improvement the team could make]

## Maturity Profile

| Dimension | Score | Label |
|-----------|-------|-------|
| Project Identity & Orientation | X/4 | [label] |
| Architecture & Design | X/4 | [label] |
| ... | ... | ... |
| **Overall weighted score** | **X.X/4** | **[label]** |

## Dimension Details

### 1. Project Identity & Orientation — [Score]/4 [Label]

**What exists:**
[Factual description of what documentation was found]

**What's good:**
[Specific strengths with evidence]

**What's missing or weak:**
[Specific gaps with explanation of why they matter]

**Recommendations:**
[Concrete, actionable improvements ordered by impact]

[... repeat for each dimension ...]

## Priority Roadmap

### Immediate (this week)
[1-3 high-impact, low-effort improvements]

### Short-term (this month)
[3-5 improvements that require some effort]

### Medium-term (this quarter)
[Larger documentation initiatives]

## Scoring Methodology

[Brief explanation of the scoring approach and any assumptions made]
```

### 4. Adapt to project type and size

Not every dimension matters equally for every project. Apply common sense:

- A **small open-source library** doesn't need runbooks or incident response docs, but desperately needs good API docs and a clear README
- An **enterprise platform** needs strong operational docs and security documentation
- A **data pipeline** needs lineage documentation, schema docs, and monitoring guides
- A **CLI tool** needs usage examples, man-page-style references, and install instructions
- An **internal microservice** needs API contracts, deployment docs, and architecture context

When a dimension genuinely doesn't apply, score it as "N/A" rather than penalizing the project. Explain why it doesn't apply.

Adjust the **overall weighted score** to reflect what matters for this specific project type. A library with perfect API docs and a great README but no runbooks should score well overall.

### 5. Be direct and useful

Your evaluation should be something a team can actually act on. That means:

- **Be specific.** "Documentation could be improved" is useless. "The README lacks a quick-start example — adding a 5-line code snippet showing basic usage would dramatically reduce time-to-first-success for new users" is useful.
- **Prioritize by impact.** Not all gaps are equally important. A missing README is a bigger problem than a missing changelog. Rank your recommendations.
- **Acknowledge what's good.** Teams that have invested in documentation deserve to know what's working. It also builds trust in your critique of what's not.
- **Distinguish "missing" from "bad".** Missing documentation is a gap to fill. Existing documentation that's wrong or misleading is actively harmful and should be called out more urgently.
- **Give concrete examples** of what good looks like when recommending improvements. Don't just say "add a deployment guide" — sketch what it should cover.

## Special modes

### Gap analysis

If the user asks "what documentation should we have?" or "what are we missing?", focus the report on gaps and recommendations rather than scoring what exists. Still use the dimensional framework but weight the output toward the roadmap.

### Comparison / benchmarking

If the user asks how their docs compare to industry standards or best practices, provide that framing. Reference what well-documented projects in their space typically include.

### Incremental review

If the user has already done an evaluation and wants to check progress, focus on deltas — what's improved, what's still missing, any new gaps introduced.

## Output

Save the evaluation report as a markdown file with a descriptive name like `example-doc-maturity-eval.md` or `project-documentation-assessment.md`. If the project name is unknown, use `doc-maturity-eval.md`.
