/**
 * lib/lean-review-spec-fixture — the bodies that make the review layer's single
 * issue bound visible.
 *
 * `lib/ticket-issue-fixture.ts`'s `OVER_BODY` proves a bound exists but cannot
 * prove which half of the body it cut: it carries no `pi-spec v1` block, so with
 * it the prose and the machine contract never compete for `MAX_ISSUE_CHARS`.
 * These bodies make them compete — the statement repeated as the spec's
 * `problem` so the block is the largest thing in the body, and criteria ids
 * placed so that an assertion about which half survived cannot pass by accident.
 *
 * Every criterion is placed at the tail of the block and the statement at its
 * head, so the bound's cut separates the two: `SPEC_CRITERION_IDS` are the ids
 * that sit past the cap for the body alone and therefore reach a child ONLY
 * through the split's own section, and `TAIL_CONSTRAINT` is a prose sentence the
 * split's strip is what keeps whole. The off arm of every case below is asserted
 * to lose exactly those, which is what makes the ON assertions non-vacuous.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { CONSTRAINT } from "./ticket-issue-fixture.ts";

/** One repeat of the statement, ~90 chars. */
const SENTENCE =
  "The meter must refuse the draw once the quota is spent, and say so in one fixed sentence. ";

/** The statement the run is for, long enough to pass `MAX_ISSUE_CHARS` on its
 * own — so a body carrying it is over the bound whichever way it is rendered. */
const LONG_STATEMENT = SENTENCE.repeat(95);

/** The same requirement at a length that fills a body's head without passing the
 * cap by itself. */
const MID_STATEMENT = SENTENCE.repeat(20);

/** The requirement once, for a body small enough to reach no bound at all. */
const BRIEF_STATEMENT = SENTENCE;

/** The prose sentence the split's strip is what keeps whole. It is the shared
 * ticket constraint plus its own tail clause, so it is never confused with a
 * criterion's text. */
const TAIL_CONSTRAINT = `${CONSTRAINT} The check runs before any state is written.`;

/** Filler that carries a body over the cap without naming anything a later
 * assertion reads. */
const FILLER = "A page of context about the meter, its quota and the ledger behind it. ".repeat(160);

/** One criterion's text, long enough that a handful of them fill the criteria
 * cap — the arm that prints the criteria marker rather than nothing. */
const LONG_CRITERION =
  "The refusal is reported on every surface the run has — reply, record and disclosure — in one wording that matches the ticket, ";

/** The criteria ids that sit PAST the issue cap in these bodies' block: with the
 * split off the bound cuts them, and only the split's own section delivers them. */
export const SPEC_CRITERION_IDS = [
  "AC6",
  "AC7",
  "AC8",
  "AC9",
  "AC10",
  "AC11",
  "AC12",
  "AC13",
  "AC14",
  "AC15",
];

/** The head criteria, which the bound keeps even with the split off. Named so an
 * assertion can say which ids are where rather than trusting any id to be there. */
export const HEAD_CRITERION_IDS = ["AC1", "AC2", "AC3", "AC4", "AC5"];

/** How many criteria the over-cap arm needs: `fenceText` clips at the criteria
 * cap, so the list has to pass it for the marker to be observable. */
export const CRITERIA_OVER_CAP_COUNT = 260;

/** The words a criteria section is opened by, imported by the tests so a brief
 * that prints them is a brief that printed the SECTION and not the raw block. */
export { LEAN_REVIEW_CRITERIA_HEADING } from "../../src/lean/review-criteria.ts";

/** The prose sentence the split keeps whole; the off arm's cut takes it. */
export const SPEC_TAIL_CONSTRAINT = TAIL_CONSTRAINT;

/** Every criterion id these specs carry, head and tail together. */
export const ALL_CRITERION_IDS = [...HEAD_CRITERION_IDS, ...SPEC_CRITERION_IDS];

/**
 * The spec's JSON. The statement leads the block (as `problem`) and the criteria
 * follow it, which is what makes an assertion about a criterion's id actually
 * about the bound: a block whose criteria came FIRST would have its head kept and
 * its tail cut, and "AC6 survived" would then be a fact about the clip rather than
 * about the split. Criteria are emitted in ascending id order — `JSON.stringify`
 * preserves array order — so every id from `SPEC_CRITERION_IDS` sits at the block's
 * tail, past the cap for the body alone, while `HEAD_CRITERION_IDS` sit before it.
 */
