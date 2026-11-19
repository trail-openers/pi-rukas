#!/usr/bin/env bun
/**
 * #2362 — the `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE` switch: on `pi-rukas-headless
 * work-lean`, an explicit `--timeout` is the caller's word for how long THIS run may
 * run, and it outranks a `PI_ENSEMBLE_CYCLE_BUDGET_MS` the host happens to have
 * exported. `PI_ENSEMBLE_CYCLE_DEADLINE` — an absolute a host set because it owns the
 * clock — still outranks both.
 *
 * The bug is a lean run started with `--timeout 165` under an exported 60-minute
 * budget: it was cut at 60 minutes and said nothing, and neither docs page stated the
 * order. Four surfaces are pinned here and nowhere else:
 *
 *   (a) the switch's truth table on the exported reader — on for unset, `"1"`, `""`
 *       and `"false"`; off for the literal `"0"`;
 *   (b) the arm the reader resolves, for every input combination, on BOTH arms, and
 *       the one warning line the disagreement costs (or the silence it must cost);
 *   (c) what the switch must NOT reach: a resume keeps the arm its first round
 *       persisted whatever `--timeout` says (R1), `work`'s `readCycleDeadline` has no
 *       flag arm at all (R3), and the warning is one line at the persist site — never
 *       inside the pure reader, and never a second line for a value the reader does
 *       not honour (R2, R4);
 *   (d) the host contract: `features.timeoutFlagPrecedence`, the roster row, and the
 *       one sentence each in `docs/headless.md` and `docs/configuration.md`.
 *
 * The off arm against a captured golden is the sibling file
 * `test-work-driver-timeout-flag-precedence-off-arm.ts`.
 *
 * Every case pins the switch with `withEnv`: the reader is read at CALL time, so a pin
 * that leaked from another file in the same bun process — or an operator's exported
 * `=0` — would otherwise make the ON cases measure the wrong arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FEATURES } from "../src/headless/capabilities.ts";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { readCycleDeadline, resolveCycleDeadline } from "../src/work-driver-deadline.ts";
import { handoffDispatchTimeoutMs } from "../src/work-driver-handoff.ts";
import { timeoutFlagPrecedenceEnabled } from "../src/work-driver-timeout-flag-precedence-switch.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { captureWarns } from "./lib/lean-review-bound-fixtures.ts";
import {
  ABSOLUTE,
  BUDGET,
  BUDGET_MS,
  type CycleBudgetMs,
  FLAG,
  FLAG_NAME,
  SWITCH,
  T0,
  cleanScratch,
  driveOnce,
  isPrecedenceWarning,
  makeAssert,
  warnsOfReader,
  withEnv,
} from "./lib/timeout-flag-precedence-fixture.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

// ─────────────────────────────────────── (a) the switch's own truth table
{
  await withEnv({ [SWITCH]: undefined }, async () => {
    const cases: [string | undefined, boolean][] = [
      [undefined, true],
      ["1", true],
      ["", true],
      ["false", true],
      ["0", false],
    ];
    for (const [value, want] of cases) {
      await withEnv({ [SWITCH]: value }, async () => {
        assert(
          timeoutFlagPrecedenceEnabled() === want,
          `(a) ${SWITCH}=${JSON.stringify(value)} reads ${String(want)}`,
        );
      });
    }
  });
}

// ── (b1) the arm the reader resolves, both arms, every input combination.
// The five combinations the off-arm golden pins plus the two-value rows the acceptance
// criteria name. `flag` is always passed as a VALUE: the flag is never an env write, and
// a case that wrote it would be testing the env instead of the flag.
const COMBOS: {
  name: string;
  env: Record<string, string | undefined>;
  flag?: CycleBudgetMs;
  /** The arm with the switch ON. */
  on: number | undefined;
  /** The arm with the switch OFF — today's order. */
  off: number | undefined;
}[] = [
  {
    name: "absolute only",
    env: { [ABSOLUTE]: String(T0 + 7_000) },
    on: T0 + 7_000,
    off: T0 + 7_000,
  },
  {
    name: "budget only",
    env: { [BUDGET]: String(BUDGET_MS) },
    on: T0 + BUDGET_MS,
    off: T0 + BUDGET_MS,
  },
  {
    name: "budget + flag",
    env: { [BUDGET]: String(BUDGET_MS) },
    flag: FLAG,
    // The defect: with the switch off the exported budget outranks the caller's
    // explicit flag, so `--timeout 165` was cut at 60 minutes with nothing logged.
    on: T0 + 165 * MINUTE_MS,
    off: T0 + BUDGET_MS,
  },
  {
    name: "absolute + flag",
    env: { [ABSOLUTE]: String(T0 + 7_000) },
    flag: FLAG,
    on: T0 + 7_000,
    off: T0 + 7_000,
  },
  {
    name: "neither",
    env: {},
    on: undefined,
    off: undefined,
  },
  {
    name: "flag only",
    env: {},
    flag: FLAG,
    on: T0 + 165 * MINUTE_MS,
    off: T0 + 165 * MINUTE_MS,
  },
  {
    name: "absolute + budget + flag",
    env: { [ABSOLUTE]: String(T0 + 3_000), [BUDGET]: String(BUDGET_MS) },
    flag: FLAG,
    on: T0 + 3_000,
    off: T0 + 3_000,
  },
];

