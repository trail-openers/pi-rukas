#!/usr/bin/env bun
/**
 * #2362, the off arm — the half of the gate that answers "what did the fix take away?"
 *
 * `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE=0` promises the pre-#2362 behaviour back, so the
 * promise is checked against a golden captured at 238291c448 — the tree that had no
 * switch — rather than against this file's own opinion. Each of the fifteen input
 * combinations pins BOTH the arm the run persisted AND every physical line that went
 * to stderr, so an off arm that quietly gained a line, lost one, or named the wrong
 * winner is as red as one whose arm moved.
 *
 * EVERY row is driven through `runLean` with the fixture's own clock (`now: () => t0`) and
 * BOTH arms are compared to the golden's captured number EXACTLY — no tolerance, and no
 * expected value built from the row's own env. A run's arm is read off the record the engine
 * persisted and matched against `arms.off` / `arms.on` byte for byte, so the observation
 * cannot be satisfied by the input: an engine that armed the flag where the base armed the
 * budget, or that printed a line the base never printed, is red.
 *
 * BOTH arms compare against the captured stream — `[]` at the base commit — because
 * `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE=0` promises the tree with no switch back in full,
 * and that tree wrote no line for an overridden flag, whichever arm it honoured. An off arm
 * that prints one is a behaviour the promise never made, and the test does not get to author
 * the line it expects back: the capture is the only source for what the off arm writes.
 *
 * The input set therefore covers the malformed budget spellings too (`"abc"`, `"-5"`,
 * `"0"`, `"1e3"`, `" 60000 "`, `""`), each pinned to the arm AND the stderr the base
 * reader produced for it. The base accepted or rejected a budget by its OWN predicate —
 * a finite positive duration — and the off arm must inherit that predicate rather than
 * re-deciding it with a "usable value" test of the fix's own: `"1e3"` is a finite
 * positive duration and must arm one second on the off arm, and a spellings table kept
 * by hand would silently differ from the base on exactly the row nobody thought to write.
 *
 * The lines compared are the whole physical stderr stream of the drive, normalised only in
 * the one clock-derived epoch the engine stamps from the REAL clock at the persist site (the
 * `--timeout` arm it quotes). What is pinned is the line's SHAPE — which arms it names, which
 * winner it picks, the durations beside them — and not a wall clock this file does not own.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { flagBudgetMs } from "../src/work-driver-deadline.ts";
import { runLean } from "../src/lean/engine.ts";
import {
  BUDGET,
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

/** The golden's own clock, handed to every drive through `runLean`'s `now` seam, so a run
 *  resolves its arm at the same instant the capture resolved its arms. */
const CLOCK = (): number => golden?.t0 ?? T0;

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

/** Drive one combination through the ENGINE and return the arm the run PERSISTED plus its
 *  whole stderr stream. Every row goes through the engine on both arms: the facts this file
 *  pins are the ones a run produces — the arm its record carries, and the WARN the persist
 *  site writes the moment it resolves that arm — and neither exists until the engine runs. */
async function observe(
  c: GoldenCase,
  switchValue: string | undefined,
  issue: number,
): Promise<{ arm: number | null; stderr: string[] }> {
  const { env, flag } = c;
  const { result: arm, lines } = await captureAll(async () => {
    let arm: number | null = null;
    await withEnv({ ...env, [SWITCH]: switchValue }, async () => {
      const calls: string[] = [];
      const r = await runLean({
        repoRoot: scratch(`golden-${String(switchValue)}-${String(flag)}`),
        issue,
        handlers: DRIVE.handlers(calls),
        seed: DRIVE.seed,
        now: CLOCK,
        ...(flag === null ? {} : { budgetMs: flagBudgetMs(flag) }),
      });
      // The arm the RUN wrote to its own record — never a value derived from `c.env`, which is
      // the input and therefore cannot be the expected answer.
      arm = r.run.deadlineMs ?? null;
    });
    return arm;
  });
  // Normalise only the epoch the engine stamps from the REAL clock at the persist site (the
  // `--timeout` arm the line quotes). The run's own arm already sits in the injected `t0`
  // frame, and the budget/deadline values the line quotes are the row's env spelled back, so
  // both are compared as written — a normaliser that rewrote any `KEY=<digits>` would happily
  // turn a wrong number into a matching one.
  const stderr = lines.map((l) =>
    l
      .replace(/\r?\n$/, "")
      .replace(new RegExp(`${FLAG_NAME}=\\d+`, "g"), `${FLAG_NAME}=${String(T0 + Number(flag))}`),
  );
  return { arm, stderr };
}

/** Issue numbers for the golden drives, kept clear of every other case in the suite. */
let nextIssue = 2400;

for (const c of golden?.cases ?? []) {
  // Every row goes through the ENGINE, on both arms: what this file pins is what a RUN does,
  // and the fact that decides the off arm's byte-identity — the WARN the persist site writes
  // the moment it resolves an arm — only exists there. The reader alone cannot show it, and a
  // row whose two arms agree still has a stream to pin.
  const offIssue = nextIssue++;
  const off = await observe(c, "0", offIssue);
  assert(
    off.arm === c.arms.off,
    `(e) off arm resolves ${String(c.arms.off)} for ${JSON.stringify(c.env)} + flag ${String(c.flag)} (got ${String(off.arm)})`,
  );
  const wantOff = c.stderr;
  assert(
    JSON.stringify(off.stderr) === JSON.stringify(wantOff),
    `(e) and the OFF arm's whole stderr stream is byte-identical to the captured one for ${JSON.stringify(c.env)} + flag ${String(c.flag)} (got ${JSON.stringify(off.stderr)}, wanted ${JSON.stringify(wantOff)})`,
  );
  const on = await observe(c, undefined, nextIssue++);
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
    const on = await observe(c, undefined, nextIssue++);
    if (on.stderr.length > c.stderr.length) sawNewLine = true;
  }
  assert(sawNewLine, "(e) and at least one ON row writes a stderr line the OFF row does not");
  // And the ON arm's line must name the FLAG as the winner — the reverse of the off
  // arm's — or the switch would be a rename rather than a re-ordering.
  for (const c of differing) {
    const on = await observe(c, undefined, nextIssue++);
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
