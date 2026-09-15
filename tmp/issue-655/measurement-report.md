# Issue #655: Deliverable-vs-Diff Classification & AC Drift Measurement

**Date:** 2026-09-15
**Corpus:** 8 projects (pi-rukas, to-bench, to-ffee, devbox-iac, vemoizer, vipune, kuiskaus, llm-iac)
**Method:** Path-overlap heuristic — declared deliverable `paths` in the normalised spec vs. the file list in the end-of-develop diff. Full per-cycle data in `measurement.json`. All aggregate figures in this report are taken from `measurement.json` (single source of truth).

## 1. Coverage

| Metric | Value |
|---|---|
| Total cycles with normalisedSpec + reached develop (spike's own #655 cycle excluded — see caveat) | 240 |
| Diffs accessible (worktree on disk, branch in repo, or merged commit) | 138 (57.5%) |
| Diffs unavailable (worktree deleted, branch merged+deleted, never committed) | 102 (42.5%) |
| Deliverables classified (across 138 measurable cycles) | 588 |
| Deliverables with no declared paths (prose-only, classified "unmeasurable") | 163 (27.7%) |

Per-project diff availability (from `measurement.json → perProject`):

| Project | Cycles | Diffs Available | Rate |
|---|---|---|---|
| pi-rukas | 88 | 53 | 60.2% |
| to-bench | 39 | 29 | 74.4% |
| vemoizer | 14 | 14 | 100.0% |
| vipune | 20 | 20 | 100.0% |
| devbox-iac | 28 | 6 | 21.4% |
| llm-iac | 17 | 11 | 64.7% |
| to-ffee | 32 | 3 | 9.4% |
| kuiskaus | 2 | 2 | 100.0% |

One cycle (this spike's own #655, in-flight) is excluded from the corpus: it is self-referential — its diff is the spike's own artifacts under `tmp/`, so all of its deliverables would mechanically classify as absent and the quiet-truncation rate would be inflated by one self-inflicted case.

Honest caveat: 42.5% of cycles have no accessible diff. Most are handoff cycles where the worktree was cleaned up after the cycle ended. The sample is therefore biased toward cycles that either (a) are still in-flight (running), (b) were handoff cycles with worktrees that were retained, or (c) were merged (commit survives in history). This is a survivorship bias in the "accessible" direction — cycles with the worst outcomes (aborted early, never committed) are under-represented.

## 2. Deliverable Classification

Across 588 deliverables in 138 measurable cycles:

| Classification | Count | % of 588 |
|---|---|---|
| Implemented (all declared paths in diff) | 229 | 38.9% |
| Partial (some but not all declared paths in diff) | 50 | 8.5% |
| Absent (no declared paths in diff) | 146 | 24.8% |
| Unmeasurable (no declared paths — prose deliverable) | 163 | 27.7% |

(Deliverable counts are unaffected by the #655 exclusion — its deliverables are prose-only or scratch-dir references (`tmp/issue-655/`), so they would not have altered the implemented/partial/absent split; the exclusion corrects the cycle-level denominators and the quiet-truncation count.)

**Quiet truncation rate** (cycles where the develop verify gate passed — i.e., no `verify-failed` cap — but at least one deliverable is classified absent or partial): **53 of 90 cycles (58.9%)**.

This is the key number for the P2 converge-gate question. In 58.9% of cycles where the verify gate said "pass," at least one planned deliverable's declared files did not appear in the diff.

### Important caveat on the "absent" classification

The path-overlap heuristic is necessary but not sufficient. A file can be absent from the diff because:

1. **The deliverable was genuinely not implemented** (true truncation) — the P2 concern.
2. **The developer used a different file name** than the plan declared (e.g., plan said `dispatch-deck-prompt.ts` but the developer created `dispatch-deck-composite.ts`). The path in the spec is a plan-time guess; the developer may have made a different but valid naming choice.
3. **The work was in a workstream whose worktree is gone** — the measurement only sees one worktree's diff, but the cycle may have had multiple workstreams. If workstream A's worktree was cleaned up but workstream B's remains, the measurement sees only B's files.
4. **The deliverable's paths were wrong in the plan** — the plan declared paths that don't match where the work actually needed to go.
5. **The declared paths themselves are prose-dirty** — spec paths often carry backticks, line anchors, or alternatives (e.g., `` `src/to_bench/run_quality_eval.py` ~line 1750 area ``), which the normaliser does not strip. In this case the bias cuts **in both directions**: a file that IS in the diff fails to match its declared path (false "absent", inflating the truncation signal), and the same prose-dirty paths are exactly what a future converge gate would inherit from the plan unless it normalises them first. Spot-check: to-bench #106's merge commit does touch `src/to_bench/run_quality_eval.py` and `tests/test_out_e2e.py`, but the declared paths are backtick-wrapped, so all 5 deliverables classify as absent anyway.

Cases 2–5 are not "quiet truncation" in the P2 sense. The 24.8% "absent" rate therefore **overstates** the true quiet-truncation rate. A semantic analysis (reading the diff content against the deliverable description) would be needed to separate true truncation from path mismatch. This spike's path-overlap method gives an upper bound.

### Cases where the signal is strong

The quiet-truncation signal is most reliable when:
- The cycle had a single workstream (no multi-workstream ambiguity)
- The verify gate passed cleanly (no `verify-failed`, no `step-failed:develop`)
- The diff is non-trivial (≥3 files changed)
- The deliverable had specific file paths declared

## 3. AC Drift

**AC drift detected in 42 of 138 measurable cycles (30.4%).**

The drift detection works in two ways:
1. **Scope fanout**: the verify gate's scope-fanout check fires when the diff touches more files than the plan declared. This means the plan's file list (which the ACs are scoped to) did not match the actual work.
2. **Verify-passed-but-paths-missing**: the verify gate passed (no failures recorded in the state file) but >30% of declared deliverable paths are not in the diff. This means the gate checked a narrower contract than the plan's ACs implied.

Most verify failures are **mechanical**, not AC-related:
- `out-of-scope path` violations (fence violations)
- `consolidated verify` cherry-pick conflicts
- `commit ahead of baseSha` (developer didn't commit)
- `PR identity mismatch` (ops opened PR for wrong branch)
- `protected path` writes
- `verify command` build/test failures

One caveat: the "verify passed" condition for signal 2 is read from the state file's `verifyEvidence`, which is absent on cycles that capped with `step-failed:develop`. For those 9 cycles (pi-rukas #545, #284, #728, #543, #451, #546; vemoizer #37; vipune #164; llm-iac #318) the drift flag is still legitimately true — the paths are genuinely missing from the diff — but the accompanying note text ("verify passed") is misleading and should be read as "no verify-failure recorded".

The true "AC drift" — where the verify gate checked a different contract than what the intent gate froze — is hard to isolate from the mechanical noise. The 30.4% figure includes scope-fanout, which is a plan-under-declaration problem rather than a contract-drift problem. The number of cycles showing **pure AC drift** (verify passed, no scope fanout, but deliverable paths missing) is a subset of the 53 quiet-truncation cases.

## 4. Interpretation for the P2/P4 Decision

### P2 (Converge gate): Warranted

The 58.9% quiet-truncation rate (upper bound) is high enough to warrant a converge gate. Even if the true rate is half the measured rate (accounting for path mismatches and multi-workstream ambiguity), ~30% of verify-passing cycles have at least one deliverable that may not be fully implemented. That is a meaningful failure mode.

The converge gate would:
- At end-of-develop, read the plan's deliverable list
- For each deliverable, check whether the diff covers its declared paths (and optionally its description)
- Flag deliverables as "not found in diff" for the adversarial gate to weigh
- Compose with the existing `claim-scan.ts` grounding seam (per the research doc)
- **Normalise declared paths first** — strip backticks, line anchors (`~line 1750`), and `(new)` / `or …` annotations — otherwise the gate inherits the plan-side prose-dirtiness described in §2 caveat 5 and produces false "not found" flags

### P4 (Validation contract): Conditionally warranted

The 30.4% AC drift rate is significant but confounded by mechanical failures. The pure "contract drift" signal — where the verify gate's checked contract diverged from the intent gate's frozen ACs — is harder to isolate. However, the scope-fanout signal (plan declared N files, diff touched M>N) is a concrete, measurable form of contract drift that occurs in a meaningful subset of cycles.

The validation contract gate would:
- At plan time, freeze the ACs as a content-addressed artifact
- At verify time, check the diff against the frozen ACs (not the current issue body)
- Prevent the ACs from being implicitly "relaxed" by the verify gate checking a narrower surface

**Recommendation:** File the P2 converge-gate issue with the measured cases as fixtures. For P4, the signal is weaker and confounded — recommend a lighter-weight instrument first (log the scope-fanout delta per cycle) rather than a full contract-freezing mechanism, unless the scope-fanout rate stays above 20% after the converge gate is in place.

## 5. Method Limitations

1. **Path overlap is necessary, not sufficient.** A file in the diff ≠ a deliverable implemented. The 38.9% "implemented" rate is a lower bound on true implementation.
2. **Survivorship bias.** 42.7% of cycles have no accessible diff. The measurable sample is biased toward cycles that survived to a point where their diff is still accessible.
3. **Multi-workstream ambiguity.** For cycles with multiple workstreams, the measurement sees the union of all accessible worktree diffs. If one workstream's worktree was cleaned up, its files are missing from the measurement.
4. **Plan-time path accuracy — bias in both directions.** The deliverable's `paths` field is a plan-time guess. If the developer chose different file names (a common occurrence), the measurement reports "absent" even though the work was done. Conversely, prose-dirty declared paths (backticks, line anchors, "or" alternatives — see §2 caveat 5) make files that ARE in the diff fail to match, also producing false "absent" classifications (e.g., to-bench #106).
5. **Merged-commit fallback is approximate.** For cycles whose branch was deleted, the diff is recovered via `git log --all --grep=#<issue>`, which can match a nearby-but-wrong merge commit. Spot-checks found this occasionally (to-bench #106 matched a merge whose content happened to be right).
6. **AC drift is confounded.** Most verify failures are mechanical. The true "contract drift" rate is a subset of the 30.4% figure. The "verify passed" note also fires on the 9 `step-failed:develop` cycles that never recorded verify evidence (see §3).

## 6. Fixtures for the P2 Issue

The following cycles show the strongest quiet-truncation signal (no `verify-failed` cap, ≥3 files changed, ≥2 deliverables declared, multiple declared paths missing from the diff):

| Project | Issue | Deliverables | Absent/Partial | Diff Files |
|---|---|---|---|---|
| pi-rukas | 725 | 6 | d3,d4 absent; d2,d5 partial | 5 |
| pi-rukas | 543 | 7 | 1 absent, 4 partial | 100 |
| pi-rukas | 451 | 5 | 1 absent, rest implemented | 25 |
| pi-rukas | 492 | 4 | 1 absent, 1 partial | 8 |
| pi-rukas | 539 | 5 | 2 partial, 1 absent | 15 |
| pi-rukas | 307 | 4 | 4 absent (paths all missing) | 5 |
| to-bench | 106 | 5 | 5 absent (merged-commit diff + prose-dirty paths — caveat applies) | 3 |
| devbox-iac | 89 | 5 | 5 absent | 12 |
| vemoizer | 12 | 3 | 1 absent, 1 partial | 8 |
| vipune | 148 | 4 | 3 absent, 1 partial | 12 |
| llm-iac | 263 | 5 | 4 absent | 9 |
| llm-iac | 318 | 5 | 5 absent | 8 |

(See `measurement.json` → `results[]` for full per-deliverable classifications.)
