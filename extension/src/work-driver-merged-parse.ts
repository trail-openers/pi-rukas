/**
 * Step 6 — Parse `pr: <N>` from an ops commit-pr reply. Lenient — accepts
 * surrounding markdown emphasis (`**pr**: 556`), backticks (`pr: #556`,
 * `pr: \`#556\``), and the bare-or-`#`-prefixed number. Returns `undefined`
 * when no marker line is present.
 */
export function parsePrNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}pr\*{0,2}\s*:\s*`?#?(\d+)`?\s*$/im);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Parse a `merge-commit: <sha>` marker line from ops's merge reply. Lenient:
 * accepts surrounding markdown (`**merge-commit:**`), backticks, and the 7+
 * hex-char SHA shape `gh pr merge` prints. Returns undefined when no marker is
 * present (the merge still succeeded; we just lost the SHA for the merged event).
 */
export function parseMergeCommit(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*[*_`]*\s*merge-commit\b[^0-9a-f\n]*([0-9a-f]{7,40})[^0-9a-f\n]*$/im);
  return m?.[1];
}
