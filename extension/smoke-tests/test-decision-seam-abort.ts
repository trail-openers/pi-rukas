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
 * lowered, the control fails and the 2-second bars below stop being meaningful.
 *
 *   - aborted at 100 ms under a 30 s seam bound -> settles in well under 2 s;
 *   - the backend's OWN signal fires, so the backend is cancelled, not leaked;
 *   - a signal already aborted when `decide()` is called -> settles at once;
 *   - the same backend, never aborted, waits out the full 30 s (the control);
 *   - the abort writes one record, carrying the abort as the backend's error.
 *
 * Offline: the backend is a closure that never settles; nothing touches the network.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Backend, BackendInput, BackendResult } from "../src/decision-backends.ts";
import { SEAMS, type SeamSpec } from "../src/decision-seam-registry.ts";
import { decide } from "../src/decision-seam.ts";
import { makeAssert, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Comfortably longer than any honest abort, comfortably shorter than the bound. */
const PROMPT_MS = 2_000;
/** The seam bound the aborted calls must NOT wait out. The control proves it bites. */
const SEAM_BOUND_MS = 30_000;

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

function records(file: string): Record<string, unknown>[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Wait until a predicate sees the record it wants, or 4 s have passed. */
async function awaitRecord(
  file: string,
  pred: (r: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 400; i++) {
    const hit = records(file).find(pred);
    if (hit !== undefined) return hit;
    await sleep(10);
  }
  return undefined;
}

const req = { state: { probe: "value" }, question: "q", rule: "ok" };

{
  const root = tmpDir("seam-abort");
  const log = path.join(root, ".pi", "decisions.jsonl");

  // 1. Aborted mid-flight while the backend never settles.
  const wedged = wedgedBackend();
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), 100);
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

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
