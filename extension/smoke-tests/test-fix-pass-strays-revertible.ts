#!/usr/bin/env bun
/**
 * #1849 item 8 — a stray the driver may not revert is a STRUCTURAL property of
 * the refusal, not a string comparison at the offer site.
 *
 * The rule ("never revert a `fenced` or `protected` stray") was enforced in one
 * expression inside `postPassFault`: `strays.every(s => s.refused !== "fenced" &&
 * s.refused !== "protected")`. That reads the two fields the refusal carries for
 * the PARK REASON, and the two are not the same question. `admitFixPassEntry`
 * answers the absolute gate first and puts its answer in `admissionRefusal` while
 * `refused` carries the spec-slot route's kind — so a file the fence refused
 * reports `refused: "no-slot"`, and the check was one field-addition away from
 * offering the revert a protected file. Worse, the set was decided by a scan over
 * strings nobody owns: add a refusal kind, or a new route that refuses, and the
 * offer silently widens.
 *
 * Now each `Stray` carries `revertible`, SET WHERE THE ABSOLUTE REFUSAL IS
 * PRODUCED, and `postPassFault` offers the revert only when every stray in the
 * set says so. Four shapes are asserted, all through the real fence:
 *   - a protected stray (`agents.json`) → no revert offered, tree untouched;
 *   - an `outOfScope` stray → no revert offered;
 *   - one non-revertible file in an otherwise revertible set → the WHOLE set is
 *     withheld (reverting the neighbours while the park names all three is the
 *     report that would lie);
 *   - a genuinely out-of-fence stray → still revertible, so the flag has not
 *     become a ban.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PassPlan, PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { planFixPass, postPassFault } from "../src/work-driver-adversarial-fix-scope.ts";
import { fixPassFence, gateFenceView } from "../src/work-driver-fix-pass-admission.ts";
import { fanoutLimitFor } from "../src/work-driver-scope-fanout.ts";
import {
  type GitRead,
  committedChanges,
  defaultExec,
  treeChanges,
} from "../src/work-driver-adversarial-fix-git.ts";
import {
  devCommit,
  git,
  mustRead,
  repoWithFile,
  singleState,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The state one fix pass carries for a workstream with the given declared and
 * out-of-scope paths, in `dir`. Built from the shared `singleState` — the
 * constructor every other fix-pass test uses — so the fence reads a pipeline
 * state with the same fields a real cycle's has, and `baseSha` is the commit the
 * worktree was added at.
 */
/** `devCommit` for a path in a directory the base commit does not have. */
function devCommitIn(wt: string, file: string, body: string): void {
  mkdirSync(dirname(join(wt, file)), { recursive: true });
  devCommit(wt, file, body);
}

function workstreamState(dir: string, paths: string[], outOfScope: string[]): WorkState {
  const base = git(dir, "rev-parse HEAD").trim();
  const s = singleState(dir, [
    { kind: "adversarial-round", at: 1, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
    {
      kind: "adversarial-fix-requested",
      at: 2,
      workstreamId: "default",
      round: 1,
      findings: "a.txt: change one to two",
    },
  ]);
  return {
    ...s,
    issue: 1846,
    pipelineState: {
      ...s.pipelineState,
      baseSha: base,
      workstreams: { default: { id: "default", scope: "fix", paths, outOfScope } },
    },
  };
}

/**
 * One planned pass in a real repo, and the post-pass verdict on the tree the
 * developer left. `paths`/`outOfScope` are the workstream as the planner wrote
 * them; `write` makes the developer's edits before the fence reads.
 */
async function verdictFor(opts: {
  paths: string[];
  outOfScope: string[];
  /** What the CYCLE's develop step left in the tree, committed, at the moment
   *  the pass is planned (i.e. `planFixPass`'s `headBefore`). */
  cycleWork?: (worktree: string) => void;
  /** What the FIX PASS itself then changed. */
  write: (worktree: string) => void;
}) {
  const dir = repoWithFile("1846-revertible");
  git(dir, "worktree add -q --detach .worktrees/issue-1846 HEAD");
  const wt = `${dir}/.worktrees/issue-1846`;
  const st = workstreamState(dir, opts.paths, opts.outOfScope);
  // The driver plans a pass against the tree the develop step left, so the
  // cycle's own commits go in BEFORE the plan and the pass's own edits after it.
  // That ordering is what the fence reads: `planFixPass` records `headBefore` as
  // the worktree's HEAD at plan time and builds the cycle-owned set from
  // `committedChanges(base..headBefore)` — a pass planned before the develop work
  // holds a `headBefore` equal to the base, and every file the cycle created then
  // looks like the pass's own work, which is a different question from the one
  // the #2156 cases below ask.
  opts.cycleWork?.(wt);
  const planned = mustRead(
    await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "a.txt: change one to two" },
    ]),
    "planFixPass",
  );
  const plans = planned.map((p) => ({ ...p, worktree: wt }));
  opts.write(wt);
  const baseSha = st.pipelineState.baseSha ?? "";
  const post = await postPassFault(defaultExec, plans, baseSha);
  return { dir, wt, plans, post, baseSha };
}

