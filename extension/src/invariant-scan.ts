/**
 * invariant-scan — deterministic type-widening scanner for diff analysis.
 *
 * Issue #279 — detects compiler-enforced invariants being removed or
 * weakened in a git diff. The scanner is route-only: findings are
 * injected into the lens context for the ARCHITECTURE lens to evaluate.
 *
 * Pattern classes (deterministic regex over added/removed diff lines):
 *
 *   1. Option widening (Rust): `T` → `Option<T>` or `T?`
 *   2. Optional widening (TS): added `| null`, `| undefined`, or `?:`
 *   3. Removed mutability guards: `readonly`, `final`, `const`, `NOT NULL`
 *   4. Type erasure: narrowed to `any`, `unknown`, or `interface{}`
 *   5. Removed invariant checks: `assert`, `debug_assert!`, `invariant()`
 *   6. Visibility widening: removed `pub` (Rust), removed `private` (TS)
 *   7. Generic widening: `T<U>` → `T<any>`, `T<unknown>`, or removed bounds
 */

/**
 * Type-widening finding from the scan.
 *
 * `kind` identifies which pattern fired. `before` and `after` are the
 * captured substrings from the removed/added lines (useful for the ARCHITECTURE
 * lens to see "what changed").
 */
export interface WideningFinding {
  file: string;
  line?: number;
  kind:
    | "option-widening-rust"
    | "option-widening-ts"
    | "optional-property"
    | "removed-readonly"
    | "type-erasure"
    | "removed-assert"
    | "removed-pub"
    | "removed-mut"
    | "generic-widening";
  before?: string;
  after?: string;
}

/**
 * Parse a diff line to extract file path and line number.
 *
 * Diff hunk headers look like: `@@ -<start>,<count> +<start>,<count> @@`
 * File headers look like: `--- a/<path>` or `+++ b/<path>`
 *
 * Returns the current file context and optional line number from the hunk.
 */
function parseDiffLine(
  line: string,
  currentFile: { file: string | null; hunkLine: number | undefined },
): { file: string | null; line: number | undefined } {
  // File headers: `--- a/path/to/file` or `+++ b/path/to/file`.
  //
  // The `+++` (post-change) path is authoritative, because every finding
  // describes the state AFTER the change — on a rename the `---` path no
  // longer exists, so reporting it points the reviewer at a file that is not
  // there. The `---` path is kept only as the fallback for deletions, where
  // `+++` is `/dev/null`.
  //
  // Two bugs lived in the old pattern: a stray space in the alternation
  // (`(---| \+\+\+)`) meant `+++` never matched at all, and the prefix strip
  // was `(?:a\/)?`, which would have left `b/` on the path even if it had.
  const fileMatch = line.match(/^(---|\+\+\+) (?:[ab]\/)?(.+)$/);
  const matchedPath = fileMatch?.[2];
  if (matchedPath) {
    if (fileMatch?.[1] === "+++") {
      if (matchedPath !== "/dev/null") currentFile.file = matchedPath;
    } else if (matchedPath !== "/dev/null") {
      currentFile.file = matchedPath;
    }
    currentFile.hunkLine = undefined;
    return { file: currentFile.file, line: undefined };
  }
  // Hunk header: `@@ -<start>,<count> +<start>,<count> @@`
  const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  if (hunkMatch?.[1] && currentFile.file) {
    currentFile.hunkLine = Number.parseInt(hunkMatch[1], 10) - 1; // Zero-based
    return { file: currentFile.file, line: currentFile.hunkLine };
  }
  // Added/removed lines: starts with `+` or `-` (not `+++` or `---`)
  if (line.startsWith("+") && !line.startsWith("+++")) {
    const lineNum = currentFile.hunkLine !== undefined ? currentFile.hunkLine + 1 : undefined;
    currentFile.hunkLine = lineNum;
    return { file: currentFile.file, line: lineNum };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    // Removed lines don't advance the hunk line
    return { file: currentFile.file, line: currentFile.hunkLine };
  }
  if (currentFile.hunkLine !== undefined) {
    currentFile.hunkLine++;
  }
  return { file: currentFile.file, line: undefined };
}

/**
 * Scan a git diff for type-widening patterns.
 *
 * Returns an array of findings. Caller is responsible for injecting
 * these into the lens context with the framing:
 *
 *   "the ARCHITECTURE lens must answer: what invariant did this widening
 *    remove, and what now guarantees it?"
 *
 * The scanner is routes-only — it does not fail the cycle.
 */
/**
 * Added-line text for each hunk, in hunk order.
 *
 * Hunk-scoped rather than whole-diff: a `const` removed in one function and an
 * unrelated `const` added a hundred lines away are different facts, and
 * matching across the whole file would suppress genuine removals.
 */
function collectHunkAddedLines(lines: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = [];
      out.push(current);
      continue;
    }
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.push(line.slice(1));
    }
  }
  return out;
}

/**
 * Did `token` actually disappear in this hunk?
 *
 * True when no added line in the hunk still contains it. Errs toward
 * SUPPRESSING the finding when the hunk is unknown — a route-only scanner that
 * cries wolf gets ignored, which costs more than the occasional missed
 * widening.
 */
function stillGone(hunkAdded: string[][], hunkIndex: number, token: string): boolean {
  const added = hunkAdded[hunkIndex];
  if (!added) return true;
  const needle = token.trim();
  if (!needle) return true;
  const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return !added.some((l) => re.test(l));
}

