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
 * GitHub: `gh label list --limit 500 --json name` (one call; the acceptance
 * criterion caps a filing at 5 labels so 500 rows is comfortably the whole set).
 * GitLab: `glab label list --per-page 100 --output json`. Both are single
 * unchained reads (the #408 rule — a recovery command the permission matcher
 * cannot wildcard must be one command).
 */
import type { ForgeType } from "./forge-detect.ts";

/**
 * The CLI prints `No labels found` as plain text and exits 0 when a repo has
 * none (verified behaviour of both CLIs on an empty label set). A label list of
 * `[]` is the honest answer there, not a parse error — but anything else that is
 * not a JSON array IS an error: silently reporting "no labels exist" would make
 * every caller's labels come back missing and refuse a filing that should run.
 */
export function parseLabelNames(stdout: string, forge: ForgeType): string[] {
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
  const names: string[] = [];
  for (const row of parsed) {
    // `gh label list --json name` rows are `{name}`; glab's rows are
    // `{id, name, color, description}`. Either way `name` is the field, and a
    // row without one is skipped rather than becoming an empty-string label.
    const name = (row as Record<string, unknown> | null)?.name;
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names;
}
