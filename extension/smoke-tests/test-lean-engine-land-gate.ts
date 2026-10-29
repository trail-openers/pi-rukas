#!/usr/bin/env bun
/**
 * lean/engine — the land gate, against a log a real drive wrote.
 *
 * Split from `test-lean-engine.ts` for the 500-line gate (AGENTS.md §12); the
 * end-to-end and refusal halves stay there, and the crash/resume half lives in
 * `test-lean-engine-crash.ts`.
 *
 * The merge is the irreversible act in a run, and the table alone cannot gate
 * it: `ci + green` is a LEGAL pair for a run whose own gate last said red,
 * because outcomes reach `next()` one at a time. So the check sits on the
 * ARRIVAL — in `apply()` for a drive that routes there, and on the DERIVED
 * position for a resumed run whose log already names `land`.
 *
 * The strict fold in `resume.ts` changed what this file may assert. It used to
 * hand a real drive `[green, red]` at `verify` and expect the gate to refuse
 * the merge. No drive can produce that record: `verify + red` routes to
 * `build`, never to another `verify`, so a run whose newest decided verdict is
 * red has no `publish`, no `review` and no `ci` after it — the combination is
 * unreachable, and a drive handed that queue never consumes its second
 * verdict. So the file is split by what a real run can and cannot write:
 *
 *   - the LAND cases drive real runs to `landed` and assert exit 0 and one
 *     merge;
 *   - the shapes the old cases pretended a run could produce (a red newest
 *     `verify` at `land`, a `draft` marker the log does not explain, a `ci:red`
 *     the log drops) appear only as FORGERIES, and the assertion is that the
 *     fold refuses them at load with every handler call count still zero.
 *
 * Every scripted queue is a fresh object literal. `HAPPY`'s arrays are shared
 * by every case in this file, and a drive that takes more of one state than a
 * later drive needs leaves the shared queue one shorter than that drive's own
 * log says.
 */

import { runLean } from "../src/lean/engine.ts";
import type { LeanRun, LeanState, Outcome } from "../src/lean/state.ts";
import { loadRun } from "../src/lean/state.ts";
import { makeAssert, scripted, tempDir, ticking } from "./lib/lean-engine-fixtures.ts";
import { driveRun, foldOf, writeForged } from "./lib/lean-real-log-fixture.ts";

const { assert, failures } = makeAssert();

const decided = (run: LeanRun, state: LeanState): number =>
  run.steps.filter((s) => s.state === state && s.outcome !== undefined).length;

const kinds = (run: LeanRun, state: LeanState): string[] =>
  run.steps.filter((s) => s.state === state).map((s) => s.outcome?.kind ?? "pending");

/**
 * The verdict queues, written out every time.
 *
 * `build` carries two rounds and `verify` as many verdicts as the walk needs:
 * a run that is challenged once spends its second round after the challenge,
 * so a happy path really does visit `build` twice and `verify` once, and a CI
 * fix round adds a third build and a second verdict. Spelling the queue out is
 * what makes a starvation visible in the case that fails rather than in the
 * `no scripted outcome` throw of a queue some earlier case shortened.
 */
const queue = (verdicts: string[], ci: Outcome[]): Partial<Record<LeanState, Outcome[]>> => ({
  ready: [{ kind: "ok" }],
  specify: [{ kind: "ok" }],
  build: [{ kind: "ok" }, { kind: "ok" }, { kind: "ok" }],
  challenge: [{ kind: "none" }, { kind: "none" }, { kind: "none" }],
  verify: verdicts.map((kind) => ({ kind })),
  publish: [{ kind: "ok" }, { kind: "ok" }],
  review: [{ kind: "done" }, { kind: "done" }],
  ci,
  land: [{ kind: "merged" }],
  handback: [{ kind: "done" }],
  decline: [{ kind: "done" }],
});

/**
 * Assert the drive consumed exactly the verdicts its own path needed, before
 * any assertion about the verdict itself.
 *
 * A queue that ran dry ends the run `handed-back` with `no scripted outcome`
 * in its reason — and a case that then asserted "does not land" would pass for
 * the wrong reason, which is precisely how the previous version of this file
 * reported a starved queue as a working gate.
 */
