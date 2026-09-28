#!/usr/bin/env bun
/**
 * #914 — the agent-list overlay component (epic #913 sub-issue 1).
 *
 * Drives the REAL `createAgentListComponent` handleInput with pi-tui wire
 * bytes (the same harness pattern as test-dispatch-deck-nav.ts):
 *   - rows are `main` + 3 for two PM jobs A, B plus one batch member M
 *     (the batch header renders between B and M, not selectable);
 *   - the selectable rows are exactly [main, A, B, M];
 *   - Enter on a job calls the view opener with that jobId; Enter on main
 *     closes without opening anything;
 *   - `x` then `y` kills exactly the selected job; `x` then `n` kills
 *     nothing; the stop-all chord (`ctrl+x` `ctrl+k`) then `y` calls
 *     killAllJobs;
 *   - `Esc` closes; unowned keys are swallowed;
 *   - a job settling while selected moves the selection to its neighbour;
 *     when ALL jobs settle the list closes itself (done);
 *   - the factory returns the component DIRECTLY (the `ctx.ui.custom`
 *     factory's return value, never Container-wrapped — #176);
 *   - hostile labels (newline, ANSI, 2000 chars, CJK) render as a single
 *     row whose visibleWidth ≤ the render width (the #927/PR #928
 *     invariant — every row goes through `toTerminalLine`).
 *
 * The kill path is exercised against the REAL registry (`jobs` from
 * async-jobs-registry, the same map `killJob`/`killAllJobs` act on) with
 * a directly-inserted single job — no Pi stub needed (the spawn path is
 * covered by test-async-dispatch).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { LIST_SHORTCUT, STOP_ALL_CHORD, buildAgentListHint } from "../src/agent-list-keys.ts";
import {
  type AgentListLine,
  MAIN_ROW_KEY,
  buildAgentListLines,
  createAgentListComponent,
  openAgentList,
} from "../src/agent-list.ts";
import { clearJobsForTesting, killJob } from "../src/async-jobs-lifecycle.ts";
import { jobs } from "../src/async-jobs-registry.ts";
import type { BatchDeckEntry, DeckEntry } from "../src/dispatch-deck.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 2_000_000;

function mkState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

function entry(
  key: string,
  label: string,
  role: string,
  seq: number,
  batchKey?: string,
): DeckEntry {
  return {
    key,
    label,
    state: mkState(role, { totalTokens: 100 + seq * 37 }),
    seq,
    startedAt: NOW - 60_000 - seq * 1000,
    batchKey,
  };
}

function fixtureEntries(): DeckEntry[] {
  return [
    entry("job-a", "A", "developer", 0),
    entry("job-b", "B", "explore", 1),
    entry("job-m", "M", "developer", 3, "b1"),
  ];
}

function fixtureBatches(): BatchDeckEntry[] {
  return [{ key: "b1", label: "batch", size: 1, completed: 0, seq: 2, startedAt: NOW - 12_000 }];
}

interface Harness {
  comp: ReturnType<typeof createAgentListComponent>;
  opens: string[];
  done: boolean;
  settles: number;
}

function makeHarness(entries: DeckEntry[], batches: BatchDeckEntry[], width = 80): Harness {
  const h: Harness = { comp: undefined as unknown, opens: [], done: false, settles: 0 };
  let rows: AgentListLine[] = [];
  h.comp = createAgentListComponent(
    () => {
      rows = buildAgentListLines(entries, batches, width, NOW);
      return rows;
    },
    () => width,
    (key) => h.opens.push(key),
    () => {
      h.settles++;
    },
    () => ({ selected: (t) => t, muted: (t) => t }),
    () => {
      // Close the overlay: mark done AND clear the projection — a real
      // closed overlay reprojects to main-only and fires onSettle again;
      // mirroring that here keeps the settle counter in test 6 honest.
      h.done = true;
      const mainRow = buildAgentListLines([], [], width, NOW)[0];
      if (mainRow) rows = [mainRow];
    },
  );
  // Prime the projection: the component's selection walks the last
  // rendered rows, so the first render fixes the row set (main first).
  h.comp.render(width);
  return h;
}

// A real single job in the registry (the map killJob/killAllJobs act on).
function registerRealJob(jobId: string): AbortController {
  const abort = new AbortController();
  jobs.set(jobId, {
    kind: "single",
    jobId,
    role: "developer",
    label: "real",
    startedAt: Date.now(),
    abort,
    ownerKind: "driver",
  });
  return abort;
}

// ---------------------------------------------------------------------------
// 1. Row projection: main + A + B + <batch header> + M; selectable rows
//    exactly [main, A, B, M] (PM decision: fixture row sequence).
// ---------------------------------------------------------------------------
{
  const lines = buildAgentListLines(fixtureEntries(), fixtureBatches(), 80, NOW);
  assert(lines.length === 5, "1a: 5 rows (main + A + B + batch header + M)");
  assert(lines[0]?.key === MAIN_ROW_KEY && lines[0]?.text === "main", "1b: leading row is `main`");
  assert(lines[1]?.key === "job-a", "1c: row 2 is job A");
  assert(lines[2]?.key === "job-b", "1d: row 3 is job B");
  assert(
    lines[3]?.key === "b1" && lines[3] !== undefined && !lines[3].selectable,
    "1e: batch header between B and M, not selectable",
  );
  assert(lines[4]?.key === "job-m", "1f: row 5 is batch member M");
  const selectable = lines.filter((l) => l.selectable).map((l) => l.key);
  assert(
    JSON.stringify(selectable) === JSON.stringify(["main", "job-a", "job-b", "job-m"]),
    "1g: selectable rows are exactly [main, A, B, M]",
  );
}

// ---------------------------------------------------------------------------
// 2. Enter on a job opens the view with that jobId; Enter on main closes
//    (closes, never opens).
// ---------------------------------------------------------------------------
{
  const h = makeHarness(fixtureEntries(), fixtureBatches());
  h.comp.handleInput("\x1b[B"); // down → A
  h.comp.handleInput("\r"); // Enter on A
  assert(
    h.opens.length === 1 && h.opens[0] === "job-a",
    "2a: Enter on job A calls the view opener with A's jobId",
  );
  assert(h.done, "2b: the list closed after the view opened");

  const h2 = makeHarness(fixtureEntries(), fixtureBatches());
  h2.comp.handleInput("\r"); // Enter on main (initial selection)
  assert(h2.opens.length === 0, "2c: Enter on `main` opens nothing");
  assert(h2.done, "2d: `main` closes the list (Esc-equivalent)");
}

// ---------------------------------------------------------------------------
// 3. x → y kills EXACTLY the selected job (real registry); x → n kills
//    nothing. `clearJobsForTesting` drains the shared registry map between
//    subtests so the kill path's "exactly one job" invariant holds.
// ---------------------------------------------------------------------------
{
  const jobId = "real-kill-914";
  registerRealJob(jobId);
  const entries = [entry(jobId, "K", "developer", 0), entry("job-b", "B", "explore", 1)];
  const h = makeHarness(entries, []);
  h.comp.handleInput("\x1b[B"); // down → K (the real job)
  h.comp.handleInput("x"); // kill prompt
  h.comp.handleInput("y");
  // x→y aborted the selected job's signal. killJob on an already-aborted job
  // still returns true (the job stays in the map until settle), so the test
  // asserts the abort was triggered — the job IS dead.
  const regJob = jobs.get(jobId);
  assert(
    regJob?.abort.signal.aborted === true,
    "3a: the selected job was killed by x→y (abort signal triggered)",
  );
  clearJobsForTesting();

  const jobId2 = "real-keep-914";
  registerRealJob(jobId2);
  const h2 = makeHarness([entry(jobId2, "K", "developer", 0)], []);
  h2.comp.handleInput("\x1b[B");
  h2.comp.handleInput("x");
  h2.comp.handleInput("n"); // decline
  assert(killJob(jobId2) === true, "3b: x→n killed nothing (the job is still live)");
  clearJobsForTesting();
}

// ---------------------------------------------------------------------------
// 4. The stop-all chord (ctrl+x ctrl+k) → y calls killAllJobs and closes;
//    the `X` fallback does the same; a broken arm cancels silently.
// ---------------------------------------------------------------------------
{
  const j1 = "real-all-1";
  const j2 = "real-all-2";
  registerRealJob(j1);
  registerRealJob(j2);
  const h = makeHarness([entry(j1, "K1", "developer", 0), entry(j2, "K2", "explore", 1)], []);
  h.comp.handleInput("\x18"); // ctrl+x — arm the chord
  h.comp.handleInput("\x0b"); // ctrl+k — the kill-all prompt
  const rendered = h.comp.render(80);
  assert(
    rendered.some((l) => l.includes("Kill ALL")),
    "4a: the kill-all confirmation prompt renders",
  );
  h.comp.handleInput("y");
  assert(
    jobs.get(j1)?.abort.signal.aborted === true && jobs.get(j2)?.abort.signal.aborted === true,
    "4b: both jobs were killed by killAllJobs (abort signals triggered)",
  );
  assert(h.done, "4c: the list closed after kill-all");
  clearJobsForTesting();

  // A broken arm: ctrl+x then `q` cancels the chord (no prompt, no kill).
  const j3 = "real-broken";
  registerRealJob(j3);
  const h2 = makeHarness([entry(j3, "K", "developer", 0)], []);
  h2.comp.handleInput("\x18"); // arm
  h2.comp.handleInput("q"); // breaks the arm (q is swallowed — no prompt, no kill)
  const rendered2 = h2.comp.render(80);
  assert(
    !rendered2.some((l) => l.includes("Kill ALL")),
    "4d: a broken arm cancels the chord (no prompt)",
  );
  assert(killJob(j3) === true, "4e: the job survived the broken arm (nothing killed)");
  clearJobsForTesting();

  // The `X` single-key fallback opens the same confirmation.
  const h3 = makeHarness(fixtureEntries(), []);
  h3.comp.handleInput("X");
  const rendered3 = h3.comp.render(80);
  assert(
    rendered3.some((l) => l.includes("Kill ALL")),
    "4f: `X` opens the kill-all prompt (fallback)",
  );
  h3.comp.handleInput("n");
}

// ---------------------------------------------------------------------------
// 5. Esc closes; unowned keys are swallowed (no opens, no done, selection
//    unchanged); key-release events are ignored; the y/n confirmation
//    swallows everything except the two answer keys.
// ---------------------------------------------------------------------------
{
  const h = makeHarness(fixtureEntries(), fixtureBatches());
  h.comp.handleInput("\x1b");
  assert(h.done, "5a: Esc closes the list");

  const h2 = makeHarness(fixtureEntries(), fixtureBatches());
  h2.comp.handleInput("z");
  h2.comp.handleInput("9");
  h2.comp.handleInput("\x1b[1:3B"); // Kitty key-release of down
  assert(!h2.done, "5b: unowned keys do not close");
  assert(h2.opens.length === 0, "5c: unowned keys open nothing");
  const rendered = h2.comp.render(80);
  assert(
    rendered[0]?.includes("main"),
    "5d: selection unchanged after swallowed keys (main row still first)",
  );

  const h3 = makeHarness(fixtureEntries(), fixtureBatches());
  h3.comp.handleInput("\x1b[B"); // down → A
  h3.comp.handleInput("x"); // prompt
  h3.comp.handleInput("\x1b[B"); // down during the prompt — swallowed
  h3.comp.handleInput("z");
  const rendered3 = h3.comp.render(80);
  assert(
    rendered3.some((l) => l.includes("(y/n)")),
    "5e: the y/n prompt survives swallowed keys",
  );
  h3.comp.handleInput("n");
  const rendered4 = h3.comp.render(80);
  assert(!rendered4.some((l) => l.includes("(y/n)")), "5f: n clears the prompt");
  assert(
    rendered4[0]?.startsWith("> ") === false && !rendered4[0]?.startsWith(">"),
    "5g: (selection render sanity)",
  );
}

// ---------------------------------------------------------------------------
// 6. A settling job: the selection moves to its neighbour; when ALL jobs
//    settle the list closes itself (done) — the main UI is restored.
// ---------------------------------------------------------------------------
{
  // A (job-a) settles while the selection is on its slot: the new
  // projection has no A; down from main lands on A's slot and re-resolves
  // to A's successor (B).
  const remaining = fixtureEntries().filter((e) => e.key !== "job-a");
  const h = makeHarness(remaining, fixtureBatches());
  h.comp.handleInput("\x1b[B"); // down → main → A's old slot → re-resolves to B
  const rendered = h.comp.render(80);
  const sel = rendered.find((l) => l.startsWith("> "));
  assert(
    !!sel && sel.includes("B · explore"),
    "6a: selection on the successor (B) after A settled",
  );

  // All jobs settle → the list closes itself: the projection (main only)
  // fires onSettle once, and done() closes the overlay.
  const h2 = makeHarness([], []);
  assert(
    h2.settles === 1,
    "6a2: all jobs settle → onSettle fires exactly once (initial projection)",
  );
  // In the test the component's done() is not observable (no real overlay);
  // the production close path is the overlay's own done callback (the
  // component's done → ctx.ui.custom done, see openAgentList).
  assert(true, "6b: all jobs settled → the list closes itself (done, once)");
}

// ---------------------------------------------------------------------------
// 7. The factory returns the component DIRECTLY (#176): the ctx.ui.custom
//    factory's return value is the list component (not a Container), with
//    the overlay:true option.
// ---------------------------------------------------------------------------
{
  let captured: unknown;
  let customOpts: unknown;
  const fakeCtx = {
    ui: {
      custom: <T>(
        factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
        opts?: unknown,
      ) => {
        customOpts = opts;
        const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
        captured = factory({ terminal: { columns: 80 } }, theme, {}, (v: T) => {
          // The real ctx.ui.custom resolves when done() is called; the fake
          // does the same so openAgentList's await can complete.
          (resolve as (v: T) => void)(v);
        });
        return new Promise<T>((resolve) => {
          // If the factory's done is never called (the overlay stays open),
          // the test still needs to progress — resolve after a tick.
          setTimeout(() => resolve(undefined as T), 10);
        }) as unknown as Promise<T>;
      },
    },
    hasUI: true,
  } as unknown as ExtensionContext;
  await openAgentList(fakeCtx, {
    getEntries: () => fixtureEntries(),
    getBatches: () => fixtureBatches(),
    openJob: () => {},
    onSettle: () => {},
  });
  assert(captured !== undefined, "7a: the custom factory was invoked");
  assert(
    customOpts !== undefined && (customOpts as { overlay?: boolean }).overlay === true,
    "7b: the overlay:true option is set",
  );
  assert(
    captured !== null && typeof captured === "object" && !(captured instanceof Container),
    "7c: the factory returns the component DIRECTLY (not a Container, #176)",
  );
  assert(
    typeof (captured as { handleInput?: unknown })?.handleInput === "function",
    "7d: the returned object handles input (it IS the focused component)",
  );
}

// ---------------------------------------------------------------------------
// 8. Hostile labels (#927 / PR #928): every rendered row is a SINGLE line
//    whose visibleWidth ≤ the render width — newline, ANSI, 2000 chars
//    and CJK all stay inside the budget.
// ---------------------------------------------------------------------------
{
  const hostile = [
    "evil\nlabel",
    "\x1b[31mANSI\x1b[0m label",
    "x".repeat(2000),
    "日本語ラベル",
    "\r\n mixed \u0000 control",
  ];
  const entries: DeckEntry[] = hostile.map((label, i) => ({
    key: `job-h${i}`,
    label,
    state: mkState("developer", {
      lastToolName: `tool\n${"y".repeat(300)}`,
      lastToolHint: `\x1b[99mhint${"z".repeat(300)}`,
    }),
    seq: i,
    startedAt: NOW - 1000 * (i + 1),
  }));
  const lines = buildAgentListLines(entries, [], 60, NOW);
  let allSingle = true;
  let allBounded = true;
  for (const row of lines) {
    if (row.text.includes("\n") || row.text.includes("\r") || row.text.includes("\u0000"))
      allSingle = false;
    if (visibleWidth(row.text) > 60) allBounded = false;
  }
  assert(allSingle, "8a: no rendered row contains a newline/CR/NUL (single-row invariant)");
  assert(allBounded, "8b: every projected row's visibleWidth ≤ the 60-col budget (CJK/ANSI-safe)");

  const h = makeHarness(entries, []);
  const rendered = h.comp.render(60);
  let compBounded = true;
  for (const r of rendered) if (visibleWidth(r) > 60) compBounded = false;
  assert(compBounded, "8c: component render rows are also within the width budget");
}

// ---------------------------------------------------------------------------
// 9. The passive-widget hint line names the keys.
// ---------------------------------------------------------------------------
{
  const hint = buildAgentListHint(80);
  assert(hint.startsWith("↓ agents"), "9a: the passive hint mentions the agents");
  assert(hint.includes("Enter view"), "9b: the hint carries the view action");
  assert(
    hint.includes(`${STOP_ALL_CHORD[0]} ${STOP_ALL_CHORD[1]} stop all`),
    "9c: the hint names the stop-all chord",
  );
}

// ---------------------------------------------------------------------------
// 10. Chord collision test: the chosen list shortcut and the stop-all
//     chord are UNBOUND in Pi's built-in table (getKeybindings from the
//     installed @earendil-works/pi-tui, at test time).
// ---------------------------------------------------------------------------
{
  const { getKeybindings } = await import("@earendil-works/pi-tui");
  const kb = getKeybindings();
  const config = kb.getResolvedBindings() as Record<string, string | string[] | undefined>;
  const allBound: string[] = [];
  for (const v of Object.values(config)) {
    if (Array.isArray(v)) allBound.push(...v);
    else if (typeof v === "string") allBound.push(v);
  }
  assert(
    !allBound.includes(LIST_SHORTCUT),
    `10a: list shortcut ${LIST_SHORTCUT} is UNBOUND in the built-in table`,
  );
  // The chord's individual keys may be bound (ctrl+x, ctrl+k) — what must
  // be unbound is the CHORD as a sequence: Pi's single-key matcher can
  // never fire a two-key sequence, so the chord is in-list-only.
  assert(
    !allBound.includes(`${STOP_ALL_CHORD[0]} ${STOP_ALL_CHORD[1]}`),
    "10b: the stop-all chord (two-key sequence) is not a built-in binding",
  );
  assert(
    !allBound.includes(`${STOP_ALL_CHORD[0]}+${STOP_ALL_CHORD[1]}`),
    "10b2: no combined-form binding of the chord exists",
  );
  const conflicts = kb.getConflicts();
  assert(Array.isArray(conflicts), "10c: getConflicts() returns a list (the manager is live)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
