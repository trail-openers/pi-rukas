/**
 * agents-md-diff — the pure unified-diff renderer for the `/agents-md`
 * tools.
 *
 * Extracted from agents-md-tool.ts (#840) both to give the diff its own unit
 * surface (every invariant testable without driving the registered tool or a
 * fake ExtensionAPI) and to keep agents-md-tool.ts comfortably under the
 * 500-line gate.
 *
 * The algorithm:
 *   1. Split both texts into lines with ONE convention: the empty string is
 *      ZERO lines; a trailing newline on either side does not add a phantom
 *      line. ("a\nb" and "a\nb\n" both split to ["a", "b"].) This is the
 *      convention that makes the "count of + lines == lines added" property
 *      hold deterministically.
 *   2. Longest-common-subsequence alignment over the two line arrays,
 *      yielding a flat op list (ctx / del / add).
 *   3. A single forward cursor walks the op list and emits DISJOINT hunks:
 *      each change run (contiguous del/add ops) is surrounded by one line of
 *      context on each side, and two runs whose context windows touch are
 *      merged into one hunk. No op index is ever rendered twice — this is the
 *      property the overlapping-hunk renderer it replaced violated (a hunk
 *      at start-1..end+1 followed by resume-at-end+1 re-emitted the trailing
 *      context, so with an empty old text each inserted line appeared 2-3
 *      times).
 *
 * Output is truncated at DIFF_MAX_LINES rendered diff lines; the `… K more
 * lines` marker's remainder is the number of ops the cursor has NOT yet
 * reached, counted once each.
 */

export const DIFF_MAX_LINES = 200;

/**
 * Cell budget for the LCS table: if n·m exceeds this, the alignment is
 * skipped and an explicit marker line is returned instead. Guards against
 * quadratic memory/time on pathologically large inputs — a short explicit
 * diff, never a silently truncated one.
 */
export const DIFF_MAX_CELLS = 4_000_000;

/**
 * The one split rule both sides share. Empty text → zero lines; a trailing
 * newline is dropped so "a\nb\n" and "a\nb" are line-identical.
 */
export function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { kind: "ctx" | "del" | "add"; line: string };

/**
 * Align old/new line arrays into a flat op list via LCS. The LCS table is
 * O(n·m) — fine at AGENTS.md size. Returns undefined when the input pair
 * exceeds DIFF_MAX_CELLS: the caller renders an explicit marker instead of
 * allocating a table it cannot afford.
 */
function align(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_MAX_CELLS) return undefined;
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => {
    const v = dp[i * (m + 1) + j];
    return typeof v === "number" ? v : 0;
  };
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i];
    for (let j = m - 1; j >= 0; j--) {
      const bj = b[j];
      if (ai !== undefined && bj !== undefined) {
        dp[i * (m + 1) + j] =
          ai === bj ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i];
    const bj = b[j];
    if (ai !== undefined && bj !== undefined && ai === bj) {
      ops.push({ kind: "ctx", line: ai });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      if (ai !== undefined) ops.push({ kind: "del", line: ai });
      i++;
    } else {
      if (bj !== undefined) ops.push({ kind: "add", line: bj });
      j++;
    }
  }
  while (i < n) {
    const ai = a[i];
    if (ai !== undefined) ops.push({ kind: "del", line: ai });
    i++;
  }
  while (j < m) {
    const bj = b[j];
    if (bj !== undefined) ops.push({ kind: "add", line: bj });
    j++;
  }
  return ops;
}

function opPrefix(kind: Op["kind"]): string {
  return kind === "ctx" ? " " : kind === "del" ? "-" : "+";
}

/**
 * Unified-style diff of oldText → newText, or "" when line-identical.
 * Every op index is rendered at most once; hunks are disjoint.
 */
export function unifiedDiff(oldText: string, newText: string): string {
  const a = toLines(oldText);
  const b = toLines(newText);
  const ops = align(a, b);
  if (ops === undefined) {
    return `… diff too large to render (${a.length} → ${b.length} lines)`;
  }
  if (!ops.some((o) => o.kind !== "ctx")) return "";

  // A change run is a maximal run of consecutive non-ctx ops.
  const changes: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < ops.length; k++) {
    const ok = ops[k];
    if (ok === undefined || ok.kind === "ctx") continue;
    let e = k;
    while (e + 1 < ops.length && ops[e + 1]?.kind !== "ctx") e++;
    changes.push({ start: k, end: e });
    k = e;
  }

  // Hunk for each change: one context line on each side, clamped to the op
  // list. Consecutive changes whose context windows touch or overlap merge
  // into one hunk.
  const out: string[] = [];
  let consumed = 0;
  for (let ci = 0; ci < changes.length; ci++) {
    const c = changes[ci];
    if (c === undefined) continue;
    const hunkStart = Math.max(consumed, c.start - 1);
    let hunkEnd = Math.min(ops.length - 1, c.end + 1);
    for (let ci2 = ci + 1; ci2 < changes.length; ci2++) {
      const nxt = changes[ci2];
      if (nxt === undefined) break;
      if (nxt.start <= hunkEnd) hunkEnd = Math.min(ops.length - 1, nxt.end + 1);
      else break;
    }
    let t = hunkStart;
    for (; t <= hunkEnd && out.length < DIFF_MAX_LINES; t++) {
      const o = ops[t];
      if (o === undefined) break;
      out.push(`${opPrefix(o.kind)}${o.line}`);
    }
    if (t < ops.length && out.length < DIFF_MAX_LINES) {
      consumed = hunkEnd + 1;
      continue;
    }
    const remaining = ops.length - t;
    if (remaining > 0) out.push(`… ${remaining} more lines`);
    break;
  }
  return out.join("\n");
}
