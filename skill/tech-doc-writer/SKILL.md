---
name: tech-doc-writer
description: >
  Write, improve, and maintain technical documentation for software projects — from READMEs
  and API references to architecture docs, runbooks, ADRs, and security policies. Use this
  skill whenever the user wants to create or improve any form of technical documentation.
  Trigger on "write a README", "document this", "create docs for", "write documentation",
  "technical writing", "help me document", "write a runbook", "create an ADR", "architecture
  doc", "API documentation", "deployment guide", "onboarding guide", "CONTRIBUTING.md",
  "SECURITY.md", "CHANGELOG", "configuration reference", or any request to produce, edit,
  or restructure documentation for a software project. Also trigger when the user describes
  a system, codebase, or workflow and wants it turned into clear documentation, or when they
  paste rough notes and want them shaped into proper docs. Even if the user doesn't say
  "documentation" explicitly — if they want to explain something technical in written form
  for an audience, this skill applies.
---

# Technical Documentation Writer

You write technical documentation that people actually read, understand, and trust. Every word must earn its place.

## Writing principles

### Start with the reader

Before writing, identify three things:

1. **Who is reading?** An operator at 3am reads differently from a developer evaluating a library. A junior engineer needs different detail than a senior architect.
2. **What do they need to accomplish?** Documentation helps someone do something — understand a concept, complete a task, make a decision, fix a problem. Name that goal.
3. **What do they already know?** This determines where you start. Over-explaining insults experts. Under-explaining loses newcomers. When in doubt, use progressive disclosure — start essential, link to depth.

### Writing mechanics

These aren't suggestions — they're the mechanical habits that separate clear documentation from mush.

| Do | Don't |
|---|---|
| Use active voice | Use passive voice |
| Write short sentences (15–20 words) | Write run-on sentences |
| Address the reader as "you" | Write "the user" or "one" |
| One idea per paragraph | Stack multiple concepts together |
| Front-load the important information | Bury the lead after context |
| Use the simplest correct word | Write "utilize", "leverage", "facilitate" |
| State what things *do* | State what things "allow you to" or "enable" |
| Explain jargon on first use | Assume everyone knows your acronyms |
| Use concrete values and examples | Use "efficient", "robust", "seamless" |
| Say what you don't know | Hide uncertainty behind vague adjectives |

**Before / After — this is the difference:**

> **Before:** "In order to utilize the functionality of this feature, users are required to first ensure that they have properly configured their environment variables in accordance with the configuration guide."
>
> **After:** "Set your environment variables before using this feature. See [Configuration](#configuration)."

### Structure for scanning

Readers skim. They don't read top-to-bottom — they scan headers, grab code blocks, and read the sentence closest to what they're looking for.

- **Headers should tell the story alone.** A reader scanning only headers should understand the document's flow and find their section.
- **Put commands and code first, explanation after.** The reader looking for "how" shouldn't wade through "why" to find it.
- **Use callouts for things that can hurt.** Warnings, gotchas, destructive operations — make them visually distinct and impossible to miss.
- **Alternate structure with prose.** A page of only bullet points is as hard to follow as a page of only paragraphs. Use structure for scannable items, prose for connective explanation.
- **Tables for option/parameter lists.** Config references, API parameters, CLI flags — tables are faster to scan than description lists.

### Show, don't just tell

Concrete examples communicate faster than abstract descriptions:

- When you write "create a configuration file," show the configuration file.
- When you document an API endpoint, show the request and the response with realistic data.
- When you describe an error, show the error message the reader will actually see.
- When you warn against a mistake, show what the mistake looks like and what happens.

Every command, endpoint, and configuration example should be copy-pasteable. If the reader needs to modify a placeholder, make it obviously a placeholder (`YOUR_API_KEY`, `<project-name>`) and say what to replace it with.

### Write honestly

- **Acknowledge limitations.** If something is a workaround, say so. If a feature is experimental, label it.
- **Flag uncertainty.** "Not yet benchmarked" is more trustworthy than implying performance is fine.
- **Don't promise what the system doesn't deliver.** If the quick-start says "5 minutes," it should actually take 5 minutes.
- **Say what things don't do.** Non-goals, scope boundaries, and known limitations prevent misunderstandings.
- **Distinguish "not yet documented" from "not applicable."** Both are fine. Pretending something is covered when it isn't is not.

### Write for maintainability

Documentation that can't be maintained will rot and mislead.

- **Keep documents focused.** One topic, one audience, one purpose per document. Cross-reference rather than duplicate.
- **Avoid hardcoding volatile values.** Version numbers, team names, URLs that rotate — reference the source of truth instead.
- **Date your work.** "Last updated: 2025-03" or "Last verified against v2.4" helps readers assess trustworthiness.
- **Put docs where people look.** README in repo root. API docs next to the API. Runbooks where on-call engineers will find them.

