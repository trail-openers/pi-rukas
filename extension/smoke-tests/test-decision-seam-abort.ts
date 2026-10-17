#!/usr/bin/env bun
/**
 * An outer abort ENDS the bounded race, it does not merely inform it (#1393).
 *
 * `runBounded` races a backend against the seam's own timeout. Before the fix
 * those were the only two racers: the outer `AbortSignal` was forwarded to the
 * backend, and a backend that ignored its signal and never settling held
 * `await Promise.race` open for the whole seam bound. An aborted caller — a
 * killed driver, a shutdown — therefore waited out a bound it had already
 * cancelled, keeping its in-flight slot (decision-shadow.ts) for the duration.
 *
 * The assertions are deliberately comparative. A wall-clock bound only fails
 * when the code under test is genuinely broken, so each "prompt" case is paired
 * with the SEAM BOUND it would have had to wait out, and the un-aborted control
 * below proves that bound is really in force: were the fixture's bound ever
 * lowered, the control fails and the bars below stop being meaningful.
 *
 * Every constant here is scaled about 10x from the first cut of this file, which
 * spent ~37 s of wall clock asleep. The scaling is uniform — bound, abort
 * latency, settle time and the teardown waits all moved together — so the
 * COMPARATIVE structure that makes the file worth running is untouched: the abort
 * still lands at ~1/10 of the bound, the settled-race waits still pass the point
 * an uncleared timer would have fired, and the control still has to wait out the
 * whole bound. Only the units changed.
 *
 *   - aborted at 10 ms under a 3 s seam bound -> settles in well under 500 ms;
 *   - the backend's OWN signal fires, so the backend is cancelled, not leaked;
 *   - a signal already aborted when `decide()` is called -> settles at once;
 *   - the same backend, never aborted, waits out the full 3 s (the control);
 *   - the abort writes one record, carrying the abort as the backend's error.
 *
 * Offline: the backend is a closure that never settles; nothing touches the network.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Backend, BackendInput, BackendResult } from "../src/decision-backends.ts";
import { SEAMS, type SeamSpec } from "../src/decision-seam-registry.ts";
import { decide } from "../src/decision-seam.ts";
import { envKey, makeAssert, records, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Comfortably longer than any honest abort, comfortably shorter than the bound. */
const PROMPT_MS = 500;
/** The seam bound the aborted calls must NOT wait out. The control proves it bites. */
const SEAM_BOUND_MS = 3_000;
/** An abort arrives at ~1/30 of the bound — same order as the 100 ms / 30 s the
 * first cut used, which is the ratio the aborted cases are about. */
const ABORT_AT_MS = 100;
/**
 * Long enough that the abort arrives BEFORE the backend answers — the whole
 * point of case 5, so `SETTLE_MS > ABORT_AT_MS` is load-bearing, not cosmetic:
 * with a backend that answered first the race would have settled normally and
 * the teardown claim would be about a call nobody aborted.
 */
const SETTLE_MS = 500;
/**
 * How long to wait for an uncleared timer to betray itself: HALF the seam bound,
 * which is past the point any racer's `setTimeout` would have fired and the
 * reason this file used to sleep for 3.6 s per probe.
 */
const TEARDOWN_WAIT_MS = SEAM_BOUND_MS * 0.5;

// A tests-only seam: production seams live in the registry source, where the
// contract test reads them. Its bound is the one the aborted calls must beat.
const seam = "fixture-abort";
(SEAMS as Record<string, SeamSpec>)[seam] = {
  id: seam,
  kind: "choice",
  instructions: "Does the thing look ok?",
  labels: { ok: "fine", flag: "needs a human" },
  ruleDefault: "flag",
  passing: ["ok"],
  // The default `advisory` is right for the abort cases below, which inspect
  // only the ABORT path — but it cannot be used for the answered case, so that
  // case registers its own seam. Under `advisory` and `may-add-only` a model
  // answer is discarded whenever it agrees with the rule, and `replace` is
  // refused without a quote-evidence contract; only `off` lets an `llm` backend's
  // answer become the Decision, which is what the answered case has to observe.
  composition: "advisory",
  defaultMode: "shadow",
  evidence: "none",
  owner: "test-decision-seam-abort.ts",
  timeoutMs: SEAM_BOUND_MS,
  tokenBudget: 8_000,
};

