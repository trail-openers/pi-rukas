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
 * line back to a watch prescription. The canary block of
 * `test-ci-doctrine-poll.ts` pins exactly that line in both directions, and
 * pins the shipped recipe lines of `modules/workflows/ci-monitoring.md` and
 * `agents-base/ops.md` against the `--watch` form; a classifier change that
 * loses either half reds the gate instead of going unnoticed on the one line a
 * child is handed.
 */

/**
 * The obligations a CI-wait doctrine must carry, each matched by a phrase.
 *
 * - `interval` / `cap` are pinned to the driver's own numbers by the gate
 *   (`CI_POLL_MS` in extension/src/lean/ci-poll.ts, `DEFAULT_TIMEOUT_MS` in
 *   extension/src/forge-ci.ts) — a doctrine interval the driver does not share
 *   is a second source of truth that drifts silently. The gate asserts the
 *   ANCHORED number (see `interval` / `cap` below) and that no other `sleep`
 *   number appears; a substring test on the digits caught deletion only, so a
 *   `sleep 600` reword left the child polling at a cadence the driver does not.
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
  // The shipped defaults, anchored with a trailing digit boundary and a leading
  // word boundary: a doctrine reworded to `sleep 600` still CONTAINS `sleep 60`,
  // and a cap reworded to `45 minutes` still contains the `30` of some other
  // sentence. A substring test catches deletion only; the cadence and the cap the
  // child runs are the thing the driver must share, so the gate builds the
  // anchored patterns from the constants it reads (see `ciDoctrineNumberPatterns`)
  // and the fallback literals here exist only for callers that pass no numbers.
  interval: /\bsleep 60(?!\d)/,
  cap: /\b30[- ]?minutes?\b/,
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

/**
 * The CI-wait surfaces that share ONE cadence and ONE cap. The gate reads the
 * numbers out of `CI_POLL_MS` / `DEFAULT_TIMEOUT_MS`, builds these patterns from
 * them, and demands that no surface states another sleep interval: the doctrine,
 * the module and the brief are one recipe told four times, and a single drifted
 * number is the second source of truth the pinning exists to prevent.
 */
export function ciDoctrineNumberPatterns(pollSeconds: number, capMinutes: number) {
  return {
    /** The sleep interval exactly — a trailing digit is a different number. */
    interval: new RegExp(`\\bsleep ${pollSeconds}(?!\\d)`),
    /** The cap exactly — `30` inside `300 minutes` is not the cap. */
    cap: new RegExp(`\\b${capMinutes}[- ]?minutes?\\b`),
    /** Any OTHER `sleep <n>` the doctrine improvised. */
    straySleep: new RegExp(`\\bsleep (?!${pollSeconds}(?!\\d))\\d+`),
  };
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
 * The `--watch` alternative is delimited so it cannot read two commands as one
 * prescription: the flag is reached only through same-line words that are
 * neither a quote nor a closer (`[^\s`"')\]`]*?` — lazy, so the match is the
 * SHORTEST run ending in a real `--watch`, never a run that jumps a backtick
 * into the next code span), and each intervening word is checked at its own
 * start, so the negative lookahead cannot let a second `--watch` hide behind a
 * word that merely begins with one. An earlier form used `(?:\s+\S)*\s+--watch`:
 * `\s` matches a newline and `\S` happily ate a backtick, so on the shipped
 * step-2 line it matched from the sanctioned `gh pr checks <n> …` all the way
 * down the paragraph to the doctrine's own "and not any `--watch` flag", and the
 * `never` three words earlier silenced the only hit the line had — which is how
 * a `--watch` written back into the shipped recipe was invisible to every gate.
 */
const WATCH_SHAPE =
  /gh\s+(?:run\s+watch|pr\s+checks(?:[ \t]+(?!--watch)[^\s`"')\]]*)*?[ \t]+--watch)/g;

/**
 * Blocking CI watches a piece of doctrine PRESCRIBES. A watch named only inside
 * a prohibition ("Never `gh run watch`", the doctrine's own ❌ bullet) is not
 * reported — the fix keeps the watch names in the text on purpose, so a reader
 * knows what to avoid — but every line TYPE is judged: heading, bullet, fenced
 * code and prose alike. An earlier exemption for non-prose lines was deleted
 * because the shipped recipe lives in a fenced block and in bullets, so the
 * exemption made a `--watch` written back into either invisible to the gate.
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
