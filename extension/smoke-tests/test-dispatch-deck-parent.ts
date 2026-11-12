#!/usr/bin/env bun
/**
 * #2188 ticket A — the dispatch deck records a PARENT LINK.
 *
 * `parentKey` is a distinct optional field on the row: `dispatchCore`'s opts →
 * `StartJobInput` → `dispatchDeck.startEntry` → `DeckEntry`. Ticket B's nesting
 * projection groups on it, so this ticket owns one thing: the value must be
 * really populated on the row, by executed evidence, not by a stub that
 * fabricates the row.
 *
 * Why the stub forwards to the REAL `dispatchCore` (the
 * test-dispatch-deck-driver.ts:94-133 pattern): the rig lives in
 * lib/deck-parent-stub.ts (§12's line cap), and it forwards rather than
 * calling `startJob` itself because `setResearchDispatch` replaces
 * `dispatchCore` wholesale (research-driver.ts's
 * `_dispatchOverride ?? dispatchCore`) — a stub that registered its own row
 * would stay green with the `opts → startJob` forwarding line deleted.
 * Forwarding to the real `dispatchCore` under `setupSpawnGuard()` makes that
 * hop executed evidence: the deck row is registered synchronously inside
 * `startJob`, before the spawn guard rejects the child. Each leg learns its OWN
 * jobId by subtracting the pre-drive registry from the post-call one — never
 * by position, which the angle fan-out's `Promise.all` shares between siblings
 * (see `baseline` in the rig).
 *
 * What the stub then does with the result: the pipeline's fail-closed rule
 * (D8) halts the whole run when no angle produced a structured claim, and the
 * spawn guard means no angle ever can. So for each observed child the stub
 * returns a fabricated successful `DispatchResult` carrying ≥1 schema-valid
 * `report_research_claim` toolUse — the population every later phase reads.
 *
 * Why the deck is read from the PARENT JOB's own work function: `startJob`'s
 * settle path calls `dispatchDeck.clearEntry`, so a gate that awaited the
 * pipeline could not observe the rows (the never-settling-work alternative is
 * test-async-dispatch.ts:243-273). Nothing here asserts a row's position or
 * `seq` — the angle children dispatch under `Promise.all`, so their insertion
 * order varies run to run.
 *
 * Vacuity guards, all four named edge cases from the ticket:
 *   - `startEntry` early-returns under PI_ENSEMBLE_QUIET_STATUS=1, so an
 *     inherited quiet flag would make every assertion below pass on an empty
 *     deck — the variable is deleted and a non-empty snapshot is asserted.
 *   - the research job's OWN row is in the same snapshot and has no parent
 *     link, so rows are selected by role, never asserted globally.
 *   - `PI_ENSEMBLE_RESEARCH_FALLBACK` is default-ON, which would add a fourth
 *     dispatch leg; it is pinned to "0" so the child population is exact.
 *   - all five `ResearchDeps` seams are stubbed and `repoRoot` is a `mkdtemp`
 *     (it is a positional argument, not a seam), so no git, HTTP, vipune,
 *     artifact or provenance write touches the working tree.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearJobsForTesting, startJob } from "../src/async-jobs.ts";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import {
  RESEARCH_REPORTER_PATH,
  setResearchDispatch,
} from "../src/research-driver.ts";
import { runResearchPipeline } from "../src/research-driver.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { checkParentLinkStaysUnrendered } from "./lib/deck-parent-projection.ts";
import {
  installResearchDispatchStub,
  observedChildren,
  settleMessages,
  settleRows,
  type Child,
} from "./lib/deck-parent-stub.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

setupSpawnGuard();
// The vacuity guards, set before anything can read them.
delete process.env.PI_ENSEMBLE_QUIET_STATUS;
process.env.PI_ENSEMBLE_RESEARCH_FALLBACK = "0";
// No accidental live spawn anywhere in this file, and a short bound so a
// stub that failed to intercept a child cannot stall the suite.
process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN = "1";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";

const PARENT_KEY = "parent-research-job-key";

/** A host with no tool surface: the pipeline-level drives never register tools. */
const FAKE_PI = { registerTool: () => {} } as never;