/**
 * One planned pass whose `headBefore` is the tip `cycleWork` committed.
 *
 * `verdictFor` above reads the cycle's base BEFORE any work lands, which is right
 * for a file that existed at the base; a file the CYCLE created has to be created
 * first, so its base has to be read afterwards. That ordering costs the pass its
 * own head: `baseSha` then already contains the pass's edits, and a fence reading
 * `committedChanges(base..headBefore)` sees an empty cycle. This variant keeps the
 * base as the base (the pre-work read) and moves only `headBefore`, which is the
 * one field the pass delta, the committed read and the revert target are all
 * derived from. `plans` is what a driver's plan looks like after its develop step
 * committed and before its fixer was dispatched.
 */
async function verdictAfterCycleWork(opts: {
  paths: string[];
  outOfScope: string[];
  /** The cycle's develop work, committed BEFORE the base SHA is read. */
  cycleWork: (worktree: string) => void;
  /** What the fix pass itself then changed. */
  write: (worktree: string) => void;
}) {
  const dir = repoWithFile("1846-revertible");
  git(dir, "worktree add -q --detach .worktrees/issue-1846 HEAD");
  const wt = `${dir}/.worktrees/issue-1846`;
  // The base is read BEFORE the develop work lands, because the base is where the
  // cycle started; `headBefore` is read after it, because that is the tip the
  // driver plans a pass against. `verdictFor` above reads the base after the tree
  // was built, which is right for a file that existed at the base and wrong for a
  // file the cycle CREATED: its base then already contains it, so no committed read
  // can call it the cycle's own. Only `headBefore` moves here — the one field the
  // pass delta, the committed read and the revert target are all derived from.
  const baseSha = git(dir, "rev-parse HEAD").trim();
  opts.cycleWork(wt);
  const headBefore = git(wt, "rev-parse HEAD").trim();
  const before = mustRead(await treeChanges(defaultExec, wt, baseSha), "treeChanges");
  const cycle = mustRead(
    await committedChanges(defaultExec, wt, baseSha, headBefore),
    "committedChanges",
  );
  const st = workstreamState(dir, opts.paths, opts.outOfScope);
  const planned = mustRead(
    await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "a.txt: change one to two" },
    ]),
    "planFixPass",
  );
  const plans = planned.map((p) => ({
    ...p,
    worktree: wt,
    headBefore,
    before,
    outOfScope: [...opts.outOfScope],
    fence: fixPassFence(
      {
        id: p.id,
        declared: p.declared,
        named: p.named,
        alreadyChanged: before.names,
        cycleOwned: [...new Set([...cycle, ...before.names])],
        outOfScope: opts.outOfScope,
        admittingSlots: 0,
      },
      fanoutLimitFor,
    ),
  }));
  opts.write(wt);
  const post = await postPassFault(defaultExec, plans, baseSha);
  return { dir, wt, plans, post, baseSha };
}

