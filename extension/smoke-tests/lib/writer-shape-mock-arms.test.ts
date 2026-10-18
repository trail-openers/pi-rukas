/**
 * #1449 — child-process arms for `test-adversarial-ledger-writer-shapes.ts`.
 *
 * Run as `bun test ./lib/ledger-writer-mock-arms.test.ts` with `PI_1449_ARM`
 * naming the arm. Each arm `mock.module`s the ledger writer and then imports
 * `adversarial-ledger-capture.ts` FRESH, which is the only way the mock reaches
 * the writer the capture module calls: bun rewrites a module's imports to
 * internal registry reads at load time, so a module already loaded keeps the
 * bindings it resolved, and a mock installed afterwards binds nothing. Running
 * each arm in its own process is what makes the fresh import genuinely fresh.
 *
 * Prints one JSON line so the parent can assert on it:
 *   "undefined" — the writer returns no promise (the `Promise.resolve` layer)
 *   "contract"  — the writer is ON contract and reports a redirect, so the
 *                 DEFAULT reporter's note must reach the held result
 *   "sync"      — the writer throws SYNCHRONOUSLY (the call-site `try`/`catch`)
 *
 * Lives in `lib/` so the suite glob does not pick it up as a test of its own.
 */
import { mock } from "bun:test";
import type { AdversarialLedgerOutcome } from "../../src/adversarial-ledger.ts";

const ARM = process.env.PI_1449_ARM || "undefined";

type Writer = (r: unknown, p: unknown) => unknown;
const writers: Record<string, Writer> = {
  // THE CI shape: what `mock.module` gives a bare `(r, p) => { push(...) }`.
  undefined: () => undefined,
  contract: () => Promise.resolve({ recorded: true, landedAtPath: "/tmp/elsewhere/x.json" }),
  sync: () => {
    throw new Error("writer exploded before returning a promise");
  },
  // The outer catch's shape: the writer's own promise REJECTS with a non-Error.
  // Built OUTSIDE the mock function and returned by reference, so the mock itself
  // never throws — `mock.module` treats a throwing mock factory as a mock failure
  // ("Expected a function") and falls back to the ORIGINAL writer, which would
  // leave this arm green while exercising nothing.
  //
  // The REJECTING promise is a fresh one per call, and it is IMMEDIATELY caught.
  // Both halves matter. Fresh, because a process-wide `Promise<never>` handed out
  // by reference types awkwardly against the `Writer` record and is a promise a
  // caller might await twice. Caught, because bun treats an unhandled rejection
  // as a fatal error and reports it on the child's stderr — and the rejecting
  // promise is what `makeLedgerWrite` chains, so a bare `Promise.reject(…)` left
  // the chain's own `.catch` attached too late: the arm's JSON line printed, the
  // reporter callback never ran, and `reason` stayed undefined. The sibling
  // promise is swallowed where it is created; the one the call site tolerates is
  // swallowed by the call site (`Promise.resolve(ledgerWrite).then(…).catch(…)`).
  rejectNonError: () => {
    const rejecting = Promise.reject("string-boom");
    rejecting.catch(() => undefined);
    return rejecting;
  },
};

// The rejecting arm builds a fresh promise per call (see the note on
// `rejectNonError` above): a single process-wide `Promise<never>` handed out by
// reference is typed awkwardly against the `Writer` record and is a promise a
// caller could await twice, neither of which the mock needs.

mock.module("../../src/adversarial-ledger.ts", () => ({
  writeAdversarialLedgerEntry: writers[ARM],
}));

const { makeLedgerWrite } = await import("../../src/adversarial-ledger-capture.ts");

// The anti-vacuity probe: with the mock in force, the writer the capture module
// is about to call must do what this arm claims. Without it a mock that failed
// to bind would make the loop arm green for the wrong reason — measured, in fact,
// which is why the probe is not optional.
const probeMod = (await import("../../src/adversarial-ledger.ts")) as {
  writeAdversarialLedgerEntry: Writer;
};
let probe: string;
try {
  const returned = probeMod.writeAdversarialLedgerEntry({ ok: true, text: "x" }, {});
  probe =
    ARM === "contract" || ARM === "rejectNonError"
      ? returned instanceof Promise
        ? "returned:promise"
        : "returned:non-promise"
      : "did not throw";
} catch {
  probe = "threw";
}

let threw = false;
let text = "REVIEW DONE";
let reason: string | undefined;
let rejected = false;
// Did the reporter run at all? Distinct from `reason`: the rejection carries a
// bare string, so the normalised outcome is `undefined` and `reason` is
// legitimately undefined even when delivery worked. Without this the parent
// could not tell "the reporter never ran" (the bug) from "the reporter ran and
// correctly had nothing to say" (the contract) — and asserted the former while
// the latter was true.
let delivered = false;
try {
  const write = makeLedgerWrite({
    state: { captured: { binding: {}, headRef: undefined } },
    workCwd: "/tmp",
    branch: "feature/x",
    resolvedBranch: "feature/x",
    decorate: (raw) => raw,
    // The loop's own threader shape (adversarial-ledger-note.ts
    // `withLedgerNote`): pure, appends a constant. NO `onLedgerOutcome`, so the
    // DEFAULT reporter (the misdirection note) is the one under test — except in
    // the outer-catch arm, which watches the raw outcome because what it asserts
    // is that a string rejection arrives as a String()-ified reason, not a crash.
    note: (raw) => {
      text = raw.text;
      return raw;
    },
    // The outer-catch arm watches the raw outcome rather than the rendered note,
    // because what it asserts is that a string rejection arrives as a
    // String()-ified reason and not as a crash. Assigned through the optional
    // property directly rather than a conditional spread, which the type of
    // `makeLedgerWrite`'s options does not accept cleanly.
    onLedgerOutcome:
      ARM === "rejectNonError"
        ? (o: AdversarialLedgerOutcome | undefined) => {
            delivered = true;
            // `reason` only exists on the `recorded: false` arm, so it is read
            // through the discriminant rather than by widening the parameter
            // type to a shape the writer never produces (which is what made
            // TS2322 fire: a `{ reason?: string }` parameter is not a valid
            // substitute for the declared callback parameter).
            reason = o && o.recorded === false ? o.reason : undefined;
          }
        : undefined,
  });
  write({ ok: true, loopOutcome: "approved", text: "REVIEW DONE" } as never);
} catch {
  threw = true;
  rejected = true;
}
// The delivery is fire-and-forget; give it a tick before judging the text.
await new Promise((r) => setTimeout(r, 60));
// A rejection that escaped the call site's tolerance shows up here: the callback
// above never runs, so `delivered` stays false even though the writer rejected.
// #1449 round 2 — `rejected` is also set on the throw path just above, so the
// parent distinguishes "the loop threw" from "the report never arrived"; both
// are the failure this arm forbids.
if (ARM === "rejectNonError" && !delivered) rejected = true;
process.stdout.write(JSON.stringify({ arm: ARM, threw, text, probe, reason, rejected, delivered }));