/** The pi stub dispatchCore hands startJob: only sendUserMessage is touched. */
function makePiStub() {
  const inbox: string[] = [];
  const pi = {
    sendUserMessage(content: string) {
      inbox.push(content);
    },
  } as unknown as ExtensionAPI;
  return { pi, inbox };
}

const EXEC_STUB: ExecFn = async (cmd) =>
  cmd.startsWith("git rev-parse") ? { stdout: "feedbeefcafe1234\n" } : { stdout: "" };

function researchDeps() {
  return {
    execFn: EXEC_STUB,
    fetchFn: (async () => ({ status: 200 })) as never,
    vipuneSearchFn: (async () => ({ kind: "hits", hits: [] })) as never,
    memoryWriteFn: (async () => ({ outcome: "written" as const, id: "mem-1" })) as never,
    // The reporter preflight must find its path, or every angle fails before
    // any dispatch happens and the deck stays empty for the wrong reason.
    statFn: (async (p: string) =>
      p === RESEARCH_REPORTER_PATH ? { isDirectory: () => false } : undefined) as never,
  };
}

async function freshRepo(): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "deck-parent-"));
  return tmp;
}

// ---------------------------------------------------------------------------
// 1. Executed evidence, end to end: start the REAL research job (the same
//    startJob call research-tool.ts makes, work fn included) and read the deck
//    while the pipeline is mid-flight. This is the join the ticket exists for:
//    child.parentKey === the parent job's own deck key.
// ---------------------------------------------------------------------------
{
  dispatchDeck.reset();
  clearJobsForTesting();
  installResearchDispatchStub();
  const children = observedChildren();
  const repo = await freshRepo();
  const { pi, inbox } = makePiStub();

  // Read after the job settles: the guard-rejection message per child, which
  // is what proves each deck row came from the REAL dispatchCore.
  let childSettles: string[] = [];
  let snapshotSize = 0;
  let parentRowCount = 0;
  let parentRowParentKey: string | undefined | "absent" = "absent";

  const handle = startJob(pi, {
    label: "research-driver",
    role: "research-driver",
    subject: "deck parent link",
    reportKind: "driver",
    // Identical in shape to research-tool.ts's work callback: the job's own
    // jobId, from WorkHooks, is what the pipeline threads to its children.
    work: async (signal, hooks) => {
      const result = await runResearchPipeline(
        { sendUserMessage: () => undefined, emit: () => undefined },
        { topic: "the deck's parent link behaviour", tier: "standard" },
        repo,
        researchDeps(),
        { signal, parentKey: hooks.jobId },
      );
      // Mid-flight: the job's own settle path has not run clearEntry yet, so
      // its row is still in the deck. The CHILD rows are read off the stub
      // (see below), not here: `startJob` wraps work() in `.then()` handlers,
      // so a row cleared while this await was in flight is gone by the time
      // the lines below are reached — reading them here would make the gate
      // depend on microtask timing rather than on the row's registration.
      const snap = dispatchDeck.snapshot();
      snapshotSize = snap.length;
      const parents = snap.filter((e) => e.state.role === "research-driver");
      parentRowCount = parents.length;
      parentRowParentKey = parents[0]?.parentKey ?? "absent";
      return {
        role: "research-driver",
        ok: !result.cancelled,
        text: "rendered research report",
        toolUses: [],
        ms: 0,
        exitCode: 0,
      };
    },
  });

  await handle.completion;
  // The guard rejections have settled by now (each is a synchronous throw
  // inside the child's work fn), so their messages are readable — and reading
  // them is what proves the row this gate observed came from the real
  // dispatchCore rather than from a stub that called startJob itself.
  childSettles = await settleMessages();
  // Every child's own row is awaited before the deck is inspected: the row
  // lives only while the child's work is outstanding, so "the deck was empty"
  // is only meaningful once each registration has been sighted (or the
  // polling window provably closed without one).
  await settleRows();
  const sighted = children.filter((c) => c.rowSeen);
  const rowsObserved = sighted.length;

  // The vacuity guard: a quiet-leaked env or a preflight failure would empty
  // the deck and make every parentKey assertion below pass on nothing. And a
  // leg whose row was never sighted is a RED here, not a pass: the per-child
  // claims below run over the sighted subset only, so an unsighted leg cannot
  // satisfy them with its initial `undefined`/`false` fields.
  assert(
    rowsObserved === children.length && rowsObserved >= 2,
    `EVERY standard-tier angle child had its OWN row sighted in the deck (${rowsObserved} of ${children.length} registrations — a row the deck never held is no evidence at all)`,
  );
  assert(
    children.length >= 2,
    `the standard tier dispatched its angle children (${children.length})`,
  );

  assert(
    // Rows must be DISTINCT objects: a rig that credited both legs of a fan-out
    // with the same deck row would otherwise satisfy "each leg's OWN row" twice
    // over with one piece of evidence.
    new Set(sighted.map((c) => c.jobId)).size === sighted.length &&
      sighted.every((c) => c.jobId !== "" && c.rowParentKey === handle.jobId),
    `EVERY sighted child row carried the parent job's jobId as its parentKey, each read off its OWN row (${sighted.length} distinct row keys) — got ${JSON.stringify(children.map((c) => `${c.requested}→${String(c.rowParentKey)}`))}`,
  );
  assert(
    sighted.every((c) => c.rowParentKey !== c.rowLabel && c.rowParentKey !== c.jobId),
    "no child row's parentKey is its own key (the link names the parent, never the row itself)",
  );
  assert(
    childSettles.every((m) => m.includes("FORBID_LIVE_SPAWN")),
    `executed evidence: the REAL dispatchCore ran for every child — the spawn guard rejected each one (${childSettles.length} guard rejections observed, not a stub-fabricated row)`,
  );
  assert(
    sighted.every((c) => c.rowParentKey === handle.jobId),
    `each sighted row's parentKey is the parent job's id: ${children.map((c) => `${c.requested}→${String(c.rowParentKey)}`).join(", ")}`,
  );
  assert(
    sighted.every((c) => c.rowBatchKeyAbsent === true),
    `research children carry NO batchKey — no batch grouping followed the parent link (${children.map((c) => `${c.requested}:${String(c.rowBatchKeyAbsent)}`).join(", ")})`,
  );
  assert(
    snapshotSize >= 1 && parentRowCount === 1 && parentRowParentKey === "absent",
    `the research job's OWN row was in the deck mid-run (${snapshotSize} row(s)) and keeps parentKey absent — a top-level dispatch has no parent`,
  );
  assert(inbox.length === 1, "the parent job delivered exactly one report to the host");

  dispatchDeck.reset();
  clearJobsForTesting();
  await rm(repo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. The pipeline-level route, driven per tier: standard (angles), deep
//    (research-entailment), adoption (the fixed trio + research-memo-synthesis)
//    — every child population, including the one the fallback flag would have
//    added, gets the parentKey it was handed.
// ---------------------------------------------------------------------------
async function drive(tier: "standard" | "deep" | "adoption"): Promise<Child[]> {
  installResearchDispatchStub();
  // The deck rows this drive creates are handed back here rather than left to
  // the settle path: the guard rejection clears a child's row the moment its
  // (fake) work settles, so a snapshot read after the await would be empty.
  const repo = await freshRepo();
  try {
    const r = await runResearchPipeline(
      FAKE_PI,
      { topic: "adopt the parent-link deck field?", tier },
      repo,
      researchDeps(),
      { parentKey: PARENT_KEY },
    );
    // A halt would mean the children were never really counted by the
    // pipeline — the parentKey assertions below would then be about a run that
    // stopped early.
    assert(!r.halt, `${tier}: pipeline ran to the artifact (no halt)`);
    // Executed evidence for this tier too: every row came from the real
    // dispatchCore, whose only outcome under the spawn guard is a rejection.
    const settles = await settleMessages();
    const children = observedChildren();
    assert(
      settles.length === children.length && settles.every((m) => m.includes("FORBID_LIVE_SPAWN")),
      `${tier}: the REAL dispatchCore ran for all ${children.length} children (guard rejections, not stub-fabricated rows)`,
    );
    return children;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

{
  const kids = await drive("standard");
  assert(kids.length >= 2, `standard: angle children dispatched (${kids.length})`);
  assert(
    kids.every((c) => c.parentKey === PARENT_KEY),
    `standard: every angle child's dispatchCore opts carried parentKey (${kids.map((c) => `${c.requested}=${String(c.parentKey)}`).join(", ")})`,
  );
  assert(
    kids.every((c) => c.optsSeen.deck === undefined && c.optsSeen.skipDeck === undefined),
    "standard: the parent link rode a sibling option, never opts.deck (which would force skipDeck:false + a batchKey)",
  );
}

{
  const kids = await drive("deep");
  const entail = kids.filter((c) => c.requested === "research-entailment");
  assert(
    entail.length === 1,
    `deep: exactly ONE entailment child dispatched (${entail.length}; labels: ${kids.map((c) => c.requested).join(",")})`,
  );
  assert(
    entail.every((c) => c.parentKey === PARENT_KEY),
    "deep: the research-entailment child carried parentKey",
  );
  assert(
    kids.every((c) => c.parentKey === PARENT_KEY),
    "deep: the angle children of the deep tier carried parentKey too",
  );
}

{
  const kids = await drive("adoption");
  // The population is read from the stub's OWN view of each dispatch: the
  // pipeline's angle fan-out runs under Promise.all, so this asserts who was
  // dispatched without depending on deck-row order or seq.
  const labels = kids.map((c) => c.requested).join(",");
  const synth = kids.filter((c) => c.requested === "research-memo-synthesis");
  const trio = kids.filter((c) => c.requested.startsWith("research-adoption"));
  assert(synth.length === 1, `adoption: exactly ONE synthesis child (labels: ${labels})`);
  assert(trio.length === 3, `adoption: the fixed three-angle set dispatched (${trio.length})`);
  assert(
    synth.every((c) => c.parentKey === PARENT_KEY),
    "adoption: the research-memo-synthesis child carried parentKey",
  );
  assert(
    trio.every((c) => c.parentKey === PARENT_KEY),
    `adoption: every adoption angle child carried parentKey (${trio.map((c) => c.requested).join(", ")})`,
  );
  assert(
    kids.every((c) => c.parentKey === PARENT_KEY),
    "adoption: no child of the run was left without the link",
  );
}

// ---------------------------------------------------------------------------
// 3. No parent link reaches a child that was never given one: the headless
//    four-argument call (headless/research.ts) keeps compiling with the opts
//    object absent, and its children get NEITHER an empty string NOR a key.
// ---------------------------------------------------------------------------
{
  const repo = await freshRepo();
  installResearchDispatchStub();
  const children = observedChildren();
  const r = await runResearchPipeline(
    FAKE_PI,
    { topic: "the headless research verb has no job", tier: "standard" },
    repo,
    researchDeps(),
  );
  assert(!r.halt, "headless-shaped call: four-argument pipeline ran to the artifact");
  assert(children.length >= 2, `headless-shaped call: children dispatched (${children.length})`);
  assert(
    children.every((c) => c.parentKey === undefined),
    `headless-shaped call: parentKey left ABSENT — never "" and never the child's own key (${JSON.stringify(children.map((c) => c.parentKey))})`,
  );
  await rm(repo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3b. The FOURTH dispatch leg — the #773 wigolo re-dispatch, which is
//     default-ON (`research-driver.ts` enables it unless the flag is exactly
//     "0"). No gate reached it before: the stub always answered success, so an
//     angle never failed and the re-dispatch never fired. Here one angle is
//     made to fail on the verbatim credit anchor, the flag is left UNSET, and
//     the re-dispatched leg's OWN deck row is claimed and asserted like every
//     other child's. The driver builds the angle's ctx once and hands the same
//     object to both legs, so this is the executed evidence that the fallback
//     leg carries the link and not merely the primary one.
// ---------------------------------------------------------------------------
{
  // Not "0": with the flag exactly "0" the selector refuses the re-dispatch
  // and this block would assert on a leg that was never dispatched. `withEnv`
  // puts back whatever the file-level vacuity guard had pinned, so the unset
  // cannot outlive this block into a sibling test in the same process.
  await withEnv({ PI_ENSEMBLE_RESEARCH_FALLBACK: undefined }, async () => {
    dispatchDeck.reset();
    clearJobsForTesting();
    const failing = "docs-depth";
    installResearchDispatchStub([failing]);
    const children = observedChildren();
    const repo = await freshRepo();
    try {
    const r = await runResearchPipeline(
      FAKE_PI,
      { topic: "does the fallback leg inherit the parent link?", tier: "standard" },
      repo,
      researchDeps(),
      { parentKey: PARENT_KEY },
    );
    const settles = await settleMessages();
    // Awaited BEFORE the assertions, which then run over the SIGHTED subset: an
    // unsighted leg must not satisfy a row claim by carrying its initial
    // `undefined`/`false` fields.
    await settleRows();
    const legs = children.filter((c) => c.requested.startsWith(`research-${failing}`.slice(0, 24)));
    const sightedLegs = legs.filter((c) => c.rowSeen);
    assert(
      legs.length === 2,
      `the fallback leg fired: the ${failing} angle dispatched TWICE, primary + wigolo re-dispatch (${legs.length}; all labels: ${children.map((c) => c.requested).join(",")})`,
    );
    assert(
      r.angles.some((a) => a.name === failing && !a.ok),
      `the ${failing} angle is recorded as FAILED — the leg below is the re-dispatch itself, not a copy of the primary (angles: ${r.angles.map((a) => `${a.name}:${a.ok ? "ok" : "fail"}`).join(",")})`,
    );
    assert(
      settles.length === children.length && settles.every((m) => m.includes("FORBID_LIVE_SPAWN")),
      `fallback: the REAL dispatchCore ran for all ${children.length} legs incl. the re-dispatch (guard rejections, not stub-fabricated rows)`,
    );
    assert(
      legs.length === 2 &&
        sightedLegs.length === legs.length &&
        sightedLegs.every((c) => c.rowParentKey === PARENT_KEY),
      `the fallback leg's OWN deck row carried the parent link — got ${JSON.stringify(legs.map((c) => `${c.requested}→${String(c.rowParentKey)}→sighted:${c.rowSeen}`))}`,
    );
    assert(
      sightedLegs.length === legs.length &&
        new Set(sightedLegs.map((c) => c.jobId)).size === sightedLegs.length,
      `both legs of the ${failing} angle had their OWN deck row sighted, under two DISTINCT keys (${sightedLegs.length} of ${legs.length}) — the re-dispatch registers a row of its own, it does not reuse the primary's`,
    );
    assert(
      sightedLegs.length === legs.length &&
        sightedLegs.every((c) => c.parentKey === PARENT_KEY && c.rowBatchKeyAbsent === true),
      "fallback: the re-dispatched child carried parentKey and no batchKey, like the primary leg",
    );
    assert(
      children.every((c) => c.parentKey === PARENT_KEY),
      "fallback drive: no child of the run — primary or re-dispatched — was left without the link",
    );
  } finally {
      dispatchDeck.reset();
      clearJobsForTesting();
      await rm(repo, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 4. The link is deck-only: startEntry copies it onto the row, snapshot carries
//    it, and no rendered surface gains a character. The projection half of the
//    gate lives in lib/deck-parent-projection.ts — this file is at the §12 size
//    cap, and byte-identity of the rendered rows is its own concern.
// ---------------------------------------------------------------------------
for (const failure of await checkParentLinkStaysUnrendered()) assert(false, failure);
assert(true, "deck/agent-list/peek projections unchanged by parentKey (see lib/deck-parent-projection.ts)");

setResearchDispatch(null);

console.log(exit === 0 ? "\ndeck parentKey gate: PASS" : "\nFAILED");
process.exit(exit);