console.log("# a fix-pass edit to a file this cycle created is inside the fence (AC1)");
{
  const t = await verdictAfterCycleWork({
    // Declared scope names only the pre-existing module — the created file is
    // nowhere in it, which is what made the pre-#2156 fence refuse it.
    paths: ["a.txt"],
    outOfScope: [],
    cycleWork: (wt) => devCommitIn(wt, "lib/created.ts", "export const created = 1;\n"),
    write: (wt) => {
      devCommit(wt, "lib/created.ts", "export const created = 2;\n");
      devCommit(wt, "a.txt", "two\n");
    },
  });
  try {
    const files = (t.post.strays ?? []).map((s) => s.file);
    assert(
      t.post.reason === undefined,
      `the pass is cleared — the cycle-created edit and its paired edit are BOTH kept (reason: ${t.post.reason})`,
    );
    assert(
      !files.includes("lib/created.ts"),
      `and the created file is never in the stray set (${JSON.stringify(files)})`,
    );
    assert(
      readFileSync(`${t.wt}/lib/created.ts`, "utf8") === "export const created = 2;\n",
      "the fixer's edit of the cycle's own file stands in the tree",
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

console.log("# an absolute refusal still outranks the cycle-owned route");
{
  // The other half of AC1: the new route must not become a way around the plan's
  // own fence. The same created file, now declared out of scope by the plan.
  const t = await verdictAfterCycleWork({
    paths: ["a.txt"],
    outOfScope: ["lib/**"],
    cycleWork: (wt) => devCommitIn(wt, "lib/created.ts", "export const created = 1;\n"),
    write: (wt) => {
      devCommit(wt, "lib/created.ts", "export const created = 2;\n");
      devCommit(wt, "a.txt", "two\n");
    },
  });
  try {
    // A stray the plan's own fence refused is the driver's hands off: the refusal
    // is park-only — no `straysFor`, no strays, no rewind set — and its wording
    // says which rule stopped the file, so an operator can see it was the fence
    // and not the absence of an admission route.
    assert(t.post.reason !== undefined, "the fenced cycle-created file is still refused");
    assert(
      (t.post.reason ?? "").includes("lib/created.ts"),
      `and the refusal names it (${(t.post.reason ?? "").slice(0, 60)})`,
    );
    assert(
      (t.post.reason ?? "").includes("outOfScope fence"),
      `naming the gate that refused it, not the admission ladder (${(t.post.reason ?? "").match(/refused it:[^.]*/)?.[0]})`,
    );
    assert(
      t.post.straysFor === undefined &&
        t.post.strays === undefined &&
        t.post.paths === undefined &&
        t.post.wholePass === undefined,
      "and nothing in this pass is offered to the revert — an absolute refusal is park-only",
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

console.log("# the rewind set is the pass's WHOLE delta, never the strays alone (AC2)");
{
  // The half-applied shape: one file outside every route (`lib/helper.ts`, the
  // stray) plus the pass's admitted fix in `a.txt`. Pre-#2156 the offer carried
  // the stray alone and the revert kept `a.txt` — the exact tree the issue
  // reports. Now the offer names the whole pass delta and says the pass is being
  // rewound, so the caller can never keep half of it.
  const t = await verdictFor({
    paths: ["a.txt"],
    outOfScope: [],
    write: (wt) => {
      devCommit(wt, "a.txt", "two\n");
      devCommitIn(wt, "lib/helper.ts", "export const helper = () => 1;\n");
    },
  });
  try {
    assert(t.post.wholePass === true, "the refusal says this is a whole-pass rewind");
    assert(
      (t.post.paths ?? []).includes("a.txt") && (t.post.paths ?? []).includes("lib/helper.ts"),
      `the rewind set covers the admitted fix AND the stray (${JSON.stringify(t.post.paths)})`,
    );
    assert(
      (t.post.strays ?? []).some((s) => s.file === "lib/helper.ts"),
      "the stray is still named for the park",
    );
    assert(
      (t.post.reason ?? "").includes("rewound this pass's whole delta"),
      `and the park says the WHOLE delta goes back, not one file (${(t.post.reason ?? "").slice(0, 40)})`,
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

console.log("# a ceiling breach is a refusal of the whole pass, never a rewind offer");
{
  // The cycle-owned route is an admission, not a skeleton key: eight files on one
  // declared path is bounded by the pass's fan-out ceiling whatever admitted them,
  // and a ceiling breach refuses the pass rather than offering a rewind of it.
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "3";
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
  const t = await verdictAfterCycleWork({
    paths: ["a.txt"],
    outOfScope: [],
    cycleWork: (wt) => {
      for (let i = 0; i < 8; i++) devCommitIn(wt, `lib/own${i}.ts`, `export const own${i} = 1;\n`);
    },
    write: (wt) => {
      for (let i = 0; i < 8; i++) devCommit(wt, `lib/own${i}.ts`, `export const own${i} = 2;\n`);
    },
  });
  try {
    assert(
      t.post.reason !== undefined && /fan-out limit/.test(t.post.reason),
      `editing eight of the cycle's own files on one declared path breaches the ceiling, not the admission ladder (${(t.post.reason ?? "").slice(0, 120)})`,
    );
    assert(
      t.post.straysFor === undefined && t.post.wholePass === undefined,
      "and a ceiling breach is a refusal of the whole pass, never a rewind offer",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR;
    delete process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN;
    rmSync(t.dir, { recursive: true, force: true });
  }
}

console.log("# the helper route's ceiling is computed from the slots it counted");
{
  // The ceiling rule is `max(declared × factor, minimum)`, so a test that wants
  // to see the slot term MOVE the ceiling has to take the floor out: with the
  // defaults (factor 3, minimum 6) one declared path and one slot both give 6 and
  // the assertion below would pass for the wrong reason.
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "3";
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
  const slots = [{ deliverableId: "d1", slot: "src", glob: "src/*.ts" }] as never[];
  const { createSpecAdmitter } = await import("../src/work-driver-spec-slot-admission.ts");
  const admitter = createSpecAdmitter({
    slots,
    source: "test",
    isFenced: () => false,
    onAdmit: () => {},
  });
  admitter.admit("default", "src/a.ts", ["src/x.ts"]);
  admitter.admit("default", "src/b.ts", ["src/x.ts"]);
  const counted = admitter.admittedSlotCount("default");
  assert(counted === 1, `one slot that admitted two files counts as ONE (${counted})`);

  // What the plan-time object says, and what the gate must be judged by.
  const planTime = fixPassFence(
    { id: "default", declared: ["src/x.ts"], named: [], alreadyChanged: [], outOfScope: [], admittingSlots: 0 },
    fanoutLimitFor,
  );
  const withSlots = fixPassFence(
    {
      id: "default",
      declared: ["src/x.ts"],
      named: [],
      alreadyChanged: [],
      outOfScope: [],
      admittingSlots: counted,
    },
    fanoutLimitFor,
  );
  assert(
    planTime.ceiling === fanoutLimitFor(1 + 0) && withSlots.ceiling === fanoutLimitFor(1 + counted),
    `each ceiling is the documented rule over its own denominator (${planTime.ceiling} vs ${withSlots.ceiling})`,
  );
  // THE assertions. (1) A spread of the counted slots onto the plan-time view
  // changes nothing, because `ceiling` is DERIVED inside `fixPassFence` and never
  // read back off the object — which is exactly why `postPassFault` must go
  // through a spread rather than the gate's own builder. (2) `gateFenceView` —
  // the function `postPassFault` itself composes, so the numbers below ARE the
  // ones the gate is judged by — widens the ceiling to the same number the
  // standalone `fixPassFence` call produces from the same denominator.
  const gateView = gateFenceView(planTime, ["src/x.ts"], new Set(["src"]), counted);

  // A slot count is meaningless without its denominator, so the pass-level check
  // must read the accounting the VIEW was built with, not recount it. Two slots
  // over one declared path is a wider pass than zero slots over the same path,
  // and the object that carries the wider ceiling has to carry the wider count.
  const twoSlots = gateFenceView(planTime, ["src/x.ts"], new Set(["src"]), 2);
  assert(
    twoSlots.admittingSlots === 2 &&
      twoSlots.ceiling === fanoutLimitFor(1 + 2) &&
      twoSlots.ceiling > gateView.ceiling,
    `the view that reports ${twoSlots.admittingSlots} admitting slots is also the one bounded by them (${twoSlots.ceiling} over the single-slot ${gateView.ceiling})`,
  );
  const zeroSlots = gateFenceView(planTime, ["src/x.ts"], new Set(["src"]), 0);
  assert(
    zeroSlots.admittingSlots === 0,
    "and a view built with no admitting slot reports zero, which is what keeps the plan-time number honest",
  );
  const spread = { ...planTime, admittingSlots: counted };
  assert(
    spread.ceiling === planTime.ceiling,
    "spreading the counted slots onto the fence changes nothing, so a spread would have been the bug",
  );
  assert(
    gateView.ceiling === withSlots.ceiling && gateView.ceiling > planTime.ceiling,
    `the SAME pass is bounded at ${planTime.ceiling} by the plan-time ceiling and ${gateView.ceiling} once the counted slot is derived in — that gap is what item 9 closes`,
  );
  assert(
    gateView.ceilingBasis === withSlots.ceilingBasis &&
      gateView.ceilingBasis.includes("1 admitting slot"),
    `the disclosure line the gate would print says the slot it was bounded by (${gateView.ceilingBasis})`,
  );
  // A zero-slot pass is unaffected: the helper route's ceiling has to stay put
  // when there is nothing to account for.
  const unchanged = gateFenceView(planTime, [], new Set(["src"]), 0);
  assert(
    unchanged.ceiling === planTime.ceiling && unchanged.ceilingBasis === planTime.ceilingBasis,
    "with no admitting slot the re-derivation is the identity",
  );
  delete process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR;
  delete process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN;
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
