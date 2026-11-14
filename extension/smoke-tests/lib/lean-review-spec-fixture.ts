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

import { criteriaBlock } from "../../src/lean/spec-blocks.ts";
import { MAX_ISSUE_CHARS } from "../../src/adversarial-prompts.ts";
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
const FILLER = "A page of context about the meter, its quota and the ledger behind it. ".repeat(
  160,
);

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

/** The head criteria of a body that reaches no bound: `AC1`–`AC5`, whose rows
 * the criteria section renders and whose JSON the raw block also carries. */
export const SHORT_CRITERION_IDS = HEAD_CRITERION_IDS;

/** A body short enough that its block survives a bound that never fires — the
 * shape that tells a STRIP apart from a CUT. `SPEC_BODY` is over the cap, so a
 * seat that strips nothing there still prints no tail JSON: the block was cut
 * before it. Here nothing is cut, so every criterion's JSON is present verbatim
 * in a seat that was handed the raw body, and its absence is a fact about the
 * strip alone. */
export const SHORT_SPEC_BODY = `Add a quota check to the meter.\n\n${TAIL_CONSTRAINT}\n\n${specBlock(BRIEF_STATEMENT, HEAD_CRITERION_IDS.length)}`;

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

/** How many criteria the second over-cap arm needs. `D3_COUNT` is the issue's
 * floor ("at least 40"); the arm is over the cap because of its PER-CRITERION
 * text, not its count, and the fixture asserts that below at construction. */
export const D3_COUNT = 40;

/** The character cap the criteria section is bounded at — the same constant
 * `renderSpecCriteriaSection` passes to `fenceText`. Declared before the bodies
 * that measure themselves against it, since they run at module load. */
const CRITERIA_CAP = 20_000;

/** One criterion's text for the 40-criterion arm: ~600 characters, so 40 rows
 * clear the 20 000-character criteria cap on their own. */
const D3_CRITERION = `the reading surface, the record surface and the disclosure surface each state it in one wording the ticket names, the wording is never re-derived per surface, a surface that cannot reach the reader says so in the same wording rather than staying silent, and no reader is left reconciling two versions of the same refusal across three screens at once. `;

/** How wide one rendered criterion's text has to be for 40 of them to pass the
 * cap; derived, so the arm cannot drift under the cap without failing here. */
const D3_TEXT_WIDTH = Math.ceil(CRITERIA_CAP / D3_COUNT) + 400;

/**
 * A body whose `problem` is the statement's tail — the part a 6 000-character
 * prose bound cuts — and whose 40 criteria alone pass the criteria cap.
 *
 * Two things are asserted of it here, because an arm that quietly stopped being
 * over the cap is a vacuous arm rather than a failing test:
 *
 *   - the rendered criteria block PASSES the cap, so the marker is observable;
 *   - the statement's tail sits PAST `MAX_ISSUE_CHARS` in the body, so the
 *     problem section is what delivers it to a review seat.
 */
export const MANY_CRITERIA_40_BODY: string = (() => {
  const criteria = Array.from({ length: D3_COUNT }, (_, i) => ({
    id: `AC${String(i + 1)}`,
    // The ordinal leads the row so an assertion can name WHICH criterion survived
    // the cut, and the text repeats a fixed sentence to the derived width so the
    // block's length is a property of the count, not of any one criterion.
    text: `AC${String(i + 1)} ${D3_CRITERION.repeat(30).slice(0, D3_TEXT_WIDTH)}`,
    verify: "test" as const,
  }));
  const problem = `${LONG_STATEMENT}\n\n${TAIL_CONSTRAINT}`;
  const block = criteriaBlock({ problem, criteria, size: "M" });
  if (block.length <= CRITERIA_CAP) {
    throw new Error(
      `MANY_CRITERIA_40_BODY geometry: ${String(D3_COUNT)} criteria render ${String(
        block.length,
      )} chars, not past the ${String(CRITERIA_CAP)}-char cap — the arm would be vacuous.`,
    );
  }
  const json = JSON.stringify({ problem, criteria, size: "M" }, null, 2);
  const body = `Add a quota check to the meter.\n\n${TAIL_CONSTRAINT}\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n`;
  if (body.trim().slice(MAX_ISSUE_CHARS).includes(TAIL_CONSTRAINT)) {
    throw new Error(
      "MANY_CRITERIA_40_BODY geometry: the statement's tail already fits under the issue bound, so the problem section proves nothing — the arm would be vacuous.",
    );
  }
  return body;
})();

/** A body whose criteria list passes the criteria cap AND whose clip falls inside
 * a run of backticks: the last criterion's text ends in a 6-backtick run whose
 * first three characters sit at the clip, so `fenceText` neutralises backticks
 * that survive its own slice. The criteria marker is substituted for the generic
 * clip notice, and a substitution that matched nothing here would print the
 * notice the docs promise the seat never sees.
 *
 * The run is placed by RENDERED geometry, not by counting the criterion's own
 * text: `criteriaBlock` prints `- **AC2** [test] ` before the text and joins the
 * lines with `\n`, so the run's offset in the block is the rendered prefix, and
 * the filler before it is what puts exactly `inside` of the run at or before the
 * cap. Deriving it from the block (and asserting it here, where a bad geometry is
 * a fixture failure rather than a vacuous arm in the test) is what keeps the arm
 * from silently drifting past the clip. */
export const BACKTICK_AT_CLIP_BODY: string = (() => {
  const ticks = 6;
  const inside = 3;
  const TICK = "\u0060";
  const render = (runTail: string): string =>
    criteriaBlock({
      problem: BRIEF_STATEMENT,
      criteria: [
        { id: "AC1", text: "The meter refuses the draw.", verify: "test" },
        { id: "AC2", text: runTail, verify: "test" },
      ],
      size: "S",
    });
  // Where the run begins in the rendered block, read off the block itself: the
  // whole AC1 line plus its newline, plus AC2's `- **AC2** [test] ` prefix.
  const runOffset = render(`${TICK.repeat(ticks)}z`).indexOf(TICK);
  const runText = `${"y".repeat(CRITERIA_CAP - runOffset - inside)}${TICK.repeat(ticks)}z`;
  if (render(runText).indexOf(TICK) !== CRITERIA_CAP - inside) {
    throw new Error(
      `BACKTICK_AT_CLIP_BODY geometry: the backtick run starts at ${String(
        render(runText).indexOf(TICK),
      )} of a rendered block clipped at ${String(CRITERIA_CAP)}, not ${String(
        CRITERIA_CAP - inside,
      )} — the arm would be vacuous.`,
    );
  }
  const json = JSON.stringify(
    {
      problem: BRIEF_STATEMENT,
      criteria: [
        { id: "AC1", text: "The meter refuses the draw.", verify: "test" },
        { id: "AC2", text: runText, verify: "test" },
      ],
      size: "S",
    },
    null,
    2,
  );
  return `Add a quota check to the meter.\n\n${TAIL_CONSTRAINT}\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n`;
})();
