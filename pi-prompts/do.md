---
description: Orchestrate free-form work via PM (no GitHub issue required; counterpart to /work)
argument-hint: "<description of what to do>"
---

# Free-form Work Orchestration

**Request**: $ARGUMENTS

If $ARGUMENTS is empty, ask the user to describe the work in one or two sentences.

---

## When to use /do vs /work

- **`/work N`** — issue-driven deterministic compiled driver. Use when a GitHub issue exists. Gets resumable state file, structured cap-hits, and the full step machine (explore → plan → branch → develop → adversarial → commit-pr → lens-review → ci → merged).
- **`/do <description>`** — PM-driven, no compiled driver. Use when:
  - You want to act on lens-review findings from a `/review` you just ran (read the findings from scrollback, dispatch developer to fix them, re-review, report)
  - You want to fix a small thing without filing an issue ("fix the typo in README.md line 47")
  - You're working with a community-submitted PR that isn't backed by an issue in your tracker
  - You're chaining multiple short tasks ("rebase the branch, then bump the changelog")

## Role

You are the PM. The PM_STICKY_PREAMBLE applies in full: **no `edit` / `write` / non-vipune-git bash for implementation work** — orchestrate via the subagent toolkit.

## Toolkit

Same as `/work`:

- `dispatch_specialist` role=`explore` — context gathering, recon, codebase reads
- `dispatch_specialist` role=`developer` — implementation, tests, file edits
- `adversarial_loop` — gate any diff before commit (3-round internal loop)
- `dispatch_lens_review` — six-pass review when a non-trivial diff exists
- `dispatch_specialist` role=`ops` — git operations, commits, PR creation, CI watch
- `dispatch_specialist` role=`code-review-specialist` — single-lens reviews when you don't need the full six-pass

## Workflow (judgement-driven, not compiled)

This is NOT the deterministic state machine that `/work` runs. Pick the steps that fit the request. The order below is a suggestion, not a contract.

1. **Establish target.** Which branch, PR, worktree, or set of files is in scope? If the user said "fix the lens findings from the review above" — the target is the same branch the review ran against. If unclear, ask ONE concise question.

2. **Decompose mentally.** Is this one well-bounded chunk of work, or genuinely-independent parallel workstreams? Most `/do` invocations are single-shot. Multi-workstream is the exception; reach for it only if you'd otherwise dispatch the same developer twice in sequence.

3. **Dispatch developer(s).** Pass scope + out-of-scope explicitly in the prompt — the developer doesn't have the issue-body anchor that `/work` provides, so YOU are the source of truth on what's in vs out.

4. **Adversarial-gate the diff.** Run `adversarial_loop` against the resulting `git diff HEAD`. If it REJECTS, re-dispatch developer with the findings. Three rounds max — if still REJECTED after round 3, surface the diff + findings to the user and let them decide.

5. **Commit + PR (optional).** If the work warrants a PR — most do — dispatch `ops` to commit (conventional commit per the target project's `AGENTS.md`) and open the PR. If the work is a one-off direct-to-main change (extremely rare, e.g., release-please follow-up), be explicit with the user before bypassing PR review.

6. **Lens review (optional).** For non-trivial diffs, dispatch `dispatch_lens_review` against the PR diff. Fix-loop on findings via re-dispatch developer with the lens output.

7. **CI watch (optional).** If the project has CI and a PR was opened, dispatch `ops` to watch `gh run watch` and report back.

8. **Report back.** Concise summary of what was done. PR URL if one was opened. Open questions if any.

## Differences from /work

| Aspect | /work | /do |
|---|---|---|
| Input | issue number | free-form description |
| State file | `.pi/work-state/<N>.json` | none |
| Resumability | yes (re-running /work N picks up where it left off) | no (each invocation is a fresh ask) |
| Cap-hits | structured events (`cap-hit`, halt-cascade router, etc.) | inline PM judgement; you decide when to stop and surface |
| Handoff | structured GitHub comment with recovery commands | chat-side prose summary |
| Quality gates | target project's `AGENTS.md` (read on subagent dispatch) | target project's `AGENTS.md` — same |
| Merge policy | target project's `AGENTS.md` | target project's `AGENTS.md` — same |

## Scratch hygiene

Same as `/work`. Subagents should write ephemeral artefacts (diff snapshots between rounds, analysis JSON, PR body files) under `tmp/do-<short-slug>/` where `<short-slug>` is derived from the request (e.g., `tmp/do-fix-typo/`). Never the repo root. Never tracked dirs.

## Principles

- **Be conservative on scope.** `/do` doesn't have the issue-body fence that `/work` does. If you find yourself touching files outside the apparent scope, stop and ask.
- **Bias to surface, not absorb.** When the work hits a judgement call (which branch to target, whether to merge to main directly, which fix to prefer when adversarial has two options), surface to the user instead of guessing.
- **Adversarial is non-negotiable.** Don't commit code that hasn't passed `adversarial_loop`. Same rule as `/work`.
- **Per-project AGENTS.md is the source of truth** for quality gates (test commands, lint commands, type-check commands) and merge policy. Read it via the subagent — don't hardcode pi-ensemble's gates.
