/**
 * lens-review-skills — the pre-fan-out skills-dir check for #872 (epic
 * #867 sub-issue 1).
 *
 * `skillsDirUsable` is the single choke point for the "skills dir missing
 * or empty → block ALL six lenses with ONE install-oriented message"
 * decision (decision 2). It is evaluated ONCE in `runLensReview` before
 * the `Promise.all` fan-out — not six times inside `runLensChild` — so the
 * operator sees one message, not six identical parseErrors.
 *
 * `blockedLensResults` is the per-lens shape that message produces: all
 * six lenses blocked with `attempts: 0` (no spawn, no retries) and the
 * single install message as `parseError`. Feeds the existing
 * REVIEW_INCOMPLETE path via `computeVerdict`'s `some((r) => r.blocked)`.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { LENSES } from "./lens-review-format.ts";
import type { LensRunResult } from "./lens-review.ts";

/**
 * #872 — the skills dir itself must exist and hold at least one of the six
 * lens skill subdirs. Missing dir, empty dir, or a dir with only unrelated
 * skills → returns the install-oriented message (and the caller blocks all
 * six lenses with it). `statSync` follows symlinks (the real skills dir
 * holds symlinks into the repo's skill/ per install.sh), so a dangling
 * symlink counts as missing. Returns `undefined` when the dir is usable.
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
  const present = LENSES.some((lens) => {
    try {
      statSync(path.join(dir, lens.skill));
      return true;
    } catch {
      return false;
    }
  });
  return present ? undefined : message;
}

/**
 * #872 — the per-lens shape of a skills-dir block: all six lenses blocked
 * with `attempts: 0` (no spawn, no retries) and the single install message
 * as `parseError`. `startMs` is captured at call time so the six rows carry
 * the same timestamp (the fan-out never started).
 */
export function blockedLensResults(problem: string): LensRunResult[] {
  const startMs = Date.now();
  return LENSES.map((lens) => ({
    lens: lens.name,
    ok: false,
    ms: 0,
    startMs,
    findings: [],
    attempts: 0,
    blocked: true,
    parseError: problem,
  }));
}