export function scanTypeWidening(diff: string): WideningFinding[] {
  const findings: WideningFinding[] = [];
  const lines = diff.split("\n");
  const currentFile: { file: string | null; hunkLine: number | undefined } = {
    file: null,
    hunkLine: undefined,
  };
  // Added-line text per hunk, indexed by the hunk each line belongs to.
  //
  // The "removed X" classes (readonly/const, assert, pub, mut) are about a
  // guard DISAPPEARING. Judged one line at a time they instead fire whenever
  // the keyword merely appears on a `-` line — so `-  const x: string` /
  // `+  const x: string | null` reported a removed `const` that is plainly
  // still there. Since the scanner routes into the ARCHITECTURE lens, that is
  // a noise pump: nearly every touched `const` line in a TS diff would carry
  // a spurious finding.
  const hunkAdded = collectHunkAddedLines(lines);
  let hunkIndex = -1;

  for (const rawLine of lines) {
    if (rawLine.startsWith("@@")) hunkIndex += 1;
    const { file, line } = parseDiffLine(rawLine, currentFile);
    if (!file || !file.match(/\.(rs|ts|tsx|js|jsx)$/)) {
      continue; // Only scan Rust and TS files
    }
    if (!rawLine.startsWith("+") && !rawLine.startsWith("-")) {
      continue; // Only added or removed lines
    }
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
      continue; // Skip file headers
    }

    const codeLine = rawLine.slice(1); // Strip leading `+` or `-`
    const isAdded = rawLine.startsWith("+");

    // Pattern 1: Rust option widening (T → Option<T> or T → T?)
    // Added: `embedder: Option<EmbeddingEngine>`, removed: `embedder: EmbeddingEngine`
    if (file.endsWith(".rs")) {
      const rustOptionMatch = codeLine.match(/:\s*(?:Option<(\w+(?:::\w+)*)>|(\w+(?:::\w+)*)\?)/);
      if (rustOptionMatch) {
        findings.push({
          file,
          line,
          kind: "option-widening-rust",
          after: rustOptionMatch[0],
          before: isAdded ? undefined : rustOptionMatch[0],
        });
      }
    }

    // Pattern 2a: TS option widening (added `| null` or `| undefined`)
    if (file.match(/\.(ts|tsx|js|jsx)$/)) {
      const nullWidenMatch = codeLine.match(/(\w+(?:<[^>]+>)?)\s*(?::\s*)?\|?\s*(null|undefined)/);
      if (nullWidenMatch && isAdded) {
        findings.push({
          file,
          line,
          kind: "option-widening-ts",
          before: nullWidenMatch[1],
          after: nullWidenMatch[0],
        });
      }

      // Pattern 2b: TS optional property (added `?:`)
      const optionalPropMatch = codeLine.match(/(\w+)\s*\?:/);
      if (optionalPropMatch && isAdded) {
        findings.push({
          file,
          line,
          kind: "optional-property",
          before: optionalPropMatch[1],
          after: optionalPropMatch[0],
        });
      }
    }

    // Pattern 3: Removed mutability guards (readonly, final, const, NOT NULL)
    const removedMutabilityMatch = codeLine.match(/\b(?:readonly|final|const|NOT NULL)\b/);
    if (
      removedMutabilityMatch &&
      !isAdded &&
      stillGone(hunkAdded, hunkIndex, removedMutabilityMatch[0])
    ) {
      findings.push({
        file,
        line,
        kind: "removed-readonly",
        before: removedMutabilityMatch[0],
      });
    }

    // Pattern 4: Type erasure (narrowed to any, unknown, or interface{})
    const typeErasureMatch = codeLine.match(/(?:\b(?:any|unknown)\b|interface\{\})/);
    if (typeErasureMatch && isAdded) {
      findings.push({
        file,
        line,
        kind: "type-erasure",
        after: typeErasureMatch[0],
      });
    }

    // Pattern 5: Removed invariant checks (assert, debug_assert!, invariant())
    const removedAssertMatch = codeLine.match(
      /\b(?:assert!\(|debug_assert!\(|invariant\(|assert\()/,
    );
    if (removedAssertMatch && !isAdded && stillGone(hunkAdded, hunkIndex, removedAssertMatch[0])) {
      findings.push({
        file,
        line,
        kind: "removed-assert",
        before: removedAssertMatch[0],
      });
    }

    // Pattern 6: Removed `pub` (Rust)
    if (file.endsWith(".rs")) {
      const removedPubMatch = codeLine.match(/\bpub\s+(?:fn|struct|enum|trait|mod)\s+/);
      if (removedPubMatch && !isAdded && stillGone(hunkAdded, hunkIndex, "pub")) {
        findings.push({
          file,
          line,
          kind: "removed-pub",
          before: removedPubMatch[0],
        });
      }

      // Pattern 7: Removed `mut` (Rust)
      const removedMutMatch = codeLine.match(/\bmut\s+/);
      if (removedMutMatch && !isAdded && stillGone(hunkAdded, hunkIndex, "mut")) {
        findings.push({
          file,
          line,
          kind: "removed-mut",
          before: removedMutMatch[0],
        });
      }
    }

    // Pattern 8: Generic widening (T<any>, T<unknown>, removed bounds)
    const genericWidenMatch = codeLine.match(/[A-Z]\w+<(?:any|unknown)>/);
    if (genericWidenMatch && isAdded) {
      findings.push({
        file,
        line,
        kind: "generic-widening",
        after: genericWidenMatch[0],
      });
    }
  }

  return findings;
}
