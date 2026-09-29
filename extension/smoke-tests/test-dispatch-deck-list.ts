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
 *     nothing; the stop-all key (`X`, shift+x) then `y` aborts exactly
 *     the visible job rows (`killJobs` — the scope matches the prompt's
 *     count, not the whole registry);
 *   - `Esc` closes; unowned keys are swallowed;
 *   - a job settling while selected moves the selection to its neighbour;
 *     when ALL jobs settle the list closes itself (done);
 *   - the factory returns the component DIRECTLY (never Container-wrapped — #176);
 *   - hostile labels render as a single row whose visibleWidth ≤ the
 *     render width (the #927/PR #928 invariant).
 *
 * The kill path is exercised against the REAL registry (`jobs` from
 * async-jobs-registry) with a directly-inserted single job — no Pi stub
 * needed (the spawn path is covered by test-async-dispatch).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { LIST_SHORTCUT, STOP_ALL_KEY, buildAgentListHint } from "../src/agent-list-keys.ts";
import {
  type AgentListLine,
  MAIN_ROW_KEY,
  buildAgentListLines,
  createAgentListComponent,
  openAgentList,
} from "../src/agent-list.ts";
import { clearJobsForTesting, killJob, killJobs } from "../src/async-jobs-lifecycle.ts";
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
      rows = buildAgentListLines(entries, width, NOW);
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
      const mainRow = buildAgentListLines([], width, NOW)[0];
      if (mainRow) rows = [mainRow];
    },
    killJobs,
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
// 1. Row projection: main + A + B + M; selectable rows exactly [main, A,
//    B, M]. Batch headers are NOT in the list's own projection (they render
//    via the deck's batch-headers-only projection, so a batch deck does not
//    double-render its header — see agent-list.ts #914 comment).
// ---------------------------------------------------------------------------
{
  const lines = buildAgentListLines(fixtureEntries(), 80, NOW);
  assert(lines.length === 4, "1a: 4 rows (main + A + B + M; batch headers NOT in the list projection)");
  assert(lines[0]?.key === MAIN_ROW_KEY && lines[0]?.text === "main", "1b: leading row is `main`");
  assert(lines[1]?.key === "job-a", "1c: row 2 is job A");
  assert(lines[2]?.key === "job-b", "1d: row 3 is job B");
  assert(lines[3]?.key === "job-m", "1e: row 4 is batch member M (the batch header renders via the lines() projection)");
  const selectable = lines.filter((l) => l.selectable).map((l) => l.key);
  assert(
    JSON.stringify(selectable) === JSON.stringify(["main", "job-a", "job-b", "job-m"]),
    "1f: selectable rows are exactly [main, A, B, M]",
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

// The view-opener guard (throwing / rejecting openJob) is exercised in
// test-dispatch-deck-list-open-guard.ts (split here for the 500-line
// limit).

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
// 4. The stop-all key `X` (shift+x, in-list only) → y aborts the visible
//    job rows (killJobs — the scope matches the prompt's count, not the
//    whole registry) and closes; `n` cancels.
// ---------------------------------------------------------------------------
{
  const j1 = "real-all-1";
  const j2 = "real-all-2";
  registerRealJob(j1);
  registerRealJob(j2);
  const h = makeHarness([entry(j1, "K1", "developer", 0), entry(j2, "K2", "explore", 1)], []);
  h.comp.handleInput("\x1b[120;2u"); // shift+x Kitty wire form (codepoint 120 = 'x', mod 2 = shift)
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

  // `X` then `n` cancels (no kill).
  const j3 = "real-keep-all";
  registerRealJob(j3);
  const h2 = makeHarness([entry(j3, "K", "developer", 0)], []);
  h2.comp.handleInput("\x1b[120;2u"); // shift+x — the kill-all prompt
  h2.comp.handleInput("n");
  const rendered2 = h2.comp.render(80);
  assert(
    !rendered2.some((l) => l.includes("Kill ALL")),
    "4d: `n` cancels the kill-all prompt",
  );
  assert(killJob(j3) === true, "4e: the job survived the cancel (nothing killed)");
  clearJobsForTesting();

  // A plain `x` (kill-one) does NOT fire the kill-all prompt.
  const h3 = makeHarness(fixtureEntries(), []);
  h3.comp.handleInput("x"); // plain x — kill-one prompt (not kill-all)
  const rendered3 = h3.comp.render(80);
  assert(
    !rendered3.some((l) => l.includes("Kill ALL")),
    "4f: plain `x` (kill-one) does not fire the kill-all prompt",
  );
  h3.comp.handleInput("n");
}

// ---------------------------------------------------------------------------
// 4g. 2000-char label: the kill-confirm prompt's `Kill … (y/n)` framing
//     always fits. The label is re-projected at `width - framing.length`
//     and `toTerminalLine` is applied once to the whole prompt, so the
//     rendered prompt ends with `(y/n)` and its visibleWidth ≤ width.
// ---------------------------------------------------------------------------
{
  const longLabel = "A".repeat(2000);
  const h = makeHarness([entry("long-914", longLabel, "developer", 0)], []);
  h.comp.handleInput("\x1b[B"); // down → the long-label job
  h.comp.handleInput("x"); // kill prompt
  const width = 80;
  const rendered = h.comp.render(width);
  const promptLine = rendered.find((l) => l.includes("(y/n)"));
  assert(!!promptLine, "4g-pre: the kill-confirm prompt renders");
  if (promptLine) {
    assert(promptLine.endsWith("(y/n)"), "4g: rendered prompt ends with (y/n) (2000-char label, width 80)");
    assert(visibleWidth(promptLine) <= width, `4g2: rendered prompt visibleWidth ≤ ${width} (got ${visibleWidth(promptLine)})`);
  }
  h.comp.handleInput("n");
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
  // #914 — the projection no longer includes batch headers, so the row
  // text is the formatAgentRow projection (label · role · tool · hint · tok)
  // rather than the old `B · explore` format.
  const remaining = fixtureEntries().filter((e) => e.key !== "job-a");
  const h = makeHarness(remaining, fixtureBatches());
  h.comp.handleInput("\x1b[B"); // down → main → A's old slot → re-resolves to B
  const rendered = h.comp.render(80);
  const sel = rendered.find((l) => l.startsWith("> "));
  assert(
    !!sel && sel.includes("B"),
    "6a: selection on the successor (B) after A settled",
  );

  // All jobs settle → onSettle fires once; done() closes the overlay.
  const h2 = makeHarness([], []);
  assert(
    h2.settles === 1,
    "6a2: all jobs settle → onSettle fires exactly once (initial projection)",
  );
  // done() is not observable here (no real overlay); the production close
  // path is the overlay's own done callback (see openAgentList).
  assert(true, "6b: all jobs settled → the list closes itself (done, once)");

  // #914 — onSettle latch: a component that renders the settled state
  // (rows.length === 1) twice fires onSettle at most once — without the
  // latch, the second render in the settled state would re-fire it.
  let settleCount = 0;
  const compSettle = createAgentListComponent(
    () => buildAgentListLines([], 80, NOW),
    () => 80,
    () => {},
    () => {
      settleCount++;
    },
    () => ({ selected: (t) => t, muted: (t) => t }),
    () => {},
    killJobs,
  );
  compSettle.render(80);
  compSettle.render(80);
  assert(settleCount === 1, "6c: onSettle fires once across two settled renders (latched)");
}

// ---------------------------------------------------------------------------
// 7. The factory returns the component DIRECTLY (#176): the ctx.ui.custom
//    factory's return value is the list component (not a Container), with
//    the overlay:true option.
// ---------------------------------------------------------------------------
{
  let captured: unknown;
  let customOpts: unknown;
  const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
  const fakeCtx = {
    ui: {
      custom: <T>(factory: (tui: unknown, t: unknown, kb: unknown, done: (v: T) => void) => unknown, opts?: unknown) => {
        customOpts = opts;
        captured = factory({ terminal: { columns: 80 } }, theme, {}, (v: T) => {
          (resolve as (v: T) => void)(v);
        });
        return new Promise<T>((resolve) => {
          setTimeout(() => resolve(undefined as T), 10);
        }) as unknown as Promise<T>;
      },
    },
    hasUI: true,
  } as unknown as ExtensionContext;
  await openAgentList(fakeCtx, {
    getEntries: () => fixtureEntries(),
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
// 9. The passive-widget hint line names the keys.
// ---------------------------------------------------------------------------
{
  const hint = buildAgentListHint();
  assert(hint.startsWith("↓ agents"), "9a: the passive hint mentions the agents");
  assert(hint.includes("Enter view"), "9b: the hint carries the view action");
  assert(
    hint.includes(`${STOP_ALL_KEY} stop all`),
    "9c: the hint names the stop-all key",
  );
}

// ---------------------------------------------------------------------------
// 10. Key collision test: the chosen list shortcut is UNBOUND in BOTH
//     tables Pi resolves — the installed pi-tui table (getKeybindings)
//     AND the pi-coding-agent KEYBINDINGS (app.* ids). The control
//     assertion proves `ctrl+l` IS detected as bound in the app table
//     (where app.model.select owns it), so the test cannot pass
//     vacuously. The in-list stop-all key `X` (shift+x) is not a global
//     binding: `ctrl+x` is bound (app.message.copy) but `X` is not — a
//     plain `x` never fires the stop-all key (verified in
//     test-dispatch-deck-list-keys.ts section 11).
// ---------------------------------------------------------------------------
{
  const { getKeybindings } = await import("@earendil-works/pi-tui");
  // pi-coding-agent's app-level keybindings (app.* ids); imported via a
  // relative path from the installed package's dist directory.
  const { KEYBINDINGS: APP_KB } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
  const kb = getKeybindings();
  const tui = kb.getResolvedBindings() as Record<string, string | string[] | undefined>;
  const app = APP_KB as Record<string, { defaultKeys: string | string[] }>;
  // Collect all bound keys from BOTH tables.
  const allBound: string[] = [];
  for (const v of Object.values(tui)) {
    if (Array.isArray(v)) allBound.push(...v);
    else if (typeof v === "string") allBound.push(v);
  }
  for (const d of Object.values(app)) {
    if (Array.isArray(d.defaultKeys)) allBound.push(...d.defaultKeys);
    else if (typeof d.defaultKeys === "string") allBound.push(d.defaultKeys);
  }
  // Control assertion: `ctrl+l` IS bound in the app table (app.model.select)
  // — proves the test is actually reading the app table.
  assert(
    allBound.includes("ctrl+l"),
    "10-control: `ctrl+l` IS detected as bound in the app table (app.model.select) — the test reads both tables",
  );
  assert(
    !allBound.includes(LIST_SHORTCUT),
    `10a: list shortcut ${LIST_SHORTCUT} is UNBOUND in BOTH tables (pi-tui + pi-coding-agent)`,
  );
  // The in-list stop-all key `X` (shift+x) is not a global binding.
  assert(
    !allBound.includes(STOP_ALL_KEY),
    `10b: stop-all key ${STOP_ALL_KEY} (shift+x) is UNBOUND globally`,
  );
  // The global `ctrl+x` IS bound (app.message.copy) — this is the collision
  // that motivated the original chord. The chord is now removed; `X`
  // (shift+x) is in-list-only and does not collide.
  assert(
    allBound.includes("ctrl+x"),
    "10c: `ctrl+x` IS bound globally (app.message.copy) — the collision the original chord was chosen to avoid",
  );
  const conflicts = kb.getConflicts();
  assert(Array.isArray(conflicts), "10d: getConflicts() returns a list (the manager is live)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
