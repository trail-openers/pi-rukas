#!/usr/bin/env bun
/**
 * #2439 AC3 / R2 — the derived roster command is `verify.test` with exactly ONE whole-word
 * `{file}` removed and `--junitxml={report} {dir}` appended, in every shape, with no hand-back.
 *
 * The defect this pins is the one the bench hit: a project whose `verify.test` is
 * `pytest -q {file}` — the shape the loader REQUIRES, one whole-word `{file}` — got the template
 * `<verify.test> --junitxml={report} {dir}`. The literal `{file}` survived into the argv, pytest
 * exited 4 on "file or directory not found: {file}", wrote no report, and the hand-back the
 * operator read blamed the report rather than the derivation.
 *
 * The three shapes R2 names are all unit cases here because no end-to-end suite covers the
 * derivation: `test-lean-verify-command-tree.ts` hard-codes its roster command, so it never asks
 * what the gate derives from `verify.test`. The `{file}`-free row is the shape the loader cannot
 * produce and a hand-built config can, and it derives by appending only — no word removed, no
 * hand-back.
 */
import { renderRosterCommand } from "../src/lean/verify-roster-command.ts";
import type { VerifyRosterConfig } from "../src/lean/verify-types.ts";

const SELF = "test-AC8-roster-command-derivation.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const TREE = "/tree";
const REPORT = `${TREE}/.lean-roster-report.xml`;

/** Render one `verify.test` template and answer for it, refusing a hand-back as a failed case. */
function derive(test: string): { bin: string; args: string[]; report: string } | undefined {
  const rendered = renderRosterCommand({ test } as VerifyRosterConfig, TREE);
  if ("reason" in rendered) {
    console.error(`✗ ${SELF}: derived nothing for ${JSON.stringify(test)}: ${rendered.reason}`);
    exit = 1;
    return undefined;
  }
  return rendered;
}

{
  // R2's first named case: the pytest template the loader accepts, minus its `{file}` word.
  const r = derive("pytest -q {file}");
  assert(
    r?.bin === "pytest",
    `(pytest) the bin is the template's own first word (${String(r?.bin)})`,
  );
  assert(
    JSON.stringify(r?.args) === JSON.stringify(["-q", `--junitxml=${REPORT}`, TREE]),
    `(pytest) argv is -q --junitxml=<tree>/.lean-roster-report.xml <tree> (${JSON.stringify(r?.args)})`,
  );
  assert(
    r?.report === REPORT,
    `(pytest) the report is the file under the tree the run happens in (${String(r?.report)})`,
  );
}

{
  // R2's second named case: a runner whose only argument WAS the `{file}` word. Dropping the word
  // leaves the runner with the tree and the report, which is what a suite runner needs; a derivation
  // that kept the word handed the runner a path that does not exist.
  const r = derive("sh {file}");
  assert(
    r?.bin === "sh" && JSON.stringify(r?.args) === JSON.stringify([`--junitxml=${REPORT}`, TREE]),
    `(bare {file}) sh {file} derives to sh --junitxml=… <tree> (${JSON.stringify(r?.args)})`,
  );
}

{
  // R2's third named case: the `{file}` word sits between two literals, so the removal is from the
  // MIDDLE of the argv rather than its end. The command-criteria fixture's self-rewriter is this
  // shape, and a derivation that only ever stripped a trailing word would leave `{file}` in front
  // of the second test path.
  const r = derive("sh self-rewrite.sh {file} tests/AC1-retry.test.sh");
  assert(
    r?.bin === "sh" &&
      JSON.stringify(r?.args) ===
        JSON.stringify([
          "self-rewrite.sh",
          "tests/AC1-retry.test.sh",
          `--junitxml=${REPORT}`,
          TREE,
        ]),
    `(middle) the {file} word is deleted in place, its neighbours keep their order (${JSON.stringify(r?.args)})`,
  );
}

{
  // A `{file}`-free template derives by appending only. Unreachable through the loader (which
  // requires the word), reachable through a hand-built config, and R2 commits to the append in
  // every shape: a hand-back here would refuse a runner the project already configured.
  const r = derive("pytest -q");
  assert(
    r?.bin === "pytest" &&
      JSON.stringify(r?.args) === JSON.stringify(["-q", `--junitxml=${REPORT}`, TREE]),
    `(no {file}) nothing is removed and the report pair is still appended (${JSON.stringify(r?.args)})`,
  );
}

{
  // A `{file}` that is part of a LARGER word is not the whole-word `{file}`: `bun run test-{file}.ts`
  // carries no whole-word placeholder, so nothing is stripped from it. The loader refuses that
  // template at load; the derivation has no reason to invent a second opinion about it.
  const r = derive("bun run test-{file}.ts");
  assert(
    r?.bin === "bun" &&
      JSON.stringify(r?.args) ===
        JSON.stringify(["run", "test-{file}.ts", `--junitxml=${REPORT}`, TREE]),
    `(substring) a {file} inside a longer word is left alone (${JSON.stringify(r?.args)})`,
  );
}

{
  // A configured `verify.roster` is used verbatim, exactly as before: the derivation belongs to the
  // ABSENT case only, and a project that named its own invocation keeps it.
  const rendered = renderRosterCommand(
    {
      test: "pytest -q {file}",
      roster: "pytest -p no:cacheprovider --junitxml={report} {dir}",
    } as VerifyRosterConfig,
    TREE,
  );
  assert(
    !("reason" in rendered) &&
      JSON.stringify(rendered.args) ===
        JSON.stringify(["-p", "no:cacheprovider", `--junitxml=${REPORT}`, TREE]),
    `(configured) verify.roster is rendered, not derived (${JSON.stringify(
      "reason" in rendered ? rendered.reason : rendered.args,
    )})`,
  );
}

{
  // Two `{file}` words: exactly ONE is removed — R2 says one, and the loader never lets a template
  // with two reach here. Asserted at the seam so a future "remove every occurrence" would fail.
  const r = derive("sh {file} {file}");
  assert(
    r?.bin === "sh" &&
      JSON.stringify(r?.args) === JSON.stringify(["{file}", `--junitxml=${REPORT}`, TREE]),
    `(two words) exactly one whole-word {file} is deleted (${JSON.stringify(r?.args)})`,
  );
}

console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
