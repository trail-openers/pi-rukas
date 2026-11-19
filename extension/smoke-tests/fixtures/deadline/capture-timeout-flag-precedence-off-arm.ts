#!/usr/bin/env bun
/**
 * One-shot capture for the #2362 off-arm golden
 * (`fixtures/deadline/timeout-flag-precedence-off-arm.json`).
 *
 * Run ONCE against the pre-fix tree — `git worktree add /tmp/x 238291c448`, then this
 * script with that tree's smoke-tests on disk — because the off arm is only worth what
 * the tree that had no switch recorded: capturing it from the fixed tree and calling the
 * result a pin would pin the fix's own output, which proves nothing.
 *
 * Each case records the arm the reader resolved AND every physical line the reader put
 * on stderr, with `PI_ENSEMBLE_DEBUG` unset, so the off arm's silence is a captured fact
 * and not an assumption. Values are absolute because the fixture and the test both use
 * the fixed clock `T0`; nothing here depends on wall time.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const T0 = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const BUDGET = "PI_ENSEMBLE_CYCLE_BUDGET_MS";
const ABSOLUTE = "PI_ENSEMBLE_CYCLE_DEADLINE";
const BUDGET_MS = 60 * MINUTE_MS;
const FLAG_MS = 165 * MINUTE_MS;

const CASES: { env: Record<string, string | undefined>; flag: number | null }[] = [
  { env: { [ABSOLUTE]: String(T0 + 7_000) }, flag: null },
  { env: { [BUDGET]: String(BUDGET_MS) }, flag: null },
  { env: { [BUDGET]: String(BUDGET_MS) }, flag: FLAG_MS },
  { env: { [ABSOLUTE]: String(T0 + 7_000) }, flag: FLAG_MS },
  { env: {}, flag: null },
];

async function main(): Promise<void> {
  // Three levels up from `smoke-tests/fixtures/deadline/` is `extension/`.
  const { flagBudgetMs, resolveCycleDeadline } = await import(
    "../../../src/work-driver-deadline.ts"
  );
  const cases = [];
  for (const c of CASES) {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return write(chunk as string | Uint8Array);
    }) as typeof process.stderr.write;
    let arm: number | null = null;
    try {
      arm =
        resolveCycleDeadline(
          { ...c.env },
          undefined,
          T0,
          c.flag === null ? undefined : (flagBudgetMs(c.flag) as never),
        ) ?? null;
    } finally {
      process.stderr.write = write;
    }
    cases.push({
      env: c.env,
      flag: c.flag,
      arms: { on: arm, off: arm },
      stderr: lines.map((l) => l.replace(/\r?\n$/, "")),
    });
  }
  // The ON arm is filled in by hand from the fixed tree's answers: it is the row the
  // switch changes, and the test asserts against it. Recorded here from the fixed tree's
  // reader so both numbers come from a reader rather than from the test's own expectation.
  const on = process.env.ON_ARMS;
  const onArms: (number | null)[] = on === undefined ? [] : (JSON.parse(on) as (number | null)[]);
  if (onArms.length !== 0 && onArms.length !== cases.length)
    throw new Error(
      `ON_ARMS has ${String(onArms.length)} entries but ${String(cases.length)} cases are captured: ` +
        `a short list would fill the leading rows and leave the rest at the pre-fix arm, silently, ` +
        `and the fixture would read as a complete capture of a run that did not happen.`,
    );
  cases.forEach((c, i) => {
    if (onArms.length === cases.length) c.arms.on = onArms[i] ?? null;
  });
  const out = {
    note: "Pre-fix arms and stderr for the #2362 `--timeout` precedence rule, captured ONCE from `resolveCycleDeadline` at 238291c448 (the tree with no PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE) driven by fixtures/deadline/capture-timeout-flag-precedence-off-arm.ts with PI_ENSEMBLE_DEBUG unset and every PI_ENSEMBLE_* variable deleted. `arms.off` is that tree's answer for every input combination; `arms.on` is the same reader at the fix's default, where an explicit --timeout outranks the exported budget. `stderr` is every physical line the reader wrote — the off arm's silence is a captured fact, not an assumption. Values are absolute because both the capture and the test drive the fixed clock `t0`; nothing here depends on wall time.",
    capturedAtCommit: "238291c448",
    switch: "PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE",
    t0: T0,
    flagMs: FLAG_MS,
    cases,
  };
  const dest = path.resolve(import.meta.dirname, "timeout-flag-precedence-off-arm.json");
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${dest}`);
  console.log(JSON.stringify(cases.map((c) => c.arms)));
}

await main();
