/**
 * lean/review-roster — what every review seat is told about the project's own pre-existing tests.
 *
 * Read off the newest green `verify`'s `projectRoster`, never off a child's claim: how many tests ran
 * at head and at the base, which failed at the base too (not this run's), and which fail at head that
 * the base did not fail. A run with no roster says so in a line, on every run and whatever the
 * acceptance switch says: a seat told nothing cannot tell "the suite never ran" from "it passed".
 */
import { ROSTER_NAMES_CAP, rosterNewlyFailing } from "./state-outcome-maps.ts";
import { type Step, newestDecided } from "./state.ts";
import { clipList, promptText } from "./text-fence.ts";

const HEADING = "## Project tests (the project's own pre-existing suite, as verify ran it)";

/** The line a seat reads when the newest green verify recorded no roster. */
export const PROJECT_TESTS_NOT_RUN =
  "Project tests: not run — the newest green verify of this run carries no project-test roster.";

/** How many names one list shows; the count beside it is the record's. */
const NAMES_SHOWN = 50;
const NAME_MAX_CHARS = 300;

/** The roster summary section, never empty. */
export function projectTestsSection(steps: Step[]): string {
  const verify = newestDecided(steps, "verify")?.outcome;
  const roster = verify?.kind === "green" ? verify.projectRoster : undefined;
  if (roster === undefined) return `${HEADING}\n\n${PROJECT_TESTS_NOT_RUN}`;
  const newly = rosterNewlyFailing(roster);
  const base =
    roster.baseSkipped === true
      ? "the base run was skipped, since head failed none"
      : `${String(roster.baseTotal)} at the base commit \`${roster.baseSha.slice(0, 12)}\``;
  return [
    HEADING,
    "",
    `Project tests: ${String(roster.total)} run at head; ${base}.`,
    // The record keeps at most ROSTER_NAMES_CAP names per list, so a list at the cap is a floor.
    names(
      "Base-failing (fail at the base too, not charged to this run)",
      roster.baseFailed,
      roster.baseFailed.length >= ROSTER_NAMES_CAP,
    ),
    newly === undefined
      ? `${NEWLY}: not determinable — the record's base-failing list is at its ${String(ROSTER_NAMES_CAP)}-name cap`
      : names(NEWLY, newly, roster.failed.length >= ROSTER_NAMES_CAP),
  ].join("\n");
}

const NEWLY = "Newly failing (fail at head, not at the base)";

function names(label: string, list: readonly string[], floor: boolean): string {
  const count = `${String(list.length)}${floor ? " or more" : ""}`;
  const shown = list.map((n) => `\`${promptText(n, NAME_MAX_CHARS)}\``);
  return `${label}: ${count}${list.length === 0 ? "" : ` — ${clipList(shown, NAMES_SHOWN)}`}`;
}

/** What every seat reads after its framing: the acceptance table when there is one, then the roster. */
export function seatSections(acceptanceTable: string | undefined, steps: Step[]): string {
  const roster = projectTestsSection(steps);
  return acceptanceTable === undefined ? roster : `${acceptanceTable}\n\n${roster}`;
}
