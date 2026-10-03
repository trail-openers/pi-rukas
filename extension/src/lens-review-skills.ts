/**
 * lens-review-skills — the pre-fan-out skills-dir check for #872 (epic
 * #867 sub-issue 1).
 *
 * `skillsDirUsable` is the single choke point for the "skills dir missing
 * or empty → block ALL lenses with ONE install-oriented message" decision
 * (decision 2). It is evaluated ONCE in `runLensReview` before the
 * `Promise.all` fan-out — not six times inside `runLensChild` — so the
 * operator sees one message, not six identical parseErrors.
 *
 * #966 — the #872 install-block early exit (`runInstallBlock` + its
 * `installBlockRows` helper) is now dead code: the empty-roster guard in
 * `runLensReview` subsumes it (the cases `skillsDirUsable` flags are
 * exactly the cases where `buildExpectedRoster` returns `[]`), and the
 * guard produces the same deck bookkeeping (via `blockedReviewSummary`) and
 * the same blocked rows (via `installBlockRowsForRoster`, below). The
 * #872 doctrine lives on in this file via `skillsDirUsable`'s docstring
 * (the install-message rule) and in `installBlockRowsForRoster`'s
 * docstring (the row shape), so nothing operator-visible is lost.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { LENS_PREFIX } from "./lens-review-format.ts";
import type { LensRunResult } from "./lens-review.ts";
import { LENS_ROSTER } from "./lens-roster.ts";

/**
 * #872 — the skills dir itself must exist and hold at least one
 * `code-review-*` lens skill DIRECTORY (the roster predicate, from which
 * this check must not disagree). Missing dir, empty dir, a dir with only
 * unrelated skills, or a dir holding only a `code-review-*` plain file
 * (which the roster ignores) → returns the install-oriented message (and
 * the caller blocks all lenses with it). `statSync` follows symlinks (the
 * real skills dir holds symlinks into the repo's skill/ per install.sh),
 * so a dangling symlink counts as missing. Returns `undefined` when the
 * dir is usable.
 */
export function skillsDirUsable(dir: string): string | undefined {
  const message = `skills dir ${dir} missing or empty — run ./install.sh`;
  try {
    statSync(dir);
  } catch {
    return message;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return message;
  }
  if (entries.length === 0) return message;
  const present = entries.some((entry) => {
    if (!entry.startsWith(LENS_PREFIX)) return false;
    try {
      return statSync(path.join(dir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
  return present ? undefined : message;
}

/**
 * #872/#873/#966 — the empty-roster blocked rows. When the installed skills
 * dir resolves to ZERO lenses (missing dir, empty dir, no `code-review-*`
 * skill — the cases `skillsDirUsable` flags), `buildExpectedRoster` returns
 * `[]` and the review must still produce blocked rows so `computeVerdict`
 * sees the block and returns REVIEW_INCOMPLETE (never zero rows → never a
 * silent APPROVED, the #966 incident).
 *
 * The rows are derived from the BUNDLED `LENS_ROSTER` (names in roster
 * order, deduped) — the roster is data, so a seventh bundled lens gets a
 * row without a code change. If the bundled dir is unreadable at module
 * load (`LENS_ROSTER` is empty) the expected set is unavailable: a single
 * row named "LENSES" carries the problem so the verdict is still
 * REVIEW_INCOMPLETE (the install message is the operator-visible signal).
 *
 * Called from the empty-roster guard in `runLensReview`; the deck
 * bookkeeping lives in `blockedReviewSummary` (lens-review-diff.ts), which
 * the guard also invokes.
 */
export function installBlockRowsForRoster(problem: string): LensRunResult[] {
  const startMs = Date.now();
  const rows = (names: string[]): LensRunResult[] =>
    names.map((lens) => ({
      lens,
      ok: false,
      ms: 0,
      startMs,
      findings: [],
      attempts: 0,
      blocked: true,
      parseError: problem,
    }));
  const names = [...new Set(LENS_ROSTER.map((e) => e.name))];
  return names.length > 0 ? rows(names) : rows(["LENSES"]);
}