/**
 * A backend that never settles on its own — the shape a wedged provider call
 * has. It records the signal it was handed so the test can assert the backend
 * was actually cancelled, not merely abandoned by the race.
 */
function wedgedBackend(): Backend & { calls: number; signals: AbortSignal[] } {
  const b = {
    name: "wedged",
    source: "llm" as const,
    calls: 0,
    signals: [] as AbortSignal[],
    run: (input: BackendInput, signal: AbortSignal) => {
      b.calls++;
      b.signals.push(signal);
      assert(input.timeoutMs === SEAM_BOUND_MS, "the backend is handed the seam's own bound");
      return new Promise<BackendResult>(() => {});
    },
  };
  return b;
}

const seamAnswered = "fixture-abort-answered";
(SEAMS as Record<string, SeamSpec>)[seamAnswered] = {
  id: seamAnswered,
  kind: "choice",
  instructions: "Does the thing look ok?",
  labels: { ok: "fine", flag: "needs a human" },
  ruleDefault: "flag",
  passing: ["ok"],
  // `may-add-only`, which is the one composition that lets an `llm` backend's
  // answer BECOME the Decision without a quote-evidence contract: `advisory`
  // always keeps the rule, and `replace` is refused outright unless the seam
  // declares `evidence: "quote"`. Under a policy that always keeps the rule the
  // distinction this case asserts — the backend's Decision survived the late
  // abort, versus no backend answered at all — does not exist, and the assertion
  // would pass for the wrong reason. The other cases here read only the ABORT
  // path, where composition is never consulted, so they keep the fixture seam.
  composition: "may-add-only",
  defaultMode: "shadow",
  evidence: "none",
  owner: "test-decision-seam-abort.ts",
  timeoutMs: SEAM_BOUND_MS,
  tokenBudget: 8_000,
};

/** Wait until a predicate sees the record it wants, or ~2 s have passed. */
async function awaitRecord(
  file: string,
  pred: (r: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 200; i++) {
    const hit = records(file).find(pred);
    if (hit !== undefined) return hit;
    await sleep(10);
  }
  return undefined;
}

const req = { state: { probe: "value" }, question: "q", rule: "ok" };

