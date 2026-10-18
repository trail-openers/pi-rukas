#!/usr/bin/env bun
/**
 * #1449 — the adversarial ledger write must never COST a review.
 *
 * `makeLedgerWrite` (adversarial-ledger-capture.ts) hands the loop's result back
 * synchronously and delivers the write's outcome when it settles. That shape is
 * only safe if the CALL SITE treats the writer as untrusted: a contract the
 * caller depends on for its own safety ("the returned promise never rejects") is
 * not a contract the caller may call unguarded.
 *
 * The bug this pins was CI-red on PR #1550: the call site did
 * `ledgerWrite.then(...)` directly, and `test-adversarial-tool-guards` mocks the
 * writer with a bare `(r, p) => { push(...) }` — which returns `undefined` — so
 * every exit of the loop threw `TypeError: undefined is not an object`. A ledger
 * problem became a lost review, the exact direction #1449 must never open. That
 * suite keeps EVERY arm on the same unchainable mock, so all thirteen loop exits
 * are its end-to-end regression test; the arms here cover the shapes a
 * `mock.module` arrow cannot express.
 *
 * Three layers, each watched separately — because the REAL writer cannot produce
 * two of the failure modes (it ends in `write().catch(...)`, so a fault in its
 * body is always a rejection and its return is always chainable). Without the
 * `LEDGER_WRITER` seam those two guards would protect code paths that cannot
 * occur, which is the same as not guarding them, and no test could tell. With
 * the seam, deleting any one layer turns an arm red — all three verified by
 * mutation:
 *
 *   (1) `Promise.resolve(...)` in front of `.then` — the unchainable return.
 *       Deleting it: `TypeError` out of the synchronous call, on every shape.
 *   (2) the `try`/`catch` around the CALL — the synchronous throw.
 *       Deleting it: the writer's throw escapes to the loop's exit.
 *   (3) the `undefined`/`null` normalisation before `deliver` — so a no-shape
 *       return reaches the reporter as "nothing to report" and appends no note,
 *       rather than being handed to the renderer as if it were an outcome.
 *       Deleting it: `null` / a plain object append a note the row never earned.
 *
 * Layer (3) is watched through the DEFAULT reporter with NO `onLedgerOutcome`
 * passed — a stub would replace the reporter and prove nothing about what
 * production does. The `note` threader is passed through untouched so the arm can
 * see whether a note was appended. That the same reporter DOES append when a
 * redirect really happened is `test-merge-guard-provenance-fault.ts`
 * (`loopAppendsTheMisdirectedNote`) — so "no note" here is not a reporter that
 * never runs.
 *
 * Split from that file on the AGENTS.md §12 size cap and a real seam: that file
 * asks "can the reporting read damage the GUARD", this one asks "can the writer's
 * return shape damage the LOOP".
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_WRITER, makeLedgerWrite } from "../src/adversarial-ledger-capture.ts";
import type { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`\u2713 ${msg}`);
    passed++;
  } else {
    console.error(`\u2717 ${msg}`);
    failed++;
  }
}

type Writer = typeof writeAdversarialLedgerEntry;
const REAL_WRITER = LEDGER_WRITER.current;

/** One `makeLedgerWrite` call with the writer swapped for `writer`, against a
 * throwaway cwd. `text` is read back through the `note` threader — the
 * synchronous return is the UN-noted result by contract (fire-and-forget), so
 * reading the returned object would assert the wrong thing. */
async function driveLoopExit(writer: Writer): Promise<{ threw: boolean; text: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-1449-shapes-"));
  let threw = false;
  let text = "REVIEW DONE";
  LEDGER_WRITER.current = writer;
  try {
    const write = makeLedgerWrite({
      state: { captured: { binding: {}, headRef: undefined } },
      workCwd: dir,
      branch: "feature/x",
      resolvedBranch: "feature/x",
      decorate: (raw) => raw,
      // The loop's own threader shape (adversarial-ledger-note.ts
      // `withLedgerNote`): pure, appends a constant. No `onLedgerOutcome`, so the
      // DEFAULT reporter (the misdirection note) is the one under test.
      note: (raw) => {
        text = raw.text;
        return raw;
      },
    });
    write({ ok: true, loopOutcome: "approved", text: "REVIEW DONE" } as never);
  } catch {
    threw = true;
  } finally {
    LEDGER_WRITER.current = REAL_WRITER;
    rmSync(dir, { recursive: true, force: true });
  }
  // The delivery is fire-and-forget; give it a tick before judging the text.
  await new Promise((r) => setTimeout(r, 10));
  return { threw, text };
}

