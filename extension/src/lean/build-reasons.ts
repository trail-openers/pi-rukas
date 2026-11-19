/**
 * The build step's reason clauses the fold owns: the paths it did NOT keep, the inert configured
 * globs, and the submodule caveat. `build` composes them in TWO places — the `ok` verdict and the
 * ceiling-stopped verdict a budget round builds for itself — so one module holds both and a clause
 * cannot reach one arm and miss the other (#2319 R4). Each function returns parts, not a joined
 * string: the caller keeps `joinNotes` and the clauses that are its own.
 */

import type { NormaliseReport } from "./build-types.ts";
import { clipList } from "./text-fence.ts";

/** How the fold words the inert-glob clause; the accumulator strips and re-adds it verbatim. */
const INERT_PREFIX = "protected paths matched nothing: ";
const INERT_PREFIX_RE = /^protected paths matched nothing: /;

/** What a reason may name before the list itself becomes the noise. */
const LIST_CLIP = 20;

/**
 * The fold's account of the paths it did NOT keep, as the `ok` reason prints them. */
export function foldClauses(report: NormaliseReport): string[] {
  return [
    report.restored.length > 0 ? `restored: ${report.restored.join(", ")}` : "",
    report.reverted.length > 0 ? `reverted: ${report.reverted.join(", ")}` : "",
    report.removed.length > 0
      ? `removed: ${report.removed.map((r) => `${r.path} (${r.why})`).join(", ")}`
      : "",
    report.deleted.length > 0 ? `deleted: ${report.deleted.join(", ")}` : "",
    // An inert configured glob is disclosed rather than accepted in silence — the only way a
    // protection rots without anyone noticing.
    report.protectedUnmatchedNote ?? "",
    // Disclosed in the fold's own reason, not only in the trace: this step's commit was built
    // against a tree with no submodule at that path. Every kind but `seeded` is named — git
    // refusing the pass is as much a caveat as a submodule it could not find locally.
    report.submodules ?? "",
  ];
}

/**
 * What the ceiling-stopped folds of one visit account for, accumulated across folds rather than
 * taken from the newest report: a budget round folds one child, commits it, then runs another on
 * top of that commit, so a path the FIRST fold undid is gone from the second's changed set. The
 * box is returned rather than passed in so a caller cannot hand one accumulator to two steps.
 */
export function budgetFoldAccumulator(): {
  note: (report: NormaliseReport) => void;
  /** The stopped fold's account, given the report this round's fold returned. */
  clauses: (report: NormaliseReport) => string[];
} {
  const reverted: string[] = [];
  const unmatched: string[] = [];
  return {
    note: (report) => {
      for (const p of report.reverted) if (!reverted.includes(p)) reverted.push(p);
      for (const p of (report.protectedUnmatchedNote ?? "")
        .replace(INERT_PREFIX_RE, "")
        .split(", "))
        if (p !== "" && !unmatched.includes(p)) unmatched.push(p);
    },
    clauses: (report) => [
      reverted.length > 0 ? `reverted: ${reverted.join(", ")}` : "",
      unmatched.length > 0 ? `${INERT_PREFIX}${unmatched.join(", ")}` : "",
      // #2319 Resolution 4: a ceiling-stopped fold owes the submodule disclosure too, and
      // both its handback and the retry's prompt read this line.
      report.submodules ?? "",
    ],
  };
}

/** The kept-file count of a stopped fold, phrased the way the handback has always phrased it. */
export function keptClause(files: readonly string[]): string {
  return files.length === 0 ? "" : `kept ${String(files.length)} file(s)`;
}

/** The still-red frozen tests a stopped round hands to the retry's prompt. */
export function failingClause(failing: readonly string[]): string {
  return failing.length === 0 ? "" : `still failing: ${clipList(failing, LIST_CLIP)}`;
}