for (const arm of ["1", "0"] as const) {
  for (const combo of COMBOS) {
    // The env is built fresh per case AND passed as a fresh object: a shared literal
    // would let one combination's `undefined` delete another's key.
    const env = { [BUDGET]: undefined, [ABSOLUTE]: undefined, ...combo.env };
    await withEnv({ ...env, [SWITCH]: arm }, async () => {
      const want = arm === "1" ? combo.on : combo.off;
      assert(
        resolveCycleDeadline({ ...env }, undefined, T0, combo.flag) === want,
        `(b1) ${arm === "1" ? "on" : "off"}: ${combo.name} resolves ${String(want)}`,
      );
      // The switch re-orders the flag against the BUDGET only: `work`'s own entry point
      // passes no flag arm, so its answers cannot move (R3). A real `WorkState`, not a
      // cast `never`: a cast would read `undefined` off a shape that does not exist.
      const workState = initialState(2362, 1) as WorkState;
      const workWant =
        combo.env[ABSOLUTE] !== undefined
          ? Number(combo.env[ABSOLUTE])
          : combo.env[BUDGET] !== undefined
            ? T0 + Number(combo.env[BUDGET])
            : undefined;
      assert(
        readCycleDeadline(workState, T0) === workWant,
        `(b1) ${arm === "1" ? "on" : "off"}: ${combo.name} leaves readCycleDeadline at ${String(workWant)}`,
      );
    });
  }
}