const unchainable: Array<[string, () => unknown]> = [
  // THE CI shape: what `mock.module` gives a bare `(r, p) => { push(...) }`.
  ["undefined", () => undefined],
  // Other values a mock, a stub, or a refactor hands back.
  ["null", () => null],
  ["a plain object that is not a promise", () => ({ recorded: true })],
  // A rejection the writer's own catch somehow missed (a dropped `.catch`).
  ["a rejected promise", () => Promise.reject(new Error("writer rejected"))],
];

try {
  // ---- (1)+(3) no return shape reaches the loop's exit as a throw ----------
  for (const [label, seam] of unchainable) {
    const { threw, text } = await driveLoopExit((() => seam()) as Writer);
    assert(!threw, `#1449 a writer returning ${label} does not throw out of the loop's exit`);
    // "Nothing to report" must not become a claim. A no-shape write appends no
    // note: the result the operator sees is byte-identical to an un-noted one.
    assert(
      !threw && text === "REVIEW DONE",
      `#1449 a writer returning ${label} appends no note to the result`,
    );
  }

  // ---- (2) the synchronous throw ------------------------------------------
  {
    const { threw, text } = await driveLoopExit((() => {
      throw new Error("writer exploded before returning a promise");
    }) as Writer);
    assert(!threw, "#1449 a writer that throws SYNCHRONOUSLY is contained at the call site");
    assert(
      !threw && text === "REVIEW DONE",
      "#1449 a faulting writer leaves the loop's result byte-identical (no note, no throw)",
    );
    // The probe that keeps the arm from passing vacuously: the swap really is in
    // force, so `threw === false` means the guard swallowed it, not that some
    // other writer ran.
    let probeSawThrow = false;
    LEDGER_WRITER.current = (() => {
      throw new Error("probe");
    }) as Writer;
    try {
      LEDGER_WRITER.current({ ok: true, loopOutcome: "approved", text: "x" } as never, {});
    } catch {
      probeSawThrow = true;
    } finally {
      LEDGER_WRITER.current = REAL_WRITER;
    }
    assert(
      probeSawThrow,
      "#1449 the installed writer really does throw (else the sync arm proves nothing)",
    );
  }

  // ---- the healthy path is not swallowed ----------------------------------
  // The guard must be a tolerance, not a catch-all that hides a real write: a
  // writer ON contract still reaches the reporter with its outcome intact.
  // (That the reporter then APPENDS the note for a redirect is proven by
  // `test-merge-guard-provenance-fault.ts::loopAppendsTheMisdirectedNote`, which
  // drives the same default reporter against a real redirected write — asserted
  // here too would duplicate it, and `misdirectedLedgerNote` is pure so there is
  // nothing local this could see that that arm does not.)
  {
    let outcome: unknown = "NOT CALLED";
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-1449-healthy-"));
    LEDGER_WRITER.current = (() =>
      Promise.resolve({ recorded: true, landedAtPath: "/tmp/elsewhere/x.json" })) as Writer;
    try {
      const write = makeLedgerWrite({
        state: { captured: { binding: {}, headRef: undefined } },
        workCwd: dir,
        branch: "feature/x",
        resolvedBranch: "feature/x",
        decorate: (raw) => raw,
        note: (raw) => raw,
        onLedgerOutcome: (o) => {
          outcome = o;
        },
      });
      write({ ok: true, loopOutcome: "approved", text: "REVIEW DONE" } as never);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      LEDGER_WRITER.current = REAL_WRITER;
      rmSync(dir, { recursive: true, force: true });
    }
    assert(
      JSON.stringify(outcome) ===
        JSON.stringify({ recorded: true, landedAtPath: "/tmp/elsewhere/x.json" }),
      "#1449 a writer ON contract still reaches the reporter with its outcome, unaltered",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  LEDGER_WRITER.current = REAL_WRITER;
}
