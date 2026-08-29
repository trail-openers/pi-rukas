/**
 * detectRepeatSeam — find missing-seam signals in a lens round's findings.
 *
 * Issue #280 — when the same-shaped defect appears across ≥3 distinct file
 * paths, it is not N defects: it is a missing seam (shared abstraction,
 * shared validation, shared pattern). Patching each instance buries the
 * duplication deeper; the driver escalates to step-back instead.
 *
 * Clustering key: (lens, normalised title). Title normalisation lowercases
 * and strips file-specific tokens (paths, filenames, line numbers, SHAs,
 * variable names) so "Missing null check on src/a.rs:42" and "Missing null
 * check on src/b.rs:17" land in the same cluster.
 *
 * A cluster spanning ≥3 distinct file paths fires a seam signal.
 */

/**
 * A repeat-seam cluster detected across findings.
 *
 * `findings` is the full list of findings that belong to this cluster (not
 * just the first three — all of them, so the caller can decide how to
 * surface the finding).
 */
export interface RepeatSeamSignal {
  /** The lens that filed all findings in this cluster. */
  lens: string;
  /** Normalised title (lowercase, file tokens stripped). */
  normalisedTitle: string;
  /** Distinct file paths that triggered this cluster. */
  files: string[];
  /** All findings that belong to this cluster (ordered as input). */
  findings: Array<{ lens: string; title: string; path: string }>;
  /** Number of distinct files — convenience alias for the signal length. */
  fileCount: number;
}

/**
 * File-path token regex — matches absolute/relative paths in titles.
 *
 * Captures patterns like `src/foo/bar.rs`, `./mod.rs`, `/dev/null`,
 * `C:\foo\bar.rs`. Stripped before clustering.
 */
const PATH_TOKEN =
  /\b(?:[a-zA-Z]:\\)?(?:[\w.-]+\/)*[\w.-]+\.(?:rs|ts|js|jsx|tsx|py|go|java|kt|scala|rb|cs|cpp|h|cc|mm|m|sh|yml|yaml|json|toml|md|txt|sql|css|scss|html|html|xml|proto|gradle|sbt|clj|ex|exs|erl|hs|ml|fs|swift|php|lua|r|R|pl|pm|raku|dart|zig|c|cxx|m|S|asm|v|sv|vhd|vhdl|tcl|el|lisp|scm|ss|rkt|lua|awk|sed|makefile|cmake|meson|ninja|Dockerfile|Makefile|Justfile|SConstruct|CMakeLists|Cargo\.toml|package\.json|go\.mod|go\.sum|pyproject\.toml|requirements|Pipfile|Gemfile|composer|mix\.exs|stack\.)\b/gi;

/**
 * Strip file-specific tokens from a title for clustering.
 *
 * Lowercases, removes file paths, line numbers, SHAs, and arbitrary
 * identifiers that vary per-file but share the same defect class.
 */
function normaliseTitle(title: string): string {
  let s = title.toLowerCase();
  // Strip absolute / relative paths with extensions
  s = s.replace(PATH_TOKEN, "<path>");
  // Strip generic path segments that look like file references
  s = s.replace(
    /\b(?:src|lib|pkg|app|modules?|components?|tests?|spec|__tests__|test)\b\/[\w./\\-]+/g,
    "<path>",
  );
  // Strip `:NN` line references (must run BEFORE path-glue strip so
  // `:<line>` is available for matching)
  s = s.replace(/:\d+/g, ":<line>");
  // Strip "at line NN" phrases
  s = s.replace(/\bat line \d+/gi, "at line <N>");
  // Strip 7+ char hex strings (git SHAs)
  s = s.replace(/\b[0-9a-f]{7,}\b/g, "<sha>");
  // Strip quoted strings that might be file names
  s = s.replace(/["'`][^"'`]{3,}["'`]/g, "<ref>");
  // Strip path references along with connecting words ("in", "at", "on",
  // "for") and surrounding glue (":<line> - ", " - ", " in ").
  // Must match `<path>:<line> - ` or `<path> - ` at start, `in <path>` anywhere.
  s = s.replace(/^(?:<path>:?<line>?[:\- ]+|(?:(?:in|at|on|for)\s+)?<path>[:\- ]+)/, "");
  s = s.replace(/[:\- ]+(?:in|at|on|for)?\s*<path>$/g, "");
  // Strip dangling glue words at end: ` in`, ` at`, ` on`, ` for`
  s = s.replace(/\s+(?:in|at|on|for)\s*$/, " ");
  // Strip leading number-glue: `12 - ` or `12:`
  s = s.replace(/^\d+[:\- ]+/, "");
  // Strip "at line NN" anywhere — match both raw numbers and pre-normalised
  // placeholders (the `at line NN` strip above runs BEFORE path-glue
  // removal, which can leave `at line <N>` behind)
  s = s.replace(/\bat line (?:\d+|<N>)/gi, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Detect a missing-seam signal among findings.
 *
 * Clusters by (lens, normalised title). A cluster spanning ≥3 distinct file
 * paths fires a seam signal. Returns the FIRST (or only) signal, or `null`
 * when no seam is detected.
 *
 * The function is **deterministic** and **pure** — no I/O, no side effects.
 * It is called inside the driver's lens-review handling path.
 *
 * Returns `null` when:
 *   - No cluster has ≥3 distinct file paths
 *   - The findings array is empty
 *
 * Returns the FIRST signal found (by input-order of the first finding in
 * each cluster) so the driver's deterministic routing is unambiguous.
 */
export function detectRepeatSeam(
  findings: Array<{ lens: string; title: string; path: string }>,
): RepeatSeamSignal | null {
  if (findings.length === 0) return null;

  // Group by (lens, normalisedTitle)
  const clusters = new Map<string, Array<{ lens: string; title: string; path: string }>>();

  for (const f of findings) {
    const key = `${f.lens}::${normaliseTitle(f.title)}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.push(f);
    } else {
      clusters.set(key, [f]);
    }
  }

  // Find the first cluster (in input-order of first finding) with ≥3 distinct files
  let firstIndex = Number.POSITIVE_INFINITY;
  let bestSignal: RepeatSeamSignal | null = null;

  clusters.forEach((cluster, key) => {
    // cluster is typed as Array<{...}> from Map<K, V>
    // Use Array.find to avoid index-access TypeScript errors
    const first = cluster.find(() => true);
    if (!first) return;
    const files = [...new Set(cluster.map((f) => f.path))];
    if (files.length >= 3 && first.lens !== "") {
      // Track which cluster appeared first in input order
      const idx = findings.indexOf(first);
      if (idx < firstIndex) {
        firstIndex = idx;
        bestSignal = {
          lens: first.lens,
          normalisedTitle: key.split("::").slice(1).join("::"),
          files,
          findings: cluster,
          fileCount: files.length,
        };
      }
    }
  });

  return bestSignal;
}