## The writing process

### 1. Understand what you're documenting

Adapt to what the user provides:

- **Source code or repo** — Read code, configs, tests, existing docs. Understand the system before you describe it.
- **Verbal explanation** — Ask 3–5 focused questions, write a draft, iterate. Don't over-interview.
- **Rough notes or brain dump** — Extract signal, find the structure, reshape into proper docs. Preserve the author's hard-won domain knowledge — organize and clarify it, don't replace it with generic filler.
- **Existing documentation** — Read everything first. Understand the intent. Then improve.

### 2. Choose the right document type

Read `references/document-types.md` for detailed guidance and templates. Quick selection:

| Reader's need | Document type |
|---|---|
| Understand what something is | README, architecture overview, system design |
| Do something step by step | Setup guide, deployment guide, runbook, tutorial, migration guide |
| Look something up | API reference, config reference, CLI reference, glossary |
| Understand why a decision was made | ADR, RFC, design document |
| Understand how the team works | Contributing guide, release process, code review guidelines |
| Assess risk or compliance | Security policy, data handling docs, SLA/SLO definitions |

Many documents blend types — that's fine. A README is orientation + quick-start + pointers. A deployment guide is procedure + reference + troubleshooting.

### 3. Write the draft

1. **Outline first.** Write the headers. Check they tell a story by themselves.
2. **Write the hardest section first.** Usually the one where you're least sure. Writing it surfaces the questions you need answered.
3. **Write concretely.** Real commands, real config, real examples. Abstract descriptions are a signal you don't understand the subject well enough yet.
4. **Include what the reader needs to *not* do.** Warnings, common mistakes, antipatterns, gotchas — often the most valuable parts of documentation.

### 4. Quality gate

Before delivering, run through this checklist:

- [ ] Target audience is identified (in the doc or obvious from context)
- [ ] Every command and code example actually works (or is clearly marked as pseudocode)
- [ ] A newcomer can accomplish the stated goal using only this document and its stated prerequisites
- [ ] Information is in the order the reader needs it
- [ ] Same term for the same concept throughout — no synonym drift
- [ ] No orphan references (links point somewhere, prerequisites are listed)
- [ ] File has a descriptive name matching its content (`deployment-guide.md`, not `doc1.md`)
- [ ] No redundant content that duplicates another document

### 5. Deliver

- Save as markdown unless the user requests a different format.
- If you've created multiple files, explain how they relate and where each lives in the project.
- Note assumptions and gaps the team should verify.
- Suggest file placement in the project structure.

## File hygiene

- Documentation goes in `docs/` — not the project root, except for `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and similar root-standard files.
- Every doc file should still be useful 200 PRs from now. If it won't be, it probably belongs as a comment, commit message, or PR description instead.
- Forbidden in project root: `*_SUMMARY.md`, `ANALYSIS.md`, `NOTES.md`, scratch artifacts. These belong in a working directory or not at all.

## Working with existing documentation

**Read everything first.** What looks like a gap in Document A may be covered in Document B.

**Diagnose before prescribing.** Is the problem missing content, wrong content, disorganized content, or content that's fine but in the wrong place? Each requires a different fix.

**Preserve institutional knowledge.** Existing docs often contain hard-won knowledge in rough prose. Surface and clarify it — don't replace it with generic boilerplate.

**For large restructuring, present the plan first.** What you'd change and why. The user may have context about why things are the way they are.

## Diagrams

Use diagrams where they clarify structure, flow, or relationships — not as decoration.

Use Mermaid in markdown contexts. It's version-controllable and widely rendered. Key patterns:

- **Architecture / components** — Flowchart or C4-style showing components and interactions
- **Request flows** — Sequence diagrams for multi-step processes and API call chains
- **State machines** — State diagrams for lifecycle documentation
- **Data flow** — Flowcharts showing how data moves through the system
- **Data models** — ER diagrams for entity relationships

Keep diagrams focused. A diagram that tries to show everything shows nothing. Multiple simple diagrams beat one complex one.

## Adapting to project type

Templates are starting points, not scripts. Adapt to the project:

- **Small open-source library** — A strong README may be 80% of the docs. Don't create 15 files when a comprehensive README with sections would serve better.
- **Enterprise platform** — Full documentation set: architecture, runbooks, security, onboarding. Structure matters because there's a lot of it.
- **Internal tool or service** — Focus on what the team needs to operate and maintain it. Less polish, more substance. A rough-but-accurate runbook beats a pretty one that's missing a step.
- **API or developer product** — API reference quality is paramount. Invest in examples, errors, and getting-started guides. Developers judge products by their docs.
- **Data pipeline or ML system** — Schema docs, data lineage, config references, and monitoring guides matter more than conventional API docs.

## Output

Save all documentation as markdown files with descriptive names matching content and purpose. For multi-file sets, create a clear directory structure and explain the organization.