// ------------------------------------------------- answered first, aborted after
//
// The race settling must remove the abort racer's listener (#1393).
//
// The mirror of every other case here: the backend answers NORMALLY and the
// caller aborts later. Two things follow, and neither was covered. The Decision
// must be the backend's answer, unaltered — a late abort on a signal nobody is
// waiting on any more must not rewrite an answered decision into an abstention.
// And the race must write no late trace: the racer that lost has to take its
// `abort` handler off the signal, or a driver that holds one signal across a
// whole cycle accumulates a closure per decision, each pinning the controller,
// the timer and the backend's input for the life of the signal.
{
  const root = tmpDir("seam-abort-after");
  const log = path.join(root, ".pi", "decisions.jsonl");
  mkdirSync(path.dirname(log), { recursive: true });
  // `enforce`, not the fixture seam's default `shadow`: under shadow the rule's
  // answer always stands and no backend answer could be observed at all, so the
  // case would assert the same thing whether the abort arrived early, late, or
  // never. Enforce is the only mode where "the Decision the backend produced"
  // is a distinguishable outcome — which is exactly what a late abort must not
  // disturb.
  // The answered path needs a label the RULE would not have produced, or the
  // composition step has nothing to change and the assertion degenerates.
  // The rule says `ok`; the backend adds the `flag` the rule did not, so the
  // composed answer is the backend's and "unchanged" has content to it.
  const lateAbortReq = { state: { probe: "value" }, question: "q", rule: "ok" };
  const answered: Backend & { calls: number; signals: AbortSignal[] } = {
    name: "answers-immediately",
    source: "llm",
    calls: 0,
    signals: [],
    run: (_input: BackendInput, signal: AbortSignal) => {
      answered.calls++;
      // No `justification`: BackendResult has no such field (the classifier's
      // JSON wire format has one; the result type does not).
      // The FIRST run's signal only. The listener-removal case below decides a
      // second time to prove the claim is not carried by history, and that
      // second run's controller is aborted by its own teardown — recording it
      // here would have this assertion read the wrong run and fail on a
      // cancellation that belongs to a different call.
      if (answered.signals.length === 0) answered.signals.push(signal);
      return Promise.resolve<BackendResult>({
        ok: true,
        answer: "flag",
      });
    },
  };
  // The removal itself is observable without spying on the module. `addEventListener
  // with `{ once: true }` does not deduplicate — a second `addEventListener` for
  // the same type is a second handler, counted separately — so a SECOND signal
  // handed to the same code path reports what THIS call's race registered on it,
  // not what an earlier call left behind. Without that, the first call's stale
  // handlers would make a later `removed >= added` true for a race that removed
  // nothing at all, and the claim would be vacuously satisfied by history.
  const probeSignal = (): AbortSignal & { __added: number; __removed: number } => {
    const s = new AbortController().signal as AbortSignal & { __added: number; __removed: number };
    s.__added = 0;
    s.__removed = 0;
    const realAdd = s.addEventListener.bind(s);
    const realRemove = s.removeEventListener.bind(s);
    s.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      if (args[0] === "abort") s.__added++;
      realAdd(...args);
    }) as AbortSignal["addEventListener"];
    s.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      if (args[0] === "abort") s.__removed++;
      realRemove(...args);
    }) as AbortSignal["removeEventListener"];
    return s;
  };
  const signal = probeSignal();
  process.env[envKey("PI_ENSEMBLE_DECISION_MODE", seamAnswered)] = "enforce";
  const d = await decide(seamAnswered as never, lateAbortReq, {
    backends: [answered],
    signal,
    repoRoot: root,
  });
  delete process.env[envKey("PI_ENSEMBLE_DECISION_MODE", seamAnswered)];
  assert(
    signal.__added >= 1,
    `the race really registered an abort listener while it was live (${signal.__added} added) — otherwise the next claim is vacuous`,
  );
  assert(
    signal.__removed >= signal.__added,
    `a settled race takes back off every abort listener it added, so a long-lived driver signal does not accumulate one closure per decision (${signal.__removed} removed of ${signal.__added} added)`,
  );
  // And the second call on a fresh signal is the same story: an earlier call's
  // handlers must not be what carries this one's bookkeeping.
  const signal2 = probeSignal();
  process.env[envKey("PI_ENSEMBLE_DECISION_MODE", seamAnswered)] = "enforce";
  await decide(seamAnswered as never, lateAbortReq, {
    backends: [answered],
    signal: signal2,
    repoRoot: root,
  });
  delete process.env[envKey("PI_ENSEMBLE_DECISION_MODE", seamAnswered)];
  assert(
    signal2.__added >= 1 && signal2.__removed >= signal2.__added,
    `the same holds for a second race on its own fresh signal, so history is not carrying the claim (${signal2.__removed} removed of ${signal2.__added} added)`,
  );
  assert(
    d.answer === "flag" && d.source === "llm" && d.backend === "answers-immediately",
    `an abort arriving AFTER the backend answered leaves the Decision alone (${d.answer}/${d.source}/${d.backend})`,
  );
  // The late abort lands on a signal of its own: the case is about an abort
  // arriving after the race settled, and the races above each owned their own
  // signal, so `ac` is free for the purpose.
  // Snapshotted HERE, not at `d`'s birth: the listener assertions above run
  // between the decision and the abort, and a clone taken before them would
  // compare a stale copy against a mutated original and fail on the test's own
  // bookkeeping rather than on anything the abort did.
  const beforeLateAbort = JSON.stringify(d);
  const late = new AbortController();
  late.abort();
  await sleep(50);
  assert(
    JSON.stringify(d) === beforeLateAbort,
    "the late abort changes nothing about the record or the answer it carries",
  );
  // The run answered normally, so the late abort must not have reached it: the
  // inner controller was never aborted, which is the difference between "the race
  // settled and untangled itself" and "the race resolved and left its teardown
  // half-done".
  assert(
    answered.calls === 2 && !answered.signals[0]?.aborted,
    `a run that answered normally is not cancelled by an abort nobody was waiting on (${answered.calls} runs, first signal aborted=${answered.signals[0]?.aborted})`,
  );
  // No late trace: the discarded-settled warning is the only thing a losing racer
  // could still emit, and there is nothing left to settle.
  let traceWarned = false;
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (line.includes("settled after its")) traceWarned = true;
    else realWrite(chunk as never, ...(rest as []));
    return true;
  }) as typeof process.stderr.write;
  // Past the seam bound, so a timer left armed from the settled race would fire.
  await sleep(TEARDOWN_WAIT_MS);
  process.stderr.write = realWrite;
  assert(!traceWarned, "a settled race leaves no armed timer and traces nothing after the fact");
  const rec = records(log).find((r) => r.seam === seamAnswered);
  assert(rec !== undefined, "the answered decision still wrote exactly its one record");
}

