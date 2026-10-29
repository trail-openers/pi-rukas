/**
 * lean/submit-tests-extract — turns the specify child's `submit_tests` tool
 * calls into rows the handler can validate.
 *
 * Pure: it takes the child's `toolUses` array and returns what it can read,
 * plus a count of the calls it had to skip. Mirrors
 * `extractFindings` in lens-findings-extract.ts — the schema is validated by
 * Pi inside the child, so anything that reaches here with the wrong shape is
 * a call the model faked rather than a call Pi accepted, and it is skipped
 * rather than trusted.
 *
 * NOTHING HERE JUDGES whether a row is legitimate: an unknown criterion id, an
 * escaping path, or a file that does not exist are all facts about the run's
 * spec and its worktree, and the boundary validator in specify.ts owns them.
 * This module's job ends at "is this a readable submit_tests call, and what
 * did it say".
 */

/** One `submit_tests` call, as read. */
export interface SubmitTestsRow {
  criterionId: string;
  testFiles: string[];
  note?: string;
}

export interface SubmitTestsExtraction {
  rows: SubmitTestsRow[];
  /** Calls that named the tool but carried something unreadable. */
  skipped: number;
}

/** A path the extractor can hand on: a non-empty string with no NUL. */
function usablePath(p: unknown): p is string {
  return typeof p === "string" && p.trim() !== "" && !p.includes("\0");
}

export function extractSubmitTests(toolUses: unknown[]): SubmitTestsExtraction {
  const rows: SubmitTestsRow[] = [];
  let skipped = 0;
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "submit_tests" || !t.arguments || typeof t.arguments !== "object") continue;
    const a = t.arguments as Record<string, unknown>;
    const criterionId = typeof a.criterionId === "string" ? a.criterionId.trim() : "";
    const rawFiles = Array.isArray(a.testFiles) ? a.testFiles : [];
    const testFiles = rawFiles.filter(usablePath).map((p) => p.trim());
    // A call that lost every one of its paths is not a partial row: an empty
    // row would read as "this criterion has no tests", which is a verdict the
    // child did not give. It is a malformed call, and it is counted.
    if (criterionId === "" || testFiles.length === 0) {
      skipped++;
      continue;
    }
    rows.push({
      criterionId,
      testFiles,
      ...(typeof a.note === "string" && a.note.trim() !== "" ? { note: a.note.trim() } : {}),
    });
  }
  return { rows, skipped };
}
