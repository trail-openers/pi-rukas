---
description: Compiled research — parallel angles, deterministic verification, dated artifact + provenance
argument-hint: "<topic>"
---

# Research Mission

**Topic**: $ARGUMENTS

If no topic was provided, ask the user before proceeding.

---

## Role

The deterministic spine of research is compiled: the `start_research_driver` tool runs memory inventory → parallel angle retrieval (structured claims) → deterministic verification (URL liveness, commit-pinned code grounding) → a dated artifact + provenance sidecar under `outputs/` → a typed vipune row. Do NOT re-implement that pipeline by hand — dispatching your own explore fan-out and hand-writing vipune lines is exactly the improvised flow the driver replaced.

Your judgement covers what the driver deliberately does not:

1. **Scope the question.** Ask clarifying questions only if scope/depth would materially change the angles.
2. **Choose the tier**: `quick` for a "what is X" lookup (1 angle, liveness only); `standard` (default) for real investigations.
3. **Choose the angles** — optional. The driver derives a sound default set (web/current + docs + codebase when the topic names code). Pass your own `angles` array only when you know a sharper cut (e.g. one angle per competitor, or a specific subsystem focus).
4. **Thread session context** — pass established facts via `context` so the children dig deeper instead of re-walking known ground.

## Execution

1. Call `start_research_driver` with the topic (plus `tier`, `angles`, `context` as judged above).
2. **Present the result**: summarize the findings for the operator, lead with any CONTRADICTIONS the driver surfaced, name the artifact path (`outputs/research-<slug>.md`) and the pinned commit. If the driver abstained (no reliably verified findings), say so plainly — an honest gap beats a confident fabrication.
3. **Stay in conversation** — offer to dig deeper. Deeper = another driver call with sharper `angles` or more `context`, never a hand-rolled dispatch fan-out.
4. When the topic is plan-relevant, offer to carry the findings into `/plan` — the artifact's findings make a strong `context` param for `start_plan_driver` (ACCEPTANCE CRITERIA / PITFALLS / OUT OF SCOPE blocks are parsed as operator directives).

## Principles

- The driver owns mechanics (verification, artifact, provenance, memory); you own judgement (scope, angles, the conversation).
- Findings marked `fast-moving` in the artifact must be re-verified before reuse in a later /plan or /work.
- Synthesise, don't dump — the artifact is the record; your reply is the readable summary.