function assertConsumed(
  label: string,
  onDisk: LeanRun,
  expected: Partial<Record<LeanState, string[]>>,
): void {
  for (const [state, want] of Object.entries(expected) as [LeanState, string[]][]) {
    const got = kinds(onDisk, state);
    assert(
      got.length === want.length && got.every((k, i) => k === want[i]),
      `${label}: ${state} carries the scripted verdicts (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    );
  }
}

// ── real runs that earn the merge ──────────────────────────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    // (1) The run's own gate said RED on its first round and GREEN on its
    // second. This is the walk the old case claimed to script: `verify + red`
    // bills a build round, that round earns the challenge, and the second
    // verdict is the one the record ends on — green, with the marker cleared
    // by the same arrow. A real drive reaches `land` only this way.
    const issue = 23;
    const { run } = await driveRun(dir, issue, queue(["red", "green"], [{ kind: "green" }]));
    assert(
      decided(run, "verify") === 2,
      `the drive consumed both scripted verdicts (got ${decided(run, "verify")})`,
    );
    assertConsumed("a recovered run", run, {
      verify: ["red", "green"],
      ci: ["green"],
      land: ["merged"],
    });
    assert(run.state === "landed", `the recovered run landed (got ${run.state})`);

    // (2) A red CI spends the run's single fix round: build, one more verdict,
    // publish, review (already done, so straight to CI), and a green CI. This
    // is the shape the old case #4 forged by cutting the log at the first
    // `ci:0`; here it is driven all the way and lands.
    // (2) A red CI spends the run's single fix round, so the walk needs TWO
    // gate verdicts — one before the publish and one after the fix build.
    const fixed = await driveRun(
      dir,
      24,
      queue(["green", "green"], [{ kind: "red" }, { kind: "green" }]),
    );
    assertConsumed("a CI-fixed run", fixed.run, {
      verify: ["green", "green"],
      ci: ["red", "green"],
      land: ["merged"],
    });
    assert(
      fixed.calls.land === 1 && fixed.run.state === "landed",
      `one fix round then green CI lands with exactly one merge (state ${fixed.run.state}, land ${fixed.calls.land})`,
    );
    assert(
      fixed.run.result?.code === 0,
      `and the record stamps the exit 0 the merge earned (got ${fixed.run.result?.code})`,
    );

    // (3) The plainest record of all is the control for every refusal below:
    // the same `runLean` entry point, a record that earned its merge, lands.
    const { handlers, calls } = scripted(queue(["green"], [{ kind: "green" }]));
    const earned = await runLean({ repoRoot: dir, issue: 25, handlers, now: ticking().now });
    const onDisk = loadRun(dir, 25);
    assert(
      onDisk !== undefined && decided(onDisk, "verify") === 1 && decided(onDisk, "ci") === 1,
      `the positive control consumed its one verify and its one ci (got ${JSON.stringify(onDisk?.steps.map((s) => `${s.state}:${s.outcome?.kind ?? "pending"}`))})`,
    );
    assert(
      earned.state === "landed" && earned.code === 0 && calls.land === 1,
      `green verify, green ci and no marker does land (got ${earned.state} exit ${earned.code}, land calls ${calls.land})`,
    );
    assert(
      loadRun(dir, 25)?.result?.code === 0,
      "and the durable record carries the exit 0 the merge earned",
    );
  } finally {
    cleanup();
  }
}

// ── forgeries: three records no drive wrote, each refused at load ─────────

{
  const { dir, cleanup } = tempDir();
  try {
    // The one real log every forgery below is cut from, so the difference
    // between each forged file and a genuine one is the assertion.
    const { run: full } = await driveRun(dir, 26, queue(["green"], [{ kind: "green" }]));
    const cutTo = (state: LeanState, take = 1): LeanRun => {
      const indexes: number[] = [];
      full.steps.forEach((s, i) => {
        if (s.state === state) indexes.push(i);
      });
      const stop = indexes[take - 1];
      if (stop === undefined) throw new Error(`the driven log has no ${state} step`);
      // The snapshot is the position the fold derives for THIS prefix, which
      // is what the engine itself persists when it writes an entry. A forgery
      // then changes exactly one thing more — a verdict, a counter, or the
      // length of the log — and that one thing is the case.
      const prefix = { ...full, steps: full.steps.slice(0, stop + 1) };
      const position = foldOf(prefix);
      return { ...prefix, state: position.state, counters: position.counters };
    };

    // A snapshot whose newest decided `verify` is a refusal. No drive can pair
    // that with a `ci` — so the file must never reach a handler.
    const redVerify = {
      ...cutTo("ci"),
      steps: cutTo("ci").steps.map((s) =>
        s.state === "verify" ? { ...s, outcome: { kind: "red" } } : s,
      ),
    };
    const { handlers: h1, calls: c1 } = scripted(queue(["green"], [{ kind: "green" }]));
    writeForged(dir, { ...redVerify, state: "land" });
    assertRefused(dir, 26, h1, c1, "a land snapshot whose newest verify is red");

    // A snapshot carrying a marker the log never raised — `draft` is set by
    // `verify + red` and cleared by `verify + green`, and this log's only
    // verdict is green.
    const drafted = cutTo("ci");
    const { handlers: h2, calls: c2 } = scripted(queue(["green"], [{ kind: "green" }]));
    writeForged(dir, { ...drafted, state: "land", counters: { ...drafted.counters, draft: true } });
    assertRefused(dir, 26, h2, c2, "a land snapshot carrying an invented draft marker");

    // The log's newest `ci` dropped, so the snapshot claims `land` on a walk
    // that ends at `review`. This is the file the old case #4 read as "a red
    // CI that must not buy the merge"; it is not a run at all.
    const dropped = cutTo("review");
    const { handlers: h3, calls: c3 } = scripted(queue(["green"], [{ kind: "green" }]));
    writeForged(dir, { ...dropped, state: "land" });
    assertRefused(dir, 26, h3, c3, "a land snapshot whose log drops the newest ci");
  } finally {
    cleanup();
  }
}

/** Drive a forged file and pin the refusal: a LeanStateError, and no handler. */
async function assertRefused(
  dir: string,
  issue: number,
  handlers: Parameters<typeof runLean>[0]["handlers"],
  calls: Record<string, number>,
  label: string,
): Promise<void> {
  const before = JSON.stringify(loadRun(dir, issue));
  let thrown: unknown;
  try {
    await runLean({ repoRoot: dir, issue, handlers, now: ticking().now });
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown instanceof Error && thrown.name === "LeanStateError",
    `${label}: refused at load with a LeanStateError (got ${String(thrown)})`,
  );
  assert(
    /snapshot disagrees with the step log/.test((thrown as Error)?.message ?? ""),
    `${label}: the refusal names the disagreement (got ${(thrown as Error)?.message})`,
  );
  assert(
    Object.keys(calls).length === 0,
    `${label}: zero handler calls (got ${JSON.stringify(calls)})`,
  );
  assert(
    JSON.stringify(loadRun(dir, issue)) === before,
    `${label}: refusing never rewrites the record`,
  );
}

process.exit(failures());
