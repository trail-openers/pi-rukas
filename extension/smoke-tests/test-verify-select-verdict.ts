#!/usr/bin/env bun
/**
 * #2450 — the selector's verdict reaches the state file.
 *
 * `planDevelopVerify` decided the develop round's command and then threw the
 * decision away: it pushed a sentence onto the caller's `notes` and returned.
 * Every `verify-started` in a state file therefore showed the full command and
 * nothing distinguished a selected run from a whole-graph fallback — which is
 * precisely how the selector stayed dead for a month unnoticed.
 *
 * So the verdict is recorded as a named `WorkEvent` kind (`verify-select`, on the
 * `driver:base-health` precedent of a driver-labelled record), and this asserts it
 * on every branch the issue's R1 commits to:
 *   - the selected run — mode `selected`, with both counts;
 *   - every fallback that produced a reason — mode `full`, naming it;
 *   - the three selection-NOT-attempted paths — no event at all, byte-identical to
 *     today.
 * The note strings stay verbatim beside the structured record (R5): docs quote
 * them, so a test pins them rather than trusting a reword to have been harmless.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDevelopVerifyCommandChain } from "../src/work-driver-verify-develop-cmd.ts";
import { recordDevelopGateEvents } from "../src/work-driver-verify-events.ts";
import type { VerifyDevelopOutcomeOptions } from "../src/work-driver-verify-develop-options.ts";
import { planDevelopVerify } from "../src/work-driver-verify-select-develop.ts";
import type { SelectedVerifyPlan } from "../src/work-driver-verify-select-develop.ts";
import { makeVerifySelectEvent } from "../src/workflow-state-events-verify-select.ts";
import type { VerifySelectEvent } from "../src/workflow-state-events-verify-select.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const VERIFY_CMD = "bash smoke-tests/lib/verify-loop.sh smoke-tests/test-x.ts";
const FAST_CMD = "node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json";

/** A repo shaped like this one enough for the selector to run against it. */
function makeRepo(opts: {
  verifyCmd?: boolean;
  fastCmd?: boolean;
  optIn?: boolean;
}): { repoRoot: string; ext: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-verify-verdict-"));
  const ext = path.join(root, "extension");
  const put = (rel: string, text: string) => {
    const file = path.join(ext, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
  };
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  put("src/a.ts", "export const a = 1;\n");
  put("src/dead.ts", "export const dead = 1;\n");
  put("smoke-tests/test-a.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
  if (opts.verifyCmd !== false) writeFileSync(path.join(root, ".pi", "verify-cmd"), `${VERIFY_CMD}\n`);
  if (opts.fastCmd !== false) writeFileSync(path.join(root, ".pi", "verify-cmd-fast"), `${FAST_CMD}\n`);
  if (opts.optIn !== false) writeFileSync(path.join(root, ".pi", "verify-select"), "");
  return { repoRoot: root, ext };
}

/**
 * A repo shaped like the real one, but inert to git.
 *
 * A fixture root is created under tmpdir(), which on a developer host sits inside
 * a working tree. `git init` there is a no-op (git finds the enclosing repo and
 * returns 0), and every later `git` call in the fixture then runs against THAT
 * repository — so a fixture that removes its own directory is removing while real
 * paths are open, which is how this suite was made to fail intermittently in
 * directories it never touched. The isolation the verify loop itself exports
 * (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, a private `HOME`) is set here for
 * the same reason, and no `git init` is attempted: nothing in these plans shells
 * out to git.
 */

/** The chain's arguments with this fixture's plan, options and no-op exec. */
function chainArgs(plan: SelectedVerifyPlan, options: VerifyDevelopOutcomeOptions) {
  return {
    ctx: { repoRoot: "/nonexistent-fixture" } as never,
    state: initialState(4245),
    execFn: (async () => ({ stdout: "", stderr: "" })) as never,
    plan,
    worktrees: {},
    baseSha: undefined,
    changedWorktrees: [],
    workstreamBaseShas: undefined,
    touchedPaths: [],
    getGitReadFailed: () => false,
    failures: [] as string[],
    notes: [] as string[],
    options,
    baselineLeg: { red: false, established: false },
    onBaseHealth: () => {},
  };
}

/** Run one plan and hand its verdict to the recording seam, as the gate does. */
async function planAndRecord(repoRoot: string, touched: string[]): Promise<{
  notes: string[];
  verdict: unknown;
  kinds: string[];
  events: VerifySelectEvent[];
}> {
  const notes: string[] = [];
  const noopExec = (async () => ({ stdout: "", stderr: "" })) as never;
  const plan = await planDevelopVerify(
    { repoRoot } as never,
    touched,
    {},
    undefined,
    noopExec,
    notes,
  );
  // The chain fills the caller's sink from the plan it holds (the hand-off lives in
  // runDevelopVerifyCommandChain, the module that has both), and the caller passes
  // what it read to the seam that owns the state write. A plan with no command
  // reaches no gate at all — the whole-suite fallback always has one.
  const sink: { verdict?: SelectedVerifyPlan["verdict"] } = {};
  await runDevelopVerifyCommandChain(chainArgs(plan, { verifySelectSink: sink }));
  const before = initialState(4245);
  const after = recordDevelopGateEvents(before, {
    ...(sink.verdict !== undefined ? { verifySelect: sink.verdict } : {}),
  });
  const events = after.eventLog.filter(
    (e): e is VerifySelectEvent => e.kind === "verify-select",
  );
  return { notes, verdict: sink.verdict, kinds: after.eventLog.map((e) => e.kind), events };
}

// --- the selected run --------------------------------------------------------
{
  const { repoRoot } = makeRepo({});
  try {
    const r = await planAndRecord(repoRoot, ["extension/src/a.ts"]);
    assert(
      r.events.length === 1,
      `a selected run records exactly one verify-select event (got ${r.events.length})`,
    );
    const e = r.events[0];
    assert(
      e?.mode === "selected" && e.selected === 1 && e.alwaysRun === 0,
      `the event carries mode and both counts (got ${JSON.stringify(e)})`,
    );
    assert(e?.fallbackReason === undefined, "a selected event carries no fallbackReason");
    assert(e?.step === "develop", "the event names its step");
    // R5: the operator-facing note is unchanged, and sits BESIDE the record.
    assert(
      r.notes.some((n) =>
        /^verify selection ran 1 test\(s\) plus 0 always-run, not the full suite \(PI_ENSEMBLE_VERIFY_SELECT=0 restores it\)$/.test(
          n,
        ),
      ),
      `the selected note string is verbatim (got ${JSON.stringify(r.notes)})`,
    );
    assert(
      r.kinds.includes("verify-select"),
      "the verdict lands on the state's eventLog, not only on the notes",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// --- a reasoned fallback ----------------------------------------------------
{
  const { repoRoot } = makeRepo({});
  try {
    // A changed file the graph cannot place: the whole-suite policy, recorded.
    const r = await planAndRecord(repoRoot, ["README.md"]);
    const e = r.events[0];
    assert(
      r.events.length === 1 && e?.mode === "full" && e.fallbackReason === "outside-graph:README.md",
      `a reasoned fallback records mode full with its reason (got ${JSON.stringify(e)})`,
    );
    assert(
      e?.selected === 0,
      "a fallback records selected: 0 rather than omitting the count",
    );
    assert(
      r.notes.some((n) =>
        /^verify selection fell back to the full suite \(outside-graph:README\.md\)$/.test(n),
      ),
      `the fallback note string is verbatim (got ${JSON.stringify(r.notes)})`,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// --- selection not attempted: three paths, no event, no note ----------------
for (const [label, opts, env] of [
  ["no .pi/verify-select", { optIn: false }, undefined],
  ["no .pi/verify-cmd", { verifyCmd: false }, undefined],
  ["PI_ENSEMBLE_VERIFY_SELECT=0", {}, "0"],
] as const) {
  const { repoRoot } = makeRepo(opts);
  const prev = process.env.PI_ENSEMBLE_VERIFY_SELECT;
  if (env !== undefined) process.env.PI_ENSEMBLE_VERIFY_SELECT = env;
  try {
    const r = await planAndRecord(repoRoot, ["extension/src/a.ts"]);
    assert(
      r.events.length === 0 && r.verdict === undefined,
      `${label}: no verify-select event and no verdict (got ${JSON.stringify(r.verdict)}) — R1's selection-not-attempted carve-out`,
    );
    if (label === "no .pi/verify-select" || label === "no .pi/verify-cmd") {
      assert(
        r.notes.length === 0,
        `${label}: not even a note — the pre-#1647 round is byte-identical (got ${JSON.stringify(r.notes)})`,
      );
    } else {
      assert(
        r.notes.some((n) => n.includes("PI_ENSEMBLE_VERIFY_SELECT=0")),
        `${label}: the escape hatch keeps its note and gains no event (got ${JSON.stringify(r.notes)})`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_VERIFY_SELECT;
    else process.env.PI_ENSEMBLE_VERIFY_SELECT = prev;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// --- the factory keeps the shape honest -------------------------------------
{
  const selected = makeVerifySelectEvent({ mode: "selected", selected: 3, alwaysRun: 9 });
  assert(
    !("fallbackReason" in selected),
    `makeVerifySelectEvent leaves fallbackReason ABSENT rather than undefined-present (got ${JSON.stringify(selected)}) — a pre-fix reader and a post-fix reader render the same bytes`,
  );
  const full = makeVerifySelectEvent({
    mode: "full",
    fallbackReason: "unlexable:src/x.ts",
    selected: 0,
    alwaysRun: 9,
  });
  assert(
    full.fallbackReason === "unlexable:src/x.ts" && full.selected === 0,
    "a fallback event carries the selector's reason string through unchanged",
  );
}

console.log(exit === 0 ? "\nAll verify-select recording checks passed." : "\nFAILED");
process.exit(exit);