// ── (b2) the one warning, at the disagreement — through the ENGINE, because that is
// where the arm is persisted and where R2 puts the line. Each case drives a real run and
// reads the record back, so the arm compared is the one the run wrote.
{
  // budget vs flag: the flag wins and the line names both values and the winner.
  const { arm, warns } = await driveOnce({
    name: "warn-budget",
    issue: 2363,
    env: { [BUDGET]: String(BUDGET_MS), [ABSOLUTE]: undefined, [SWITCH]: undefined },
    budgetMs: FLAG,
  });
  assert(
    arm !== undefined && arm - Date.now() > 160 * MINUTE_MS,
    `(b2) --timeout 165 under a 60-min budget arms 165 minutes on the run's own record (arm is ${String(arm)}, now ${String(Date.now())})`,
  );
  assert(
    warns.length === 1 && isPrecedenceWarning(warns[0] ?? ""),
    `(b2) the disagreement costs exactly one warning naming both values and the winner (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
  );
  assert(
    (warns[0] ?? "").includes(`${BUDGET}=${String(BUDGET_MS)}`) &&
      (warns[0] ?? "").includes(`${FLAG_NAME}=${String(arm)}`),
    `(b2) and the line carries both values in ms, so an operator can see which number bit (got ${JSON.stringify(warns[0])})`,
  );
}
{
  // absolute earlier than the flag alone gives: the absolute wins, and says so. The
  // line is judged STRUCTURALLY, by `shapeOf`, rather than by substrings: its groups are
  // the flag's arm, the loser, the winner and the deadline, in the order the sentence
  // puts them, so the tail's `PI_ENSEMBLE_CYCLE_BUDGET_MS` cannot be mistaken for the
  // loser. Non-vacuity is the arithmetic between the groups — the loser token must carry
  // the very epoch the line reports as the deadline, the winner must be the absolute, and
  // the flag's epoch must sit exactly the 155 minutes `--timeout 165` left unspent above
  // it. One millisecond of tolerance on each: the line is built from the drive's own
  // `Date.now()` and the case's `earlier` from this file's, and a run that moved an arm
  // by more than that from what this case armed is not this case.
  const earlier = Date.now() + 10 * MINUTE_MS;
  const { arm, warns } = await driveOnce({
    name: "warn-absolute",
    issue: 2364,
    env: { [ABSOLUTE]: String(earlier), [BUDGET]: undefined, [SWITCH]: undefined },
    budgetMs: FLAG,
  });
  assert(
    arm === earlier,
    `(b2) a CYCLE_DEADLINE earlier than --timeout wins on the record (got ${String(arm)} vs ${String(earlier)})`,
  );
  const shape = /(?<flag>\d+) against (?<loser>\S+) \S+ (?<winner>\S+) wins \(the run's deadline is (?<deadline>\d+)\)/.exec(
    warns[0] ?? "",
  );
  assert(
    warns.length === 1 &&
      isPrecedenceWarning(warns[0] ?? "") &&
      shape !== null &&
      shape.groups?.loser === `${ABSOLUTE}=${shape.groups.deadline}` &&
      shape.groups.winner === ABSOLUTE &&
      Math.abs(Number(shape.groups.flag) - Number(shape.groups.deadline) - (165 - 10) * MINUTE_MS) <= 1 &&
      Math.abs(Number(shape.groups.deadline) - earlier) <= 1,
    `(b2) and one warning names the absolute arm and both values (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
  );
}
{
  // F3 — the line is said about what the READER honoured, not about what this file re-read
  // from the env. `"1e3"` is a DURATION STRING whose numeric value is one second, while the
  // OFF arm's reader turns the same env into the 60-minute arm the fixture's `3600000` row
  // holds: a line that re-parsed the env and compared epochs would print an arm the run never
  // held, or quote a duration the reader never weighed. What the line must carry is the arm
  // THIS run got — the flag's own — and `--timeout` as the winner: the run was not cut, and
  // the line says so with the numbers it actually honoured.
  const { arm, warns } = await driveOnce({
    name: "warn-tiny-budget",
    issue: 2366,
    env: { [BUDGET]: "1e3", [ABSOLUTE]: undefined, [SWITCH]: undefined },
    budgetMs: FLAG,
  });
  assert(
    arm !== undefined && arm - Date.now() > 160 * MINUTE_MS,
    `(b2) a one-second exported budget does not cut --timeout 165 (arm is ${String(arm)})`,
  );
  assert(
    warns.length === 1 && isPrecedenceWarning(warns[0] ?? ""),
    `(b2) and the disagreement is still ONE line, said with the arm the reader honoured (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
  );
  assert(
    (warns[0] ?? "").includes(`${FLAG_NAME}=${String(arm)}`) &&
      (warns[0] ?? "").includes("--timeout wins") &&
      (warns[0] ?? "").includes(`the run's deadline is ${String(arm)}`),
    `(b2) and the line names --timeout's OWN arm as both the flag's value and the deadline, never a re-derived one (got ${JSON.stringify(warns[0])})`,
  );
}
{
  // F3 — the `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE=0` remedy belongs to the BUDGET arm
  // alone: the switch re-orders the flag against the exported budget and cannot move an
  // absolute deadline, so the deadline's own line must not suggest that turning the knob
  // would put the exported budget above the flag. `shapeOf` still requires the switch's name
  // on every line (an operator reaching for the knob needs to see what it does to THIS row),
  // so what is pinned here is that the deadline's line states what `=0` cannot do rather
  // than quoting the budget's promise.
  const earlier = Date.now() + 10 * MINUTE_MS;
  const { warns } = await driveOnce({
    name: "remedy-tail",
    issue: 2367,
    env: { [ABSOLUTE]: String(earlier), [BUDGET]: undefined, [SWITCH]: undefined },
    budgetMs: FLAG,
  });
  assert(
    warns.length === 1 &&
      !warns[0]!.includes("puts the exported budget back above the flag"),
    `(b2) and a line overridden by the absolute deadline offers no budget remedy (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
  );
}
{
  // R4 + "no disagreement logs nothing": every case where the values agree, or where
  // the env value is one the reader does not honour, stays silent.
  const silent: [string, Record<string, string | undefined>, number | undefined][] = [
    ["no env at all", {}, undefined],
    ["budget equal to the flag", { [BUDGET]: String(165 * MINUTE_MS) }, undefined],
    ["absolute equal to the flag", { [ABSOLUTE]: String(T0 + 165 * MINUTE_MS) }, undefined],
    ["empty budget", { [BUDGET]: "" }, undefined],
    ["malformed budget", { [BUDGET]: "abc" }, undefined],
    ["non-positive budget", { [BUDGET]: "0" }, undefined],
    ["malformed absolute", { [ABSOLUTE]: "not-a-number" }, undefined],
    ["absolute in seconds", { [ABSOLUTE]: "1700000200" }, undefined],
  ];
  for (const [name, env, persisted] of silent) {
    const warns: string[] = [];
    await withEnv({ [BUDGET]: undefined, [ABSOLUTE]: undefined, [SWITCH]: undefined }, async () => {
      await captureReader(env, persisted, warns, FLAG);
    });
    assert(
      warns.length === 0,
      `(b2) ${name}: a value the reader does not honour never warns (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
    );
  }
}
{
  // The off arm's ORDER is today's, and the pure reader stays silent on it — the line
  // is the persist site's, and its content is pinned by the off-arm sibling file.
  const warns: string[] = [];
  let resolved: number | undefined;
  await withEnv({ [BUDGET]: String(BUDGET_MS), [ABSOLUTE]: undefined, [SWITCH]: "0" }, async () => {
    await captureReader({ [BUDGET]: String(BUDGET_MS) }, undefined, warns, FLAG);
    resolved = resolveCycleDeadline({ [BUDGET]: String(BUDGET_MS) }, undefined, T0, FLAG);
  });
  assert(
    resolved === T0 + BUDGET_MS,
    `(b2) "0" restores today's order (arm ${String(resolved)})`,
  );
  assert(
    warns.length === 0,
    `(b2) and the pure reader stays silent on it, on either arm (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
  );
}

// ── (c1) R1 — the flag-wins order applies to the FIRST resolve only.
{
  const persisted = T0 + 7_000;
  const warns: string[] = [];
  let resolved: number | undefined;
  await withEnv({ [BUDGET]: String(BUDGET_MS), [ABSOLUTE]: undefined, [SWITCH]: undefined }, async () => {
    await captureReader({ [BUDGET]: String(BUDGET_MS) }, persisted, warns, FLAG);
    resolved = resolveCycleDeadline({ [BUDGET]: String(BUDGET_MS) }, persisted, T0, FLAG);
  });
  assert(
    resolved === persisted && warns.length === 0,
    `(c1) a resume keeps the persisted arm whatever --timeout says, and the switch adds no line to it (got ${String(resolved)}, ${String(warns.length)} warn line(s))`,
  );
}

// ── (c2) the warning is emitted at the engine's PERSIST SITE, once per run — never
// inside the pure reader, and never re-emitted at a later boundary of the same run.
{
  const { warns, optsSeen } = await driveOnce({
    name: "warn-once",
    issue: 2362,
    env: { [BUDGET]: String(BUDGET_MS), [ABSOLUTE]: undefined, [SWITCH]: undefined },
    budgetMs: FLAG,
  });
  assert(
    warns.length === 1 && isPrecedenceWarning(warns[0] ?? ""),
    `(c2) a real run whose flag was overridden costs exactly ONE line with PI_ENSEMBLE_DEBUG unset (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
  );
  // The line is the PERSIST SITE's, so the pure reader stays silent on the very input
  // the run above passed it. A warning that lived inside the reader would print here too
  // — and the run's single line above would then read as two.
  assert(
    (await warnsOfReader({ [BUDGET]: String(BUDGET_MS) }, FLAG)) === 0,
    "(c2) and the pure reader itself writes no line: the warning belongs to the persist site",
  );
  assert(
    optsSeen.budgetMs === FLAG,
    "(c2) and the flag reached the engine as a VALUE, not an env write",
  );
  assert(
    process.env[BUDGET] === undefined,
    `(c2) and the run wrote nothing to the budget env (got ${JSON.stringify(process.env[BUDGET])})`,
  );
}

// ── (c3) R2 — the line stays one valid NDJSON log line under headless: it is a single
// `traceWarn` write with no newline inside it, which is the shape the headless NDJSON
// capture turns into exactly one v1 record (test-headless-stderr-ndjson.ts is the gate
// that judges the capture itself).
{
  const { warns } = await driveOnce({
    name: "ndjson",
    issue: 2365,
    env: { [BUDGET]: String(BUDGET_MS), [ABSOLUTE]: undefined, [SWITCH]: undefined },
    budgetMs: FLAG,
  });
  assert(
    warns.length === 1 &&
      (warns[0] ?? "").startsWith("[pi-rukas] WARN ") &&
      !/[\r\n]/.test(warns[0] ?? ""),
    `(c3) the warning is ONE newline-free traceWarn line, the shape the NDJSON capture renders as one log record (got ${String(warns.length)}: ${JSON.stringify(warns)})`,
  );
}

// ── (d) the host contract: the feature, the roster row, and the two doc sentences.
{
  const features = HEADLESS_FEATURES as unknown as Record<string, unknown>;
  assert(
    features.timeoutFlagPrecedence === true,
    "(d) features.timeoutFlagPrecedence is true in this build",
  );
  const row = HEADLESS_INPUTS.find((i) => i.name === SWITCH);
  assert(
    row !== undefined && row.type === "boolean" && row.default === true,
    `(d) HEADLESS_INPUTS lists ${SWITCH} as a boolean defaulting to true (got ${JSON.stringify(row)})`,
  );
  const host = docs("headless.md");
  assert(
    host.includes("features.timeoutFlagPrecedence"),
    "(d) docs/headless.md has a features row for the switch",
  );
  assert(
    host.includes(SWITCH),
    "(d) docs/headless.md names the switch where it states the order",
  );
  const conf = docs("configuration.md");
  assert(
    conf.includes(`\`${SWITCH}\``),
    "(d) docs/configuration.md carries a row for the switch",
  );
  assert(
    conf.includes("--timeout") && conf.includes(BUDGET),
    "(d) and that row states the order between the flag and the exported budget",
  );
}

// ── (f) the handoff allowance is untouched: the switch changes which DURATION wins,
// never where step work ends.
{
  await withEnv({ [BUDGET]: String(BUDGET_MS), [ABSOLUTE]: undefined, [SWITCH]: undefined }, async () => {
    const arm = resolveCycleDeadline({ [BUDGET]: String(BUDGET_MS) }, undefined, T0, FLAG);
    assert(
      arm === T0 + 165 * MINUTE_MS &&
        arm - T0 > handoffDispatchTimeoutMs() &&
        handoffDispatchTimeoutMs() > 0,
      `(f) the winning arm still sits outside a positive handoff allowance (${String(arm - T0)}ms vs ${String(handoffDispatchTimeoutMs())}ms)`,
    );
  });
}

/** Call the pure reader under the current env scope, catching this rule's lines. Kept
 *  local because only the silence cases need it: `warnsOfReader` from the fixture
 *  opens its own env scope, which these cases have already pinned. */
async function captureReader(
  env: Record<string, string | undefined>,
  persisted: number | undefined,
  into: string[],
  flag: CycleBudgetMs | undefined = FLAG,
): Promise<void> {
  await captureWarns("--timeout", into, async () => {
    resolveCycleDeadline(env, persisted, T0, flag);
  });
}

cleanScratch();
console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
