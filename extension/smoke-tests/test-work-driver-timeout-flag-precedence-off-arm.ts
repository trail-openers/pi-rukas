#!/usr/bin/env bun
/**
 * #2362, the off arm — the half of the gate that answers "what did the fix take away?"
 *
 * `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE=0` promises the pre-#2362 behaviour back, so the
 * promise is checked against a golden captured at 238291c448 — the tree that had no
 * switch — rather than against this file's own opinion. Each of the five input
 * combinations pins BOTH the arm the reader resolved AND every physical line that went
 * to stderr, so an off arm that quietly gained a line, lost one, or named the wrong
 * winner is as red as one whose arm moved.
 *
 * Rows the switch does not re-order (the two arms agree) are untouched by the fix, so
 * their OFF arm stream is byte-identical to the capture. Rows it DOES re-order had no
 * line at the base commit and have exactly one now — and because the line's `won` is
 * decided by which duration actually reached the run's deadline, `"0"` restores both the
 * order AND its wording: the exported budget named as the winner. A line that still said
 * `--timeout wins` while handing the run the budget's arm would tell the operator the
 * opposite of what ran, and would read green under a substring assertion on the tail —
 * the tail names the budget whatever the loser was. That is why the expected line is
 * built whole and compared, not prodded with `includes`.
 *
 * Clock-derived epochs are normalized into the fixture's own `t0` frame before the
 * comparison, so what is pinned is the line's SHAPE — which arms it names, which winner
 * it picks, the durations beside them — and not a wall clock this file does not own.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import {
  type CycleBudgetMs,
  flagBudgetMs,
  resolveCycleDeadline,
} from "../src/work-driver-deadline.ts";
import { runLean } from "../src/lean/engine.ts";
import {
  ABSOLUTE,
  BUDGET,
  BUDGET_MS,
  FLAG_NAME,
  SWITCH,
  T0,
  captureAll,
  cleanScratch,
  makeAssert,
  scratch,
  withEnv,
  DRIVE,
} from "./lib/timeout-flag-precedence-fixture.ts";

const { assert, failures } = makeAssert();

interface GoldenCase {
  env: Record<string, string | undefined>;
  flag: number | null;
  arms: { on: number | null; off: number | null };
  /** Every physical stderr line the OFF arm produced at the base commit. */
  stderr: string[];
}
interface Golden {
  note: string;
  capturedAtCommit: string;
  switch: string;
  t0: number;
  flagMs: number;
  cases: GoldenCase[];
}

const goldenPath = path.resolve(
  import.meta.dirname,
  "fixtures",
  "deadline",
  "timeout-flag-precedence-off-arm.json",
);
let golden: Golden | undefined;
let problem: string | undefined;
try {
  golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;
} catch (err) {
  problem = String(err);
}
assert(golden !== undefined, `(e) the off-arm golden fixture is readable (${problem ?? "ok"})`);

/** The one line the restored pre-#2362 ORDER costs: the exported budget named as both
 *  loser and winner, at the arm that order gives. */
function expectOffLine(c: GoldenCase, arm: number | null, issue: number): string {
  return (
    `[pi-rukas] WARN work-lean #${String(issue)}: ${FLAG_NAME}=${String(golden!.t0 + Number(c.flag))}` +
    ` against ${BUDGET}=${String(c.env[BUDGET])} — ${BUDGET} wins` +
    ` (the run's deadline is ${String(arm)}); ${SWITCH}=0 puts the exported budget back above the flag`
  );
}

/** Drive one combination and return its arm plus its whole stderr stream — through the
 *  ENGINE for rows the switch re-orders, so the stream compared is the one a run
 *  produces (the persist site's WARN line and all), and through the reader for rows it
 *  does not, where there is no persist-site decision to make. */
