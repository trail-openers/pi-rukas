/**
 * ci-doctrine — the classifiers the #2333 gate runs over doctrine prose
 * (`extension/smoke-tests/test-ci-doctrine-poll.ts`) and over the base commit's
 * text to prove the gate red (the scratch red-proof harness).
 *
 * Exported as a module, rather than living inside the test file, so the red
 * proof can import the EXACT functions the shipped gate uses: a copy of the
 * regexes in the harness would prove the harness works, not the gate.
 *
 * The obligation phrases are deliberately permissive (a phrase, not a whole
 * sentence) so a reword of the doctrine does not break the gate, while each one
 * still names a rule a child can act on. The watch classifier is deliberately
 * strict about scope: a watch named in a clause that forbids it is not a
 * prescription, and the negation has to govern the watch's OWN clause — the
 * same rule shape `test-oo-prompt-hygiene.ts` uses.
 *
 * The shipped CI brief is a numbered list whose step 2 is both the sanctioned
 * poll recipe AND the sentence that names the forbidden watch — so the
 * classifier has to see the prohibition, and still see a reword of that same
 * line back to a watch prescription. `lib/ci-doctrine-canary.ts` pins exactly
 * that line in both directions; a classifier change that loses either half
 * reds the gate instead of going unnoticed on the one line a child is handed.
 */

/**
 * The obligations a CI-wait doctrine must carry, each matched by a phrase.
 *
 * - `interval` / `cap` are pinned to the driver's own numbers by the gate
 *   (`CI_POLL_MS` in extension/src/lean/ci-poll.ts, `DEFAULT_TIMEOUT_MS` in
 *   extension/src/forge-ci.ts) — a doctrine interval the driver does not share
 *   is a second source of truth that drifts silently.
 * - `pendingContinues` is the rule whose absence was the bug: an ops child that
 *   ended its turn mid-wait left the merge undone.
 * - `exitCodeIsData` covers the `gh pr checks` exit-8-while-pending trap that
 *   makes a polling child abandon the poll.
 */
export interface CiDoctrineObligations {
  /** Names the sleep interval, in seconds. */
  interval: RegExp;
  /** Names the wait cap. */
  cap: RegExp;
  /** Names the terminal statuses the poll stops on. */
  terminal: RegExp;
  /** States that a pending check never ends the dispatch. */
  pendingContinues: RegExp;
  /** States that a non-zero gh exit is data, not a failed read. */
  exitCodeIsData: RegExp;
}

export const CI_DOCTRINE_OBLIGATIONS: CiDoctrineObligations = {
  interval: /sleep 60/,
  cap: /30[- ]minute|30 minutes/,
  terminal: /terminal/i,
  pendingContinues:
    /pending[\s\S]{0,90}never a reason to end|never a reason to end[\s\S]{0,90}pending/i,
  exitCodeIsData: /non-?zero exit|exits 8/i,
};

/** Every obligation `want` that `text` does not state, by name. */
export function missingCiDoctrine(text: string, want = CI_DOCTRINE_OBLIGATIONS): string[] {
  return Object.entries(want)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

/** Words that make a clause a prohibition rather than an instruction. */
const WATCH_NEGATION =
  /\b(?:never|not|no|avoid|forbid|refrain|prohibit|skip|omit|replaced?|removed?)\b|❌|do\s+not|don'?t|must\s+not|instead\s+of|rather\s+than/i;

/** Clause boundaries inside a line — a watch named in a new clause is judged on
 * that clause alone. `—` is a boundary because the sanctioned recipe separates
 * its prohibition with an em-dash ("the bounded sleep-poll — NOT `gh run
 * watch`"), and `,` because the brief's step 2 opens with a status clause
 * ("If the run is not terminal yet, …") that must not reach the watch clause
 * and read the word `not` there as a prohibition on the watch. */
const CLAUSE_BREAK = /[.;:!?]|\bbut\b|\bhowever\b|\band\b|\bor\b|—|,/i;

/**
 * The blocking CI-watch shapes a doctrine can prescribe: `gh run watch`, and
 * `gh pr checks … --watch`.
 *
 * Matches are kept inside one command word group (`(?:\s+\S)*\s+--watch`, not
 * `[^\n]*--watch`): the wider form matched from the sanctioned poll's
 * `gh pr checks <n>` all the way to a later sentence's `--watch`, reading two
 * commands as one prescription.
 */
const WATCH_SHAPE = /gh\s+(?:run\s+watch|pr\s+checks(?:\s+\S)*\s+--watch)/g;

/** Lines on which a mention of a watch is the doctrine SHOWING the forbidden
 * form rather than prescribing it: a heading, a bullet, or a fenced code line. */
const NON_PRESCRIPTIVE_LINE = /^\s*(?:#|[-*]|\d+\.|>|```)/;

/**
 * Blocking CI watches a piece of doctrine PRESCRIBES. A watch named only inside
 * a prohibition ("Never `gh run watch`", the doctrine's own ❌ bullet) or on a
 * heading/bullet/code line is not reported — the fix keeps the watch names in
 * the text on purpose, so a reader knows what to avoid.
 */
export function blockingWatchPrescribed(text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    WATCH_SHAPE.lastIndex = 0;
    for (const m of line.matchAll(WATCH_SHAPE)) {
      // The negation must govern the watch's OWN clause: the text from the last
      // clause break up to the watch name, never everything before the match.
      // The wider window read the `not` of an unrelated "is not terminal yet"
      // as prohibiting a watch named later in the line, which made the brief's
      // step-2 recipe line blind to any watch reword written into it.
      const clause = (line.slice(0, m.index).split(CLAUSE_BREAK).pop() ?? "").replace(
        /^[\s>#*`-]+/,
        "",
      );
      if (WATCH_NEGATION.test(clause)) continue;
      hits.push(`line ${i + 1}: ${line.trim().slice(0, 100)}`);
      break;
    }
  });
  return hits;
}
