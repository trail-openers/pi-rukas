/**
 * forge-labels — the label-name read for the forge adapter (#1377).
 *
 * `start_plan_driver` must check that every label a caller asked for already
 * exists on the target repo BEFORE filing: the label has to be on the issue from
 * the first moment (a follow-up `gh issue edit` leaves a window where an
 * auto-filed ticket reads as manual work to everything that watches the
 * tracker), and creating a missing label as a side effect of filing would let a
 * caller mutate repo config through a ticket. So the rule is check-then-refuse,
 * and this module is the check.
 *
 * GitHub: `gh label list --limit 1000 --json name` (one call; the acceptance
 * criterion caps a filing at 5 labels so 1000 rows is comfortably the whole set,
 * and a read that lands exactly on the page is reported as possibly truncated
 * rather than as "these labels do not exist" — see `labelListCmd`).
 * GitLab: `glab label list --page 1 --per-page 1000 --output json`. Both are
 * single unchained reads (the #408 rule — a recovery command the permission
 * matcher cannot wildcard must be one command).
 */
import type { ForgeType } from "./forge-detect.ts";

/**
 * The CLI prints `No labels found` as plain text and exits 0 when a repo has
 * none (verified behaviour of both CLIs on an empty label set). A label list of
 * `[]` is the honest answer there, not a parse error — but anything else that is
 * not a JSON array IS an error: silently reporting "no labels exist" would make
 * every caller's labels come back missing and refuse a filing that should run.
 */
export function parseLabelRows(stdout: string, forge: ForgeType): unknown[] {
  const trimmed = stdout.trim();
  if (trimmed === "" || /^no labels found/i.test(trimmed)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `forge label list: ${forge} did not return JSON (${(err as Error).message}): ${trimmed.slice(0, 120)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`forge label list: ${forge} returned a JSON ${typeof parsed}, not an array`);
  }
  return parsed;
}

/**
 * The `name` of every row that has one. Rows without a usable name are skipped
 * rather than becoming an empty-string label — the CLI's own rows are
 * `{name}` (`gh label list --json name`) or `{id, name, color, description}`
 * (glab), so a row without a name is not a label this feature can compare.
 */
export function labelNamesFromRows(rows: unknown[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const name = (row as Record<string, unknown> | null)?.name;
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names;
}

/**
 * Rows → names, the shape the tests drive directly. The list read itself uses
 * the two halves separately: `truncated` has to be judged on the RAW row count
 * (see `labelOps.labelList`), and one helper that returns only names cannot say
 * how many rows it dropped.
 */
export function parseLabelNames(stdout: string, forge: ForgeType): string[] {
  return labelNamesFromRows(parseLabelRows(stdout, forge));
}
