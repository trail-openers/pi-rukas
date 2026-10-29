/**
 * lean/engine — a stamped `result` is the answer only when its own log earned it.
 *
 * `runLean` returns a record that already carries a `result` VERBATIM — "the file
 * is the answer" — and it used to do that before any gate was asked. `result` is
 * as much a cache as `state` and `counters` (state.ts's own header says the
 * snapshot fields are not the record), so a file whose hand-written code was 0
 * reported a merge the record itself refuses.
 *
 * `verifiedPosition` already refuses a snapshot whose `state` or `counters` the
 * step log does not reproduce, and it derives them both — which leaves `result`
 * as the ONE terminal field a file can carry that its own log contradicts. This
 * is the case for the three rules that check now, each of which is one of the
 * three things `endRun` — the only writer of `result` — writes: the state is
 * terminal, the code is `exitCodeFor` that state, and a `landed` state is one the
 * land gate (`landEarned`) actually holds of the log.
 *
 * Split from `test-lean-engine-resume.ts` for the 500-line cap (AGENTS.md §12)
 * along the seam between "where a resumed run stands" and "what a finished run
 * is allowed to claim".
 */

import { runLean } from "../src/lean/engine.ts";
import type { LeanRun, LeanState, Outcome } from "../src/lean/state.ts";
import { loadRun } from "../src/lean/state.ts";
import { makeAssert, scripted, tempDir, ticking } from "./lib/lean-engine-fixtures.ts";
import { driveRun, foldOf, writeForged } from "./lib/lean-real-log-fixture.ts";

const { assert, failures } = makeAssert();

/**
 * A record that carries a `result` its own step log does not earn, built from a
 * real drive's bytes — the shape `stampedResultRefusal` exists to refuse.
 *
 * A fixture cannot lie about `state` or `counters` to reach that gate: the fold
 * answers for those BEFORE the stamp is read, so a case that tripped it would be
 * testing the fold. Hence every knob below is set from the fold's own answer for
 * the log it is paired with, and the only thing left for a case to assert on is
 * the stamp.
 *
 * `ciRed` cuts the log back to the walk its CI had not spoken on and stamps a
 * merge on top of it; `code` is the other way a stamp can be one no `endRun`
 * wrote. Both records are hand-written by construction: a drive that went
 * through the gate stamps the state its log reached, and the log that reached
 * `landed` has a green CI in it.
 */
function writeStampedBeyondItsLog(
  dir: string,
  source: LeanRun,
  issue: number,
  opts: { ciRed?: boolean; code?: number } = {},
): LeanRun {
  let steps = source.steps.map((s) => ({ ...s }));
  if (opts.ciRed) {
    // Keeping the red entry moves the fold to `build` (`ci + red` routes there
    // and bills a round); keeping the whole log leaves the fix round's
    // `publish + error` verdict — an outcome with no arrow, which `resume.ts`
    // refuses on any file that does not itself end `handed-back`. Cutting to
    // before it leaves a log with no `ci` verdict at all, so the merge the stamp
    // claims is one the record never reached.
    const redCi = source.steps.findIndex((s) => s.state === "ci" && s.outcome?.kind === "red");
    if (redCi < 0) throw new Error("the fixture log has no red ci verdict");
    if (source.steps.some((s) => s.state === "land"))
      throw new Error("the fixture log already holds a merge — it is not a handed-back drive");
    if (source.steps.at(-1)?.outcome?.kind !== "error")
      throw new Error(
        "the fixture did not halt on a halted-handler outcome, so it is not the capped drive this log is cut from",
      );
    steps = source.steps.slice(0, redCi).map((s) => ({ ...s }));
  }
  // The snapshot is the fold's own answer for this log, never a guess: the
  // judgement under test reads the DERIVED position, and a snapshot the fold
  // cannot reproduce is refused before anything asks about the stamp.
  const position = foldOf({ ...source, issue, steps });
  return writeForged(dir, {
    ...source,
    issue,
    steps,
    state: position.state,
    counters: position.counters,
    result: { code: opts.code ?? 0, reason: "merged" },
  });
}

/**
 * A drive whose CI goes RED first and green second — the one fix round
 * `ciFixUsed` allows. At the build cap that walk hands back (the fix round's
 * build is the third, which `MAX_BUILD_ATTEMPTS` refuses), so its log is a real
 * drive's bytes in which the newest word on the merge is a red CI verdict.
 */
function ciRedThenGreen(): Partial<Record<LeanState, Outcome[]>> {
  return {
    ready: [{ kind: "ok" }],
    specify: [{ kind: "ok" }],
    build: [{ kind: "ok" }, { kind: "ok" }],
    challenge: [{ kind: "none" }, { kind: "none" }],
    verify: [{ kind: "green" }, { kind: "green" }],
    publish: [{ kind: "ok" }],
    review: [{ kind: "done" }],
    ci: [{ kind: "red" }, { kind: "green" }],
    land: [{ kind: "merged" }],
    handback: [{ kind: "done" }],
  };
}

/** The same drive with a CI that says green first time: this one lands. */
function ciGreen(): Partial<Record<LeanState, Outcome[]>> {
  return {
    ...ciRedThenGreen(),
    build: [{ kind: "ok" }],
    challenge: [{ kind: "none" }],
    verify: [{ kind: "green" }],
    ci: [{ kind: "green" }],
  };
}

