# Issue #655 — Decision: P2 converge gate vs P4 validation contract

**Date:** 2026-09-15
**Spike type:** measurement → go/no-go (no code ships; this document is the deliverable)
**Inputs:** `measurement.json` + `measurement-report.md` (same scratch dir, generated 2026-09-15T04:13Z, commit `2cb6165`)
**Issue criteria:** quiet-truncation rate ≥ X% → file P2 issue; drift observed → file P4 issue; otherwise record both as measured-absent so they are not re-proposed.

## 1. Decision

| Gate | Decision | Basis |
|---|---|---|
| **P2 — converge gate** (read-only, end-of-develop) | **GO — file the implementation issue** | 53/90 verify-passing measurable cycles (58.9%) had ≥1 declared deliverable absent or partial in the diff; worst cases hit 100% of declared paths |
| **P4 — externalized validation contract** (freeze ACs, content-addressed) | **NO-GO as specified — record measured-absent; re-test with cheap instrument** | The signal P4 exists to prevent (verify checking a *different* AC contract than the intent gate froze) was **not observed**. The 30.4% drift flag is confounded with plan under-declaration (scope fanout, 13 cycles) and truncation (which is P2's problem, not contract drift) |

## 2. Measured evidence (from the sibling measurement)

Corpus: 8 projects, 241 cycles with a normalised spec that reached develop; **138 (57.3%) with an accessible diff** — far above the ≥15 required. 42.7% of cycles have no accessible diff (worktrees cleaned up after handoff/abort). This is a **survivorship bias in the accessible direction**: the hardest failures (early abort, never committed) are under-represented, so both rates below are bounds, not point estimates.

### Deliverable classification (588 deliverables, 138 measurable cycles)

| Classification | Count | % |
|---|---|---|
| Implemented (all declared paths in diff) | 229 | 38.9% |
| Partial | 50 | 8.5% |
| Absent | 146 | 24.8% |
| Unmeasurable (prose deliverable, no declared paths) | 163 | 27.7% |

### Quiet truncation (the P2 question)

- **53 of 90 verify-passing measurable cycles (58.9%)** had ≥1 deliverable classified absent or partial, despite the develop verify gate passing cleanly.
- Worst individual cases — verify passed, yet **100% of declared deliverable paths missing** from the diff: pi-rukas #284 (7/7), #307 (5/5), #357 (3/3); to-bench #227 (4/4), #106 (5/5), #96 (8/8); devbox-iac #89 (17/17); kuiskaus #37 (7/7); llm-iac #318 (9/9), #263 (9/9); vipune #179 (5/5); vemoizer #37 (9/11).
- Caveat (upper bound): path overlap is necessary, not sufficient — "absent" can mean the developer picked different file names, the plan's paths were wrong, or a sibling workstream's worktree was cleaned up. Even a 50% haircut leaves ~30% of verify-passing cycles with at least one possibly-truncated deliverable. A full 100%-missing case is the strongest possible single-cycle signal; 12 such cycles were measured.

### Drift (the P4 question)

42/138 measurable cycles (30.4%) flagged `acDrift: true`. Decomposing the notes:

| Signal type | Cycles | What it means |
|---|---|---|
| "Verify passed but N/M deliverable paths not in diff" | ~30 | **Truncation** — the gate checked a narrower surface than the plan. This is P2's failure mode, not contract drift. |
| "Scope fanout: plan under-declared files vs actual diff" | 13 | **Plan under-declaration** — the diff was *larger* than the plan declared. The plan's file list was wrong at plan time; the ACs themselves did not drift between intent and verify. |
| Mechanical verify failures (fence, build, commit, consolidation, PR identity) | 83+49+17+10+5 note instances | Not AC-related at all. |

**No cycle showed the specific failure P4 exists to prevent**: the acceptance criteria the verify gate checked *differing from the ACs the intent gate froze*. The verify gate checks paths, fence, and a verify command — all derived from the same frozen normalised spec in the state file. What the measurement found is (a) deliverables that went unimplemented (→ P2) and (b) plans whose declared file list was too small (→ a plan-quality problem, addressed by the existing scope-fanout gate already present in `verifyStepOutcome`).

## 3. Why GO for P2

1. **Rate far above any plausible threshold.** The issue says "≥ X%" — any X below ~50% is met by the upper bound (58.9%); ~30% survives an aggressive 50% haircut.
2. **12 full-100%-missing cases across 6 projects** — the worst signal shape, not a marginal one.
3. **The existing gate demonstrably does not catch it.** `verify-failed:develop` is 36.9% of all caps (census 2026-09-09) — the gate catches *broken* builds; it cannot see that 2 of 3 deliverables were simply not written. That is exactly the gap a converge pass (diff vs deliverable list, end-of-develop, read-only) fills.
4. **Composable with existing seams.** Per the research (`outputs/work-driver-deterministic-factory.md` §4 P2): read-only at end-of-develop, grounding via the existing `claim-scan.ts` `GroundingLookup` seam, findings routed to the adversarial gate rather than auto-blocking (consistent with the #664 verdict-vocabulary lesson: flags are weighed, not obeyed).

## 4. Why NO-GO (as specified) for P4

1. **The precondition was "drift observed". It was not.** What was observed is truncation + plan under-declaration. Freezing the ACs as a content-addressed artifact would not change any measured outcome: the ACs were already effectively frozen in the state file, and the verify gate reads from it.
2. **Scope fanout (13 cycles) is already instrumented and gated** — `PI_ENSEMBLE_SCOPE_GATE` exists in `verifyStepOutcome` today. Re-building it as a "contract" would add ceremony without closing a measured gap.
3. **This repo's doctrine is compile-on-measurement.** The research doc's own recommendation was "measure first, build only if the failure mode actually occurs." For P4, the failure mode did not occur; for P2 it did, at high rate.

**Conditional follow-up (recorded, not built now):** if the P2 converge gate ships and the scope-fanout rate stays above 20% of cycles, re-open P4 with the fanout delta logged per cycle as the new evidence base. That instrument is a few lines (log plan-declared count vs diff count), not a content-addressed artifact.

## 5. Follow-up issue drafts (for PM to file)

### Draft issue A — P2 converge gate (file this)

```
### Task Description

Add a read-only **converge pass** at end-of-develop in the /work driver: for each
deliverable in the frozen normalised spec (NormalisedSpec.deliverables), check whether
the worktree diff covers its declared paths (and, where declared paths are absent, its
description). Classify per deliverable: implemented / partial / absent / unmeasurable
(no declared paths — prose deliverable, per #443).

Findings are NOT auto-blocking: emit a structured converge-findings event carrying the
per-deliverable classification, routed into (1) the adversarial gate's input and (2) the
PR body, so the review can weigh truncation with the issue and the diff in view. Same
route-only principle as the #664 verdict relaxation.

Method note: compose with the existing claim-scan.ts GroundingLookup seam for path
grounding (per outputs/work-driver-deterministic-factory.md section 4 P2). Escape hatch
PI_ENSEMBLE_CONVERGE=0 (off) following the existing gate pattern.

### Evidence (spike #655, 2026-09-15, 138 measurable cycles / 8 projects)

- 53 of 90 verify-passing cycles (58.9%) had >=1 deliverable absent or partial in the diff.
- 12 cycles had 100% of declared deliverable paths missing despite verify passing:
  pi-rukas #284 (7/7), #307 (5/5), #357 (3/3); to-bench #227 (4/4), #106 (5/5), #96 (8/8);
  devbox-iac #89 (17/17); kuiskaus #37 (7/7); llm-iac #318 (9/9), #263 (9/9); vipune #179 (5/5);
  vemoizer #37 (9/11).
- Upper bound: path overlap is necessary not sufficient (renaming, wrong plan paths, or a
  cleaned-up sibling worktree can produce a false "absent"). A 50% haircut still leaves ~30%.
- Caveat: 42.7% of cycles had no accessible diff (survivorship bias toward accessible).
  Full per-cycle data: measurement.json from the #655 scratch dir.

### Acceptance criteria
- Converge pass runs at end-of-develop, read-only, over the frozen spec in work state
- Per-deliverable classification (implemented/partial/absent/unmeasurable) in a structured event
- Findings reach the adversarial gate and the PR body; never auto-block
- Prose deliverables with no declared paths classify as unmeasurable, not absent
- Escape hatch PI_ENSEMBLE_CONVERGE=0 disables the pass
- Smoke test with fixtures drawn from the 12 full-100%-missing cycles above

### Quality Gates
- tsc + biome + offline smoke tests pass
- No changes to verify gates, timeouts, or review policy (per #655 scope)
```

### P4 — do NOT file now. Record as measured-absent

Recorded in vipune (typed fact, this dispatch): the P4 externalized-validation-contract
precondition (AC contract drift between intent gate and verify gate) was **not observed**
in the #655 measurement; the 30.4% drift flag decomposes into truncation (P2) + scope
fanout (already gated by PI_ENSEMBLE_SCOPE_GATE) + mechanical failures. Do not re-propose
P4 unless the scope-fanout rate stays >20% after the P2 converge gate ships; re-measure
with the per-cycle fanout-delta log as the new evidence base.

## 6. Method limitations (carried from the measurement, for the record)

1. Path overlap ≠ implementation; rates are bounds.
2. Survivorship bias: 42.7% of cycles unmeasurable (diff gone).
3. Multi-workstream cycles: union of accessible worktree diffs only.
4. AC drift detection is via verify-failure classification + path coverage, not semantic AC comparison — which is also why P4's specific failure shape (semantically different ACs) cannot be ruled out to certainty, only shown to have no positive signal.

## 7. Verification of this workstream

- `tmp/issue-655/decision.md` written (this file).
- vipune fact saved (see return message for the text).
- No repo files outside the scratch dir touched; sibling measurement artifacts (`measure*.ts`, `measurement.json`, `measurement-report.md`, `corpus-scan.ts`, `coverage-scan.json`) left untouched.
- No code, no tests — issue #655 declares "Test surface: none".
