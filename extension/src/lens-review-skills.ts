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
 * `installBlockRows` is the per-lens shape that message produces: one
 * blocked row per BUNDLED lens (derived from `LENS_ROSTER`, deduped), all
 * with `attempts: 0` (no spawn, no retries) and the single install message
 * as `parseError`. Feeds the existing REVIEW_INCOMPLETE path via
 * `computeVerdict`'s `some((r) => r.blocked)`.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { LENS_PREFIX } from "./lens-review-format.ts";
import type { LensRunResult } from "./lens-review.ts";
import { LENS_ROSTER } from "./lens-roster.ts";
import { trace } from "./trace.ts";

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
 * #872/#873 — the install-block rows: when the skills dir is missing,
 * empty, or has no usable `code-review-*` lens skill, the roster is empty
 * and the review must still produce one blocked row per standard lens name
 * so `computeVerdict` sees the block and returns REVIEW_INCOMPLETE. The
 * rows are derived from the BUNDLED `LENS_ROSTER` (names in roster order,
 * deduped) — the roster is data, so a seventh bundled lens gets a row
 * without a code change. If the bundled dir is unreadable at module load
 * (`LENS_ROSTER` is empty) the expected set is unavailable: a single row
 * named "LENSES" carries the problem so the verdict is still
 * REVIEW_INCOMPLETE (traced — the install message alone is the signal).
 */
export function installBlockRows(problem: string): LensRunResult[] {
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
  if (names.length > 0) return rows(names);
  trace(
    `install block: bundled lens roster unreadable (LENS_ROSTER empty) — single "LENSES" row carries the problem: ${problem}`,
  );
  return rows(["LENSES"]);
}