{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 48;
    const { run: handedBack } = await driveRun(dir, issue, ciRedThenGreen());
    assert(
      handedBack.state === "handed-back" && handedBack.counters.draft === false,
      `the source drive walked the ci fix round and handed back at the build cap (${handedBack.state}, draft ${handedBack.counters.draft})`,
    );
    assert(
      handedBack.steps.some((s) => s.state === "ci" && s.outcome?.kind === "red"),
      "the source drive really saw a red ci",
    );
    const { run: full } = await driveRun(dir, issue, ciGreen());
    assert(
      full.state === "landed" &&
        full.counters.draft === false &&
        JSON.stringify(loadRun(dir, issue)?.result) === JSON.stringify(full.result),
      `a run whose log earned the merge is on disk as stamped (${full.state}, code ${full.result?.code}, reason ${full.result?.reason})`,
    );

    // (a) a record stamped with a merge its own step log never reached. The
    // stamp says the run is over with a merge; the log folds to `ci`, which is
    // not terminal, and the fold agrees with the log — so the refusal can only
    // come from the stamp check, which is what it is for.
    const unearned = writeStampedBeyondItsLog(dir, handedBack, issue, { ciRed: true });
    const ciVerdicts = unearned.steps
      .filter((s) => s.state === "ci" && s.outcome !== undefined)
      .map((s) => s.outcome?.kind);
    assert(
      unearned.result?.code === 0 && unearned.result.reason === "merged" && ciVerdicts.length === 0,
      `the fixture really is a stamped merge claim on a log that never reached a ci verdict (code ${unearned.result?.code}, reason ${unearned.result?.reason}, ci ${ciVerdicts.join(",") || "none"})`,
    );
    const { handlers, calls } = scripted(ciRedThenGreen());
    let thrown: unknown;
    try {
      await runLean({ repoRoot: dir, issue, handlers, now: ticking().now });
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && /stamped result disagrees with the step log/.test(thrown.message),
      `a stamped record the log does not earn is refused (got ${String(thrown)})`,
    );
    assert(
      thrown instanceof Error && /not terminal/.test(thrown.message),
      `the refusal says the log does not reach a terminal state (got ${String(thrown)})`,
    );
    assert(
      Object.keys(calls).length === 0,
      `a refused stamp runs no handler at all (ran ${JSON.stringify(calls)})`,
    );

    // (b) a code that is not the one its terminal state exits with, on a log
    // that DID earn the merge: `landed` exits 0, so a stamp that says 10 is one
    // `endRun` could not have written, and the land gate is not what is refusing
    // here (`landEarned` holds of this very log).
    const wrongCode = writeStampedBeyondItsLog(dir, full, issue, { code: 10 });
    assert(
      wrongCode.state === "landed" && wrongCode.result?.code === 10,
      `the fixture really is a stamped landed with a code its terminal does not exit (${wrongCode.state}, code ${wrongCode.result?.code})`,
    );
    const { handlers: loud, calls: loudCalls } = scripted(ciGreen());
    let thrown2: unknown;
    try {
      await runLean({ repoRoot: dir, issue, handlers: loud, now: ticking().now });
    } catch (err) {
      thrown2 = err;
    }
    assert(
      thrown2 instanceof Error &&
        /stamped result disagrees with the step log/.test(thrown2.message),
      `a stamped code that does not match its terminal is refused (got ${String(thrown2)})`,
    );
    assert(
      Object.keys(loudCalls).length === 0,
      `a refused code runs no handler either (ran ${JSON.stringify(loudCalls)})`,
    );

    // (c) the honest record, read back off disk rather than from the drive's own
    // return value: what a second `/work-lean` on a finished issue sees is the
    // bytes. With the log and the code both consistent the run comes back
    // exactly as stamped and NOTHING runs — so the gate is a check, not a
    // re-drive. The reason is set to text no `endRun` writes for `landed`
    // (`endRun` stamps `"merged"`), which is what makes "verbatim" observable
    // rather than merely consistent with a re-run.
    const onDisk = loadRun(dir, issue);
    assert(onDisk !== undefined, "the honest record is on disk to be read back");
    const stamped: LeanRun = {
      ...(onDisk as LeanRun),
      result: { code: 0, reason: "the merge went out" },
    };
    writeForged(dir, stamped);
    const { handlers: quiet, calls: quietCalls } = scripted(ciGreen());
    const returned = await runLean({ repoRoot: dir, issue, handlers: quiet, now: ticking().now });
    assert(
      returned.code === 0 &&
        returned.state === "landed" &&
        returned.run.result?.reason === "the merge went out",
      `a genuine finished run is returned as stamped (got exit ${returned.code} at ${returned.state}, reason ${returned.run.result?.reason})`,
    );
    assert(
      Object.keys(quietCalls).length === 0,
      `the verbatim return calls no handler (called ${JSON.stringify(quietCalls)})`,
    );
    assert(
      JSON.stringify(loadRun(dir, issue)) === JSON.stringify(stamped),
      "and the record on disk is untouched — no write, no re-stamp",
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