async function observe(
  c: GoldenCase,
  switchValue: string | undefined,
  through: "reader" | "engine",
  issue: number,
): Promise<{ arm: number | null; stderr: string[] }> {
  const { env, flag } = c;
  const { result: arm, lines } = await captureAll(async () => {
    let arm: number | null = null;
    await withEnv({ ...env, [SWITCH]: switchValue }, async () => {
      if (through === "reader") {
        arm =
          resolveCycleDeadline(
            { ...env },
            undefined,
            T0,
            flag === null ? undefined : (flagBudgetMs(flag) as CycleBudgetMs),
          ) ?? null;
        return;
      }
      const calls: string[] = [];
      const r = await runLean({
        repoRoot: scratch(`golden-${String(switchValue)}-${String(flag)}`),
        issue,
        handlers: DRIVE.handlers(calls),
        seed: DRIVE.seed,
        ...(flag === null ? {} : { budgetMs: flagBudgetMs(flag) as CycleBudgetMs }),
      });
      // A run resolves its arm from the real clock at its own first boundary, so the
      // comparable fact is the DURATION the fixture names: the run's arm is the fixture's
      // absolute iff the run added the row's duration to a now within a minute of here.
      // An arm that moved — the budget's when the flag's was due, or the reverse —
      // matches neither branch and reads red.
      arm =
        r.run.deadlineMs === undefined
          ? null
          : flag !== null && Math.abs(r.run.deadlineMs - (Date.now() + flag)) < 60_000
            ? T0 + flag
            : env[ABSOLUTE] !== undefined
              ? Number(env[ABSOLUTE])
              : T0 + BUDGET_MS;
    });
    return arm;
  });
  // Normalize every clock-derived epoch into the fixture's `t0` frame: the flag's arm and
  // the budget's from the row's own durations, the deadline from the arm this observation
  // resolved. A row whose line names a duration it did not weigh has no match here and
  // the byte comparison below catches it.
  const stderr = lines.map((l) =>
    l
      .replace(/\r?\n$/, "")
      .replace(new RegExp(`${FLAG_NAME}=\\d+`, "g"), `${FLAG_NAME}=${String(golden!.t0 + Number(flag))}`)
      .replace(new RegExp(`${BUDGET}=\\d+`, "g"), `${BUDGET}=${String(c.env[BUDGET])}`)
      .replace(/the run's deadline is \d+/g, `the run's deadline is ${String(arm ?? 0)}`),
  );
  return { arm, stderr };
}

/** Issue numbers for the golden drives, kept clear of every other case in the suite. */
let nextIssue = 2400;

for (const c of golden?.cases ?? []) {
  const via = c.arms.on !== c.arms.off ? "engine" : "reader";
  const offIssue = nextIssue++;
  const off = await observe(c, "0", via, offIssue);
  assert(
    off.arm === c.arms.off,
    `(e) off arm resolves ${String(c.arms.off)} for ${JSON.stringify(c.env)} + flag ${String(c.flag)} (got ${String(off.arm)})`,
  );
  const wantOff = c.arms.on === c.arms.off ? c.stderr : [expectOffLine(c, off.arm, offIssue)];
  assert(
    JSON.stringify(off.stderr) === JSON.stringify(wantOff),
    `(e) and the OFF arm's whole stderr stream is byte-identical to the captured one for ${JSON.stringify(c.env)} + flag ${String(c.flag)} (got ${JSON.stringify(off.stderr)}, wanted ${JSON.stringify(wantOff)})`,
  );
  const on = await observe(c, undefined, via, nextIssue++);
  assert(
    on.arm === c.arms.on,
    `(e) the ON arm resolves ${String(c.arms.on)} for the same input (got ${String(on.arm)})`,
  );
}

// The comparison must not be vacuous: at least one row's two arms differ, and at least
// one ON row logs a line the OFF row does not. Without this the fixture could be all
// agree-rows and the whole file would pass on silence.
{
  const differing = (golden?.cases ?? []).filter((c) => c.arms.on !== c.arms.off);
  assert(differing.length > 0, "(e) at least one row's ON arm differs from its OFF arm");
  let sawNewLine = false;
  for (const c of differing) {
    const on = await observe(c, undefined, "engine", nextIssue++);
    if (on.stderr.length > c.stderr.length) sawNewLine = true;
  }
  assert(sawNewLine, "(e) and at least one ON row writes a stderr line the OFF row does not");
  // And the ON arm's line must name the FLAG as the winner — the reverse of the off
  // arm's — or the switch would be a rename rather than a re-ordering.
  for (const c of differing) {
    const on = await observe(c, undefined, "engine", nextIssue++);
    assert(
      on.stderr.length === 1 &&
        / — --timeout wins /.test(on.stderr[0] ?? "") &&
        on.stderr[0]!.includes(`the run's deadline is ${String(T0 + Number(c.flag))}`),
      `(e) and the ON arm's line names --timeout as the winner at the flag's own arm (got ${JSON.stringify(on.stderr)})`,
    );
  }
}

cleanScratch();
console.log(
  `\n${failures() === 0 ? "off-arm green" : "off-arm RED"} (${String(failures())} failing)`,
);
process.exit(failures());
