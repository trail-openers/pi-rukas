/**
 * lib/lean-full-tier-golden — the OFF-arm golden of the full-tier skip, in one place.
 *
 * `test-2633-full-tier-relative-operand.ts` compares the switch-at-`0` predicate against
 * `fixtures/lean-state/full-tier-off-2633.json`, a table captured ONCE from `45fb130a44` — origin/main
 * before this change — by `fixtures/lean-state/capture-full-tier-off.ts`, which calls THIS same `rows()`
 * and `answers()`. Both sides must ask the same rows the same way, so the table and the driver live here.
 * The capture is run against a detached worktree of that commit with this file and the capture script
 * COPIED in, so every `src/` import it makes resolves inside the pre-change tree: a golden whose harness
 * drifted from its capture, or whose `src/` resolved at this branch, would pin nothing.
 *
 * What the golden holds: one row per (tier, roster command, report path, tree) the rule is asked about,
 * and the OLD predicate's boolean answer to each. The rows cover every arm the roster-skip files pin (the two
 * prescribed shapes, the flag-not-at-the-tail shape, the two-word spelling, this repo's own recipe), the
 * panel's bench rows, and the rows a skip must never be credited with. Every tree is an absolute
 * path under a fixed scratch root, and the report is always that tree's `.lean-roster-report.xml`, so
 * nothing machine-specific — no wall clock, no repo path, no sha — reaches the record.
 *
 * The ON arm is asserted against the same table in the test file: rows the change was made to satisfy
 * must answer the opposite of the golden there, which is what keeps a capture accidentally taken from
 * this branch from passing.
 */
import { renderRosterCommand } from "../../src/lean/verify-roster-command.ts";
import { fullTierSatisfiedBy } from "../../src/lean/verify-suite-command.ts";

/** The committed path of the golden, relative to `smoke-tests/`. */
export const FULL_TIER_FIXTURE = "fixtures/lean-state/full-tier-off-2633.json";
/** The base commit the capture was taken from — recorded in the file so a drift is visible. */
export const FULL_TIER_BASE = "45fb130a44";

/** Every roster's tree: fixed, absolute, and never a path the harness creates. */
export const WT = "/var/tmp/lean-wt";
export const REPORT = `${WT}/.lean-roster-report.xml`;
/** The panel's rows all carry the same env prefix and the same pytest flags. */
export const PREFIX = "env PATH=/opt/tools/bin";
export const FLAGS = "-q -p no:cacheprovider";
/** The runner's own words: what the config wrote before the step put its report pair on the end. */
export const RUNNER = `${PREFIX} python -m pytest ${FLAGS}`;
export const TWO_WORD = `${RUNNER} --junitxml {report} {dir}`;
export const GLUED = `${RUNNER} --junitxml={report} {dir}`;
/** The tier the roster covers: the runner's words and the one directory of the tree it runs. */
export const tierFor = (dir: string): string => `${RUNNER} ${WT}/${dir}`;

/** One roster command as the gate renders it, or the refusal it answered with. */
export function argv(config: { roster?: string; test?: string }): {
  bin: string;
  args: string[];
  report: string;
} {
  const r = renderRosterCommand(config, WT);
  if ("reason" in r) throw new Error(`renderRosterCommand refused: ${r.reason}`);
  return { bin: r.bin, args: r.args, report: r.report };
}

/** The roster's whole command as the head run ran it: the binary, then its args. */
export const verbatim = (r: { bin: string; args: string[] }): string =>
  [r.bin, ...r.args].join(" ");

/** One row of the golden: a tier asked of the roster whose head ran green. */
export interface FullTierRow {
  /** What the row is — the reason it is in the table, read out loud by the test's own assertions. */
  why: string;
  tier: string;
  roster: { bin: string; args: string[]; report: string };
  head: { failed: string[] };
}

const GREEN = { failed: [] as string[] };
const RED = { failed: ["tests/test-suite.sh::passes"] };