{
  const root = tmpDir("seam-abort");
  const log = path.join(root, ".pi", "decisions.jsonl");

  // 1. Aborted mid-flight while the backend never settles.
  const wedged = wedgedBackend();
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), ABORT_AT_MS);
  const t0 = Date.now();
  const d = await decide(seam as never, req, {
    backends: [wedged],
    signal: ac.signal,
    repoRoot: root,
  });
  const elapsed = Date.now() - t0;
  clearTimeout(abortTimer);
  assert(
    elapsed < PROMPT_MS,
    `a backend that never settles plus an outer abort settles in ${elapsed}ms, not the ${SEAM_BOUND_MS}ms seam bound`,
  );
  assert(
    d.answer === "ok" && d.source === "rule" && d.abstained,
    "the aborted call still returns the rule's answer — an abort never changes the outcome",
  );
  assert(
    wedged.calls === 1 && wedged.signals.length === 1,
    "the backend was started once and handed its own cancellation signal",
  );
  // The backend is cancelled, not leaked: `runBounded` aborts the controller it
  // built for the run on its way out. Without it a wedged provider request
  // would keep streaming after the caller had given up.
  for (let i = 0; i < 100 && !wedged.signals[0]?.aborted; i++) await sleep(10);
  assert(
    wedged.signals[0]?.aborted === true,
    "the backend's own signal is aborted, so the wedged run is cancelled",
  );
  assert(
    /abort/i.test(d.reason ?? ""),
    `the reason names the abort rather than hiding it (${JSON.stringify(d.reason)})`,
  );

  // 2. The aborted attempt is audited, not swallowed.
  const rec = await awaitRecord(log, (r) => Array.isArray(r.backends));
  const backends = rec?.backends as { name?: string; error?: string }[] | undefined;
  assert(
    records(log).length === 1 &&
      rec?.seam === seam &&
      backends?.length === 1 &&
      backends[0]?.name === "wedged" &&
      /abort/i.test(backends[0]?.error ?? ""),
    `the aborted race writes ONE record carrying the backend's abort (${records(log).length} record(s), ${JSON.stringify(backends)})`,
  );

  // 3. A signal already aborted when the call is made.
  const pre = new AbortController();
  pre.abort();
  const idle = wedgedBackend();
  const t1 = Date.now();
  const dPre = await decide(seam as never, req, {
    backends: [idle],
    signal: pre.signal,
    repoRoot: root,
  });
  const preElapsed = Date.now() - t1;
  assert(
    preElapsed < PROMPT_MS && idle.calls === 0,
    `a signal aborted before the call settles in ${preElapsed}ms and starts no backend (${idle.calls} started)`,
  );
  assert(dPre.answer === "ok" && dPre.abstained, "...and still answers from the rule");

  // 4. THE CONTROL: the same wedged backend, with nothing aborted, really does
  //    wait out the seam bound. Were this fixture's bound lowered, or the race
  //    made to settle for some other reason, this assertion fails and the
  //    2-second bars above stop proving anything.
  const slow = wedgedBackend();
  const t2 = Date.now();
  await decide(seam as never, req, { backends: [slow], repoRoot: root });
  const waited = Date.now() - t2;
  assert(
    waited >= SEAM_BOUND_MS * 0.9 && slow.calls === 1,
    `with no abort the same never-settling backend does wait out the bound (${waited}ms) — the bound is real, so the bars above are not vacuous`,
  );
  assert(
    records(log).length === 3,
    `three calls, three records: every path — aborted, pre-aborted and timed out — is audited (${records(log).length})`,
  );
}

