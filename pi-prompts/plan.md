---
description: Create a well-structured GitHub issue with type-specific template
argument-hint: "<bug|feature|epic|chore|spike description>"
---

# Plan: Create GitHub Issue(s)

**Input**: $ARGUMENTS

If no input was provided, ask the user before proceeding.

---

## Steps

1. **Read project context** (do not rely on session memory):
   - Read AGENTS.md if present — issue conventions, quality gates, labels.
   - **Search memory for prior decisions.** Derive a few conceptual keywords from the user's input and run a focused `vipune search "<keyword>" --limit 5` per keyword. Use your judgment for what's worth searching. Avoid passing the user's whole sentence as a single query — vipune is keyword-semantic search and prefers short phrases.

2. **Classify the issue**:

   | Type | When | Title Prefix |
   |------|------|--------------|
   | Bug | Something broken | `Bug: ` |
   | Feature | New capability | `feat: ` |
   | Epic | Multi-issue body of work | `EPIC: ` |
   | Task/Chore | Refactor, config, deps | `chore: ` |
   | Research/Spike | Open question, investigation | `research: ` |

   If unclear, ask.

3. **Interview only what cannot be inferred** — scope, acceptance criteria, constraints, type-specific specifics.

4. **Investigate** — dispatch `explore` via `dispatch_specialist`:
   ```
   role: explore
   prompt: "Use colgrep to find any existing code implementing what the issue is asking for (e.g. a function, module, or feature concept). Skip colgrep if the request is a meta/project-level question — read AGENTS.md and vipune instead. Also check open GitHub issues for duplicates."
   ```

5. **Draft using the type-specific template**:

   - **Bug**: title `Bug: …`; sections — What happened, Expected behaviour, Steps to reproduce, Environment, Logs/Screenshots, Acceptance Criteria, Definition of Done.
   - **Feature**: title `feat: …`; sections — Motivation, User Story (as a … I want … so that …), Proposed Solution, Alternatives Considered, Acceptance Criteria, Definition of Done.
   - **Epic**: title `EPIC: …`; sections — Goal, Scope, Out of Scope, Child Issues (checklist), Milestone, Acceptance Criteria.
   - **Chore**: title `chore: …`; sections — What, Why, Acceptance Criteria.
   - **Research/Spike**: title `research: …`; sections — Question, Background, Timebox, Expected Deliverable (not code — a decision or proof of concept), Out of Scope.

   Acceptance criteria are checkbox lists. Definition of Done sections should cover tests, linting, type checking, and any project-specific quality gates (look these up in AGENTS.md). Keep titles under 70 chars.

6. **Confirm before creating** — always show the draft, wait for explicit confirmation.

7. **Create**:
   ```bash
   gh issue create --title "..." --label "..." --body "..."
   ```

   For epics: create the epic first, then offer to create child issues. Update the epic's task list with real issue numbers.

---

## Principles

- Context before drafting — 2-min codebase search prevents a mis-scoped issue.
- Confirm before creating — issues are harder to clean up than to get right.
- Type-specific quality — chore ≠ feature; apply the right standard.
- AGENTS.md is the law.
- Epics are containers; implementation details go in child issues.
