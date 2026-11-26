#!/usr/bin/env bun
/**
 * #2633 — the full-tier skip over the panel's rows, and the switch that decides how wide it looks.
 *
 * The panel's rows all spell the roster's report flag as TWO words (`--junitxml {report} {dir}`) and the
 * full tier as the same command over one directory of the tree (`<P>python -m pytest -q -p
 * no:cacheprovider tests`). #2620's rule compared words literally, so it answered false for every such
 * row and the step paid for the whole suite twice.
 *
 * Three things are pinned here, in this order:
 *
 *   1. **the off arm against the golden** — every row's answer with the switch at `0` is the answer
 *      `45fb130a44` gave, row for row (fixtures/lean-state/full-tier-off-2633.json);
 *   2. **the on arm differs from the golden on exactly the rows the change was made for** — so a golden
 *      re-captured from this branch could not pass;
 *   3. **the near-miss table** — the operand shapes that name nothing the whole-tree run covered, and the
 *      roster shapes whose tail was never the step's to take back.
 *
 * The step-level arm — the skip shown at the tier, with the record and the reason to prove it — is
 * `test-2633-panel-full-tier-skip.ts`.
 */
import {
  FULL_TIER_BASE,
  FLAGS,
  GLUED,
  PREFIX,
  RUNNER,
  TWO_WORD,
  WT,
  argv,
  rows,
  tierFor,
  verbatim,
} from "./lib/lean-full-tier-golden.ts";
import { fullTierSatisfiedBy } from "../src/lean/verify-suite-command.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-2633-full-tier-relative-operand.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

/** The committed golden, and the shape it holds. */
interface GoldenRow {
  why: string;
  tier: string;
  roster: string;
  head: string[];
  satisfied: boolean;
}
const golden: { base: string; rows: GoldenRow[] } = await Bun.file(
  new URL(`./${"fixtures/lean-state/full-tier-off-2633.json"}`, import.meta.url),
).json();

/** The rows the change was made to satisfy: false under #2620's rule, true under the wider one. */
const SATISFIED = new Set<string>([
  "(panel) tests, glued roster",
  "(panel) outer blanks around the tier",
  "(panel) the runner's own words, two-word roster",
  // The two-word flag is the difference the issue is about: under #2620's rule the flag word was never
  // recognised, so only the verbatim command matched. Taking the step's own pair back restores the
  // runner's words, and the verbatim tier keeps the answer #2620 pinned for it.
  "(two-word) the runner's words",
  "(panel) tests, two-word roster",
  "(panel) test, two-word roster",
  "(panel) server, two-word roster",
  // A tier may write the runner's own whole tree as an absolute path: it names exactly what the run
  // covered, and a rule that could not tell the two spellings of one directory apart would refuse the
  // project whose tier came from a tool that expands paths.
  "(never) an absolute path under the tree",
  // The two tiers that put the step's pair back. A glued pair is what the runner's own words read as once
  // those words go home, so it names the run that was made; a two-word pair is the command verbatim, which
  // is the answer #2620 pinned for it and the one a widened rule must not lose.
  "(derived) the roster's whole command",
  "(configured) the roster's whole command",
  "(panel) a tier that keeps the step's pair, glued",
  // …and its two-word twin, which the run before this change already skipped as the command verbatim: it
  // gains nothing from the wider rule, so it is not a row the change was made for — only a row it may not
  // break. Its name is held apart from the intended set so a widening that loses it fails the guard below.
]);

{
  // ── 1. the off arm is the tree before the change, row for row, byte for byte.
  const table = rows();
  assert(
    golden.rows.length === table.length && golden.base === FULL_TIER_BASE,
    `(golden) the fixture holds one answer per row of the shared table at ${FULL_TIER_BASE} (${String(golden.rows.length)} vs ${String(table.length)}, base ${golden.base})`,
  );
  let mismatches = 0;
  const offAnswers: boolean[] = [];
  await withEnv({ PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND: "0" }, async () => {
    for (const row of table) offAnswers.push(fullTierSatisfiedBy(row.tier, row.roster, row.head));
  });
  for (const [i, row] of table.entries()) {
    const g = golden.rows[i];
    if (
      g === undefined ||
      g.why !== row.why ||
      g.tier !== row.tier ||
      g.roster !== verbatim(row.roster) ||
      g.head.join("\n") !== row.head.failed.join("\n") ||
      g.satisfied !== offAnswers[i]
    ) {
      mismatches++;
      console.error(`✗ ${SELF}: off arm differs from the golden at row ${String(i)}: ${row.why}`);
    }
  }
  assert(mismatches === 0, "(off) every row answers what the pre-change predicate answered");
}

