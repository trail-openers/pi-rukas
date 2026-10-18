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
 * suite keeps EVERY one of the loop's thirteen exits on that unchainable mock, so
 * the no-promise return is covered end-to-end there; the arms here cover the rest.
 *
 * ## No mutable production seam
 *
 * Layer (2) used to be reachable only through a process-global `LEDGER_WRITER`
 * box that production read and a test wrote. That is gone (#1449 round 1): a
 * swappable writer on the module the #912 trust path consults is a liability
 * bought for no test benefit, and the loop now calls `writeAdversarialLedgerEntry`
 * directly. The tolerance is asserted where each half is implemented:
 *
 *   (1) `normaliseLedgerWriteReturn` — the PURE shape arm. Every off-contract
 *       return is fed to it DIRECTLY: `undefined`, `null`, a bare object with no
 *       `recorded`, an empty object, a string, a number, an array. Deleting the
 *       discriminant check turns the bare-object/empty-object/array arms red;
 *       deleting the nullish guard turns the `undefined`/`null` arms red (both
 *       verified by mutation). The falsy-LOOKING and hostile-getter probes are
 *       what stop those arms passing because of truthiness rather than the guard.
 *   (2) the `try`/`catch` around the CALL — reached by `mock.module`-ing
 *       `toolPathFields` (a module-level binding `writeAdversarialLedgerEntry`
 *       calls UNGUARDED, in the entry literal, before its first `await` completes)
 *       to a function that throws synchronously, then importing
 *       `makeLedgerWrite` FRESH so the mock applies. Deleting the `try`/`catch`
 *       makes the arm red (mutation-verified). Why a mock is needed at all: the
 *       REAL writer is total — every git helper it calls swallows its own fault
 *       (measured: a synchronously-throwing `execFn` still resolves
 *       `{recorded: false}`), so no injectable reaches a synchronous throw
 *       through it, and an arm that simply assumed one did passes vacuously.
 *       Why this particular seam and not the writer itself: `mock.module` rewires
 *       a module for IMPORTS MADE AFTER IT, but not the internal binding of a
 *       module already loaded — so a file that statically imports
 *       `adversarial-ledger-capture.ts` cannot swap the writer that module calls.
 *       `toolPathFields` is called cross-module, so it can be swapped.
 *   (3) the `Promise.resolve` in front of `.then` — reached by `mock.module`-ing
 *       the writer to an `undefined`-returning function and importing
 *       `makeLedgerWrite` FRESH afterwards, which is when the mock does apply. Its
 *       other end-to-end regression test is `test-adversarial-tool-guards.ts`.
 *
 * The DEFAULT reporter (the misdirection note) watches arms (2)/(3) — with NO
 * `onLedgerOutcome` passed, so nothing replaces the reporter and proves nothing
 * about production. That it appends the note for a real redirect through a real
 * write is `test-merge-guard-provenance-fault.ts` (`loopAppendsTheMisdirectedNote`).
 *
 * Split from that file on the AGENTS.md §12 size cap and a real seam: that file
 * asks "can the reporting read damage the GUARD", this one asks "can the writer's
 * return shape damage the LOOP".
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normaliseLedgerWriteReturn } from "../src/adversarial-ledger-capture.ts";

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

// #1449 round 2 — the hand-rolled two-argument `pathJoin` this file used to
// carry is gone, in favour of `node:path`. It accepted exactly two segments and
// the arms path needs THREE (`import.meta.dirname` + "lib" + the filename),
// which TS2554 caught: a three-argument call was an arity error, and the shape
// it would have produced anyway — an absolute path with the fixture name
// missing — is a `bun test` filter that matches nothing, i.e. an arm reporting
// green while running no child.

const dir = path.join(os.tmpdir(), "pi-1449-shapes-");

/** Values that are not outcomes but would survive a truthiness check — what a
 * stub, or a refactor that stops returning the tagged shape, hands back. */
