#!/usr/bin/env bun
/**
 * #2620 — the satisfaction predicate itself, probed with production's own argv.
 *
 * The rule (issue Decision 1) is narrow: a `verify.full` tier is satisfied by the roster's head run only
 * when the tier's words equal the roster's command minus the two words the roster itself added — its
 * report flag and the tree — compared token-wise with no other normalisation. Everything else runs the
 * tier, as today. This file asks the predicate directly rather than through the step, because the two ways
 * to get that subtraction wrong are invisible at step level: comparing against only ONE word removed skips
 * a tier that runs a different set of tests than the roster did (pytest with no positional path collects
 * from its rootdir, not from `{dir}`), and comparing against no removal at all skips a tier whose words
 * merely sit in a different order. Both are wrong greens the gate exists to refuse.
 *
 * `renderRosterCommand` is production's own renderer, so the command below is the one the gate submitted
 * to the head run: `runProjectSuite` passes `bin` and `args` apart, and a tier is one shell string, so the
 * compared command is the binary followed by those args.
 */
import { renderRosterCommand } from "../src/lean/verify-roster-command.ts";
import { fullTierSatisfiedBy } from "../src/lean/verify-suite-command.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-2620-full-tier-satisfied-predicate.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const WT = "/var/tmp/lean-wt";
  const REPORT = `${WT}/.lean-roster-report.xml`;
  const GREEN = { failed: [] as string[] };
  const RED = { failed: ["tests/test-suite.sh::passes"] };

  // Everything the tables below pin is the rule that shipped with #2620, which
  // `PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND=0` restores exactly; the wider arm is pinned by
  // `test-2633-full-tier-relative-operand.ts`. Pinned rather than left to the ambient env, so this file
  // really does exercise the off arm.
  await withEnv({ PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND: "0" }, async () => {
  /** The roster command for a config, rendered by the gate itself, report path and all. */
  function argv(config: { roster?: string; test?: string }): {
    bin: string;
    args: string[];
    report: string;
  } {
    const r = renderRosterCommand(config, WT);
    if ("reason" in r) throw new Error(`renderRosterCommand refused: ${r.reason}`);
    return { bin: r.bin, args: r.args, report: r.report };
  }

  // The two shapes the docs prescribe: the roster the gate DERIVES from `verify.test`, and one a project
  // CONFIGURES. Both are `pytest -q` plus the roster's own report flag and tree, so the tier that means
  // "run my suite" is `pytest -q` — the command with both of the roster's words taken back.
  const SHAPES = [
    ["derived from verify.test", argv({ test: "pytest -q {file}" })],
    ["configured verify.roster", argv({ roster: "pytest -q --junitxml={report} {dir}" })],
  ] as const;

  /** The roster's whole command as the head run ran it: the binary, then its args. */
  const verbatim = (r: { bin: string; args: string[] }) => [r.bin, ...r.args].join(" ");

  for (const [label, rendered] of SHAPES) {
    assert(
      fullTierSatisfiedBy("pytest -q", rendered, GREEN),
      `(${label}) the roster's command with its own report flag AND tree taken back is satisfied by its accepted head run`,
    );
    assert(
      !fullTierSatisfiedBy(verbatim(rendered), rendered, GREEN),
      `(${label}) the roster's whole command is NOT satisfied — a tier that still carries a word the roster added runs`,
    );
    assert(
      !fullTierSatisfiedBy(`pytest -q ${WT}`, rendered, GREEN),
      `(${label}) a tier missing only the report flag is a different command`,
    );
    assert(
      !fullTierSatisfiedBy(`pytest -q --junitxml=${REPORT}`, rendered, GREEN),
      `(${label}) a tier missing only the tree the roster ran is a different command`,
    );
    assert(
      !fullTierSatisfiedBy(`pytest --junitxml=${REPORT} -q ${WT}`, rendered, GREEN),
      `(${label}) the same words in a different order is a different command`,
    );
    assert(
      !fullTierSatisfiedBy("pytest", rendered, GREEN),
      `(${label}) the binary alone, with the roster's flags gone, is a different command`,
    );
    assert(
      !fullTierSatisfiedBy("pytest -q --x", rendered, GREEN),
      `(${label}) the stripped command with one extra flag is a different command`,
    );
    assert(
      !fullTierSatisfiedBy(`sh -q --junitxml=${REPORT} ${WT}`, rendered, GREEN),
      `(${label}) a different binary is a different command`,
    );
    assert(
      !fullTierSatisfiedBy("sh -q", rendered, GREEN),
      `(${label}) a stripped command spelled with the wrong binary is a different command`,
    );
    assert(
      !fullTierSatisfiedBy(`'pytest' -q`, rendered, GREEN),
      `(${label}) a quoted binary is a different command, quotes and all`,
    );
    assert(
      !fullTierSatisfiedBy("FOO=1 pytest -q", rendered, GREEN),
      `(${label}) an env prefix is a different command`,
    );
    assert(
      !fullTierSatisfiedBy(`cd ${WT} && pytest -q`, rendered, GREEN),
      `(${label}) a shell chain is a different command`,
    );
    assert(
      !fullTierSatisfiedBy("pytest -q && pytest -q", rendered, GREEN),
      `(${label}) the same command twice in one tier is a different command`,
    );
    assert(
      fullTierSatisfiedBy("pytest  -q", rendered, GREEN),
      `(${label}) blanks BETWEEN words are the tier author's typing, not another command`,
    );
    assert(
      !fullTierSatisfiedBy(`pytest -q --junitxml=$(mk) ${WT}`, rendered, GREEN),
      `(${label}) a substituted report path is a different command`,
    );
    assert(
      !fullTierSatisfiedBy(verbatim(rendered), rendered, RED),
      `(${label}) a roster whose head failed a test satisfies nothing`,
    );
    assert(
      !fullTierSatisfiedBy(undefined, rendered, GREEN),
      `(${label}) no configured tier is never satisfied`,
    );
    assert(
      !fullTierSatisfiedBy("   ", rendered, GREEN),
      `(${label}) a blank tier is never satisfied`,
    );
    // Leading/trailing blanks are the tier author's typing, not another command.
    assert(
      fullTierSatisfiedBy("  pytest -q  ", rendered, GREEN),
      `(${label}) and the surrounding blanks of the same words are the same command`,
    );
  }

  // The two words the predicate may take back are the roster's own additions, and it adds them at the TAIL.
  // Where the report flag sits elsewhere it belongs to the project's own command, so nothing is taken back —
  // and then the only tier that matches is the command the head actually ran, word for word. The refusals
  // below ask what that leaves unprotected: a tier that drops one of the roster's own words, or spells the
  // same words in another order, still runs.
  const MID = argv({ roster: "pytest --junitxml={report} -q {dir}" });
  assert(
    fullTierSatisfiedBy(`pytest --junitxml=${REPORT} -q ${WT}`, MID, GREEN),
    "(flag not at the tail) with nothing taken back, the command the head ran word for word is the one tier that may be skipped",
  );
  assert(
    !fullTierSatisfiedBy("pytest -q", MID, GREEN),
    "(flag not at the tail) and a tier missing the roster's own flag and tree runs — those words were never the roster's to take back",
  );
  assert(
    !fullTierSatisfiedBy(`pytest -q --junitxml=${REPORT} ${WT}`, MID, GREEN),
    "(flag not at the tail) and the same words in another order are a different command",
  );

  // A two-word flag form (`--junitxml <path>`) is likewise not the pair the roster appends at the tail, so
  // the same rule holds for it: only the verbatim command is covered.
  const TWOWORD = argv({ roster: "pytest -q --junitxml {report} {dir}" });
  assert(
    fullTierSatisfiedBy(`pytest -q --junitxml ${REPORT} ${WT}`, TWOWORD, GREEN),
    "(two-word flag) the verbatim command is the one tier that may be skipped",
  );
  assert(
    !fullTierSatisfiedBy(`pytest -q ${REPORT} ${WT}`, TWOWORD, GREEN),
    "(two-word flag) and a tier that drops the flag itself runs",
  );
  // This repo's own config is the shape the feature was written for: the roster is a wrapper script spelled
  // `<tree> <report>`, so its tail pair is tree-then-report rather than the derived report-then-tree. The
  // wrapper alone is a command that ran NOWHERE — it was invoked with the tree and the report — so it must
  // run, and only a tier that keeps those two words and differs in none other may be skipped.
  const OWN = argv({ roster: "bash extension/smoke-tests/lib/lean-roster.sh {dir} {report}" });
  assert(
    !fullTierSatisfiedBy("bash extension/smoke-tests/lib/lean-roster.sh", OWN, GREEN),
    "(this repo's recipe) the bare wrapper is not satisfied — the head ran it WITH the tree and the report",
  );
  assert(
    !fullTierSatisfiedBy(
      "bash extension/smoke-tests/lib/lean-roster.sh /some/other/tree",
      OWN,
      GREEN,
    ),
    "(this repo's recipe) and a wrapper pointed at another tree is a different command",
  );

});

console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