function specJson(problem: string, count: number): string {
  const head = [
    { id: "AC1", text: "The meter refuses the draw once the quota is spent.", verify: "test" },
    {
      id: "AC2",
      text: "The refusal names the quota that was exceeded.",
      verify: "command",
      command: "bun test extension/smoke-tests/test-meter-quota.ts",
    },
    { id: "AC3", text: "The counter never goes negative.", verify: "manual" },
    { id: "AC4", text: `${LONG_CRITERION}so no reader reconciles two wordings.`, verify: "test" },
    {
      id: "AC5",
      text: `${LONG_CRITERION}and the wording is the ticket's own.`,
      verify: "command",
      command: "bun run check",
    },
  ];
  const tail = [];
  for (let n = head.length + 1; n <= count; n++) {
    tail.push({
      id: `AC${String(n)}`,
      text: `Criterion ${String(n)}: ${TAIL_CONSTRAINT} The refusal is reported on every surface the run has.`,
      verify: "test",
    });
  }
  return JSON.stringify({ problem, criteria: [...head, ...tail], size: "M" }, null, 2);
}

function specBlock(problem: string, count: number): string {
  return `\`\`\`pi-spec v1\n${specJson(problem, count)}\n\`\`\`\n`;
}

/** A body whose statement passes the cap on its own and whose `pi-spec v1` block
 * repeats it as `problem`: the block is cut and its tail criteria are lost, while
 * the split delivers both. The prose tail sits past the cap too, so the off arm
 * is shown to cut the statement as well. */
export const SPEC_BODY = `${LONG_STATEMENT}\n\n${TAIL_CONSTRAINT}\n\n${specBlock(LONG_STATEMENT, 20)}`;

/** A body carrying a parsable spec that stays UNDER the issue cap, so the classic
 * /work reviewer's prompt keeps the whole raw block: the byte-identity assertions
 * for that prompt need a body whose block is not itself the thing being cut. */
export const CLASSIC_SPEC_BODY = `Add a quota check to the meter.

${TAIL_CONSTRAINT}

${specBlock(BRIEF_STATEMENT, 8)}`;

/** The body whose STATEMENT alone passes the cap — the one shape in which the
 * bound cuts the block AND the prose tail, so the split is the only way either
 * survives whole. Same bytes as `SPEC_BODY`, named for what an assertion needs. */
export const OVER_STATEMENT_BODY = SPEC_BODY;

/** A body under the cap as a whole that carries a parsable spec — the split's
 * ordinary case, with no bound applied to anything. */
export const SMALL_SPEC_BODY = `Add a quota check to the meter.\n\n${TAIL_CONSTRAINT}\n\n${specBlock(BRIEF_STATEMENT, 20)}`;

/** A body over the cap ONLY because of its block: the prose alone fits, so with
 * the split the prose survives whole, which the off arm cannot produce. */
export const MEDIUM_SPEC_BODY = `Add a quota check to the meter.\n\n${TAIL_CONSTRAINT}\n\n${specBlock(MID_STATEMENT, 40)}`;

/** A body with the long statement and NO machine block: the split must render no
 * criteria section and bound the prose exactly as the off arm bounds it. */
export const NO_SPEC_BODY = `${LONG_STATEMENT}\n\n${TAIL_CONSTRAINT}\n\n${FILLER}`;

/** A body whose spec fence never closes: `stripPiSpecBlocks` keeps such a block
 * verbatim and `parsePiSpec` refuses it, so the seat gets the raw prose, one
 * bound, and no criteria section. */
export const UNTERMINATED_SPEC_BODY = `Add a quota check to the meter.\n\n${TAIL_CONSTRAINT}\n\n${FILLER}\n\n${specBlock(MID_STATEMENT, 40).slice(0, -6)}`;

/** A body whose criteria list passes the criteria cap — the over-cap arm of the
 * criteria section, which prints its own marker and not the issue's. */
export const MANY_CRITERIA_BODY = `Add a quota check to the meter.\n\n${TAIL_CONSTRAINT}\n\n${LONG_STATEMENT}\n\n${specBlock(BRIEF_STATEMENT, CRITERIA_OVER_CAP_COUNT)}`;