/** The rows the golden is asked about — the union of both roster-skip files and the panel. */
export function rows(): FullTierRow[] {
  const derived = argv({ test: "pytest -q {file}" });
  const configured = argv({ roster: "pytest -q --junitxml={report} {dir}" });
  const mid = argv({ roster: "pytest --junitxml={report} -q {dir}" });
  const two = argv({ roster: "pytest -q --junitxml {report} {dir}" });
  const own = argv({ roster: "bash extension/smoke-tests/lib/lean-roster.sh {dir} {report}" });
  const glue = argv({ roster: GLUED });
  const twoWord = argv({ roster: TWO_WORD });
  const flagIsTree = argv({ roster: `${RUNNER} --junitxml {dir}` });
  const otherReport = argv({ roster: `${RUNNER} --junitxml /opt/other.xml {dir}` });
  const midFlag = argv({ roster: `${PREFIX} python -m pytest --junitxml {report} ${FLAGS} {dir}` });
  const r = (why: string, tier: string, roster: typeof derived, head = GREEN): FullTierRow => ({
    why,
    tier,
    roster,
    head,
  });
  return [
    // ── the shapes the predicate file pins
    r("(derived) the roster's words with its own pair taken back", "pytest -q", derived),
    r("(derived) the roster's whole command", verbatim(derived), derived),
    r("(derived) a tier missing only the report flag", `pytest -q ${WT}`, derived),
    r("(derived) a tier missing only the tree", `pytest -q --junitxml=${REPORT}`, derived),
    r("(derived) the same words in another order", `pytest --junitxml=${REPORT} -q ${WT}`, derived),
    r("(derived) the binary alone", "pytest", derived),
    r("(derived) the stripped command plus one flag", "pytest -q --x", derived),
    r("(derived) a different binary", `sh -q --junitxml=${REPORT} ${WT}`, derived),
    r("(derived) a stripped command with the wrong binary", "sh -q", derived),
    r("(derived) a quoted binary", `'pytest' -q`, derived),
    r("(derived) an env prefix", "FOO=1 pytest -q", derived),
    r("(derived) a shell chain", `cd ${WT} && pytest -q`, derived),
    r("(derived) the same command twice", "pytest -q && pytest -q", derived),
    r("(derived) blanks between words", "pytest  -q", derived),
    r("(derived) a substituted report path", `pytest -q --junitxml=$(mk) ${WT}`, derived),
    r("(derived) the whole command, red head", verbatim(derived), derived, RED),
    r("(derived) no configured tier", undefined as unknown as string, derived),
    r("(derived) a blank tier", "   ", derived),
    r("(derived) surrounding blanks", "  pytest -q  ", derived),
    r("(configured) the roster's words with its own pair taken back", "pytest -q", configured),
    r("(configured) the roster's whole command", verbatim(configured), configured),
    r("(configured) a tier missing only the report flag", `pytest -q ${WT}`, configured),
    r("(configured) a tier missing only the tree", `pytest -q --junitxml=${REPORT}`, configured),
    r("(configured) the same words in another order", `pytest --junitxml=${REPORT} -q ${WT}`, configured),
    r("(configured) the binary alone", "pytest", configured),
    r("(configured) the stripped command plus one flag", "pytest -q --x", configured),
    r("(configured) a different binary", `sh -q --junitxml=${REPORT} ${WT}`, configured),
    r("(configured) a stripped command with the wrong binary", "sh -q", configured),
    r("(configured) a quoted binary", `'pytest' -q`, configured),
    r("(configured) an env prefix", "FOO=1 pytest -q", configured),
    r("(configured) a shell chain", `cd ${WT} && pytest -q`, configured),
    r("(configured) the same command twice", "pytest -q && pytest -q", configured),
    r("(configured) blanks between words", "pytest  -q", configured),
    r("(configured) a substituted report path", `pytest -q --junitxml=$(mk) ${WT}`, configured),
    r("(configured) the whole command, red head", verbatim(configured), configured, RED),
    r("(configured) no configured tier", undefined as unknown as string, configured),
    r("(configured) a blank tier", "   ", configured),
    r("(configured) surrounding blanks", "  pytest -q  ", configured),
    // ── the flag-not-at-the-tail shape, where nothing may be taken back
    r("(mid) the command the head ran", `pytest --junitxml=${REPORT} -q ${WT}`, mid),
    r("(mid) the runner's words", "pytest -q", mid),
    r("(mid) the same words reordered", `pytest -q --junitxml=${REPORT} ${WT}`, mid),
    // ── the two-word spelling: only the verbatim command is covered
    r("(two-word) the verbatim command", `pytest -q --junitxml ${REPORT} ${WT}`, two),
    r("(two-word) the runner's words", "pytest -q", two),
    r("(two-word) a tier that drops the flag", `pytest -q ${REPORT} ${WT}`, two),
    // ── this repo's own recipe: the tail pair is tree-then-report, never the step's
    r("(own) the bare wrapper", "bash extension/smoke-tests/lib/lean-roster.sh", own),
    r(
      "(own) the wrapper pointed at another tree",
      "bash extension/smoke-tests/lib/lean-roster.sh /some/other/tree",
      own,
    ),
    // ── the panel's bench rows
    r("(panel) the runner's own words, two-word roster", RUNNER, twoWord),
    r("(panel) the runner's own words, glued roster", RUNNER, glue),
    r("(panel) tests, two-word roster", tierFor("tests"), twoWord),
    r("(panel) tests, glued roster", tierFor("tests"), glue),
    r("(panel) test, two-word roster", tierFor("test"), twoWord),
    r("(panel) server, two-word roster", tierFor("server"), twoWord),
    r("(panel) tests over a red roster", tierFor("tests"), twoWord, RED),
    r("(panel) a tier that keeps the step's pair, two-word", verbatim(twoWord), twoWord),
    r("(panel) a tier that keeps the step's pair, glued", verbatim(glue), glue),
    r("(panel) naming the tree itself", `${RUNNER} ${WT}`, twoWord),
    r("(panel) the operand twice", `${RUNNER} ${WT}/tests ${WT}/tests`, twoWord),
    r("(panel) an operand plus a filter", `${RUNNER} ${WT}/tests -k smoke`, twoWord),
    r("(panel) a filter before the operand", `${RUNNER} -k smoke ${WT}/tests`, twoWord),
    r("(panel) outer blanks around the tier", `   ${tierFor("tests")}\t\n`, twoWord),
    r("(panel) a quoted runner word", `${PREFIX} python -m  'pytest' ${FLAGS} ${WT}/tests`, twoWord),
    r("(panel) a case-folded runner word", `${RUNNER} PYTEST ${WT}/tests`, twoWord),
    r("(panel) a glued roster's own whole-tree tier", RUNNER, glue),
    // ── rows a skip must never be credited with
    r("(never) a roster whose flag value IS the tree", verbatim(flagIsTree), flagIsTree),
    r("(never) an operand against a flag-value-is-tree roster", `${RUNNER} ${WT}/tests`, flagIsTree),
    r("(never) its own report elsewhere", verbatim(otherReport), otherReport),
    r("(never) an operand against a foreign report roster", tierFor("tests"), otherReport),
    r("(never) a mid-command flag, verbatim", verbatim(midFlag), midFlag),
    r("(never) an operand against a mid-flag roster", tierFor("tests"), midFlag),
    r("(never) this repo's wrapper, verbatim", verbatim(own), own),
    r("(never) an absolute path under the tree", `${RUNNER} ${WT}/tests`, glue),
    r("(never) a parent segment under the tree", `${RUNNER} ${WT}/tests/..`, glue),
    r("(never) an absolute path outside the tree", `${RUNNER} /etc/tests`, glue),
    r("(never) a climbing operand", `${RUNNER} ${WT}/../tests`, glue),
    r("(never) a dotted operand", `${RUNNER} ${WT}/./tests`, glue),
    r("(never) a trailing slash", `${RUNNER} ${WT}/tests/`, glue),
    r("(never) ./tests", `${RUNNER} ./tests`, glue),
    r("(never) tests/", `${RUNNER} tests/`, glue),
    r("(never) tests//", `${RUNNER} tests//`, glue),
  ];
}

/** What the predicate answers for one row, in the tree this module's `src/` import lives in. */
export function answers(row: FullTierRow): boolean {
  return fullTierSatisfiedBy(row.tier, row.roster, row.head);
}

/** The committed shape of the golden. */
export interface FullTierGolden {
  base: string;
  rows: { why: string; tier: string; roster: string; head: string[]; satisfied: boolean }[];
}

/** The golden as the capture writes it: one masked line per row, plus the base it was taken from. */
export function drive(): FullTierGolden {
  return {
    base: FULL_TIER_BASE,
    rows: rows().map((row) => ({
      why: row.why,
      tier: row.tier,
      roster: verbatim(row.roster),
      head: [...row.head.failed],
      satisfied: answers(row),
    })),
  };
}
