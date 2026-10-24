/**
 * work-driver-plan-parse — markdown section slicing and list-field parsing.
 *
 * Split from work-driver-plan.ts (AGENTS.md §12). These answer "what does this
 * markdown say?", which is a different question from "is this plan any good?"
 * — and the difference is not academic: both live defects fixed here were
 * parsing bugs whose damage showed up in gates two modules away.
 */

/**
 * Slice the markdown subsection following a given `## <name>` heading.
 * Returns text from the line after the heading up to (but not including)
 * the next top-level `## ` heading or end of input. Returns `undefined`
 * when the heading isn't present. JS regex has no `\Z`; this helper
 * gives the same effect with explicit string operations.
 *
 * `name` is regex-escaped before it reaches the pattern (see `escapeRegExp`).
 */
export function sliceMarkdownSection(text: string, name: string): string | undefined {
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(name)}\\s*$`, "m");
  const m = text.match(headingRe);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length;
  const after = text.slice(start);
  const nextMatch = after.match(/^##\s/m);
  const body = nextMatch && nextMatch.index !== undefined ? after.slice(0, nextMatch.index) : after;
  // A `---` rule between sections belongs to neither. It terminated nothing,
  // so it rode along on the section above and surfaced verbatim in the park
  // explanation a human reads ("Resolver's rationale: …\n\n---").
  return body.replace(/\n\s*-{3,}\s*$/, "\n");
}

/**
 * Escape a literal for embedding in a `new RegExp` pattern.
 *
 * `name` is a heading name the CALLER supplies, and every call site so far
 * passes one that happens to be regex-safe (`"Workstreams"`, `"Spec"`,
 * `"Worktrees"`, `"Rationale"`). That is an accident of the current call
 * graph, not a contract: a name containing `(`, `+` or `.` would either throw
 * inside `new RegExp` or silently match a different heading, and the failure
 * would land in the parser rather than where the bad name was written. One
 * line here removes the whole class.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a `key: a, b, c` value into items — but never inside parentheses.
 *
 * A plan routinely qualifies a path: `src/config/data.rs (lines 21-44,
 * function body only)`. Splitting that on every comma produced
 * `src/config/data.rs (lines 21-44` and `function body only)`, two fragments
 * with unbalanced parens that `normaliseDeclaredPath` then could not strip —
 * its regex requires an intact `(...)` at the end.
 *
 * The damage landed on two separate gates, in opposite directions.
 * `findPathCollisions` compared the mangled strings, saw no overlap, and waved
 * through a fan-out where every workstream edited one file. Then
 * `verifyConsolidation` looked for the mangled strings in the committed diff,
 * never found them, and reported every such workstream MISSING even after a
 * correct integration — halting the cycle at
 * `commit-pr-incomplete-consolidation`. Two of nine measured cycles
 * died there.
 */
export function splitOutsideParens(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    // Never negative: a stray `)` must not make later commas "nested" and
    // silently glue the whole rest of the line into one item.
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === "\n") && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Extract `- key: a, b, c` or `- key: a` from a markdown sub-section. */
export function extractListField(body: string, keyPattern: string): string[] {
  const re = new RegExp(`^\\s*[-*]\\s*${keyPattern}\\s*:\\s*(.+?)\\s*$`, "im");
  const m = body.match(re);
  if (!m) return [];
  return splitOutsideParens(m[1] ?? "");
}