const NOT_OUTCOMES: Array<[string, unknown]> = [
  // THE CI shape: what `mock.module` gives a bare `(r, p) => { push(...) }`.
  ["undefined", undefined],
  ["null", null],
  ["a bare object with no `recorded`", { landedAtPath: "/tmp/x.json" }],
  ["an empty object", {}],
  ["a string", "recorded"],
  ["a number", 0],
  ["an array", []],
];

const OUTCOMES: Array<[string, unknown]> = [
  ["a redirected outcome", { recorded: true, landedAtPath: "/tmp/elsewhere/x.json" }],
  ["an ordinary recorded outcome", { recorded: true }],
  ["a by-design skip", { recorded: false, reason: "no branch to key the ledger entry on" }],
];

try {
  // ---- (1) the pure normaliser: every shape answered directly -------------
  for (const [label, value] of NOT_OUTCOMES) {
    assert(
      normaliseLedgerWriteReturn(value) === undefined,
      `#1449 normaliseLedgerWriteReturn maps ${label} to "nothing to report"`,
    );
  }
  for (const [label, value] of OUTCOMES) {
    assert(
      normaliseLedgerWriteReturn(value) === value,
      `#1449 normaliseLedgerWriteReturn passes ${label} through unaltered`,
    );
  }
  // Probes that keep the nullish arms from passing vacuously: a value that merely
  // LOOKS falsy must still come back, so the arms above returned undefined because
  // of the discriminant check and not because of truthiness.
  // #1449 round 2 — the check is the BOOLEAN `recorded`, not its presence. The
  // reporter branches on `outcome.recorded === true`, so a truthy non-boolean is
  // the shape that turns "nothing to report" into "a row was recorded": a
  // `{ recorded: "yes" }` from a stub, or `1`/`[]` from a refactor, used to reach
  // the operator as a claim. Same direction as the guard's own validation of a
  // foreign ledger row (`validEntries`: `typeof passed === "boolean"`) — a value
  // a #912 reader acts on is type-checked, not truth-tested. This supersedes the
  // round-1 arm that asserted "any value under `recorded` is still an outcome":
  // presence was the wrong bar, and `""`/`"yes"` now read as nothing.
  assert(
    normaliseLedgerWriteReturn({ recorded: false }) !== undefined,
    "#1449 `{ recorded: false }` is still an outcome (the guard is the boolean's IDENTITY, not truthiness)",
  );
  for (const shape of [
    { recorded: "" },
    { recorded: "yes", landedAtPath: "/tmp/elsewhere/x.json" },
    { recorded: 1 },
    { recorded: [] },
  ]) {
    assert(
      normaliseLedgerWriteReturn(shape) === undefined,
      `#1449 a discriminant that is not exactly true/false is nothing to report (${JSON.stringify(shape)})`,
    );
  }
  assert(
    normaliseLedgerWriteReturn({ recorded: true }) !== undefined,
    "#1449 the boolean guard is not over-tight — a real { recorded: true } still passes",
  );
  assert(
    normaliseLedgerWriteReturn({ recorded: false, reason: "no branch" }) !== undefined,
    "#1449 the boolean guard is not over-tight — a real { recorded: false, reason } still passes",
  );
  // A property that throws on read is still a crash the helper may not cause, so
  // the discriminant is read through a property access wrapped in its own
  // swallow: a hostile getter yields "not a boolean", which is the same answer
  // the boolean guard already gives for anything unreadable — nothing to report.
  const hostile: Record<string, unknown> = {};
  let hostileThrew = false;
  let hostileOut: unknown = "NOT SET";
  Object.defineProperty(hostile, "recorded", {
    get: () => {
      throw new Error("hostile getter");
    },
    enumerable: true,
  });
  try {
    hostileOut = normaliseLedgerWriteReturn(hostile);
  } catch {
    hostileThrew = true;
  }
  assert(
    !hostileThrew && hostileOut === undefined,
    "#1449 an outcome whose `recorded` throws on read yields nothing to report, not a crash",
  );

  // The nullish cases are covered by the arms above, and the reasoning is in the
  // source comment: `typeof null === "object"` and `in` throws on a primitive,
  // so `value === null` is load-bearing (mutation-verified: deleting it turns the
  // null arm red). Deleting the discriminant check turns four arms red. Adding a
  // nullish guard alongside survived mutation on every shape this suite can
  // construct, so it is not written.

  // ---- (1b) the discriminant must be a BOOLEAN, not merely present ---------
  //
  // #1449 round 2. The reporter branches on `outcome.recorded === true`, so a
  // truthy non-boolean is the shape that turns "nothing was reported" into "a
  // row was recorded". A truthiness check would let all three below through.
  for (const shape of [
    { recorded: "yes", landedAtPath: "/tmp/elsewhere/x.json" },
    { recorded: 1 },
    { recorded: [] },
  ]) {
    assert(
      normaliseLedgerWriteReturn(shape) === undefined,
      `#1449 an outcome whose discriminant is not a boolean is nothing to report (${JSON.stringify(shape)})`,
    );
  }
  // …and the two real arms still pass, so the guard above is not over-tight.
  assert(
    normaliseLedgerWriteReturn({ recorded: true }) !== undefined,
    "#1449 a real { recorded: true } outcome still passes the boolean check",
  );
  assert(
    normaliseLedgerWriteReturn({ recorded: false, reason: "no branch" }) !== undefined,
    "#1449 a real { recorded: false, reason } outcome still passes the boolean check",
  );

  // ---- (2) + (3): the mock arms, each in its own process -----------------
  //
  // `lib/writer-shape-mock-arms.test.ts` mocks the writer module and then imports
  // `adversarial-ledger-capture.ts` FRESH — the only way the mock reaches the
  // writer the capture module calls, because bun rewrites a module's imports to
  // internal registry reads at load time and a module already loaded keeps the
  // bindings it resolved. "Fresh" therefore requires a fresh process, which is
  // why each arm is a child. (The first draft of these arms mocked in-process and
  // the mocked writer was never invoked — every arm passed vacuously; the mutation
  // checks below are what caught it.)
  // `import.meta.dir` is the ENTRY's directory under `bun test` (here:
  // `extension/`), not this file's — measured. `import.meta.dirname` is the
  // file's own, which is what the fixture path needs.
  const arms = path.join(import.meta.dirname, "lib", "writer-shape-mock-arms.test.ts");
  function runArm(arm: string): {
    threw: boolean;
    text: string;
    probe: string;
    reason?: string;
    rejected?: boolean;
    delivered?: boolean;
  } {
    // `arms` is already absolute (built from `import.meta.dirname`); a "./" prefix
    // would make it `.//Users/...`, which `bun test` treats as a filter and
    // matches nothing.
    const r = Bun.spawnSync([process.execPath, "test", arms], {
      encoding: "utf8",
      env: { ...process.env, PI_1449_ARM: arm },
    });
    const out = r.stdout.toString() + r.stderr.toString();
    const m = out.match(/\{"arm":.*\}/);
    if (!m)
      return {
        threw: true,
        text: `<child produced no verdict: ${out.slice(0, 160)}>`,
        probe: "?",
        rejected: true,
      };
    try {
      const p = JSON.parse(m[0]);
      return {
        threw: p.threw === true,
        text: String(p.text ?? ""),
        probe: String(p.probe ?? ""),
        // Only the rejectNonError arm populates these; every other arm leaves
        // them undefined, which the assertions below never read.
        reason: p.reason === undefined || p.reason === null ? undefined : String(p.reason),
        rejected: p.rejected === true,
        delivered: p.delivered === true,
      };
    } catch {
      return { threw: true, text: `<unparseable: ${m[0].slice(0, 160)}>`, probe: "?" };
    }
  }

  // ---- (2) the synchronous throw -----------------------------------------
  {
    const { threw, text, probe } = runArm("sync");
    assert(
      probe === "threw",
      `#1449 the mocked writer really does throw synchronously (else the sync arm proves nothing) — ${probe}`,
    );
    assert(!threw, "#1449 a writer that throws SYNCHRONOUSLY is contained at the call site");
    assert(
      !threw && text === "REVIEW DONE",
      "#1449 a faulting writer leaves the loop's result byte-identical (no note, no throw)",
    );
  }

  // ---- (3) the unchainable return -----------------------------------------
  // The CI shape: a bare `(r, p) => { push(...) }` returns `undefined`, and the
  // call site once did `ledgerWrite.then(...)` on it. `Promise.resolve` is the
  // layer under test — deleting it makes this arm red (mutation-verified).
  {
    const { threw, text, probe } = runArm("undefined");
    assert(
      probe === "did not throw",
      `#1449 the mocked writer is installed and returns no promise (${probe})`,
    );
    assert(!threw, "#1449 a writer returning undefined does not throw out of the loop's exit");
    assert(
      !threw && text === "REVIEW DONE",
      "#1449 a writer returning undefined appends no note to the result",
    );
  }

  // ---- the healthy path is not swallowed ----------------------------------
  // The tolerance must not be a catch-all that hides a real write: a writer ON
  // contract still reaches the DEFAULT reporter, whose note names the file.
  {
    const { threw, text, probe } = runArm("contract");
    assert(
      probe === "returned:promise",
      `#1449 the contract arm's writer really is installed and on contract (${probe})`,
    );
    assert(!threw, "#1449 a writer on contract does not throw out of the loop's exit");
    assert(
      text.includes("/tmp/elsewhere/x.json"),
      "#1449 a writer on contract still reaches the DEFAULT reporter — the note names the redirected file",
    );
  }

  // ---- the writer's catch survives a NON-Error rejection -------------------
  //
  // #1161's contract is that the returned promise NEVER rejects, and every
  // caller relies on it. The writer's catch read `(err as Error).message`, which
  // is erased at compile time and throws a TypeError INSIDE the catch when the
  // rejection is a string, a number, `null`, or `undefined` — turning "the ledger
  // had a problem" into a rejected promise, i.e. breaking the one guarantee the
  // function exists to make. The shape is reachable: the writer's body awaits
  // injected functions, and a hand-rolled executor can reject with anything.
  {
    const { writeAdversarialLedgerEntry } = await import("../src/adversarial-ledger.ts");
    // An Error rejection still carries its message, so the odd-shape arms below
    // are the catch handling strange values rather than a catch that reports
    // nothing at all.
    const errOutcome = await writeAdversarialLedgerEntry(
      { ok: true, loopOutcome: "approved", text: "x" } as never,
      {
        workCwd: dir,
        resolvedBranch: "feature/x",
        execFn: (() => Promise.reject(new Error("distinct-message"))) as never,
      },
    );
    assert(
      !errOutcome.recorded && errOutcome.reason.includes("distinct-message"),
      "#1449 an Error rejection still carries its message into the outcome — the odd-shape arms are not a blanket swallow",
    );
  }

  // ---- the writer's own promise rejects with a NON-Error (mock arm) --------
  //
  // The loop-level twin of the in-process arms below: the writer module is
  // `mock.module`d so its promise REJECTS with a bare string, and the loop's
  // exits must still return byte-identical results with no note and no throw.
  // #1449 round 2 — the arm existed in the child but no parent ran it, so it
  // verified nothing, and `rejected` was written by the child and never read
  // here.
  //
  // What it asserts is DELIVERY, not a reason string. The rejection carries a
  // bare string, so `normaliseLedgerWriteReturn` correctly answers `undefined`
  // (no `recorded` key) and the reporter's `reason` is legitimately undefined —
  // asserting a String()-ified reason here would assert a shape the writer never
  // produces. The String()-ification claim lives in the in-process non-Error
  // arms below, where the value really does become `recorded: false` + reason.
  // `delivered` is the load-bearing bit: before the round-2 fix the reporter sat
  // in a `.then` fulfilment handler, so a REJECTED write skipped it entirely and
  // the loop silently reported nothing about a ledger that had failed.
  {
    const { threw, text, probe, rejected, delivered } = runArm("rejectNonError");
    assert(
      probe === "returned:promise",
      `#1449 the rejecting writer really is installed (else the arm proves nothing) — ${probe}`,
    );
    assert(
      !threw,
      "#1449 a writer whose promise rejects with a non-Error does not throw out of the loop's exit",
    );
    assert(
      rejected === false,
      "#1449 the child's own guard saw no escaped rejection — the call site's tolerance held",
    );
    assert(
      delivered === true,
      "#1449 the reporter IS reached on a REJECTED write — a `.then` fulfilment handler alone skips it, so the loop reported nothing about a failed ledger",
    );
    assert(
      text === "REVIEW DONE",
      "#1449 a rejecting writer appends no note to the loop's result",
    );
  }

  // ---- the writer's catch survives a NON-Error rejection -------------------
  //
  // #1161's contract is that the returned promise NEVER rejects, and every caller
  // relies on it. The resolution helpers' catch read `(err as Error).message`,
  // which is erased at compile time and throws a TypeError INSIDE the catch when
  // the rejection is a string, a number, `null`, `undefined`, or a plain object —
  // turning "the ledger had a problem" into a rejected promise, i.e. breaking the
  // one guarantee the function exists to make. Reachable: the writer awaits
  // injected functions, and a hand-rolled executor can reject with anything.
  //
  // Each value is driven through the REAL writer in-process. `resolvedBranch` is
  // REQUIRED: without it the writer returns its "no branch" skip before reaching
  // the code under test and every arm is green for the wrong reason. The
  // assertion is on the VALUE appearing in the reason text — a
  // `(err as Error).message` read yields `undefined` there, so this distinguishes
  // the fix from the bug instead of merely checking that nothing threw.
  {
    const { writeAdversarialLedgerEntry } = await import("../src/adversarial-ledger.ts");
    for (const [label, value, needle] of [
      ["a string", "string-boom", "string-boom"],
      ["a number", 42, "42"],
      ["null", null, "null"],
      ["undefined", undefined, "undefined"],
      ["a plain object", { why: "no message" }, "[object Object]"],
    ] as Array<[string, unknown, string]>) {
      let settled: string | undefined;
      let rejected = false;
      try {
        const outcome = await writeAdversarialLedgerEntry(
          { ok: true, loopOutcome: "approved", text: "x" } as never,
          {
            workCwd: dir,
            resolvedBranch: "feature/x",
            execFn: async () => Promise.reject(value),
          } as never,
        );
        settled = JSON.stringify(outcome);
      } catch {
        rejected = true;
      }
      assert(
        !rejected &&
          (settled ?? "").includes('"recorded":false') &&
          (settled ?? "").includes(needle),
        `#1449 a non-Error rejection (${label}) resolves the writer AND reports its value, not 'undefined' (${settled})`,
      );
    }
    // An Error still carries its message, so the arms above are the catch handling
    // odd shapes rather than a catch that reports nothing at all.
    const errOutcome = await writeAdversarialLedgerEntry(
      { ok: true, loopOutcome: "approved", text: "x" } as never,
      {
        workCwd: dir,
        resolvedBranch: "feature/x",
        execFn: async () => Promise.reject(new Error("distinct-message")),
      } as never,
    );
    assert(
      !errOutcome.recorded && errOutcome.reason.includes("distinct-message"),
      "#1449 an Error rejection still carries its message — the odd-shape arms are not a blanket swallow",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