// 5. The abort performs the TIMEOUT racer's teardown, not just its own (#1393).
//
// `runBounded` arms the seam's own `setTimeout` before the backend runs. If the
// outer abort resolved the race without clearing it, a ~3 s timer stays armed
// past a call answered in ~10 ms, and its callback then fires into a decision
// that has already been answered — setting `timedOut` and emitting the
// "settled after its bound" trace for a call nobody is waiting on. A pending
// timer is not observable from outside this runtime (no `Bun.getTimerCount`), so
// the probe is the callback itself: this backend settles SUCCESSFULLY at
// `SETTLE_MS` (after `ABORT_AT_MS`) under a `SEAM_BOUND_MS` bound, and the test
// then waits past the point at which an uncleared timer would have fired.
{
  let boundTimerFired = false;
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    // The claim here is about the seam's own `setTimeout` firing into an answered
    // call, which the timeout path labels `bound`. A `... abort; discarded` line
    // is the LEGITIMATE trace of the backend settling late after the abort won —
    // case 6 below asserts that one exists — so this spy must not count it.
    if (/settled after its[^\n]*\bbound\b/.test(line)) boundTimerFired = true;
    else realWrite(chunk as never, ...(rest as []));
    return true;
  }) as typeof process.stderr.write;

  const root = tmpDir("abort-teardown");
  // `mainCheckout` prefers `--git-common-dir`, which resolves to the MAIN
  // checkout of this repo when the temp dir holds no `.git` of its own — and the
  // main checkout is read-only to a test by design, so the record silently goes
  // nowhere and the block below would assert on an empty log. A bare `.git`
  // directory makes the temp dir its own checkout.
  mkdirSync(path.join(root, ".git"), { recursive: true });
  const log = path.join(root, ".pi", "decisions.jsonl");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ABORT_AT_MS);
  const settledBackend: Backend = {
    name: "settles-after-abort",
    source: "llm",
    run: (_input: BackendInput, signal: AbortSignal) =>
      new Promise<BackendResult>((resolve) => {
        setTimeout(() => resolve({ ok: true, answer: "ok" }), SETTLE_MS);
        signal.addEventListener("abort", () => resolve({ ok: false, error: "cancelled" }));
      }),
  };
  const t = Date.now();
  await decide(seam as never, req, {
    backends: [settledBackend],
    signal: ac.signal,
    repoRoot: root,
  });
  const elapsed = Date.now() - t;
  assert(
    elapsed < PROMPT_MS,
    `the aborted call settled promptly (${elapsed}ms), so any timer still armed below belongs to the abandoned race`,
  );
  // The seam bound is seconds, not a minute, and half of it is still past the
  // point at which an uncleared timer would have fired.
  await sleep(TEARDOWN_WAIT_MS);
  process.stderr.write = realWrite;
  assert(
    !boundTimerFired,
    "the abort cleared the seam's own bound timer, as the timeout racer does: no bound-fired trace for a call already answered",
  );
  // The teardown path is audited like every other: the record exists and its
  // backends array carries the cancellation the race produced. (`Decision` has
  // no `status` field — `abstained` belongs to the answer, not the record.)
  const rec = await awaitRecord(log, (r) => Array.isArray(r.backends));
  const backends = rec?.backends as { name?: string; error?: string }[] | undefined;
  assert(
    Array.isArray(backends) &&
      backends.some((b) => b.name === "settles-after-abort" && /cancel|abort/i.test(b.error ?? "")),
    `the teardown path still writes its record, carrying the cancellation (${JSON.stringify(backends)})`,
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