{
  // ── 2. the on arm differs from the golden on the intended rows, and only those differences are
  // allowed to be in the intended set — which is what keeps a self-captured golden from passing.
  const table = rows();
  const onAnswers: boolean[] = [];
  await withEnv({ PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND: "1" }, async () => {
    for (const row of table) onAnswers.push(fullTierSatisfiedBy(row.tier, row.roster, row.head));
  });
  const differs = table
    .filter((row, i) => golden.rows[i]?.satisfied === false && onAnswers[i] === true)
    .map((row) => row.why);
  assert(
    differs.every((why) => SATISFIED.has(why)),
    `(on) no row changes answer except one the change was made for (${differs.join(" | ") || "none"})`,
  );
  assert(
    SATISFIED.size === differs.length &&
      differs.every((why) => onAnswers[table.findIndex((r) => r.why === why)] === true),
    `(on) and every intended row was refused before the change and skips now (${String(differs.length)} rows)`,
  );
  // The panel's own three directory names, and the flag spelling the panel wrote: named apart from the
  // table so a rule that assumed `tests`, or the glued flag alone, fails here first.
  assert(
    !SATISFIED.has("(panel) naming the tree itself"),
    "(on) a tier that names the tree itself is the head run again, not a subset of it",
  );
  // The row the review caught this regression on, asked by name: a tier spelled exactly as the two-word
  // roster's own command is the command the head ran, and it skips on the on arm exactly as #2620 pinned.
  const verbatimRow = table.findIndex((row) => row.why === "(two-word) the verbatim command");
  assert(
    verbatimRow >= 0 &&
      onAnswers[verbatimRow] === true &&
      golden.rows[verbatimRow]?.satisfied === true,
    "(on) the two-word roster's own command verbatim keeps its skip",
  );
  // The other direction of the same guard, and the one a widening loses first: a row the run before this
  // change skipped may not stop skipping because the rule got wider. Every skip the step already granted is
  // a suite the project does not pay for twice, and a lost one is invisible until a panel pays for it.
  const lost = table
    .filter((row, i) => golden.rows[i]?.satisfied === true && onAnswers[i] === false)
    .map((row) => row.why);
  assert(
    lost.length === 0,
    `(on) no row the rule already skipped lost its skip (${lost.join(" | ") || "none"})`,
  );
}

{
  // ── 3. the near-miss table, asked directly. Every row below is a tier the step must still run.
  const GREEN = { failed: [] as string[] };
  const RED = { failed: ["tests/test-suite.sh::passes"] };
  const two = argv({ roster: TWO_WORD });
  const glue = argv({ roster: GLUED });
  const run = (tier: string, r: typeof two): boolean => fullTierSatisfiedBy(tier, r, GREEN);

  for (const dir of ["tests", "test", "server"]) {
    assert(
      run(tierFor(dir), two) && run(tierFor(dir), glue),
      `(bench ${dir}) the panel's tier is satisfied by either spelling of the report flag`,
    );
    assert(
      !fullTierSatisfiedBy(tierFor(dir), two, RED) &&
        !fullTierSatisfiedBy(tierFor(dir), glue, RED),
      `(red head ${dir}) a head run that failed a test satisfies nothing`,
    );
  }
  assert(
    ["./tests", "tests/", "tests//", `${WT}/tests/..`, `${WT}/../tests`, `${WT}/./tests`, `${WT}/tests/`, "/etc/tests"].every(
      (operand) => !run(`${RUNNER} ${operand}`, two),
    ),
    "(operands) an absolute path, a parent segment, a dot segment or a trailing slash never skips",
  );
  assert(
    !run(`${RUNNER} ${WT}/tests ${WT}/tests`, two) &&
      !run(`${RUNNER} ${WT}/tests -k smoke`, two) &&
      !run(`${RUNNER} -k smoke ${WT}/tests`, two),
    "(extra words) one operand is one operand, and a flag is no operand",
  );
  assert(
    !run(`${RUNNER} ${WT}`, two) && !run(verbatim(glue), two),
    "(the step's own words) neither the bare tree nor a glued tier that re-writes the pair is the covered tier",
  );
  assert(
    !run(`${PREFIX} python -m  'pytest' ${FLAGS} ${WT}/tests`, two) &&
      !run(`${RUNNER} PYTEST ${WT}/tests`, two) &&
      !run(`cd ${WT} && ${tierFor("tests")}`, two),
    "(no normalisation) quotes, case and a shell chain are still another command",
  );
  assert(
    run(`   ${tierFor("tests")}\t\n`, two),
    "(blanks) outer blanks are the tier author's typing, not another command",
  );
  assert(
    !run(undefined as unknown as string, two) && !run("   ", two),
    "(no tier) a project with no full tier is satisfied by nothing",
  );
  // A roster whose tail was its own writing has nothing to take back, in either spelling: only the
  // command as the head ran it can match it, and an operand in place of its own words is a tier nobody ran.
  for (const [why, template] of [
    ["the flag's value is the tree", `${RUNNER} --junitxml {dir}`],
    ["the flag points at another file", `${RUNNER} --junitxml /opt/other.xml {dir}`],
    ["the flag sits mid-command", `${PREFIX} python -m pytest --junitxml {report} ${FLAGS} {dir}`],
    ["this repo's wrapper recipe", "bash extension/smoke-tests/lib/lean-roster.sh {dir} {report}"],
  ] as const) {
    const r = argv({ roster: template });
    assert(
      run(verbatim(r), r) && !run(tierFor("tests"), r) && !run(RUNNER, r),
      `(project's own tail — ${why}) only the command as the head ran it is covered`,
    );
  }
}

{
  // ── 4. the switch's truth table: `"0"` is the only off value, and the read is per call.
  const two = argv({ roster: TWO_WORD });
  for (const value of ["0"]) {
    await withEnv({ PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND: value }, async () => {
      assert(
        !fullTierSatisfiedBy(tierFor("tests"), two, { failed: [] }),
        `(switch) "${value}" takes the wider rule out`,
      );
    });
  }
  for (const value of [undefined, "1", "true", "false", "off", "", "0 ", "00"]) {
    await withEnv({ PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND: value }, async () => {
      assert(
        fullTierSatisfiedBy(tierFor("tests"), two, { failed: [] }),
        `(switch) ${JSON.stringify(value)} is not the one value that turns the rule off`,
      );
    });
  }
}

console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
