#!/usr/bin/env bun
/**
 * #1360 lens 4/6, arms 3-4 — what the REAL loop does with the marker.
 *
 * Arms 1-2 (arms/tool-params.ts) stubbed the loop to read the tool's params.
 * These arms need the opposite: the loop itself, driven with the marker present
 * and absent, counted at the capture seam and observed through the ledger rows
 * the real writer leaves on disk. A stubbed loop would make every assertion
 * here read "it completed" off a mock.
 */

import { mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { LedgerEntry } from "../../../src/review-ledger.ts";
import type { LedgerBinding } from "../../../src/adversarial-ledger-binding.ts";
import type { BindingState } from "../../../src/adversarial-ledger-capture.ts";
import { BINDING_REFUSAL_PREFIXES, ledgerFile, setupRepo } from "../adversarial-ledger-harness.ts";
import { countedCapture } from "./capture-counter.ts";

/** A detail is a binding refusal iff it opens with one of the prefixes the
 * module itself exports — the same array the merge guard's renderer reads, so
 * an assertion here cannot drift from what the guard will honour. */
function startsWithBindingPrefix(detail: unknown): boolean {
  return (
    typeof detail === "string" &&
    BINDING_REFUSAL_PREFIXES.some((prefix) => detail.startsWith(`${prefix}: `))
  );
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The capture is counted at the module boundary the LOOP resolves, so the count
// is the loop's and not the test's. The wrapper lives in lib/ precisely because
// a mock factory cannot resolve its own module without aliasing it — spreading
// the live module here makes `captureRound` delegate to itself (verified).
const captureCounter = countedCapture();
const captureSurface = await import("../../../src/adversarial-ledger-capture.ts");
// The real `captureBinding` lives in a DIFFERENT module from the one being
// mocked, so the counter wrapper below cannot alias it — but the module this
// factory replaces is aliased, which is why the wrapper's body is written out
// in `capture-counter.ts` rather than delegated through `captureSurface`.
mock.module(new URL("../../../src/adversarial-ledger-capture.ts", import.meta.url).href, () => ({
  ...captureSurface,
  captureRound: captureCounter.captureRound,
}));

// Spawn is stubbed — each arm needs one reviewer reply, and nothing here is
// about the child process.
mock.module(new URL("../../../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1360-prov",
  spawnSpecialist: async (spec: { role: string }) => ({
    role: spec.role,
    ok: true,
    text: "VERDICT: APPROVED\n\nlooks good",
    toolUses: [],
    ms: 1,
    exitCode: 0,
  }),
}));

const deckSurface = await import("../../../src/dispatch-deck.ts");
mock.module(new URL("../../../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...deckSurface,
  startEntry: () => {},
  updateEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
  clearBatchEntry: () => {},
}));
const registrySurface = await import("../../../src/async-jobs-registry.ts");
mock.module(new URL("../../../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...registrySurface,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));

// The writer is fire-and-forget (a ledger problem must never fail a review), so
// a row lands on a later tick. `appendLedgerEntry` is the seam that lands it,
// and the promise it is handed is the writer's own — awaited here, it is the
// deterministic wait. Registered BEFORE `adversarial.ts` is imported, because
// `adversarial-ledger.ts` binds this import at its own module load: a mock
// registered after that load is invisible to the writer.
//
// The real `appendLedgerEntry` is captured here (in `lib/`, outside the module
// registry) and the wrapper delegates to THAT. The factory's `...ledgerSurface`
// spread of name→value pairs is harmless, but a wrapper that resolved
// `appendLedgerEntry` through the live module would call its own replacement —
// the same aliasing trap `capture-counter.ts` documents, and it presents as
// "Maximum call stack size exceeded" in the writer's catch, not as a recursion
// error at the call site. The ROW on disk stays the assertion target: a mocked
// writer that recorded calls but wrote nothing is exactly the failure this test
// exists to make visible.
const ledgerSurface = await import("../../../src/review-ledger.ts");
const { appendLedgerEntry: realAppendLedgerEntry, readLedgerFile } = ledgerSurface;
const pendingWrites: Array<Promise<unknown>> = [];
mock.module(new URL("../../../src/review-ledger.ts", import.meta.url).href, () => ({
  ...ledgerSurface,
  appendLedgerEntry: (entry: unknown, execFn?: unknown, c?: unknown) => {
    const p = realAppendLedgerEntry(entry as never, execFn as never, c as never);
    pendingWrites.push(p);
    return p;
  },
}));

const { runAdversarialLoop } = await import("../../../src/adversarial.ts");
const { captureRound } = captureSurface;

async function drainLedgerWrites(): Promise<void> {
  const batch = pendingWrites.splice(0, pendingWrites.length);
  await Promise.allSettled(batch);
}

// The repo fixture is the shared harness's: a bare origin with `main` pushed
// and `set-head` run, which is what makes `identityBase` resolve a mainline. A
// repo with no origin resolves none, and the writer then skips the row entirely
// — which reads as "the writer wrote nothing" and is the wrong failure to
// debug. Reusing the harness also keeps one fixture shape across every #1360
// test.
const fixture = setupRepo();
const repo = fixture.dir;
// #1069 / test-ledger-isolation.ts: a test that drives a ledger writer must
// self-isolate. The harness repo is a temp clone so the writer's own resolution
// already lands inside it; the explicit override names the single file these
// arms read, so the assertion target is not re-derived from git each time.
const LEDGER_FILE = ledgerFile(repo);
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = LEDGER_FILE;

/** The rows on disk, after every in-flight write has settled.
 *
 * Read through the ledger's OWN reader (`readLedgerFile`, captured before the
 * module mock so the arms read exactly what the guard reads): it runs
 * `validEntries` on the same bytes, so a malformed row is dropped and traced
 * there instead of being `as LedgerEntry`-asserted into existence here, and a
 * rename of a writer's field cannot hide from tsc under an unchecked cast.
 * `at` is a finite number by the time these rows arrive, so the chronological
 * sort below cannot NaN its way into an arbitrary order. */
async function readRows(): Promise<LedgerEntry[]> {
  await drainLedgerWrites();
  if (!existsSync(LEDGER_FILE)) return [];
  // Chronological, explicitly: the file's own append order is what the arms
  // index into, so an arm that expected three rows and got two fails loudly
  // rather than reading some other round's row.
  return readLedgerFile(LEDGER_FILE)
    .entries.filter((e) => e.kind === "adversarial")
    .sort((a, b) => a.at - b.at);
}

/** The rows carrying `nonce` — the `orchestratorJobId` an arm passed to
 * `runAdversarialLoop`, which the writer stamps onto its own row as
 * `LedgerEntry.rowNonce` (#1557; see that field's jsdoc for why identity, not
 * a timestamp floor, is what identifies a fire-and-forget writer's row).
 *
 * A miss reports ABSENCE: at the deadline the poll returns `[]`, never "the
 * latest row", so an arm that wrote no row fails its own assertion instead of
 * judging another arm's. */
async function waitForRowsWithNonce(nonce: string): Promise<LedgerEntry[]> {
  const deadline = Date.now() + 20_000;
  let readFailure = "";
  for (;;) {
    // A transient read failure (EMFILE/EAGAIN on the shared fixture, a torn
    // read) must not abort the whole arms script: all arms share one
    // try/finally, so a throw here would skip every remaining arm's
    // assertions and the run would die with an uncaught crash instead of
    // reaching its named failures and its `exit N` line. Record the reason,
    // retry on the next tick, and surface it only at the deadline — then an
    // empty result says what it might be rather than silently reading as
    // absence.
    let rows: LedgerEntry[] = [];
    try {
      rows = (await readRows()).filter((r) => r.rowNonce === nonce);
      readFailure = "";
    } catch (err) {
      readFailure = err instanceof Error ? err.message : String(err);
    }
    if (rows.length > 0) return rows;
    if (Date.now() >= deadline) {
      if (readFailure) {
        console.error(
          `ledger: the last read of ${LEDGER_FILE} failed (${readFailure}) — this empty result may be that read failure, not absence`,
        );
      }
      return rows;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const priorCwd = process.cwd();
process.chdir(repo);
try {
  // ── 3. the /work driver path carries NO marker, so it runs NO capture
  captureCounter.reset();
  const driver = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "driver",
      workCwd: repo,
      branch: "feature/x",
      reportOnly: true,
      reportVerdict: "routed",
      getDiff: async () => "diff --git a/f b/f\n+x",
    },
    new AbortController().signal,
    "job-driver",
  );
  assert(
    driver.ok === true,
    "driver path: the loop completed (so the counts below mean something)",
  );
  assert(
    captureCounter.calls() === 0,
    "driver path: captureRound is never called (no wasted git subprocess)",
  );
  // #1557 — this arm's rows, by its own nonce (see `waitForRowsWithNonce`).
  const driverRows = await waitForRowsWithNonce("job-driver");
  assert(
    driverRows.length === 1 && driverRows[0]?.passed === true,
    `driver path: the ledger write still runs exactly once (for this arm's nonce) and stays PASSING (got ${JSON.stringify(driverRows)})`,
  );
  assert(
    driverRows[0]?.reviewedBase === undefined && driverRows[0]?.reviewedHead === undefined,
    "driver path: its row keeps the pre-#1360 shape — no binding fields it never computed",
  );

  // The same call WITH the marker does capture — so the gate above is
  // provenance-driven, not "the driver happens to skip a round". No `diff`
  // string: a pasted diff is the #1161 `callerSuppliedDiff` shape, which takes
  // the row non-passing for its own reason and would let this assertion pass on
  // the wrong cause.
  //
  // An honest tool-path round is a PASS: the capture is taken immediately before
  // the reviewer dispatch and the write re-reads the same tree, so range, HEAD
  // and tree identity all match. Asserting refusal here would be asserting that
  // the feature never works — the refusal arms belong to
  // `test-adversarial-ledger-range.ts`, and arm 4b below brings one through
  // this same end-to-end path to prove the marker is what makes the gate live.
  captureCounter.reset();
  const tool = await runAdversarialLoop(
    {
      context: "tool-shaped",
      workCwd: repo,
      branch: "feature/x",
      base: "main",
      head: "HEAD",
      reportOnly: true,
      reportVerdict: "terminal",
      toolPath: "adversarial-loop-tool",
    },
    new AbortController().signal,
    "job-tool",
  );
  assert(tool.ok === true, "tool path: the loop completed");
  assert(
    captureCounter.calls() === 1,
    `tool path: the round captures exactly once (got ${captureCounter.calls()})`,
  );
  // #1557 — this arm's row, by its own nonce (see `waitForRowsWithNonce`). The
  // old file-wide count (`waitForRows(2)` then `toolRows[1]`) was a positional
  // read over rows whose survival is a race, not a contract.
  const toolRows = await waitForRowsWithNonce("job-tool");
  assert(
    toolRows.length === 1,
    `tool path: exactly one row carries this arm's nonce (got ${JSON.stringify(toolRows.map((r) => r.passed))})`,
  );
  const toolRow = toolRows[0];
  assert(
    toolRow?.passed === true,
    `tool path: an honest round whose capture matches the write PASSES (got passed=${JSON.stringify(toolRow?.passed)}, detail=${JSON.stringify(toolRow?.detail)})`,
  );
  // The rows are where the two paths visibly differ: the tool row carries the
  // range it bound, the driver row carries none. That is the whole point of
  // #1360, and it is observable without reaching into any mock.
  assert(
    typeof toolRow?.reviewedBase === "string" &&
      /^[0-9a-f]{40}$/.test(String(toolRow.reviewedBase)),
    `tool path: its row carries the verified base SHA (got ${JSON.stringify(toolRow?.reviewedBase)})`,
  );
  assert(
    typeof toolRow?.reviewedHead === "string" &&
      /^[0-9a-f]{40}$/.test(String(toolRow.reviewedHead)),
    `tool path: its row carries the verified head SHA (got ${JSON.stringify(toolRow?.reviewedHead)})`,
  );

  // ── 4b. the marker is what makes the gate live: the SAME loop call, with the
  // per-round capture sabotaged to a stale one, must be refused. This is the
  // end-to-end counterpart to the writer-level arms in
  // `test-adversarial-ledger-range.ts` — it proves the refusal travels the
  // loop's own path (capture → state → writer → row), not just the writer's.

  captureCounter.poison({
    reviewedBase: fixture.mergeBase,
    reviewedHead: "f".repeat(40),
    reviewedTreePatchId: "b".repeat(40),
    reviewedHeadRef: "HEAD",
    headAtCapture: "f".repeat(40),
  });
  captureCounter.reset();
  // Two independent defects made this arm flake; the nonce selector closes
  // both, and the sentinel values stay because they keep the REFUSAL itself
  // stale by construction.
  //
  // (1) The poisoned SHAs below are sentinels rather than `fixture.parent`.
  // A fixture SHA is only stale relative to whatever HEAD happens to be when
  // the writer resolves it, so it is not stale *by construction*; a 40-char hex
  // string no commit object can ever have cannot match the tip. Measured alone
  // this cut the flake from ~32% to ~3% — a large cut, which is exactly why the
  // remaining 3% needed a second cause rather than a better value.
  //
  // (2) The straggler: the writer is fire-and-forget and a row's `at` is its
  // OWN creation stamp, so an arm-4 write still in flight here stamped itself
  // after the floor the old reader sampled and was read as THIS arm's row —
  // the honest `passed=true, detail="approved"` row reported as the refusal. A
  // 300ms delay injected into `appendLedgerEntry` drove that residual to 0/3,
  // which proved the floor unsound by construction, not merely tight. #1557
  // replaced it with identity (see `waitForRowsWithNonce`).
  // The range diff is supplied through the loop's own injectable seam (the 4th
  // argument, the one #859 added) rather than as a `diff` string: a pasted diff
  // sets `callerSuppliedDiff`, and a #1161 caller-supplied row is already
  // non-passing for its own reason — it would pass this assertion without the
  // binding ever being consulted. A real range read keeps the refusal's cause
  // single and provable. It is supplied because the harness's two commits both
  // touch files the writer's own patch id ignores, so the real read comes back
  // empty and the round would exit through `noDiffResult` before its capture.
  const stale = await runAdversarialLoop(
    {
      context: "stale-capture",
      workCwd: repo,
      branch: "feature/x",
      base: "main",
      head: "HEAD",
      reportOnly: true,
      reportVerdict: "terminal",
      toolPath: "adversarial-loop-tool",
    },
    new AbortController().signal,
    "job-stale",
    async () => ({ ok: true as const, diff: "diff --git a/a.txt b/a.txt\n+a\n" }),
  );
  assert(stale.ok === true, "stale capture: the loop still completes (a refusal is not a crash)");
  // This arm's row, by its own nonce (see `waitForRowsWithNonce`): an arm that
  // wrote no row reads as absence (`[]` at the deadline), so the next two
  // assertions fail loudly instead of judging another arm's passing row.
  const staleRows = await waitForRowsWithNonce("job-stale");
  assert(
    staleRows.length <= 1,
    `stale capture: at most one row carries this arm's nonce (got ${staleRows.length})`,
  );
  const staleRow = staleRows[0];
  captureCounter.unpoison();
  assert(
    staleRow !== undefined,
    "stale capture: this arm's row was written (an arm that wrote no row proves nothing)",
  );
  assert(
    staleRow?.passed === false,
    `stale capture: the row is NON-PASSING (got passed=${JSON.stringify(staleRow?.passed)}, detail=${JSON.stringify(staleRow?.detail)})`,
  );
  assert(
    startsWithBindingPrefix(staleRow?.detail),
    `stale capture: the detail is a binding refusal the guard recognises (got ${JSON.stringify(staleRow?.detail)})`,
  );

  // ── 4. captureRound's exec seam is threaded to EVERY git read it makes — the
  // identity base, the range refs, the merge-base, the HEAD and the patch id —
  // not just the first helper that happens to take one.
  const seen: string[] = [];
  // The real capture type, not a hand-declared `{ captured?: { binding?:
  // unknown } }` erasure: the assertions below read the binding's fields, and
  // this file is in the `tsconfig.smoke-tests.json` ratchet — the erasure was
  // what kept the file from compiling under the project's own options.
  const state: BindingState = {};
  await captureRound(state, repo, "main", "HEAD", async (cmd, o) => {
    seen.push(`${cmd} ${(o?.argv ?? []).join(" ")}`.trim());
    return { stdout: `${"a".repeat(40)}\n` };
  });
  // The arms mock `captureRound` (arms 3-4 count those calls), so the wrapper
  // installed by the mock is what `captureRound` resolves to here. The counter
  // wrapper writes the state identically to production — but assert on what IT
  // produced rather than trusting the delegation.
  const binding: Partial<LedgerBinding> = state.captured?.binding ?? {};
  const gitReads = seen.filter((c) => c === "git" || c.startsWith("git "));
  assert(
    gitReads.length >= 4,
    `captureRound threads the injected executor to every git read it makes (${gitReads.length} seen)`,
  );
  assert(
    seen.every((c) => c === "git" || c.startsWith("git ")),
    "captureRound reaches the injected executor for every exec — no read slips past it to the real one",
  );
  assert(
    state.captured?.headRef === "HEAD",
    "captureRound records the head ref the round reviewed alongside the capture",
  );
  // The pairing is the #1360 round-3 fix: the binding and the head ref it was
  // taken for land in ONE object, so an interrupted round cannot leave the
  // writer pairing one round's capture with another round's ref.
  assert(
    state.captured !== undefined &&
      Object.keys(state.captured).sort().join(",") === "binding,headRef",
    `captureRound stores the binding and its head ref as ONE paired value (got ${JSON.stringify(Object.keys(state.captured ?? {}))})`,
  );
  // The point of threading the executor is that the CAPTURE IS REAL: every git
  // read went through the seam, so what landed in the state is what the seam
  // answered. A capture that silently fell back to the real executor would
  // still leave the counter at 1 and the state non-empty.
  assert(
    typeof binding.reviewedTreePatchId === "string" &&
      /^[0-9a-f]{40}$/.test(binding.reviewedTreePatchId),
    `captureRound populated the working-tree identity from the threaded executor (got ${JSON.stringify(binding.reviewedTreePatchId)})`,
  );
  assert(
    typeof binding.headAtCapture === "string" && /^[0-9a-f]{40}$/.test(binding.headAtCapture),
    `captureRound populated workCwd's HEAD from the threaded executor (got ${JSON.stringify(binding.headAtCapture)})`,
  );
  assert(
    binding.reviewedHeadRef === "HEAD",
    `captureRound records the ref the round reviewed, as the caller named it (got ${JSON.stringify(binding.reviewedHeadRef)})`,
  );
} finally {
  process.chdir(priorCwd);
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
